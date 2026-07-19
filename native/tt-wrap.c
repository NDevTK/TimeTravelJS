/*
 * TimeTravelJS wasm embedder.
 *
 * Exports a small API around a patched QuickJS build. The step hook fires on
 * every source-line boundary; the host decides per step whether to keep
 * running, take a snapshot, or park. Suspension uses Binaryen's Asyncify:
 * the `tt_host_step` import unwinds the entire wasm stack into a fixed
 * buffer in the data segment, so a linear-memory snapshot taken while
 * suspended is a complete, resumable machine state.
 *
 * While paused, the host talks to the VM through the command loop below —
 * inspection and console evaluation run *inside* the interpreter at the
 * paused position, where every frame is live and valid.
 */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "quickjs.h"

#define EXPORT(name) __attribute__((export_name(name), used))
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

/* host imports ----------------------------------------------------------- */
/* Asyncified: may suspend the whole VM. Returns the next command. */
IMPORT("tt_host_step") extern int tt_host_step(int line, int col, int depth);
/* Synchronous out-of-band channel: kind 0=console 1=inspect 2=eval-result
   3=eval-done 4=jobs-done 5=timer-done */
IMPORT("tt_host_out") extern void tt_host_out(int kind, const char *ptr, int len);
/* Synchronous: copy the staged command payload (eval source) into dst,
   returns its UTF-8 length (or 0). */
IMPORT("tt_host_arg") extern int tt_host_arg(char *dst, int cap);
/* Synchronous watchdog for code running between step points. */
IMPORT("tt_host_interrupt") extern int tt_host_interrupt(void);

/* step commands ---------------------------------------------------------- */
enum {
    TT_CMD_CONTINUE = 0,
    TT_CMD_ABORT = 1,
    TT_CMD_INSPECT = 2,       /* inspect, then ask for the next command   */
    TT_CMD_EVAL = 3,          /* evaluate, then ask for the next command  */
    TT_CMD_INSPECT_ABORT = 4, /* inspect, then abort this activation      */
    TT_CMD_EVAL_ABORT = 5,    /* evaluate, then abort this activation     */
    TT_CMD_EVAL_CONTINUE = 6, /* evaluate, then resume execution (fork)   */
};

/* fixed asyncify state area — lives in the data segment, so its address is
   identical in every snapshot and across the whole session */
#define TT_ASYNCIFY_STACK (512 * 1024)
static unsigned char g_asyncify_area[8 + TT_ASYNCIFY_STACK];

EXPORT("tt_asyncify_area") unsigned char *tt_asyncify_area(void) { return g_asyncify_area; }
EXPORT("tt_asyncify_area_size") int tt_asyncify_area_size(void) { return (int)sizeof(g_asyncify_area); }

/* Dirty-page byte map for the write barrier: the build post-processes the
   wasm so every store also sets g_tt_dirty[(addr >> 10)] = 1 (uninstrumented
   itself). One byte per 1 KB page, sized for the 512 MB memory maximum.
   Zero-initialized BSS — costs nothing in the binary. The host reads and
   clears it; barrier writes bypass instrumentation, so the map region never
   marks itself and stays out of the recorded history. */
#define TT_DIRTY_PAGES (512 * 1024)
static unsigned char g_tt_dirty[TT_DIRTY_PAGES] __attribute__((aligned(1024)));

EXPORT("tt_dirty_map") unsigned char *tt_dirty_map(void) { return g_tt_dirty; }
EXPORT("tt_dirty_map_size") int tt_dirty_map_size(void) { return TT_DIRTY_PAGES; }

/* state ------------------------------------------------------------------ */
static JSRuntime *g_rt;
static JSContext *g_ctx;
static JSValue g_ser_fn;        /* (value, kind) -> JSON string           */
static JSValue g_envelope_fn;   /* (isError, value) -> JSON string        */
static JSValue g_globals_fn;    /* () -> plain object of user globals     */
static JSValue g_timer_pop_fn;  /* () -> [fn, argsArray, at] | null       */
static JSValue g_timer_count_fn;/* () -> int                              */
static JSValue g_rejected_fn;   /* (reason) -> void (console error)       */
static int g_in_hook;           /* re-entrancy guard for inspect/eval     */
static char g_arg_buf[65536];

/* ------------------------------------------------------------------------ */
static void send_json_value(JSContext *ctx, int kind, JSValueConst val)
{
    JSValue args[1];
    JSValue s;
    const char *cstr;
    size_t len;

    args[0] = (JSValue)val;
    s = JS_Call(ctx, g_ser_fn, JS_UNDEFINED, 1, (JSValueConst *)args);
    if (JS_IsException(s)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        tt_host_out(kind, "null", 4);
        return;
    }
    cstr = JS_ToCStringLen(ctx, &len, s);
    if (cstr) {
        tt_host_out(kind, cstr, (int)len);
        JS_FreeCString(ctx, cstr);
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx));
        tt_host_out(kind, "null", 4);
    }
    JS_FreeValue(ctx, s);
}

/* Send { stack, frames: [locals…], globals } for the paused position. */
static void send_inspection(JSContext *ctx)
{
    JSValue obj = JS_NewObject(ctx);
    JSValue stack = JS_TTBacktrace(ctx);
    JSValue frames = JS_NewArray(ctx);
    JSValue globals;
    int level;
    int64_t nframes = 0;

    JS_DefinePropertyValueStr(ctx, obj, "stack", stack, JS_PROP_C_W_E);
    {
        JSValue lenv = JS_GetPropertyStr(ctx, stack, "length");
        JS_ToInt64(ctx, &nframes, lenv);
        JS_FreeValue(ctx, lenv);
    }
    if (nframes > 32) nframes = 32;
    for (level = 0; level < (int)nframes; level++) {
        JS_DefinePropertyValueUint32(ctx, frames, level, JS_TTLocals(ctx, level), JS_PROP_C_W_E);
    }
    JS_DefinePropertyValueStr(ctx, obj, "frames", frames, JS_PROP_C_W_E);
    globals = JS_Call(ctx, g_globals_fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(globals)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        globals = JS_NewObject(ctx);
    }
    JS_DefinePropertyValueStr(ctx, obj, "globals", globals, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "lexicals", JS_TTGlobalLexicals(ctx), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "__ttInspect", JS_TRUE, 0);
    send_json_value(ctx, 1, obj);
    JS_FreeValue(ctx, obj);
}

/* Evaluate a console expression at the paused position. The innermost
   frame's locals are made visible through a sloppy-mode `with` around a
   direct eval; the step hook is disabled so the evaluation is atomic. */
static const char EVAL_WRAPPER_SRC[] =
    "(function (__ttL, __ttSrc) { with (__ttL) { return eval(__ttSrc); } })";

static void eval_at_pause_mode(JSContext *ctx, int write_back)
{
    int len = tt_host_arg(g_arg_buf, (int)sizeof(g_arg_buf) - 1);
    JSValue v, env, args[2];
    const char *cstr;
    size_t slen;

    if (len <= 0 || len >= (int)sizeof(g_arg_buf)) {
        tt_host_out(2, "null", 4);
        return;
    }
    g_arg_buf[len] = 0;
    {
        JSValue wrapper = JS_Eval(ctx, EVAL_WRAPPER_SRC, sizeof(EVAL_WRAPPER_SRC) - 1,
                                  "<console-scope>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(wrapper)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            v = JS_Eval(ctx, g_arg_buf, len, "<console>", JS_EVAL_TYPE_GLOBAL);
        } else {
            JSValue callArgs[2];
            callArgs[0] = JS_TTLocals(ctx, 0);
            callArgs[1] = JS_NewStringLen(ctx, g_arg_buf, len);
            v = JS_Call(ctx, wrapper, JS_UNDEFINED, 2, (JSValueConst *)callArgs);
            if (write_back && !JS_IsException(v)) {
                /* rebindings made by the edit live on the scope object —
                   push them into the real frame slots */
                JSPropertyEnum *tab;
                uint32_t n, i;
                if (!JS_GetOwnPropertyNames(ctx, &tab, &n, callArgs[0],
                                            JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
                    for (i = 0; i < n; i++) {
                        JSValue pv = JS_GetProperty(ctx, callArgs[0], tab[i].atom);
                        if (!JS_IsException(pv)) {
                            JS_TTSetLocal(ctx, 0, tab[i].atom, pv);
                            JS_FreeValue(ctx, pv);
                        } else {
                            JS_FreeValue(ctx, JS_GetException(ctx));
                        }
                    }
                    JS_FreePropertyEnum(ctx, tab, n);
                }
            }
            JS_FreeValue(ctx, callArgs[0]);
            JS_FreeValue(ctx, callArgs[1]);
            JS_FreeValue(ctx, wrapper);
        }
    }
    if (JS_IsException(v)) {
        args[0] = JS_TRUE;
        args[1] = JS_GetException(ctx);
    } else {
        args[0] = JS_FALSE;
        args[1] = v;
    }
    env = JS_Call(ctx, g_envelope_fn, JS_UNDEFINED, 2, (JSValueConst *)args);
    JS_FreeValue(ctx, args[1]);
    if (JS_IsException(env)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        tt_host_out(2, "null", 4);
        return;
    }
    cstr = JS_ToCStringLen(ctx, &slen, env);
    if (cstr) {
        tt_host_out(2, cstr, (int)slen);
        JS_FreeCString(ctx, cstr);
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx));
        tt_host_out(2, "null", 4);
    }
    JS_FreeValue(ctx, env);
}

static void eval_at_pause(JSContext *ctx)
{
    eval_at_pause_mode(ctx, 0);
}

/* The step handler: one host round-trip per command; tt_host_step may
   suspend for as long as the debugger is parked here. */
static int tt_step_handler(JSContext *ctx, int line, int col, int depth, void *opaque)
{
    (void)opaque;
    if (g_in_hook)
        return 0;
    for (;;) {
        int cmd = tt_host_step(line, col, depth);
        switch (cmd) {
        case TT_CMD_CONTINUE:
            return 0;
        case TT_CMD_ABORT:
            return 1;
        case TT_CMD_INSPECT:
            g_in_hook = 1;
            JS_TTEnableStep(g_rt, 0);
            send_inspection(ctx);
            JS_TTEnableStep(g_rt, 1);
            g_in_hook = 0;
            break;
        case TT_CMD_EVAL:
            g_in_hook = 1;
            JS_TTEnableStep(g_rt, 0);
            eval_at_pause(ctx);
            JS_TTEnableStep(g_rt, 1);
            g_in_hook = 0;
            break;
        case TT_CMD_INSPECT_ABORT:
            /* transactional one-shot: never suspends this activation again */
            g_in_hook = 1;
            JS_TTEnableStep(g_rt, 0);
            send_inspection(ctx);
            JS_TTEnableStep(g_rt, 1);
            g_in_hook = 0;
            return 1;
        case TT_CMD_EVAL_ABORT:
            g_in_hook = 1;
            JS_TTEnableStep(g_rt, 0);
            eval_at_pause(ctx);
            JS_TTEnableStep(g_rt, 1);
            g_in_hook = 0;
            return 1;
        case TT_CMD_EVAL_CONTINUE:
            /* timeline fork: apply the edit (with local write-back), then
               let execution continue — the next hook suspends normally */
            g_in_hook = 1;
            JS_TTEnableStep(g_rt, 0);
            eval_at_pause_mode(ctx, 1);
            JS_TTEnableStep(g_rt, 1);
            g_in_hook = 0;
            return 0;
        default:
            return 0;
        }
    }
}

static int tt_interrupt_handler(JSRuntime *rt, void *opaque)
{
    (void)rt;
    (void)opaque;
    return tt_host_interrupt();
}

static void tt_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                 JSValueConst reason, JS_BOOL is_handled, void *opaque)
{
    JSValue args[1];
    JSValue r;
    (void)promise;
    (void)opaque;
    if (is_handled)
        return;
    args[0] = (JSValue)reason;
    r = JS_Call(ctx, g_rejected_fn, JS_UNDEFINED, 1, (JSValueConst *)args);
    if (JS_IsException(r))
        JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeValue(ctx, r);
}

/* console bridge: level + pre-serialized JSON parts from the setup script */
static JSValue js_tt_console(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t level = 0;
    const char *json;
    size_t len;
    (void)this_val;
    if (argc < 2)
        return JS_UNDEFINED;
    JS_ToInt32(ctx, &level, argv[0]);
    json = JS_ToCStringLen(ctx, &len, argv[1]);
    if (json) {
        tt_host_out(0, json, (int)len);
        JS_FreeCString(ctx, json);
    }
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------------ */
/* Support runtime evaluated once at init (stepping disabled). Everything is
   captured into C-held references; user programs see only the intended
   globals (console, setTimeout, …). No user code is ever transformed. */
static const char SETUP_SRC[] =
"(function () {\n"
"  'use strict';\n"
"  const MAXD = 4, MAXI = 40, MAXK = 40, MAXS = 200;\n"
"  function className(v) {\n"
"    try {\n"
"      const p = Object.getPrototypeOf(v);\n"
"      if (p === null) return 'Object';\n"
"      const n = p.constructor && p.constructor.name;\n"
"      return n && n !== 'Object' ? n : '';\n"
"    } catch (e) { return ''; }\n"
"  }\n"
"  function ser(v, depth, seen) {\n"
"    const t = typeof v;\n"
"    if (v === null) return { t: 'null' };\n"
"    if (t === 'undefined') return { t: 'undef' };\n"
"    if (t === 'number') {\n"
"      if (v !== v) return { t: 'nan' };\n"
"      if (v === Infinity) return { t: 'num', v: 'Infinity', special: true };\n"
"      if (v === -Infinity) return { t: 'num', v: '-Infinity', special: true };\n"
"      return { t: 'num', v: v };\n"
"    }\n"
"    if (t === 'boolean') return { t: 'bool', v: v };\n"
"    if (t === 'bigint') return { t: 'bigint', v: String(v) };\n"
"    if (t === 'string') return v.length > MAXS ? { t: 'str', v: v.slice(0, MAXS), trunc: v.length } : { t: 'str', v: v };\n"
"    if (t === 'symbol') return { t: 'sym', v: String(v) };\n"
"    if (t === 'function') return { t: 'fn', name: v.name || '' };\n"
"    if (seen.indexOf(v) >= 0) return { t: 'ref' };\n"
"    if (depth <= 0) return { t: 'more', cls: className(v) };\n"
"    seen.push(v);\n"
"    try {\n"
"      if (Array.isArray(v)) {\n"
"        const items = [];\n"
"        const lim = Math.min(v.length, MAXI);\n"
"        for (let i = 0; i < lim; i++) items.push(i in v ? ser(v[i], depth - 1, seen) : { t: 'hole' });\n"
"        return { t: 'arr', n: v.length, items: items, more: v.length > lim };\n"
"      }\n"
"      if (v instanceof Date) return { t: 'date', v: 'virtual+' + v.getTime() + 'ms' };\n"
"      if (v instanceof RegExp) return { t: 'regexp', v: String(v) };\n"
"      if (v instanceof Error) return { t: 'error', name: v.name, msg: String(v.message) };\n"
"      if (v instanceof Map) {\n"
"        const entries = [];\n"
"        let i = 0;\n"
"        for (const [k, val] of v) { if (i++ >= 20) break; entries.push([ser(k, depth - 1, seen), ser(val, depth - 1, seen)]); }\n"
"        return { t: 'map', n: v.size, entries: entries, more: v.size > 20 };\n"
"      }\n"
"      if (v instanceof Set) {\n"
"        const items = [];\n"
"        let i = 0;\n"
"        for (const val of v) { if (i++ >= 20) break; items.push(ser(val, depth - 1, seen)); }\n"
"        return { t: 'set', n: v.size, items: items, more: v.size > 20 };\n"
"      }\n"
"      if (ArrayBuffer.isView(v)) {\n"
"        const n = v.length === undefined ? 0 : v.length;\n"
"        const lim = Math.min(n, 20);\n"
"        const items = [];\n"
"        for (let i = 0; i < lim; i++) items.push(v[i]);\n"
"        return { t: 'typed', cls: className(v), n: n, items: items, more: n > lim };\n"
"      }\n"
"      const props = [];\n"
"      const keys = Object.keys(v);\n"
"      const lim = Math.min(keys.length, MAXK);\n"
"      for (let k = 0; k < lim; k++) {\n"
"        const key = keys[k];\n"
"        const desc = Object.getOwnPropertyDescriptor(v, key);\n"
"        if (desc && desc.get) props.push([key, { t: 'getter' }]);\n"
"        else if (desc) props.push([key, ser(desc.value, depth - 1, seen)]);\n"
"      }\n"
"      return { t: 'obj', cls: className(v), props: props, more: keys.length > lim };\n"
"    } finally { seen.pop(); }\n"
"  }\n"
"  function serTop(value) {\n"
"    if (value && value.__ttInspect) {\n"
"      const out = { stack: value.stack, frames: [], globals: [] };\n"
"      for (const frame of value.frames) {\n"
"        const locals = [];\n"
"        const tdz = frame['<uninitialized>'] || [];\n"
"        for (const key of Object.keys(frame)) {\n"
"          if (key === '<uninitialized>') continue;\n"
"          locals.push([key, ser(frame[key], MAXD, [])]);\n"
"        }\n"
"        for (const name of tdz) locals.push([name, { t: 'tdz' }]);\n"
"        out.frames.push(locals);\n"
"      }\n"
"      for (const key of Object.keys(value.globals)) out.globals.push([key, ser(value.globals[key], 3, [])]);\n"
"      if (value.lexicals) {\n"
"        const seenNames = new Set(out.globals.map((g) => g[0]));\n"
"        const ltdz = value.lexicals['<uninitialized>'] || [];\n"
"        for (const key of Object.keys(value.lexicals)) {\n"
"          if (key === '<uninitialized>' || seenNames.has(key)) continue;\n"
"          out.globals.push([key, ser(value.lexicals[key], 3, [])]);\n"
"        }\n"
"        for (const name of ltdz) if (!seenNames.has(name)) out.globals.push([name, { t: 'tdz' }]);\n"
"      }\n"
"      return JSON.stringify(out);\n"
"    }\n"
"    return JSON.stringify(ser(value, MAXD, []));\n"
"  }\n"
"  const G = globalThis;\n"
"  const natConsole = G.__tt_nat_console;\n"
"  delete G.__tt_nat_console;\n"
"  function consoleOut(level, args) {\n"
"    const parts = [];\n"
"    for (let i = 0; i < args.length; i++) parts.push(ser(args[i], 3, []));\n"
"    natConsole(level, JSON.stringify({ level: level, parts: parts }));\n"
"  }\n"
"  G.console = {\n"
"    log: function () { consoleOut(0, arguments); },\n"
"    info: function () { consoleOut(1, arguments); },\n"
"    warn: function () { consoleOut(2, arguments); },\n"
"    error: function () { consoleOut(3, arguments); },\n"
"    debug: function () { consoleOut(0, arguments); },\n"
"    trace: function () { consoleOut(0, arguments); },\n"
"    assert: function (cond) { if (!cond) consoleOut(3, ['Assertion failed'].concat(Array.prototype.slice.call(arguments, 1))); },\n"
"  };\n"
"  let timerSeq = 1;\n"
"  const timers = [];\n"
"  G.setTimeout = function (fn, ms) {\n"
"    if (typeof fn !== 'function') return 0;\n"
"    const id = timerSeq++;\n"
"    timers.push({ id: id, fn: fn, at: Date.now() + (ms > 0 ? Math.floor(ms) : 0), args: Array.prototype.slice.call(arguments, 2) });\n"
"    return id;\n"
"  };\n"
"  G.clearTimeout = function (id) {\n"
"    for (let i = 0; i < timers.length; i++) if (timers[i].id === id) { timers.splice(i, 1); return; }\n"
"  };\n"
"  G.setInterval = function () { throw new Error('setInterval is not supported (use setTimeout)'); };\n"
"  G.clearInterval = G.clearTimeout;\n"
"  G.queueMicrotask = function (fn) { Promise.resolve().then(fn); };\n"
"  G.performance = { now: function () { return Date.now(); } };\n"
"  const baseline = new Set(Object.getOwnPropertyNames(G));\n"
"  function timerCount() { return timers.length; }\n"
"  function timerPop() {\n"
"    if (!timers.length) return null;\n"
"    let best = 0;\n"
"    for (let i = 1; i < timers.length; i++) {\n"
"      if (timers[i].at < timers[best].at || (timers[i].at === timers[best].at && timers[i].id < timers[best].id)) best = i;\n"
"    }\n"
"    const t = timers.splice(best, 1)[0];\n"
"    return [t.fn, t.args, t.at];\n"
"  }\n"
"  function userGlobals() {\n"
"    const out = {};\n"
"    for (const name of Object.getOwnPropertyNames(G)) {\n"
"      if (baseline.has(name)) continue;\n"
"      try { out[name] = G[name]; } catch (e) {}\n"
"    }\n"
"    return out;\n"
"  }\n"
"  function envelope(isError, value) {\n"
"    return JSON.stringify(isError ? { error: ser(value, MAXD, []) } : { ok: ser(value, MAXD, []) });\n"
"  }\n"
"  function rejected(reason) { consoleOut(3, ['Unhandled promise rejection:', reason]); }\n"
"  return { serTop: serTop, envelope: envelope, userGlobals: userGlobals, timerCount: timerCount, timerPop: timerPop, rejected: rejected };\n"
"})()\n";

/* ------------------------------------------------------------------------ */
EXPORT("tt_init") int tt_init(void)
{
    JSValue setup, glob, natfn;

    JS_TTSetVirtualTime(0, 1); /* must precede context creation (random seed) */
    g_rt = JS_NewRuntime();
    if (!g_rt)
        return 1;
    JS_SetMemoryLimit(g_rt, 192 * 1024 * 1024);
    JS_SetMaxStackSize(g_rt, 384 * 1024);
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx)
        return 2;

    glob = JS_GetGlobalObject(g_ctx);
    natfn = JS_NewCFunction(g_ctx, js_tt_console, "__tt_nat_console", 2);
    JS_SetPropertyStr(g_ctx, glob, "__tt_nat_console", natfn);
    JS_FreeValue(g_ctx, glob);

    setup = JS_Eval(g_ctx, SETUP_SRC, sizeof(SETUP_SRC) - 1, "tt-setup.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(setup))
        return 3;
    g_ser_fn = JS_GetPropertyStr(g_ctx, setup, "serTop");
    g_envelope_fn = JS_GetPropertyStr(g_ctx, setup, "envelope");
    g_globals_fn = JS_GetPropertyStr(g_ctx, setup, "userGlobals");
    g_timer_count_fn = JS_GetPropertyStr(g_ctx, setup, "timerCount");
    g_timer_pop_fn = JS_GetPropertyStr(g_ctx, setup, "timerPop");
    g_rejected_fn = JS_GetPropertyStr(g_ctx, setup, "rejected");
    JS_FreeValue(g_ctx, setup);

    JS_TTSetStepHandler(g_rt, tt_step_handler, NULL);
    JS_TTSetStepFilename(g_ctx, "program.js");
    JS_SetInterruptHandler(g_rt, tt_interrupt_handler, NULL);
    JS_SetHostPromiseRejectionTracker(g_rt, tt_rejection_tracker, NULL);
    return 0;
}

/* Run the user program. May suspend at any step. On real completion emits
   kind=3 with { ok } | { error }. The code buffer must stay valid (and
   untouched) for the whole run, including across suspensions. */
EXPORT("tt_eval") void tt_eval(const char *code, int len)
{
    JSValue v, env, args[2];
    const char *cstr;
    size_t slen;

    JS_TTEnableStep(g_rt, 1);
    v = JS_Eval(g_ctx, code, len, "program.js", JS_EVAL_TYPE_GLOBAL);
    JS_TTEnableStep(g_rt, 0);
    if (JS_IsException(v)) {
        args[0] = JS_TRUE;
        args[1] = JS_GetException(g_ctx);
    } else {
        args[0] = JS_FALSE;
        args[1] = v;
    }
    env = JS_Call(g_ctx, g_envelope_fn, JS_UNDEFINED, 2, (JSValueConst *)args);
    JS_FreeValue(g_ctx, args[1]);
    cstr = JS_ToCStringLen(g_ctx, &slen, env);
    if (cstr) {
        tt_host_out(3, cstr, (int)slen);
        JS_FreeCString(g_ctx, cstr);
    } else {
        JS_FreeValue(g_ctx, JS_GetException(g_ctx));
        tt_host_out(3, "null", 4);
    }
    JS_FreeValue(g_ctx, env);
}

/* Run pending promise jobs (each job is steppable). Emits kind=4 when done. */
EXPORT("tt_run_jobs") void tt_run_jobs(void)
{
    JSContext *ctx1;
    int count = 0, err;
    char buf[64];

    JS_TTEnableStep(g_rt, 1);
    for (;;) {
        err = JS_ExecutePendingJob(g_rt, &ctx1);
        if (err <= 0) {
            if (err < 0)
                JS_FreeValue(ctx1, JS_GetException(ctx1));
            break;
        }
        count++;
        if (count > 10000)
            break;
    }
    JS_TTEnableStep(g_rt, 0);
    snprintf(buf, sizeof(buf), "{\"jobs\":%d}", count);
    tt_host_out(4, buf, (int)strlen(buf));
}

EXPORT("tt_timer_count") int tt_timer_count(void)
{
    JSValue v;
    int32_t n = 0;
    v = JS_Call(g_ctx, g_timer_count_fn, JS_UNDEFINED, 0, NULL);
    JS_ToInt32(g_ctx, &n, v);
    JS_FreeValue(g_ctx, v);
    return n;
}

/* Fire the next due virtual timer (steppable). Emits kind=5 when done with
   { line: <registration unknown → 0>, at } or { idle: true }. */
EXPORT("tt_fire_timer") void tt_fire_timer(void)
{
    JSValue tuple, fn, fnargs, atv, r;
    double at = 0;
    int64_t i, alen = 0;
    JSValue argbuf[8];
    char buf[96];

    tuple = JS_Call(g_ctx, g_timer_pop_fn, JS_UNDEFINED, 0, NULL);
    if (!JS_IsObject(tuple)) {
        JS_FreeValue(g_ctx, tuple);
        tt_host_out(5, "{\"idle\":true}", 13);
        return;
    }
    fn = JS_GetPropertyUint32(g_ctx, tuple, 0);
    fnargs = JS_GetPropertyUint32(g_ctx, tuple, 1);
    atv = JS_GetPropertyUint32(g_ctx, tuple, 2);
    JS_ToFloat64(g_ctx, &at, atv);
    JS_FreeValue(g_ctx, atv);
    JS_FreeValue(g_ctx, tuple);

    if (at > JS_TTGetVirtualTime())
        JS_TTSetVirtualTime(at, 1);

    {
        JSValue lenv = JS_GetPropertyStr(g_ctx, fnargs, "length");
        JS_ToInt64(g_ctx, &alen, lenv);
        JS_FreeValue(g_ctx, lenv);
    }
    if (alen > 8) alen = 8;
    for (i = 0; i < alen; i++)
        argbuf[i] = JS_GetPropertyUint32(g_ctx, fnargs, (uint32_t)i);

    JS_TTEnableStep(g_rt, 1);
    r = JS_Call(g_ctx, fn, JS_UNDEFINED, (int)alen, (JSValueConst *)argbuf);
    JS_TTEnableStep(g_rt, 0);
    if (JS_IsException(r)) {
        JSValue exc = JS_GetException(g_ctx);
        JSValue args2[1];
        JSValue rr;
        args2[0] = exc;
        rr = JS_Call(g_ctx, g_rejected_fn, JS_UNDEFINED, 1, (JSValueConst *)args2);
        JS_FreeValue(g_ctx, rr);
        JS_FreeValue(g_ctx, exc);
    }
    JS_FreeValue(g_ctx, r);
    for (i = 0; i < alen; i++)
        JS_FreeValue(g_ctx, argbuf[i]);
    JS_FreeValue(g_ctx, fn);
    JS_FreeValue(g_ctx, fnargs);
    snprintf(buf, sizeof(buf), "{\"at\":%.0f}", at);
    tt_host_out(5, buf, (int)strlen(buf));
}

EXPORT("tt_pending_jobs") int tt_pending_jobs(void)
{
    return JS_IsJobPending(g_rt);
}

EXPORT("tt_vtime") double tt_vtime_get(void)
{
    return JS_TTGetVirtualTime();
}

/* Inspection for the idle (finished) position: globals only, no frames. */
EXPORT("tt_inspect_idle") void tt_inspect_idle(void)
{
    JSValue obj = JS_NewObject(g_ctx);
    JSValue globals;
    JS_DefinePropertyValueStr(g_ctx, obj, "stack", JS_NewArray(g_ctx), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(g_ctx, obj, "frames", JS_NewArray(g_ctx), JS_PROP_C_W_E);
    globals = JS_Call(g_ctx, g_globals_fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(globals)) {
        JS_FreeValue(g_ctx, JS_GetException(g_ctx));
        globals = JS_NewObject(g_ctx);
    }
    JS_DefinePropertyValueStr(g_ctx, obj, "globals", globals, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(g_ctx, obj, "lexicals", JS_TTGlobalLexicals(g_ctx), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(g_ctx, obj, "__ttInspect", JS_TRUE, 0);
    send_json_value(g_ctx, 1, obj);
    JS_FreeValue(g_ctx, obj);
}

/* Console evaluation against the idle (finished) state. */
EXPORT("tt_eval_idle") void tt_eval_idle(void)
{
    eval_at_pause(g_ctx);
}

/* Fresh context for a new debugging session (the runtime survives). */
EXPORT("tt_reset") int tt_reset(void)
{
    JSValue setup, glob, natfn;

    JS_FreeValue(g_ctx, g_ser_fn);
    JS_FreeValue(g_ctx, g_envelope_fn);
    JS_FreeValue(g_ctx, g_globals_fn);
    JS_FreeValue(g_ctx, g_timer_count_fn);
    JS_FreeValue(g_ctx, g_timer_pop_fn);
    JS_FreeValue(g_ctx, g_rejected_fn);
    JS_FreeContext(g_ctx);
    JS_TTSetVirtualTime(0, 1);
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx)
        return 2;
    JS_TTResetExecState(g_ctx);
    glob = JS_GetGlobalObject(g_ctx);
    natfn = JS_NewCFunction(g_ctx, js_tt_console, "__tt_nat_console", 2);
    JS_SetPropertyStr(g_ctx, glob, "__tt_nat_console", natfn);
    JS_FreeValue(g_ctx, glob);
    setup = JS_Eval(g_ctx, SETUP_SRC, sizeof(SETUP_SRC) - 1, "tt-setup.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(setup))
        return 3;
    g_ser_fn = JS_GetPropertyStr(g_ctx, setup, "serTop");
    g_envelope_fn = JS_GetPropertyStr(g_ctx, setup, "envelope");
    g_globals_fn = JS_GetPropertyStr(g_ctx, setup, "userGlobals");
    g_timer_count_fn = JS_GetPropertyStr(g_ctx, setup, "timerCount");
    g_timer_pop_fn = JS_GetPropertyStr(g_ctx, setup, "timerPop");
    g_rejected_fn = JS_GetPropertyStr(g_ctx, setup, "rejected");
    JS_FreeValue(g_ctx, setup);
    JS_TTSetStepFilename(g_ctx, "program.js");
    return 0;
}

EXPORT("tt_alloc") void *tt_alloc(int n) { return malloc((size_t)n); }
EXPORT("tt_free") void tt_free(void *p) { free(p); }
