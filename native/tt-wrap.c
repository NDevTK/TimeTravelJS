/*
 * TimeTravelJS wasm embedder.
 *
 * Exports a small API around a rewritten (stackless) QuickJS build. The
 * step hook fires per source line — or per opcode in microscope mode. Two
 * suspension paths, one invariant (a snapshot IS a resumable machine):
 *
 *  - park by return: interpreter frames live in a linear-memory arena, so
 *    when only the dispatch loop is on the C stack the machine suspends by
 *    returning from the export (tt_eval/tt_resume return 1). Inspection and
 *    evaluation against a parked machine are plain calls.
 *
 *  - suppressed steps: user code invoked synchronously from inside an
 *    unconverted C builtin (accessors reached from C paths, proxy traps,
 *    toPrimitive coercions, async generators) executes normally but cannot
 *    become a snapshot; such steps are counted (tt_suppressed) instead.
 */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "quickjs.h"

#define EXPORT(name) __attribute__((export_name(name), used))
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

/* host imports ----------------------------------------------------------- */
/* Synchronous out-of-band channel: kind 0=console 1=inspect 2=eval-result
   3=eval-done 4=jobs-done 5=timer-done */
IMPORT("tt_host_out") extern void tt_host_out(int kind, const char *ptr, int len);
/* Synchronous: copy the staged command payload (eval source) into dst,
   returns its UTF-8 length (or 0). */
IMPORT("tt_host_arg") extern int tt_host_arg(char *dst, int cap);
/* Synchronous watchdog for code running between step points. */
IMPORT("tt_host_interrupt") extern int tt_host_interrupt(void);

/* tt-dom.c: the Lexbor layer (same linear memory, so the DOM time-travels
   through the ordinary COW snapshots) */
void tt_dom_register(JSContext *ctx);
int tt_dom_load_html(const char *html, size_t len);
void tt_dom_destroy(void);

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
static JSValue g_rejected_fn;
static JSValue g_dom_build_fn;   /* (reason) -> void (console error)       */
static JSValue g_set_url_fn;     /* (href) -> void — session location init */
static int g_in_hook;           /* re-entrancy guard for inspect/eval     */
static char g_arg_buf[65536];

/* What kind of activation is currently parked/being driven — decides what
   tt_resume does after the parked frame completes. */
enum { TT_EXEC_SCRIPT = 0, TT_EXEC_JOBS = 1, TT_EXEC_TIMER = 2 };
static int g_exec_kind;
static int g_jobs_count;
static int pump_jobs_loop(void);
static int timer_finish(JSValue r);

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

/* Park-by-return bookkeeping: when the interpreter says the machine can
   suspend by simply returning (stackless path — no C frames below the
   dispatch loop), we take that route and let the host read the step info
   from these statics. */
static int g_park_line, g_park_col, g_park_depth;

EXPORT("tt_park_line") int tt_park_line(void) { return g_park_line; }
EXPORT("tt_park_col") int tt_park_col(void) { return g_park_col; }
EXPORT("tt_park_depth") int tt_park_depth(void) { return g_park_depth; }

/* Steps that fire while the machine is not parkable (user code invoked
   synchronously from inside an unconverted C builtin: accessors reached
   from C paths, proxy traps, toPrimitive coercions, async generators).
   With Asyncify gone these cannot become snapshots — they execute
   normally, tick virtual time, and are counted here for the host. */
static int g_suppressed;

EXPORT("tt_suppressed") int tt_suppressed(void) { return g_suppressed; }

/* The step handler: park by return when the interpreter allows it;
   otherwise count the step as suppressed and continue. */
static int tt_step_handler(JSContext *ctx, int line, int col, int depth,
                           int parkable, void *opaque)
{
    (void)opaque;
    (void)ctx;
    if (g_in_hook)
        return 0;
    if (parkable) {
        g_park_line = line;
        g_park_col = col;
        g_park_depth = depth;
        return 2;
    }
    (void)line;
    (void)col;
    (void)depth;
    g_suppressed++;
    return 0;
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
"    if (DomNode && v instanceof DomNode) {\n"
"      let h = ''; try { h = DOM.serialize(v.__p, 0); } catch (e) {}\n"
"      return { t: 'dom', name: String(DOM.nodeName(v.__p)), html: h.length > 160 ? h.slice(0, 160) + '\u2026' : h };\n"
"    }\n"
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
"      if (DOM && DOM.hasDoc()) out.dom = DOM.serialize(DOM.doc(), 0);\n"
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
"  /* Debug-runtime self-hosted callback builtins: user callbacks run from\n"
"     bytecode, so the stackless interpreter can suspend inside them. Plain\n"
"     arrays with function callbacks take the JS path; anything exotic\n"
"     (thisArg, subclasses, proxies) delegates to the C originals. */\n"
"  (function () {\n"
"    const AP = Array.prototype;\n"
"    const plain = (a) => Array.isArray(a) && Object.getPrototypeOf(a) === AP;\n"
"    const origs = {};\n"
"    for (const n of ['sort', 'forEach', 'map', 'filter', 'some', 'every',\n"
"                     'find', 'findIndex', 'findLast', 'findLastIndex',\n"
"                     'reduce', 'reduceRight']) origs[n] = AP[n];\n"
"    const def = (name, fn) => {\n"
"      Object.defineProperty(fn, 'name', { value: name, configurable: true });\n"
"      Object.defineProperty(fn, 'length', { value: origs[name].length, configurable: true });\n"
"      Object.defineProperty(AP, name, { value: fn, writable: true, configurable: true });\n"
"    };\n"
"    const bail = (name, self, args) => origs[name].apply(self, args);\n"
"    def('forEach', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('forEach', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      for (let i = 0; i < n; i++) if (i in this) cb(this[i], i, this);\n"
"    });\n"
"    def('map', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('map', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      const out = new Array(n);\n"
"      for (let i = 0; i < n; i++) if (i in this) out[i] = cb(this[i], i, this);\n"
"      return out;\n"
"    });\n"
"    def('filter', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('filter', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      const out = [];\n"
"      for (let i = 0; i < n; i++) if (i in this) { const v = this[i]; if (cb(v, i, this)) out[out.length] = v; }\n"
"      return out;\n"
"    });\n"
"    def('some', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('some', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      for (let i = 0; i < n; i++) if (i in this && cb(this[i], i, this)) return true;\n"
"      return false;\n"
"    });\n"
"    def('every', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('every', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      for (let i = 0; i < n; i++) if (i in this && !cb(this[i], i, this)) return false;\n"
"      return true;\n"
"    });\n"
"    def('find', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('find', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      for (let i = 0; i < n; i++) { const v = this[i]; if (cb(v, i, this)) return v; }\n"
"      return undefined;\n"
"    });\n"
"    def('findIndex', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('findIndex', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      for (let i = 0; i < n; i++) if (cb(this[i], i, this)) return i;\n"
"      return -1;\n"
"    });\n"
"    def('findLast', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('findLast', this, arguments);\n"
"      for (let i = (this.length >>> 0) - 1; i >= 0; i--) { const v = this[i]; if (cb(v, i, this)) return v; }\n"
"      return undefined;\n"
"    });\n"
"    def('findLastIndex', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('findLastIndex', this, arguments);\n"
"      for (let i = (this.length >>> 0) - 1; i >= 0; i--) if (cb(this[i], i, this)) return i;\n"
"      return -1;\n"
"    });\n"
"    def('reduce', function (cb, init) {\n"
"      if (!plain(this) || typeof cb !== 'function') return bail('reduce', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      let acc, i = 0, has = arguments.length >= 2;\n"
"      if (has) { acc = init; } else {\n"
"        for (; i < n; i++) if (i in this) { acc = this[i]; i++; has = true; break; }\n"
"        if (!has) throw new TypeError('reduce of empty array with no initial value');\n"
"      }\n"
"      for (; i < n; i++) if (i in this) acc = cb(acc, this[i], i, this);\n"
"      return acc;\n"
"    });\n"
"    def('reduceRight', function (cb, init) {\n"
"      if (!plain(this) || typeof cb !== 'function') return bail('reduceRight', this, arguments);\n"
"      let i = (this.length >>> 0) - 1, acc, has = arguments.length >= 2;\n"
"      if (has) { acc = init; } else {\n"
"        for (; i >= 0; i--) if (i in this) { acc = this[i]; i--; has = true; break; }\n"
"        if (!has) throw new TypeError('reduce of empty array with no initial value');\n"
"      }\n"
"      for (; i >= 0; i--) if (i in this) acc = cb(acc, this[i], i, this);\n"
"      return acc;\n"
"    });\n"
"    def('sort', function (cmp) {\n"
"      if (cmp !== undefined && typeof cmp !== 'function') throw new TypeError('not a function');\n"
"      if (!plain(this) || cmp === undefined) return bail('sort', this, arguments);\n"
"      const n = this.length >>> 0;\n"
"      const items = [];\n"
"      let undef = 0, holes = 0;\n"
"      for (let i = 0; i < n; i++) {\n"
"        if (!(i in this)) { holes++; continue; }\n"
"        const v = this[i];\n"
"        if (v === undefined) { undef++; continue; }\n"
"        items[items.length] = v;\n"
"      }\n"
"      /* stable merge sort; SortCompare: NaN → 0 */\n"
"      const m = items.length;\n"
"      const tmp = new Array(m);\n"
"      const sc = (x, y) => { const r = +cmp(x, y); return r === r ? r : 0; };\n"
"      for (let w = 1; w < m; w *= 2) {\n"
"        for (let lo = 0; lo < m - w; lo += 2 * w) {\n"
"          const mid = lo + w, hi = Math.min(lo + 2 * w, m);\n"
"          let i = lo, j = mid, k = lo;\n"
"          while (i < mid && j < hi) tmp[k++] = sc(items[i], items[j]) <= 0 ? items[i++] : items[j++];\n"
"          while (i < mid) tmp[k++] = items[i++];\n"
"          while (j < hi) tmp[k++] = items[j++];\n"
"          for (let t = lo; t < hi; t++) items[t] = tmp[t];\n"
"        }\n"
"      }\n"
"      let k = 0;\n"
"      for (; k < m; k++) this[k] = items[k];\n"
"      for (let u = 0; u < undef; u++) this[k++] = undefined;\n"
"      for (let h = 0; h < holes; h++) delete this[k++];\n"
"      return this;\n"
"    });\n"
"  })();\n"
"  /* More debug-runtime self-hosts: user callbacks and coercions run from\n"
"     bytecode so the stackless interpreter can suspend inside them. */\n"
"  (function () {\n"
"    const AP = Array.prototype;\n"
"    const SP = String.prototype;\n"
"    const plain = (a) => Array.isArray(a) && Object.getPrototypeOf(a) === AP;\n"
"    const origSort = AP.sort, origJoin = AP.join, origFlat = AP.flat,\n"
"          origFrom = Array.from, origReplace = SP.replace, origReplaceAll = SP.replaceAll,\n"
"          origStringify = JSON.stringify, origParse = JSON.parse;\n"
"    const OrigString = String;\n"
"    /* exact ToString: String(v) for non-symbols (the engine coerces the\n"
"       object argument in-loop, so user toString parks); symbols throw */\n"
"    const toStr = (v) => {\n"
"      if (typeof v === 'symbol') throw new TypeError('cannot convert symbol to string');\n"
"      return OrigString(v);\n"
"    };\n"
"    const dp = (o, n, fn, len) => {\n"
"      Object.defineProperty(fn, 'name', { value: n, configurable: true });\n"
"      Object.defineProperty(fn, 'length', { value: len, configurable: true });\n"
"      Object.defineProperty(o, n, { value: fn, writable: true, configurable: true });\n"
"    };\n"
"    /* default sort: SortCompare does ToString from bytecode */\n"
"    dp(AP, 'sort', function (cmp) {\n"
"      if (cmp !== undefined && typeof cmp !== 'function') throw new TypeError('not a function');\n"
"      if (!plain(this)) return origSort.apply(this, arguments);\n"
"      const sc = cmp !== undefined ? cmp : (x, y) => {\n"
"        const xs = toStr(x), ys = toStr(y);\n"
"        return xs < ys ? -1 : xs > ys ? 1 : 0;\n"
"      };\n"
"      const n = this.length >>> 0;\n"
"      const items = [];\n"
"      let undef = 0, holes = 0;\n"
"      for (let i = 0; i < n; i++) {\n"
"        if (!(i in this)) { holes++; continue; }\n"
"        const v = this[i];\n"
"        if (v === undefined) { undef++; continue; }\n"
"        items[items.length] = v;\n"
"      }\n"
"      const m = items.length, tmp = new Array(m);\n"
"      const c2 = (x, y) => { const r = +sc(x, y); return r === r ? r : 0; };\n"
"      for (let w = 1; w < m; w *= 2) {\n"
"        for (let lo = 0; lo < m - w; lo += 2 * w) {\n"
"          const mid = lo + w, hi = Math.min(lo + 2 * w, m);\n"
"          let i = lo, j = mid, k = lo;\n"
"          while (i < mid && j < hi) tmp[k++] = c2(items[i], items[j]) <= 0 ? items[i++] : items[j++];\n"
"          while (i < mid) tmp[k++] = items[i++];\n"
"          while (j < hi) tmp[k++] = items[j++];\n"
"          for (let t = lo; t < hi; t++) items[t] = tmp[t];\n"
"        }\n"
"      }\n"
"      let k = 0;\n"
"      for (; k < m; k++) this[k] = items[k];\n"
"      for (let u = 0; u < undef; u++) this[k++] = undefined;\n"
"      for (let h = 0; h < holes; h++) delete this[k++];\n"
"      return this;\n"
"    }, 1);\n"
"    dp(AP, 'join', function (sep) {\n"
"      if (!plain(this)) return origJoin.apply(this, arguments);\n"
"      const s = sep === undefined ? ',' : toStr(sep);\n"
"      const n = this.length >>> 0;\n"
"      let out = '';\n"
"      for (let i = 0; i < n; i++) {\n"
"        if (i > 0) out += s;\n"
"        const v = this[i];\n"
"        if (v !== undefined && v !== null) out += toStr(v);\n"
"      }\n"
"      return out;\n"
"    }, 1);\n"
"    dp(AP, 'toString', function () {\n"
"      const j = this.join;\n"
"      if (typeof j === 'function') return j.call(this);\n"
"      return Object.prototype.toString.call(this);\n"
"    }, 0);\n"
"    dp(AP, 'flatMap', function (cb, thisArg) {\n"
"      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) {\n"
"        const mapped = AP.map.apply(this, arguments);\n"
"        return origFlat.call(mapped, 1);\n"
"      }\n"
"      const n = this.length >>> 0;\n"
"      const out = [];\n"
"      for (let i = 0; i < n; i++) {\n"
"        if (!(i in this)) continue;\n"
"        const v = cb(this[i], i, this);\n"
"        if (Array.isArray(v)) { for (let j = 0; j < v.length; j++) out[out.length] = v[j]; }\n"
"        else out[out.length] = v;\n"
"      }\n"
"      return out;\n"
"    }, 1);\n"
"    dp(Array, 'from', function (items, mapFn, thisArg) {\n"
"      if (mapFn !== undefined && typeof mapFn !== 'function') throw new TypeError('not a function');\n"
"      if (this !== Array || thisArg !== undefined) return origFrom.apply(this, arguments);\n"
"      const out = [];\n"
"      if (items === undefined || items === null) return origFrom.apply(this, arguments);\n"
"      const itf = items[Symbol.iterator];\n"
"      if (typeof itf === 'function') {\n"
"        let i = 0;\n"
"        for (const v of items) { out[out.length] = mapFn ? mapFn(v, i) : v; i++; }\n"
"        return out;\n"
"      }\n"
"      const n = Math.floor(Math.max(0, +items.length || 0));\n"
"      for (let i = 0; i < n; i++) { const v = items[i]; out[out.length] = mapFn ? mapFn(v, i) : v; }\n"
"      return out;\n"
"    }, 1);\n"
"    /* JSON.stringify with toJSON/replacer walked from bytecode */\n"
"    dp(JSON, 'stringify', function (value, replacer, space) {\n"
"      let repFn, repList = null;\n"
"      if (typeof replacer === 'function') repFn = replacer;\n"
"      else if (Array.isArray(replacer)) {\n"
"        repList = [];\n"
"        for (const k of replacer) {\n"
"          if (typeof k === 'string') repList[repList.length] = k;\n"
"          else if (typeof k === 'number') repList[repList.length] = '' + k;\n"
"          else if (k instanceof String || k instanceof Number) repList[repList.length] = '' + k;\n"
"        }\n"
"      }\n"
"      const walk = (holder, key) => {\n"
"        let v = holder[key];\n"
"        if (v !== null && (typeof v === 'object' || typeof v === 'bigint')) {\n"
"          const tj = v && v.toJSON;\n"
"          if (typeof tj === 'function') v = tj.call(v, key);\n"
"        }\n"
"        if (repFn) v = repFn.call(holder, key, v);\n"
"        if (v !== null && typeof v === 'object' && !(v instanceof Boolean) && !(v instanceof Number) && !(v instanceof String)) {\n"
"          if (Array.isArray(v)) {\n"
"            const out = new Array(v.length);\n"
"            for (let i = 0; i < v.length; i++) { const w = walk(v, i); out[i] = w === undefined ? null : w; }\n"
"            return out;\n"
"          }\n"
"          const out = {};\n"
"          const keys = repList !== null ? repList : Object.keys(v);\n"
"          for (const k of keys) {\n"
"            if (!(k in v) && repList !== null) continue;\n"
"            const w = walk(v, k);\n"
"            if (w !== undefined) out[k] = w;\n"
"          }\n"
"          return out;\n"
"        }\n"
"        return v;\n"
"      };\n"
"      const needWalk = repFn || repList !== null || (value !== null && typeof value === 'object') || typeof value === 'object';\n"
"      if (!needWalk) return origStringify(value, undefined, space);\n"
"      const root = { '': value };\n"
"      const cooked = walk(root, '');\n"
"      return origStringify(cooked, undefined, space);\n"
"    }, 3);\n"
"    dp(JSON, 'parse', function (text, reviver) {\n"
"      const v = origParse('' + text);\n"
"      if (typeof reviver !== 'function') return v;\n"
"      const walk = (holder, key) => {\n"
"        const val = holder[key];\n"
"        if (val !== null && typeof val === 'object') {\n"
"          if (Array.isArray(val)) {\n"
"            for (let i = 0; i < val.length; i++) {\n"
"              const w = walk(val, i);\n"
"              if (w === undefined) delete val[i]; else val[i] = w;\n"
"            }\n"
"          } else {\n"
"            for (const k of Object.keys(val)) {\n"
"              const w = walk(val, k);\n"
"              if (w === undefined) delete val[k]; else val[k] = w;\n"
"            }\n"
"          }\n"
"        }\n"
"        return reviver.call(holder, '' + key, val);\n"
"      };\n"
"      return walk({ '': v }, '');\n"
"    }, 2);\n"
"    /* String replace with a function callback: drive matches from bytecode */\n"
"    const doReplace = (self, orig, pat, rep, all) => {\n"
"      if (typeof rep !== 'function') return orig.apply(self, [pat, rep]);\n"
"      const str = '' + self;\n"
"      if (typeof pat === 'string' || !(pat instanceof RegExp)) {\n"
"        const ps = '' + pat;\n"
"        let out = '', pos = 0;\n"
"        for (;;) {\n"
"          const at = str.indexOf(ps, pos);\n"
"          if (at < 0) break;\n"
"          out += str.slice(pos, at) + ('' + rep(ps, at, str));\n"
"          pos = at + (ps.length > 0 ? ps.length : 1);\n"
"          if (ps.length === 0) out += str.slice(at, pos - 0).slice(0, 1);\n"
"          if (!all) break;\n"
"        }\n"
"        return out + str.slice(pos);\n"
"      }\n"
"      const re = pat.global || !all ? pat : new RegExp(pat.source, pat.flags + 'g');\n"
"      const g = re.global;\n"
"      re.lastIndex = 0;\n"
"      let out = '', pos = 0, m;\n"
"      while ((m = re.exec(str)) !== null) {\n"
"        const args = m.slice();\n"
"        args[args.length] = m.index;\n"
"        args[args.length] = str;\n"
"        out += str.slice(pos, m.index) + ('' + rep.apply(undefined, args));\n"
"        pos = m.index + m[0].length;\n"
"        if (m[0].length === 0) re.lastIndex++;\n"
"        if (!g) break;\n"
"      }\n"
"      return out + str.slice(pos);\n"
"    };\n"
"    dp(SP, 'replace', function (pat, rep) { return doReplace(this, origReplace, pat, rep, false); }, 2);\n"
"    dp(SP, 'replaceAll', function (pat, rep) {\n"
"      if (typeof rep === 'function' && pat instanceof RegExp && !pat.global)\n"
"        return origReplaceAll.apply(this, arguments); /* keep the TypeError */\n"
"      return doReplace(this, origReplaceAll, pat, rep, true);\n"
"    }, 2);\n"
"    /* Promise: run the user executor from bytecode (capability captured by\n"
"       a setup-code mini-executor via super) */\n"
"    const OrigPromise = G.Promise;\n"
"    class TTPromise extends OrigPromise {\n"
"      constructor(executor) {\n"
"        if (typeof executor !== 'function') { super(executor); return; }\n"
"        let cap;\n"
"        super((res, rej) => { cap = [res, rej]; });\n"
"        try { executor(cap[0], cap[1]); } catch (e) { cap[1](e); }\n"
"      }\n"
"    }\n"
"    Object.defineProperty(TTPromise, 'name', { value: 'Promise', configurable: true });\n"
"    G.Promise = TTPromise;\n"
"    /* combinators iterate user iterables from bytecode */\n"
"    const toArr = (it) => { const a = []; for (const v of it) a[a.length] = v; return a; };\n"
"    dp(TTPromise, 'all', function (it) { return OrigPromise.all.call(this, toArr(it)); }, 1);\n"
"    dp(TTPromise, 'allSettled', function (it) { return OrigPromise.allSettled.call(this, toArr(it)); }, 1);\n"
"    dp(TTPromise, 'race', function (it) { return OrigPromise.race.call(this, toArr(it)); }, 1);\n"
"    dp(TTPromise, 'any', function (it) { return OrigPromise.any.call(this, toArr(it)); }, 1);\n"
"  })();\n"
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
"  /* ---- web-platform substrate: URL, location, storage -----------------\n"
"     Self-hosted IN the machine so it snapshots, scrubs and forks with\n"
"     everything else. Read registries record which URL parameters and\n"
"     storage keys the program actually consulted — the raw material for\n"
"     the engine's parameter search. */\n"
"  const paramReads = new Set();\n"
"  const storageReads = new Set();\n"
"  function parseSearch(qs) {\n"
"    const out = [];\n"
"    const s = String(qs == null ? '' : qs).replace(/^\\?/, '');\n"
"    if (s) for (const part of s.split('&')) {\n"
"      if (!part) continue;\n"
"      const i = part.indexOf('=');\n"
"      const k = i < 0 ? part : part.slice(0, i);\n"
"      const v = i < 0 ? '' : part.slice(i + 1);\n"
"      out.push([decodeURIComponent(k.replace(/\\+/g, ' ')), decodeURIComponent(v.replace(/\\+/g, ' '))]);\n"
"    }\n"
"    return out;\n"
"  }\n"
"  class URLSearchParams {\n"
"    constructor(init) {\n"
"      this.__l = typeof init === 'string' ? parseSearch(init)\n"
"        : init instanceof URLSearchParams ? init.__l.map((e) => e.slice())\n"
"        : Array.isArray(init) ? init.map((e) => [String(e[0]), String(e[1])])\n"
"        : init && typeof init === 'object' ? Object.keys(init).map((k) => [k, String(init[k])])\n"
"        : [];\n"
"    }\n"
"    get(k) { paramReads.add(String(k)); const e = this.__l.find((x) => x[0] === String(k)); return e ? e[1] : null; }\n"
"    getAll(k) { paramReads.add(String(k)); return this.__l.filter((x) => x[0] === String(k)).map((x) => x[1]); }\n"
"    has(k) { paramReads.add(String(k)); return this.__l.some((x) => x[0] === String(k)); }\n"
"    set(k, v) { const l = this.__l.filter((x) => x[0] !== String(k)); l.push([String(k), String(v)]); this.__l = l; }\n"
"    append(k, v) { this.__l.push([String(k), String(v)]); }\n"
"    delete(k) { this.__l = this.__l.filter((x) => x[0] !== String(k)); }\n"
"    forEach(fn, self) { for (const e of this.__l.slice()) fn.call(self, e[1], e[0], this); }\n"
"    keys() { return this.__l.map((e) => e[0])[Symbol.iterator](); }\n"
"    values() { return this.__l.map((e) => e[1])[Symbol.iterator](); }\n"
"    entries() { return this.__l.map((e) => e.slice())[Symbol.iterator](); }\n"
"    [Symbol.iterator]() { return this.entries(); }\n"
"    get size() { return this.__l.length; }\n"
"    toString() {\n"
"      return this.__l.map((e) => encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1])).join('&');\n"
"    }\n"
"  }\n"
"  class URL {\n"
"    constructor(href, base) {\n"
"      let h = String(href);\n"
"      if (base != null && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) {\n"
"        const b = base instanceof URL ? base : new URL(String(base));\n"
"        h = h.startsWith('/') ? b.origin + h\n"
"          : b.origin + b.pathname.replace(/[^/]*$/, '') + h;\n"
"      }\n"
"      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(h);\n"
"      if (!m) throw new TypeError('Invalid URL: ' + h);\n"
"      this.protocol = m[1] + ':';\n"
"      this.host = m[2];\n"
"      this.pathname = m[3] || '/';\n"
"      this.hash = m[5] || '';\n"
"      this.__sp = new URLSearchParams(m[4] || '');\n"
"    }\n"
"    get searchParams() { return this.__sp; }\n"
"    get search() { const q = this.__sp.toString(); return q ? '?' + q : ''; }\n"
"    set search(v) { this.__sp = new URLSearchParams(String(v)); }\n"
"    get origin() { return this.protocol + '//' + this.host; }\n"
"    get hostname() { return this.host.replace(/:\\d+$/, ''); }\n"
"    get port() { const i = this.host.indexOf(':'); return i < 0 ? '' : this.host.slice(i + 1); }\n"
"    get href() { return this.origin + this.pathname + this.search + this.hash; }\n"
"    set href(v) {\n"
"      const u = new URL(String(v));\n"
"      this.protocol = u.protocol; this.host = u.host; this.pathname = u.pathname;\n"
"      this.hash = u.hash; this.__sp = u.__sp;\n"
"    }\n"
"    toString() { return this.href; }\n"
"    toJSON() { return this.href; }\n"
"  }\n"
"  const loc = { u: new URL('https://example.test/') };\n"
"  class Location {\n"
"    get href() { return loc.u.href; }\n"
"    set href(v) { loc.u = new URL(String(v), loc.u); }\n"
"    get origin() { return loc.u.origin; }\n"
"    get protocol() { return loc.u.protocol; }\n"
"    get host() { return loc.u.host; }\n"
"    get hostname() { return loc.u.hostname; }\n"
"    get port() { return loc.u.port; }\n"
"    get pathname() { return loc.u.pathname; }\n"
"    set pathname(v) { loc.u.pathname = String(v); }\n"
"    get search() { return loc.u.search; }\n"
"    set search(v) { loc.u.search = String(v); }\n"
"    get hash() { return loc.u.hash; }\n"
"    set hash(v) { const s = String(v); loc.u.hash = !s || s.startsWith('#') ? s : '#' + s; }\n"
"    assign(v) { this.href = v; }\n"
"    replace(v) { this.href = v; }\n"
"    reload() {}\n"
"    toString() { return this.href; }\n"
"    get __paramReads() { return Array.from(paramReads); }\n"
"  }\n"
"  function makeStorage() {\n"
"    const m = new Map();\n"
"    return {\n"
"      getItem(k) { storageReads.add(String(k)); return m.has(String(k)) ? m.get(String(k)) : null; },\n"
"      setItem(k, v) { m.set(String(k), String(v)); },\n"
"      removeItem(k) { m.delete(String(k)); },\n"
"      clear() { m.clear(); },\n"
"      key(i) { const a = Array.from(m.keys()); return i >= 0 && i < a.length ? a[i] : null; },\n"
"      get length() { return m.size; },\n"
"      get __reads() { return Array.from(storageReads); },\n"
"      get __keys() { return Array.from(m.keys()); },\n"
"    };\n"
"  }\n"
"  G.URL = URL; G.URLSearchParams = URLSearchParams;\n"
"  G.location = new Location();\n"
"  G.localStorage = makeStorage();\n"
"  G.sessionStorage = makeStorage();\n"
"  for (const n of ['URL', 'URLSearchParams', 'location', 'localStorage', 'sessionStorage'])\n"
"    baseline.add(n);\n"
"  function setURL(href) { loc.u = new URL(String(href)); }\n"
"  /* ---- postMessage: an external input channel -------------------------\n"
"     Messages queue in-machine and every handler sees every message\n"
"     exactly once — so a message posted at a fork anchor (before the\n"
"     program ran a single line) still reaches handlers registered later\n"
"     in the run. __msgProbe builds a recording payload: property reads\n"
"     return marked strings, so the comparison journal reveals which keys\n"
"     an object protocol consults and what it tests them against. */\n"
"  const msgs = [];\n"
"  const msgHandlers = [];\n"
"  const winEvents = new Set();\n"
"  function msgFlush() {\n"
"    for (const h of msgHandlers)\n"
"      while (h.seen < msgs.length) {\n"
"        const data = msgs[h.seen++];\n"
"        h.fn.call(G, { type: 'message', data: data, origin: loc.u.origin, source: null, lastEventId: '', ports: [] });\n"
"      }\n"
"  }\n"
"  G.postMessage = function (data) { msgs.push(data); msgFlush(); };\n"
"  G.addEventListener = function (type, fn) {\n"
"    winEvents.add(String(type));\n"
"    if (String(type) === 'message' && typeof fn === 'function') { msgHandlers.push({ fn: fn, seen: 0 }); msgFlush(); }\n"
"  };\n"
"  G.removeEventListener = function (type, fn) {\n"
"    for (let i = 0; i < msgHandlers.length; i++)\n"
"      if (msgHandlers[i].fn === fn) { msgHandlers.splice(i, 1); return; }\n"
"  };\n"
"  let onmsg = null;\n"
"  Object.defineProperty(G, 'onmessage', {\n"
"    configurable: true,\n"
"    get: function () { return onmsg ? onmsg.fn : null; },\n"
"    set: function (fn) {\n"
"      if (onmsg) { const i = msgHandlers.indexOf(onmsg); if (i >= 0) msgHandlers.splice(i, 1); onmsg = null; }\n"
"      if (typeof fn === 'function') { winEvents.add('message'); onmsg = { fn: fn, seen: 0 }; msgHandlers.push(onmsg); msgFlush(); }\n"
"    },\n"
"  });\n"
"  G.__messageStats = function () {\n"
"    return { handlers: msgHandlers.length, posted: msgs.length, types: Array.from(winEvents) };\n"
"  };\n"
"  G.__msgProbe = function (m, over) {\n"
"    m = String(m);\n"
"    over = over && typeof over === 'object' ? over : {};\n"
"    return new Proxy({}, {\n"
"      get: function (t, k) {\n"
"        if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf' || k === 'toJSON') return function () { return m; };\n"
"        if (typeof k !== 'string') return undefined;\n"
"        if (Object.prototype.hasOwnProperty.call(over, k)) return over[k];\n"
"        return m + '.' + k;\n"
"      },\n"
"      has: function () { return true; },\n"
"    });\n"
"  };\n"
"  G.window = G;\n"
"  for (const n of ['postMessage', 'addEventListener', 'removeEventListener', 'onmessage', '__messageStats', '__msgProbe', 'window'])\n"
"    baseline.add(n);\n"
"  /* ---- DOM self-host over the __dom leaf primitives (Lexbor) ----------\n"
"     Everything here is bytecode: user event handlers, callbacks touching\n"
"     the DOM, style reads — all park like any other code. The C layer only\n"
"     walks/mutates the tree between steps. */\n"
"  const DOM = G.__dom;\n"
"  delete G.__dom;\n"
"  let DomNode = null;\n"
"  function buildDOM() {\n"
"    if (!DOM || !DOM.hasDoc()) return;\n"
"    const wraps = new Map();\n"
"    const listeners = new Map();\n"
"    const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());\n"
"    const parseStyle = (txt) => {\n"
"      const m = new Map();\n"
"      if (!txt) return m;\n"
"      for (const part of txt.split(';')) {\n"
"        const i = part.indexOf(':');\n"
"        if (i < 0) continue;\n"
"        const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();\n"
"        if (k) m.set(k, v);\n"
"      }\n"
"      return m;\n"
"    };\n"
"    const styleText = (m) => Array.from(m).map((e) => e[0] + ': ' + e[1]).join('; ');\n"
"    function wrap(p) {\n"
"      if (!p) return null;\n"
"      let w = wraps.get(p);\n"
"      if (w) return w;\n"
"      const t = DOM.nodeType(p);\n"
"      w = t === 1 ? new Element(p) : t === 3 ? new Text(p)\n"
"        : t === 8 ? new Comment(p) : t === 9 ? new Document(p)\n"
"        : t === 10 ? new DocumentType(p) : new Node(p);\n"
"      wraps.set(p, w);\n"
"      return w;\n"
"    }\n"
"    class Node {\n"
"      constructor(p) { this.__p = p; }\n"
"      get nodeType() { return DOM.nodeType(this.__p); }\n"
"      get nodeName() { return DOM.nodeName(this.__p); }\n"
"      get parentNode() { return wrap(DOM.parent(this.__p)); }\n"
"      get parentElement() { const n = wrap(DOM.parent(this.__p)); return n && n.nodeType === 1 ? n : null; }\n"
"      get firstChild() { return wrap(DOM.firstChild(this.__p)); }\n"
"      get lastChild() { return wrap(DOM.lastChild(this.__p)); }\n"
"      get nextSibling() { return wrap(DOM.next(this.__p)); }\n"
"      get previousSibling() { return wrap(DOM.prev(this.__p)); }\n"
"      get childNodes() {\n"
"        const out = [];\n"
"        let c = DOM.firstChild(this.__p);\n"
"        while (c) { out.push(wrap(c)); c = DOM.next(c); }\n"
"        return out;\n"
"      }\n"
"      get textContent() { return DOM.textGet(this.__p); }\n"
"      set textContent(v) { DOM.textSet(this.__p, String(v)); }\n"
"      get ownerDocument() { return G.document; }\n"
"      get isConnected() {\n"
"        let n = this.__p;\n"
"        while (n) { if (DOM.nodeType(n) === 9) return true; n = DOM.parent(n); }\n"
"        return false;\n"
"      }\n"
"      appendChild(n) { DOM.append(this.__p, n.__p); return n; }\n"
"      insertBefore(n, ref) {\n"
"        if (ref == null) return this.appendChild(n);\n"
"        DOM.insertBefore(ref.__p, n.__p);\n"
"        return n;\n"
"      }\n"
"      removeChild(n) { DOM.remove(n.__p); return n; }\n"
"      replaceChild(n, old) { DOM.insertBefore(old.__p, n.__p); DOM.remove(old.__p); return old; }\n"
"      remove() { DOM.remove(this.__p); }\n"
"      cloneNode(deep) { return wrap(DOM.clone(this.__p, !!deep)); }\n"
"      contains(n) {\n"
"        let c = n && n.__p;\n"
"        while (c) { if (c === this.__p) return true; c = DOM.parent(c); }\n"
"        return false;\n"
"      }\n"
"      hasChildNodes() { return DOM.firstChild(this.__p) !== 0; }\n"
"      addEventListener(type, fn, opts) {\n"
"        if (typeof fn !== 'function') return;\n"
"        const cap = !!(opts === true || (opts && opts.capture));\n"
"        const once = !!(opts && opts.once);\n"
"        let per = listeners.get(this.__p);\n"
"        if (!per) { per = new Map(); listeners.set(this.__p, per); }\n"
"        let arr = per.get(String(type));\n"
"        if (!arr) { arr = []; per.set(String(type), arr); }\n"
"        for (const l of arr) if (l.fn === fn && l.cap === cap) return;\n"
"        arr.push({ fn: fn, cap: cap, once: once });\n"
"      }\n"
"      removeEventListener(type, fn, opts) {\n"
"        const cap = !!(opts === true || (opts && opts.capture));\n"
"        const per = listeners.get(this.__p);\n"
"        const arr = per && per.get(String(type));\n"
"        if (!arr) return;\n"
"        for (let i = 0; i < arr.length; i++)\n"
"          if (arr[i].fn === fn && arr[i].cap === cap) { arr.splice(i, 1); return; }\n"
"      }\n"
"      dispatchEvent(ev) {\n"
"        ev.__target = this;\n"
"        const path = [];\n"
"        let a = DOM.parent(this.__p);\n"
"        while (a) { path.push(wrap(a)); a = DOM.parent(a); }\n"
"        const fire = (node, phase) => {\n"
"          const per = listeners.get(node.__p);\n"
"          const arr = per && per.get(ev.type);\n"
"          if (!arr) return;\n"
"          for (const l of arr.slice()) {\n"
"            if (ev.__stopNow) return;\n"
"            if (phase === 1 && !l.cap) continue;\n"
"            if (phase === 3 && l.cap) continue;\n"
"            if (l.once) { const k = arr.indexOf(l); if (k >= 0) arr.splice(k, 1); }\n"
"            ev.__phase = phase; ev.__current = node;\n"
"            try { l.fn.call(node, ev); }\n"
"            catch (e) { consoleOut(3, [e]); }\n"
"          }\n"
"        };\n"
"        for (let i = path.length - 1; i >= 0; i--) { if (ev.__stop) break; fire(path[i], 1); }\n"
"        if (!ev.__stop) fire(this, 2);\n"
"        if (ev.bubbles) for (let i = 0; i < path.length; i++) { if (ev.__stop) break; fire(path[i], 3); }\n"
"        ev.__phase = 0; ev.__current = null;\n"
"        return !ev.defaultPrevented;\n"
"      }\n"
"    }\n"
"    class Element extends Node {\n"
"      get tagName() { return DOM.nodeName(this.__p); }\n"
"      get id() { return DOM.attrGet(this.__p, 'id') || ''; }\n"
"      set id(v) { DOM.attrSet(this.__p, 'id', String(v)); }\n"
"      get className() { return DOM.attrGet(this.__p, 'class') || ''; }\n"
"      set className(v) { DOM.attrSet(this.__p, 'class', String(v)); }\n"
"      get classList() {\n"
"        const el = this;\n"
"        return {\n"
"          get length() { return el.className.split(/\\s+/).filter(Boolean).length; },\n"
"          contains(c) { return el.className.split(/\\s+/).filter(Boolean).indexOf(String(c)) >= 0; },\n"
"          add(...cs) {\n"
"            const s = el.className.split(/\\s+/).filter(Boolean);\n"
"            for (const c of cs) if (s.indexOf(String(c)) < 0) s.push(String(c));\n"
"            el.className = s.join(' ');\n"
"          },\n"
"          remove(...cs) {\n"
"            let s = el.className.split(/\\s+/).filter(Boolean);\n"
"            for (const c of cs) s = s.filter((x) => x !== String(c));\n"
"            el.className = s.join(' ');\n"
"          },\n"
"          toggle(c, force) {\n"
"            const has = this.contains(c);\n"
"            const want = force === undefined ? !has : !!force;\n"
"            if (want && !has) this.add(c);\n"
"            else if (!want && has) this.remove(c);\n"
"            return want;\n"
"          },\n"
"          toString() { return el.className; },\n"
"        };\n"
"      }\n"
"      get children() { return this.childNodes.filter((n) => n.nodeType === 1); }\n"
"      get firstElementChild() { return this.children[0] || null; }\n"
"      get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }\n"
"      getAttribute(n) { return DOM.attrGet(this.__p, String(n)); }\n"
"      setAttribute(n, v) { DOM.attrSet(this.__p, String(n), String(v)); }\n"
"      removeAttribute(n) { DOM.attrDel(this.__p, String(n)); }\n"
"      hasAttribute(n) { return DOM.attrGet(this.__p, String(n)) !== null; }\n"
"      getAttributeNames() { return DOM.attrNames(this.__p); }\n"
"      get innerHTML() { return DOM.serialize(this.__p, 1); }\n"
"      set innerHTML(v) { DOM.innerSet(this.__p, String(v)); }\n"
"      get outerHTML() { return DOM.serialize(this.__p, 0); }\n"
"      querySelector(sel) { const r = DOM.qsa(this.__p, String(sel)); return r.length ? wrap(r[0]) : null; }\n"
"      querySelectorAll(sel) { return DOM.qsa(this.__p, String(sel)).map(wrap); }\n"
"      matches(sel) { return DOM.matches(this.__p, String(sel)); }\n"
"      closest(sel) {\n"
"        let n = this;\n"
"        while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; }\n"
"        return null;\n"
"      }\n"
"      getElementsByTagName(t) { return this.querySelectorAll(String(t)); }\n"
"      getElementsByClassName(c) {\n"
"        return this.querySelectorAll('.' + String(c).trim().split(/\\s+/).join('.'));\n"
"      }\n"
"      get namespaceURI() {\n"
"        const k = DOM.ns(this.__p);\n"
"        return k === 'svg' ? 'http://www.w3.org/2000/svg'\n"
"          : k === 'math' ? 'http://www.w3.org/1998/Math/MathML'\n"
"          : 'http://www.w3.org/1999/xhtml';\n"
"      }\n"
"      get content() {\n"
"        return wrap(DOM.templateContent(this.__p));\n"
"      }\n"
"      get style() {\n"
"        let f = wrapsStyle.get(this.__p);\n"
"        if (f) return f;\n"
"        const el = this;\n"
"        f = new Proxy({}, {\n"
"          get(t, k) {\n"
"            if (k === 'cssText') return DOM.attrGet(el.__p, 'style') || '';\n"
"            if (k === 'setProperty') return (n, v) => {\n"
"              const m = parseStyle(DOM.attrGet(el.__p, 'style'));\n"
"              m.set(String(n), String(v));\n"
"              DOM.attrSet(el.__p, 'style', styleText(m));\n"
"            };\n"
"            if (k === 'getPropertyValue') return (n) => parseStyle(DOM.attrGet(el.__p, 'style')).get(String(n)) || '';\n"
"            if (k === 'removeProperty') return (n) => {\n"
"              const m = parseStyle(DOM.attrGet(el.__p, 'style'));\n"
"              const old = m.get(String(n)) || '';\n"
"              m.delete(String(n));\n"
"              DOM.attrSet(el.__p, 'style', styleText(m));\n"
"              return old;\n"
"            };\n"
"            if (typeof k !== 'string') return undefined;\n"
"            return parseStyle(DOM.attrGet(el.__p, 'style')).get(kebab(k)) || '';\n"
"          },\n"
"          set(t, k, v) {\n"
"            if (k === 'cssText') { DOM.attrSet(el.__p, 'style', String(v)); return true; }\n"
"            const m = parseStyle(DOM.attrGet(el.__p, 'style'));\n"
"            if (v === '' || v == null) m.delete(kebab(String(k)));\n"
"            else m.set(kebab(String(k)), String(v));\n"
"            DOM.attrSet(el.__p, 'style', styleText(m));\n"
"            return true;\n"
"          },\n"
"        });\n"
"        wrapsStyle.set(this.__p, f);\n"
"        return f;\n"
"      }\n"
"    }\n"
"    const wrapsStyle = new Map();\n"
"    class CharacterData extends Node {\n"
"      get data() { return DOM.dataGet(this.__p); }\n"
"      set data(v) { DOM.textSet(this.__p, String(v)); }\n"
"      get nodeValue() { return this.data; }\n"
"      set nodeValue(v) { this.data = v; }\n"
"      get length() { return this.data.length; }\n"
"    }\n"
"    class Text extends CharacterData {}\n"
"    class Comment extends CharacterData {}\n"
"    class DocumentType extends Node {\n"
"      get name() { return DOM.doctypeIds(this.__p)[0] || ''; }\n"
"      get publicId() { return DOM.doctypeIds(this.__p)[1] || ''; }\n"
"      get systemId() { return DOM.doctypeIds(this.__p)[2] || ''; }\n"
"    }\n"
"    class Document extends Node {\n"
"      get __eventTypes() {\n"
"        const s = new Set();\n"
"        for (const per of listeners.values())\n"
"          for (const kv of per) if (kv[1].length) s.add(kv[0]);\n"
"        return Array.from(s);\n"
"      }\n"
"      get doctype() {\n"
"        for (const c of this.childNodes) if (c.nodeType === 10) return c;\n"
"        return null;\n"
"      }\n"
"      get body() { return wrap(DOM.body()); }\n"
"      get head() { return wrap(DOM.head()); }\n"
"      get documentElement() { return wrap(DOM.docElement()); }\n"
"      createElement(n) { return wrap(DOM.createElement(String(n))); }\n"
"      createTextNode(s) { return wrap(DOM.createText(String(s))); }\n"
"      createComment(s) { return wrap(DOM.createComment(String(s))); }\n"
"      getElementById(id) { return wrap(DOM.byAttr(DOM.docElement(), 'id', String(id))); }\n"
"      querySelector(sel) { const r = DOM.qsa(this.__p, String(sel)); return r.length ? wrap(r[0]) : null; }\n"
"      querySelectorAll(sel) { return DOM.qsa(this.__p, String(sel)).map(wrap); }\n"
"      getElementsByTagName(t) { return this.querySelectorAll(String(t)); }\n"
"      getElementsByClassName(c) {\n"
"        return this.querySelectorAll('.' + String(c).trim().split(/\\s+/).join('.'));\n"
"      }\n"
"      addStyleSheet(css) { DOM.addCss(String(css)); }\n"
"    }\n"
"    class Event {\n"
"      constructor(type, init) {\n"
"        init = init || {};\n"
"        this.type = String(type);\n"
"        this.bubbles = !!init.bubbles;\n"
"        this.cancelable = !!init.cancelable;\n"
"        this.defaultPrevented = false;\n"
"        this.__stop = false; this.__stopNow = false;\n"
"        this.__phase = 0; this.__current = null; this.__target = null;\n"
"        this.timeStamp = Date.now();\n"
"        this.isTrusted = false;\n"
"      }\n"
"      get target() { return this.__target; }\n"
"      get currentTarget() { return this.__current; }\n"
"      get eventPhase() { return this.__phase; }\n"
"      stopPropagation() { this.__stop = true; }\n"
"      stopImmediatePropagation() { this.__stop = true; this.__stopNow = true; }\n"
"      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }\n"
"    }\n"
"    class CustomEvent extends Event {\n"
"      constructor(type, init) {\n"
"        super(type, init);\n"
"        this.detail = init && init.detail !== undefined ? init.detail : null;\n"
"      }\n"
"    }\n"
"    DomNode = Node;\n"
"    G.Node = Node; G.Element = Element; G.Text = Text; G.Comment = Comment;\n"
"    G.DocumentType = DocumentType;\n"
"    G.CharacterData = CharacterData; G.Document = Document;\n"
"    G.Event = Event; G.CustomEvent = CustomEvent;\n"
"    G.document = wrap(DOM.doc());\n"
"    G.getComputedStyle = (el) => {\n"
"      const out = {};\n"
"      const flat = DOM.computed(el.__p);\n"
"      const rules = [];\n"
"      for (let i = 0; i + 1 < flat.length; i += 2) rules.push([flat[i], flat[i + 1]]);\n"
"      rules.sort((a, b) => a[0] - b[0]); /* stable: doc order breaks ties */\n"
"      const importants = new Map();\n"
"      for (const [, txt] of rules) {\n"
"        for (const [k, v] of parseStyle(txt)) {\n"
"          if (/\\s!important$/.test(v)) importants.set(k, v.replace(/\\s*!important$/, ''));\n"
"          else out[k] = v;\n"
"        }\n"
"      }\n"
"      for (const [k, v] of parseStyle(DOM.attrGet(el.__p, 'style'))) out[k] = v;\n"
"      for (const [k, v] of importants) out[k] = v;\n"
"      Object.defineProperty(out, 'getPropertyValue', {\n"
"        value: (n) => out[String(n)] || '', enumerable: false,\n"
"      });\n"
"      return out;\n"
"    };\n"
"  }\n"
"  return { serTop: serTop, envelope: envelope, userGlobals: userGlobals, timerCount: timerCount, timerPop: timerPop, rejected: rejected, buildDOM: buildDOM, setURL: setURL };\n"
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
    tt_dom_register(g_ctx);

    setup = JS_Eval(g_ctx, SETUP_SRC, sizeof(SETUP_SRC) - 1, "tt-setup.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(setup))
        return 3;
    g_ser_fn = JS_GetPropertyStr(g_ctx, setup, "serTop");
    g_envelope_fn = JS_GetPropertyStr(g_ctx, setup, "envelope");
    g_globals_fn = JS_GetPropertyStr(g_ctx, setup, "userGlobals");
    g_timer_count_fn = JS_GetPropertyStr(g_ctx, setup, "timerCount");
    g_timer_pop_fn = JS_GetPropertyStr(g_ctx, setup, "timerPop");
    g_rejected_fn = JS_GetPropertyStr(g_ctx, setup, "rejected");
    g_dom_build_fn = JS_GetPropertyStr(g_ctx, setup, "buildDOM");
    g_set_url_fn = JS_GetPropertyStr(g_ctx, setup, "setURL");
    JS_FreeValue(g_ctx, setup);

    JS_TTSetStepHandler(g_rt, tt_step_handler, NULL);
    JS_TTSetStepFilename(g_ctx, "program.js");
    JS_SetInterruptHandler(g_rt, tt_interrupt_handler, NULL);
    JS_SetHostPromiseRejectionTracker(g_rt, tt_rejection_tracker, NULL);
    return 0;
}

/* Emit the kind=3 completion envelope for the program value/exception. */
static void emit_eval_done(JSValue v)
{
    JSValue env, args[2];
    const char *cstr;
    size_t slen;

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

/* Run the user program. Compiles once, then executes under the park-by-
   return driver: every step suspends by RETURNING from this export
   (tt_parked() → 1; continue with tt_resume). On completion emits kind=3
   with { ok } | { error }. Returns 1 while parked, 0 done. */
EXPORT("tt_eval") int tt_eval(const char *code, int len)
{
    JSValue fn, v;
    int parked = 0;

    g_exec_kind = TT_EXEC_SCRIPT;
    g_suppressed = 0;
    JS_TTCmpClear(g_rt); /* fresh comparison journal per recording */
    JS_TTEnableStep(g_rt, 1);
    fn = JS_Eval(g_ctx, code, len, "program.js",
                 JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(fn)) {
        JS_TTEnableStep(g_rt, 0);
        emit_eval_done(fn);
        return 0;
    }
    v = JS_TTCallStart(g_ctx, fn, &parked);
    if (parked)
        return 1;
    JS_TTEnableStep(g_rt, 0);
    emit_eval_done(v);
    return 0;
}

/* Resume a machine parked by return. cmd 0 = continue, 1 = abort. What
   happens on completion depends on what was being driven: the script emits
   its result envelope, the job pump keeps draining, the timer runs its
   post half. Returns 1 while (still) parked. */
EXPORT("tt_resume") int tt_resume(int cmd)
{
    JSValue v;
    int parked = 0;

    v = JS_TTCallResume(g_ctx, cmd, &parked);
    if (parked)
        return 1;
    if (g_exec_kind == TT_EXEC_JOBS) {
        JS_FreeValue(g_ctx, v); /* job post ran inside JS_TTCallResume */
        return pump_jobs_loop();
    }
    if (g_exec_kind == TT_EXEC_TIMER) {
        JS_TTEnableStep(g_rt, 0);
        return timer_finish(v);
    }
    JS_TTEnableStep(g_rt, 0);
    emit_eval_done(v);
    return 0;
}

EXPORT("tt_parked") int tt_parked(void)
{
    return JS_TTParked(g_ctx);
}

/* Inspect / evaluate against a return-parked machine: the frame chain is
   live in linear memory and no rewind is needed at all. */
EXPORT("tt_inspect_parked") void tt_inspect_parked(void)
{
    g_in_hook = 1;
    JS_TTEnableStep(g_rt, 0);
    send_inspection(g_ctx);
    JS_TTEnableStep(g_rt, 1);
    g_in_hook = 0;
}

EXPORT("tt_eval_parked") void tt_eval_parked(int write_back)
{
    g_in_hook = 1;
    JS_TTEnableStep(g_rt, 0);
    eval_at_pause_mode(g_ctx, write_back);
    JS_TTEnableStep(g_rt, 1);
    g_in_hook = 0;
}

/* Step granularity: 0 = source line, 1 = every opcode. */
EXPORT("tt_set_granularity") void tt_set_granularity(int g)
{
    JS_TTSetGranularity(g_ctx, g);
}

/* Drain the job queue via the stackless pump; returns 1 while parked. */
static int pump_jobs_loop(void)
{
    int parked = 0, err;
    char buf[64];

    for (;;) {
        err = JS_TTPumpJob(JS_GetRuntime(g_ctx), NULL, &parked);
        if (parked) {
            g_exec_kind = TT_EXEC_JOBS;
            return 1;
        }
        if (err == 0)
            break;
        if (err < 0)
            JS_FreeValue(g_ctx, JS_GetException(g_ctx));
        g_jobs_count++;
        if (g_jobs_count > 10000)
            break;
    }
    JS_TTEnableStep(g_rt, 0);
    g_exec_kind = TT_EXEC_SCRIPT;
    snprintf(buf, sizeof(buf), "{\"jobs\":%d}", g_jobs_count);
    tt_host_out(4, buf, (int)strlen(buf));
    return 0;
}

/* Run pending promise jobs (each job steppable, callbacks park by return).
   Emits kind=4 when the queue is drained. Returns 1 while parked. */
EXPORT("tt_run_jobs") int tt_run_jobs(void)
{
    g_jobs_count = 0;
    JS_TTEnableStep(g_rt, 1);
    return pump_jobs_loop();
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

/* parked-timer continuation (statics live in the snapshot) */
static JSValue g_timer_fn;
static JSValue g_timer_args[8];
static int g_timer_alen;
static double g_timer_at;

static int timer_finish(JSValue r)
{
    int i;
    char buf[96];

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
    for (i = 0; i < g_timer_alen; i++)
        JS_FreeValue(g_ctx, g_timer_args[i]);
    JS_FreeValue(g_ctx, g_timer_fn);
    g_timer_fn = JS_UNDEFINED;
    g_timer_alen = 0;
    g_exec_kind = TT_EXEC_SCRIPT;
    snprintf(buf, sizeof(buf), "{\"at\":%.0f}", g_timer_at);
    tt_host_out(5, buf, (int)strlen(buf));
    return 0;
}

/* Fire the next due virtual timer (steppable; the callback parks by
   return). Emits kind=5 when done. Returns 1 while parked. */
EXPORT("tt_fire_timer") int tt_fire_timer(void)
{
    JSValue tuple, fnargs, atv, r;
    int64_t i, alen = 0;
    int parked = 0;

    tuple = JS_Call(g_ctx, g_timer_pop_fn, JS_UNDEFINED, 0, NULL);
    if (!JS_IsObject(tuple)) {
        JS_FreeValue(g_ctx, tuple);
        tt_host_out(5, "{\"idle\":true}", 13);
        return 0;
    }
    g_timer_at = 0;
    g_timer_fn = JS_GetPropertyUint32(g_ctx, tuple, 0);
    fnargs = JS_GetPropertyUint32(g_ctx, tuple, 1);
    atv = JS_GetPropertyUint32(g_ctx, tuple, 2);
    JS_ToFloat64(g_ctx, &g_timer_at, atv);
    JS_FreeValue(g_ctx, atv);
    JS_FreeValue(g_ctx, tuple);

    if (g_timer_at > JS_TTGetVirtualTime())
        JS_TTSetVirtualTime(g_timer_at, 1);

    {
        JSValue lenv = JS_GetPropertyStr(g_ctx, fnargs, "length");
        JS_ToInt64(g_ctx, &alen, lenv);
        JS_FreeValue(g_ctx, lenv);
    }
    if (alen > 8) alen = 8;
    for (i = 0; i < alen; i++)
        g_timer_args[i] = JS_GetPropertyUint32(g_ctx, fnargs, (uint32_t)i);
    g_timer_alen = (int)alen;
    JS_FreeValue(g_ctx, fnargs);

    JS_TTEnableStep(g_rt, 1);
    r = JS_TTCallArgs(g_ctx, g_timer_fn, JS_UNDEFINED, g_timer_alen,
                      (JSValueConst *)g_timer_args, &parked);
    if (parked) {
        g_exec_kind = TT_EXEC_TIMER;
        return 1;
    }
    JS_TTEnableStep(g_rt, 0);
    return timer_finish(r);
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
    JS_FreeValue(g_ctx, g_dom_build_fn);
    JS_FreeValue(g_ctx, g_set_url_fn);
    JS_TTCmpClear(g_rt);
    tt_dom_destroy();
    JS_FreeContext(g_ctx);
    JS_TTSetVirtualTime(0, 1);
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx)
        return 2;
    JS_TTResetExecState(g_ctx);
    g_exec_kind = TT_EXEC_SCRIPT;
    g_timer_fn = JS_UNDEFINED; /* abandoned parked-timer state, if any */
    g_timer_alen = 0;
    glob = JS_GetGlobalObject(g_ctx);
    natfn = JS_NewCFunction(g_ctx, js_tt_console, "__tt_nat_console", 2);
    JS_SetPropertyStr(g_ctx, glob, "__tt_nat_console", natfn);
    JS_FreeValue(g_ctx, glob);
    tt_dom_register(g_ctx);
    setup = JS_Eval(g_ctx, SETUP_SRC, sizeof(SETUP_SRC) - 1, "tt-setup.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(setup))
        return 3;
    g_ser_fn = JS_GetPropertyStr(g_ctx, setup, "serTop");
    g_envelope_fn = JS_GetPropertyStr(g_ctx, setup, "envelope");
    g_globals_fn = JS_GetPropertyStr(g_ctx, setup, "userGlobals");
    g_timer_count_fn = JS_GetPropertyStr(g_ctx, setup, "timerCount");
    g_timer_pop_fn = JS_GetPropertyStr(g_ctx, setup, "timerPop");
    g_rejected_fn = JS_GetPropertyStr(g_ctx, setup, "rejected");
    g_dom_build_fn = JS_GetPropertyStr(g_ctx, setup, "buildDOM");
    g_set_url_fn = JS_GetPropertyStr(g_ctx, setup, "setURL");
    JS_FreeValue(g_ctx, setup);
    JS_TTSetStepFilename(g_ctx, "program.js");
    return 0;
}

EXPORT("tt_alloc") void *tt_alloc(int n) { return malloc((size_t)n); }
EXPORT("tt_free") void tt_free(void *p) { free(p); }

/* Load an HTML document for this session (call after tt_init/tt_reset,
   before tt_eval). Parses via Lexbor into THIS linear memory and builds
   the self-hosted DOM API. Returns 0 on success. */
static char *tt_json_str(char *w, const char *s)
{
    *w++ = '"';
    for (; *s; s++) {
        if (*s == '"' || *s == '\\')
            *w++ = '\\';
        *w++ = *s;
    }
    *w++ = '"';
    return w;
}

/* The comparison journal OF THE CURRENT MACHINE STATE as JSON:
   [[op, lhs, rhs], ...] with op 0 eq / 1 includes / 2 startsWith /
   3 endsWith / 4 indexOf. Position the memory first — each timeline
   reads back its own comparisons. malloc'd; caller tt_free's. */
EXPORT("tt_cmp_json") char *tt_cmp_json(void)
{
    int n = JS_TTCmpCount(g_rt), i, op;
    const char *a, *b;
    char *out, *w;

    out = malloc((size_t)n * 300 + 8);
    if (!out)
        return NULL;
    w = out;
    *w++ = '[';
    for (i = 0; i < n; i++) {
        if (JS_TTCmpGet(g_rt, i, &op, &a, &b))
            break;
        if (i)
            *w++ = ',';
        *w++ = '[';
        *w++ = (char)('0' + op);
        *w++ = ',';
        w = tt_json_str(w, a);
        *w++ = ',';
        w = tt_json_str(w, b);
        *w++ = ']';
    }
    *w++ = ']';
    *w = 0;
    return out;
}

/* Set the session's location BEFORE tt_eval — the program reads its URL
   parameters off this. Returns 0 on success, 1 for an unparsable URL. */
EXPORT("tt_set_url") int tt_set_url(const char *href, int len)
{
    JSValue s, r;
    s = JS_NewStringLen(g_ctx, href, (size_t)len);
    r = JS_Call(g_ctx, g_set_url_fn, JS_UNDEFINED, 1, &s);
    JS_FreeValue(g_ctx, s);
    if (JS_IsException(r)) {
        JS_FreeValue(g_ctx, JS_GetException(g_ctx));
        return 1;
    }
    JS_FreeValue(g_ctx, r);
    return 0;
}

EXPORT("tt_dom_load") int tt_dom_load(const char *html, int len)
{
    JSValue r;
    int rc = tt_dom_load_html(html, (size_t)len);
    if (rc)
        return rc;
    r = JS_Call(g_ctx, g_dom_build_fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r)) {
        JS_FreeValue(g_ctx, JS_GetException(g_ctx));
        return 100;
    }
    JS_FreeValue(g_ctx, r);
    return 0;
}
