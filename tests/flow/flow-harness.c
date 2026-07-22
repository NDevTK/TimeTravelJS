/*
 * TimeTravelJS flow-serialization harness.
 *
 * Two processes prove the cross-process contract:
 *   flow-harness emit <file>    process A: build baseline, run a flow to a
 *                               park deep inside a yield* chain, record a COW
 *                               delta, check the flow out, serialize it to
 *                               <file>; then check it back in and finish it
 *                               locally, printing the reference trace.
 *   flow-harness resume <file>  process B: fresh runtime, rebuild the same
 *                               baseline, deserialize, check in, finish,
 *                               printing the same trace format.
 * run.sh byte-compares the two "POST:" traces.
 *
 *   flow-harness selftest       in-process assertions: N-flow baseline
 *                               dedup (by id, zero copies), re-serialization
 *                               byte-equality, shared identity after
 *                               transplant, corrupt-input rejection,
 *                               wrong-baseline rejection, GC + leak checks.
 *
 *   flow-harness emit2/resume2  the machine-parked TrampFrame chain: a
 *                               step-hook park INSIDE helper() (four frames
 *                               deep under a for-of driver) serializes as
 *                               [outer heap, inner yield* splice, helper
 *                               arena]; process B transplants the parked
 *                               machine and completes the interrupted
 *                               next() with JS_TTFlowResumeParked. emit2's
 *                               reference future comes from an in-process
 *                               transplant into a second runtime, and the
 *                               original machine is discarded through the
 *                               abort-unwind path.
 *
 *   flow-harness forktest       JS_TTFlowFork: clone a parked flow (two
 *                               frames deep in yield*, open cell, delta)
 *                               into siblings; prove divergent futures
 *                               under different next() feeds, two- and
 *                               three-way delta isolation (fork-of-fork),
 *                               baseline sharing by identity, refusal on
 *                               completed flows, leak-free teardown.
 *
 *   flow-harness forkhere       the suspended machine as a first-class
 *                               per-flow value: JS_TTForkHere splits the
 *                               RUNNING machine mid-opcode from the step
 *                               hook (four frames deep in helper()); the
 *                               legacy machine plus three forked handles
 *                               stay suspended concurrently, resume
 *                               independently (with per-arm injections
 *                               into the same live local and per-arm
 *                               deltas), and an abandoned arm tears down
 *                               leak-free without ever resuming.
 *
 *   flow-harness mass           segmented arenas: 2000 machines forked
 *                               from one baseline; HARD bound that their
 *                               measured arena RAM is a small multiple of
 *                               the chains' actual bytes, not N x 2 MB;
 *                               spot resumes identical; mass teardown
 *                               through the leak oracle.
 *
 *   flow-harness deep           a recursion parked 30 frames down forks/
 *                               transplants into multi-segment machines
 *                               that grow further while installed and
 *                               unwind back across every segment
 *                               boundary, byte-identical to the
 *                               never-segmented reference; evict/hydrate
 *                               of the deep machine included.
 *
 *   flow-harness evict          cold eviction: a suspended machine (with
 *                               an injected local and a delta) round-
 *                               trips through bytes -- freed, hydrated,
 *                               resumed byte-identically to its
 *                               never-evicted twin -- without disturbing
 *                               the parent or siblings; the live legacy
 *                               machine refuses; yield-suspended flows
 *                               evict too.
 *
 *   flow-harness asynctest      per-flow async machinery: an async
 *                               function suspended at `await p` forks
 *                               through its RESULT-PROMISE handle; each
 *                               arm settles its own cloned resolver
 *                               (read via JS_TTFlowGetLocal) and
 *                               continues past the await with diverging
 *                               values, isolated deltas, and a .then
 *                               observer running as its own parked
 *                               sub-flow. A for-await loop over a
 *                               flow-private async iterator forks
 *                               mid-loop into independently-fed arms.
 *                               An await-suspended flow with a captured
 *                               pending microtask evicts to bytes, frees,
 *                               hydrates, and pumps to a byte-identical
 *                               continuation -- the microtask firing
 *                               exactly once per living copy.
 *
 *   flow-harness cowtest        automatic transparent COW: two forked arms
 *                               run ORDINARY program code (sharedObj.x = v;
 *                               sharedArr.push(...); sharedP.then(...)) with
 *                               no host DeltaWrite calls; the engine captures
 *                               baseline pre-images into the checked-in
 *                               flow's delta automatically. Asserts per-arm
 *                               isolation, pristine baseline when nobody is
 *                               checked in, shared pointer identity, the
 *                               exact delta record count (flow-private
 *                               objects are never captured), zero
 *                               allocation on the second write to an
 *                               already-captured cell, serialize/hydrate
 *                               round-trip of an auto-captured delta, the
 *                               per-arm promise-reaction oracle, and that
 *                               completion commits the winning arm's writes.
 *
 *   flow-harness taggedtest     tagged values: a JS_TTMakeTagged value
 *                               (concrete payload + opaque host note) as a
 *                               first-class citizen of fork / serialize /
 *                               evict / GC. Asserts the accessor API, a
 *                               payload<->tagged GC cycle, fork independence
 *                               (own payload copy per arm, NoteClone'd
 *                               notes, a mutation in one arm touching
 *                               nobody), serialize->hydrate and evict->
 *                               hydrate round trips through NoteSerialize/
 *                               Deserialize, loud refusals when a needed
 *                               hook is missing (NULL notes still pass),
 *                               NoteFree exactly once per abandoned arm,
 *                               and a note-liveness oracle over the whole
 *                               run beside the runtime leak oracle.
 *
 *   flow-harness combinetest    tagged-value propagation through value-
 *                               producing operations: any tagged operand
 *                               of an arithmetic/bitwise/shift/relational/
 *                               loose-eq op, a concat (including the
 *                               template-literal engine), or a covered
 *                               coercion pipeline (unary +, String(),
 *                               parseInt/parseFloat) yields a tagged
 *                               result whose payload is the ENGINE's own
 *                               result on the unwrapped concretes and
 *                               whose note derives via the Combine hook
 *                               (right op code, per-operand note array).
 *                               Asserts exact payloads ("x"+t("y") is
 *                               "xy", +t("5") is the number 5 -- the real
 *                               op ran), faithful concrete throws and
 *                               NaNs, two-tagged combines, strict-eq
 *                               (===/!==, the switch case-compare, and
 *                               the null/undefined literal forms)
 *                               unwrapping exactly like loose-eq with
 *                               reflexive x === x staying concrete and
 *                               hook-free, the parameter/destructuring
 *                               default probes never unwrapping, payload
 *                               truthiness everywhere ToBool runs (with
 *                               the cond hook observing exactly the
 *                               control-flow branches -- if / ?: / && /
 *                               || / ||= / loops / switch -- while ?? and
 *                               ?. stay payload-nullish and silent, and
 *                               ! / Boolean() coerce silently), typeof /
 *                               property-key coercion staying exactly as
 *                               today, JSON.stringify refusing loudly at
 *                               the named field instead of silently
 *                               de-tagging (payload toJSON not consulted;
 *                               untagged structures byte-identical), the
 *                               string search builtins (indexOf/
 *                               lastIndexOf/includes/startsWith/endsWith)
 *                               searching the PAYLOAD, journaling the
 *                               payload token with the tagged operand's
 *                               note (JS_TTCmpGet), and re-wrapping the
 *                               result (tagged receiver via .call, tagged
 *                               needle, tagged position for the offset;
 *                               concretes byte-identical with a NULL
 *                               journal note), property gets forwarding
 *                               to the payload (length/index exotics,
 *                               own/getter/inherited/missing props,
 *                               nested payloads wrapping once with the
 *                               outer note, stored tagged values
 *                               flattening, functions passing through
 *                               unwrapped so plain method calls reach
 *                               the forwarded builtins, tagged keys
 *                               still refusing, untagged gets
 *                               byte-identical), property sets
 *                               forwarding as the get's inverse (writes
 *                               land on the payload -- never the
 *                               wrapper, per the raw JS_TTOwnPropCount
 *                               probe -- through setters/exotics with
 *                               tagged values stored as-is, and a write
 *                               to a BASELINE payload routing through
 *                               automatic COW: one deduped delta,
 *                               isolated at checkout), has/enumerate
 *                               forwarding (`in` concrete over the
 *                               payload chain with the real TypeError
 *                               for primitive payloads, keys concrete,
 *                               values/entries tracked via the wrapper,
 *                               for-in over object/proto/string
 *                               payloads), and propagated results (a
 *                               strict-eq boolean, a search integer, a
 *                               get result, a cond observation stream)
 *                               riding problem 1's fork + serialize
 *                               paths.
 */
#include "quickjs.h"
#include "cutils.h"     /* DynBuf, for the tagged-value note hooks */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <math.h>
#include <time.h>

/* the baseline program: MUST be byte-identical in every process. The flow
   exercises: baseline objects (CONFIG/TABLE), nested generators (yield* =
   two parked TrampFrames), a flow-private object + closure over a flow
   local (open var_ref), try (catch offset on the parked stack), TDZ slot,
   float, short bigint, Date wrapper, symbol-keyed private prop. */
static const char *BASELINE_SRC =
"\"use strict\";\n"
"var CONFIG = { name: \"baseline-config\", limit: 3, tag: \"cfg\" };\n"
"var TABLE = [];\n"
"for (var i = 0; i < 64; i++) TABLE.push(\"row-\" + i);\n"
"function bump(x) { return x + CONFIG.limit; }\n"
"function helper(k, a) {\n"
"  var acc = k * 2;\n"
"  acc = acc + CONFIG.limit;\n"
"  acc = acc - a;\n"
"  return acc + 1;\n"
"}\n"
"function drive(g) { var out = []; for (var v of g) out.push(v); return out.join(\"|\"); }\n"
"function* inner(a) {\n"
"  var t = 0.5;\n"
"  for (var k = 0; k < a; k++) {\n"
"    t += helper(k, a);\n"
"    try { var fed = yield \"inner:\" + k + \":\" + t + \":\" + TABLE[k % TABLE.length]; }\n"
"    catch (e) { yield \"caught:\" + e; }\n"
"    if (fed) t += fed;\n"
"  }\n"
"  return \"inner-done:\" + t;\n"
"}\n"
"function* outer(n) {\n"
"  var local = { acc: 1 };\n"
"  var mk = function (d) { return local.acc + d; };\n"
"  var when = new Date(1234567890123);\n"
"  var big = 123n;\n"
"  var sym = Symbol(\"flow-sym\");\n"
"  var symval = {};\n"
"  symval[sym] = \"sv\";\n"
"  yield \"start:\" + CONFIG.name;\n"
"  var got = yield* inner(n);\n"
"  let late = \"L\" + n;\n"
"  local.acc = mk(bump(n));\n"
"  yield \"after-inner:\" + got + \":\" + local.acc + \":\" + late;\n"
"  yield \"delta-view:\" + CONFIG.tag + \":\" + when.getTime() + \":\" + String(big);\n"
"  return \"outer-done:\" + local.acc + \":\" + CONFIG.tag + \":\" + symval[sym];\n"
"}\n"
"function rec(n, a) {\n"
"  if (n <= 0) return helper(1, a);\n"
"  return rec(n - 1, a) + 0;\n"
"}\n"
"function* deepflow(d) {\n"
"  var t = rec(d, 3);\n"
"  yield \"deep:\" + t;\n"
"  yield \"deep2:\" + (t + rec(3, 1));\n"
"  return \"deep-done:\" + t;\n"
"}\n"
"var SINK = [];\n"
"function sink(tag) { return function (v) { SINK.push(tag + \":\" + v); return v; }; }\n"
"async function af(n) {\n"
"  var r = null;\n"
"  var p = new Promise(function (res) { r = res; });\n"
"  var got = await p;\n"
"  return \"af\" + n + \":got=\" + got + \":\" + CONFIG.tag;\n"
"}\n"
"async function loopy(ait) {\n"
"  var acc = [];\n"
"  for await (var v of ait) {\n"
"    acc.push(v);\n"
"    if (acc.length >= 2) break;\n"
"  }\n"
"  return acc.join(\"+\");\n"
"}\n"
"function mk_ait() {\n"
"  var o = {};\n"
"  o.feed = null;\n"
"  o.next = function () { return new Promise(function (res) { o.feed = res; }); };\n"
"  o[Symbol.asyncIterator] = function () { return o; };\n"
"  return o;\n"
"}\n"
"var MLOG = [];\n"
"async function mf() {\n"
"  var r = null;\n"
"  Promise.resolve(\"m\").then(function (v) { MLOG.push(\"micro:\" + v); return v; });\n"
"  var got = await new Promise(function (res) { r = res; });\n"
"  return \"mf:got=\" + got;\n"
"}\n"
"var SHOBJ = { x: 0 };\n"
"var SHARR = [];\n"
"var SHP_RES = null;\n"
"var SHP = new Promise(function (r) { SHP_RES = r; });\n"
"function* cowflow() {\n"
"  var v = yield \"ready\";\n"
"  SHOBJ.x = v;\n"
"  SHOBJ.x = v + 10;\n"
"  SHARR.push(\"arm\" + v);\n"
"  SHP.then(sink(\"p\" + v));\n"
"  var w = yield \"wrote:\" + SHOBJ.x + \":\" + SHARR.join(\",\") + \":\" + SHARR.length;\n"
"  return \"done:\" + SHOBJ.x + \":\" + w;\n"
"}\n"
"function* tflow() {\n"
"  var t = null;\n"
"  var u = null;\n"
"  var fed = yield \"t0\";\n"
"  yield \"t1:\" + (t ? typeof t : \"null\") + \":\" + fed;\n"
"  return \"t-end\";\n"
"}\n";

static void die(JSContext *ctx, const char *what)
{
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    fprintf(stderr, "FATAL %s: %s\n", what, msg ? msg : "?");
    exit(1);
}

static JSContext *new_baseline_ctx(JSRuntime **prt)
{
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx;
    JSValue v;
    assert(rt);
    ctx = JS_NewContext(rt);
    assert(ctx);
    v = JS_Eval(ctx, BASELINE_SRC, strlen(BASELINE_SRC), "baseline.js",
                JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v))
        die(ctx, "baseline eval");
    JS_FreeValue(ctx, v);
    if (JS_TTBaselineCapture(ctx))
        die(ctx, "baseline capture");
    *prt = rt;
    return ctx;
}

/* start outer(4) and advance 'steps' yields; prints them with 'pfx' */
static JSValue start_flow(JSContext *ctx, int steps, const char *pfx)
{
    JSValue g, glob, fn, arg;
    int i;
    glob = JS_GetGlobalObject(ctx);
    fn = JS_GetPropertyStr(ctx, glob, "outer");
    arg = JS_NewInt32(ctx, 4);
    g = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&arg);
    if (JS_IsException(g))
        die(ctx, "outer()");
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, glob);
    for (i = 0; i < steps; i++) {
        JSValue r = JS_Invoke(ctx, g, JS_NewAtom(ctx, "next"), 0, NULL);
        JSValue val;
        const char *s;
        if (JS_IsException(r))
            die(ctx, "next()");
        val = JS_GetPropertyStr(ctx, r, "value");
        s = JS_ToCString(ctx, val);
        if (pfx)
            printf("%s%s\n", pfx, s);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, val);
        JS_FreeValue(ctx, r);
    }
    return g;
}

/* drive a suspended flow to completion, printing every yield + the return */
static void finish_flow(JSContext *ctx, JSValueConst g, const char *pfx)
{
    for (;;) {
        JSValue r = JS_Invoke(ctx, (JSValue)g, JS_NewAtom(ctx, "next"), 0, NULL);
        JSValue val, done;
        const char *s;
        int isdone;
        if (JS_IsException(r))
            die(ctx, "next()");
        val = JS_GetPropertyStr(ctx, r, "value");
        done = JS_GetPropertyStr(ctx, r, "done");
        isdone = JS_ToBool(ctx, done);
        s = JS_ToCString(ctx, val);
        printf("%s%s%s\n", pfx, isdone ? "return:" : "", s);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, val);
        JS_FreeValue(ctx, done);
        JS_FreeValue(ctx, r);
        if (isdone)
            break;
    }
}

static JSValue get_global(JSContext *ctx, const char *name)
{
    JSValue glob = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, glob, name);
    JS_FreeValue(ctx, glob);
    return v;
}

static char *eval_str(JSContext *ctx, const char *expr)
{
    JSValue v = JS_Eval(ctx, expr, strlen(expr), "probe.js", JS_EVAL_TYPE_GLOBAL);
    const char *s;
    char *out;
    if (JS_IsException(v))
        die(ctx, expr);
    s = JS_ToCString(ctx, v);
    out = strdup(s ? s : "?");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
}

static void expect_str(JSContext *ctx, const char *expr, const char *want,
                       const char *what)
{
    char *got = eval_str(ctx, expr);
    if (strcmp(got, want)) {
        fprintf(stderr, "FAIL %s: %s == \"%s\", want \"%s\"\n",
                what, expr, got, want);
        exit(1);
    }
    free(got);
}

/* park the machine at the Nth arrival on a target source line; with
   fork_here set, split the running machine there first (the fork-arm handle
   lands in plan->forked, the continue-arm parks by the returned 2) */
typedef struct ParkPlan {
    int line;
    int countdown;
    int parked_line;
    int fork_here;
    JSValue forked;
} ParkPlan;

static int park_handler(JSContext *ctx, int line, int col, int depth,
                        int parkable, void *opaque)
{
    ParkPlan *plan = opaque;
    (void)col; (void)depth;
    if (getenv("FLOW_DEBUG_STEPS"))
        fprintf(stderr, "[step] line=%d depth=%d parkable=%d\n",
                line, depth, parkable);
    if (parkable && line == plan->line && --plan->countdown == 0) {
        plan->parked_line = line;
        if (plan->fork_here) {
            plan->forked = JS_TTForkHere(ctx);
            if (JS_IsException(plan->forked))
                return 1;     /* abort; the command dies on the exception */
        }
        return 2;
    }
    return 0;
}

/* 1-based line of the first occurrence of 'needle' in the baseline */
static int baseline_line_of(const char *needle)
{
    const char *p = strstr(BASELINE_SRC, needle);
    int line = 1;
    const char *q;
    assert(p);
    for (q = BASELINE_SRC; q < p; q++)
        if (*q == '\n')
            line++;
    return line;
}

static void print_step(JSContext *ctx, JSValueConst val, int done,
                       const char *pfx)
{
    if (done == 2) {
        /* yield* delegation step: the value IS the iterator result */
        JSValue v2 = JS_GetPropertyStr(ctx, val, "value");
        JSValue d2 = JS_GetPropertyStr(ctx, val, "done");
        print_step(ctx, v2, JS_ToBool(ctx, d2), pfx);
        JS_FreeValue(ctx, v2);
        JS_FreeValue(ctx, d2);
        return;
    }
    {
        const char *str = JS_ToCString(ctx, val);
        printf("%s%s%s\n", pfx, done == 1 ? "return:" : "", str ? str : "?");
        JS_FreeCString(ctx, str);
    }
}

/* record the flow's COW delta: CONFIG.tag = "cfg-flow" through the flow */
static void write_delta(JSContext *ctx, JSValueConst g)
{
    JSValue cfg = get_global(ctx, "CONFIG");
    JSAtom tag = JS_NewAtom(ctx, "tag");
    JSValue nv = JS_NewString(ctx, "cfg-flow");
    if (JS_TTFlowDeltaWriteProp(ctx, g, cfg, tag, nv))
        die(ctx, "delta write");
    JS_FreeValue(ctx, nv);
    JS_FreeAtom(ctx, tag);
    JS_FreeValue(ctx, cfg);
}

/* ---- emit: process A ---- */
static int cmd_emit(const char *path)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue g;
    uint8_t *bytes;
    size_t len;
    FILE *f;

    printf("BASELINE:count=%u:fp=%016llx\n",
           (unsigned)JS_TTBaselineCount(rt),
           (unsigned long long)JS_TTBaselineFingerprint(rt));

    g = start_flow(ctx, 3, "PRE:");           /* parked inside inner (yield*) */
    write_delta(ctx, g);
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "delta live view");
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout");
    expect_str(ctx, "CONFIG.tag", "cfg", "pristine after checkout");

    bytes = JS_TTFlowSerialize(ctx, g, &len);
    if (!bytes)
        die(ctx, "serialize");
    f = fopen(path, "wb");
    if (!f || fwrite(bytes, 1, len, f) != len) {
        fprintf(stderr, "FATAL cannot write %s\n", path);
        return 1;
    }
    fclose(f);
    printf("BYTES:%u\n", (unsigned)len);
    js_free(ctx, bytes);

    /* reference future: check back in and finish locally */
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin");
    finish_flow(ctx, g, "POST:");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "delta committed by resume");

    JS_FreeValue(ctx, g);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return 0;
}

/* ---- resume: process B ---- */
static int cmd_resume(const char *path)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue g;
    uint8_t *bytes;
    long len;
    FILE *f;

    printf("BASELINE:count=%u:fp=%016llx\n",
           (unsigned)JS_TTBaselineCount(rt),
           (unsigned long long)JS_TTBaselineFingerprint(rt));

    f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "FATAL cannot read %s\n", path);
        return 1;
    }
    fseek(f, 0, SEEK_END);
    len = ftell(f);
    fseek(f, 0, SEEK_SET);
    bytes = malloc(len);
    if (fread(bytes, 1, len, f) != (size_t)len) {
        fprintf(stderr, "FATAL short read\n");
        return 1;
    }
    fclose(f);
    printf("BYTES:%u\n", (unsigned)len);

    g = JS_TTFlowDeserialize(ctx, bytes, len);
    free(bytes);
    if (JS_IsException(g))
        die(ctx, "deserialize");

    expect_str(ctx, "CONFIG.tag", "cfg", "pristine before checkin");
    /* the rebuilt graph must survive a full GC before it ever runs */
    JS_RunGC(rt);
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "flow view after checkin");

    finish_flow(ctx, g, "POST:");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "delta committed by resume");

    JS_FreeValue(ctx, g);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return 0;
}

/* ---- emit2/resume2: the machine-parked TrampFrame chain round trip ----
   The flow parks INSIDE helper() called from inner() delegated from outer()
   via yield* -- a three-frame chain [outer heap, inner heap, helper arena]
   -- then crosses the process boundary and completes the interrupted
   next() on the other side. */
static int cmd_emit2(const char *path)
{
    JSRuntime *rt, *rt2;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSContext *ctx2;
    JSValue g, g2, drive_fn;
    ParkPlan plan;
    uint8_t *bytes;
    size_t blen;
    FILE *f;
    int parked = 0, done = 0;

    printf("BASELINE:count=%u:fp=%016llx\n",
           (unsigned)JS_TTBaselineCount(rt),
           (unsigned long long)JS_TTBaselineFingerprint(rt));

    g = start_flow(ctx, 2, "PRE:");   /* "start", "inner:0" */

    /* a for-of driver resumes the generator through the engine's in-loop
       splices, so the step hook can park anywhere inside; park at
       helper()'s middle line, deep inside outer -> yield* inner -> helper */
    plan.line = baseline_line_of("acc = acc + CONFIG.limit");
    plan.countdown = 1;
    plan.parked_line = 0;
    plan.fork_here = 0;
    plan.forked = JS_UNDEFINED;
    JS_TTSetStepHandler(rt, park_handler, &plan);
    JS_TTSetStepFilename(ctx, "baseline.js");
    JS_TTEnableStep(rt, 1);
    drive_fn = get_global(ctx, "drive");
    {
        JSValueConst args[1] = { g };
        JSValue ret = JS_TTCallArgs(ctx, drive_fn, JS_UNDEFINED, 1, args,
                                    &parked);
        if (!parked) {
            fprintf(stderr, "FATAL machine did not park (line %d)\n",
                    plan.line);
            return 1;
        }
        JS_FreeValue(ctx, ret);
    }
    JS_TTEnableStep(rt, 0);
    printf("PARKED:line=%d\n", plan.parked_line);

    write_delta(ctx, g);              /* delta on a machine-parked flow */
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "delta live view");
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout");
    expect_str(ctx, "CONFIG.tag", "cfg", "pristine after checkout");

    bytes = JS_TTFlowSerialize(ctx, g, &blen);
    if (!bytes)
        die(ctx, "serialize");
    f = fopen(path, "wb");
    if (!f || fwrite(bytes, 1, blen, f) != blen) {
        fprintf(stderr, "FATAL cannot write %s\n", path);
        return 1;
    }
    fclose(f);
    printf("BYTES:%u\n", (unsigned)blen);

    /* reference future: transplant into a SECOND runtime in this process
       and drive it exactly like process B will -- the two futures must
       agree byte for byte */
    ctx2 = new_baseline_ctx(&rt2);
    g2 = JS_TTFlowDeserialize(ctx2, bytes, blen);
    if (JS_IsException(g2))
        die(ctx2, "in-process deserialize");
    expect_str(ctx2, "CONFIG.tag", "cfg", "pristine before checkin");
    JS_RunGC(rt2);
    if (JS_TTFlowCheckin(ctx2, g2))
        die(ctx2, "checkin");
    expect_str(ctx2, "CONFIG.tag", "cfg-flow", "flow view after checkin");
    {
        JSValue v = JS_TTFlowResumeParked(ctx2, g2, 0, &done, &parked);
        if (parked || JS_IsException(v))
            die(ctx2, "resume parked");
        print_step(ctx2, v, done, "POST:");
        JS_FreeValue(ctx2, v);
    }
    finish_flow(ctx2, g2, "POST:");
    expect_str(ctx2, "CONFIG.tag", "cfg-flow", "delta committed by resume");
    JS_FreeValue(ctx2, g2);
    JS_FreeContext(ctx2);
    JS_FreeRuntime(rt2);

    /* discard the original parked machine: the documented abort path
       (Interrupted unwinds helper -> inner -> outer -> driver) */
    {
        JSValue ret = JS_TTCallResume(ctx, 1, &parked);
        if (parked)
            die(ctx, "abort did not complete");
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    js_free(ctx, bytes);
    JS_FreeValue(ctx, drive_fn);
    JS_FreeValue(ctx, g);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return 0;
}

static int cmd_resume2(const char *path)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue g;
    uint8_t *bytes;
    long blen;
    FILE *f;
    int done = 0, parked = 0;

    printf("BASELINE:count=%u:fp=%016llx\n",
           (unsigned)JS_TTBaselineCount(rt),
           (unsigned long long)JS_TTBaselineFingerprint(rt));

    f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "FATAL cannot read %s\n", path);
        return 1;
    }
    fseek(f, 0, SEEK_END);
    blen = ftell(f);
    fseek(f, 0, SEEK_SET);
    bytes = malloc(blen);
    if (fread(bytes, 1, blen, f) != (size_t)blen) {
        fprintf(stderr, "FATAL short read\n");
        return 1;
    }
    fclose(f);
    printf("BYTES:%u\n", (unsigned)blen);

    g = JS_TTFlowDeserialize(ctx, bytes, blen);
    if (JS_IsException(g))
        die(ctx, "deserialize");
    if (!JS_TTFlowParked(ctx, g)) {
        fprintf(stderr, "FATAL flow did not arrive as a parked machine\n");
        return 1;
    }
    printf("PARKED:transplanted\n");

    /* suspended machines are per-flow values now: a second transplant of
       the same bytes must SUCCEED and park independently -- and resuming
       (aborting) it must leave the first machine untouched */
    {
        int d2 = 0, p2 = 0;
        JSValue dup = JS_TTFlowDeserialize(ctx, bytes, (size_t)blen);
        JSValue ret;
        if (JS_IsException(dup))
            die(ctx, "second transplant");
        if (!JS_TTFlowParked(ctx, dup)) {
            fprintf(stderr, "FAIL second machine not parked\n");
            return 1;
        }
        ret = JS_TTFlowResumeParked(ctx, dup, 1, &d2, &p2);   /* abort */
        if (p2 || !JS_IsException(ret)) {
            fprintf(stderr, "FAIL abort of second machine\n");
            return 1;
        }
        JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, dup);
        if (!JS_TTFlowParked(ctx, g)) {
            fprintf(stderr, "FAIL first machine lost its park\n");
            return 1;
        }
        printf("SELF:concurrent transplant ok\n");
    }
    /* re-serializing the transplanted parked chain reproduces the bytes:
       arena offsets are relative, ids deterministic */
    {
        size_t l2;
        uint8_t *again = JS_TTFlowSerialize(ctx, g, &l2);
        if (!again)
            die(ctx, "re-serialize parked");
        if (l2 != (size_t)blen || memcmp(again, bytes, l2) != 0) {
            fprintf(stderr, "FAIL parked re-serialization drifted\n");
            return 1;
        }
        js_free(ctx, again);
        printf("SELF:parked byte-stable ok\n");
    }
    free(bytes);

    expect_str(ctx, "CONFIG.tag", "cfg", "pristine before checkin");
    JS_RunGC(rt);
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "flow view after checkin");

    {
        JSValue v = JS_TTFlowResumeParked(ctx, g, 0, &done, &parked);
        if (parked || JS_IsException(v))
            die(ctx, "resume parked");
        print_step(ctx, v, done, "POST:");
        JS_FreeValue(ctx, v);
    }
    finish_flow(ctx, g, "POST:");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "delta committed by resume");

    JS_FreeValue(ctx, g);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return 0;
}

/* ---- selftest: dedup, identity, byte-stability, robustness, leaks ---- */
static uint8_t *serialize_parked(JSContext *ctx, JSValueConst g, size_t *plen)
{
    uint8_t *b;
    if (JS_TTFlowCheckout(ctx, (JSValue)g))
        die(ctx, "checkout");
    b = JS_TTFlowSerialize(ctx, g, plen);
    if (!b)
        die(ctx, "serialize");
    return b;
}

static int cmd_selftest(void)
{
    JSRuntime *rtA, *rtB, *rtC;
    JSContext *ctxA, *ctxB, *ctxC;
    JSValue g1, g2, h1, h2;
    uint8_t *b1, *b2, *b1again;
    size_t l1, l2, l1again;
    size_t i;

    /* -- process-A-side: two flows over the same baseline -- */
    ctxA = new_baseline_ctx(&rtA);
    g1 = start_flow(ctxA, 3, NULL);
    write_delta(ctxA, g1);
    g2 = start_flow(ctxA, 3, NULL);
    b1 = serialize_parked(ctxA, g1, &l1);
    b2 = serialize_parked(ctxA, g2, &l2);

    /* the shared baseline must not be copied into either flow: TABLE alone
       holds 64 "row-N" strings; a single leaked copy would show up */
    for (i = 0; b1 && i + 4 <= l1; i++)
        assert(memcmp(b1 + i, "row-", 4) != 0);
    for (i = 0; b2 && i + 4 <= l2; i++)
        assert(memcmp(b2 + i, "row-", 4) != 0);
    assert(l1 < 2048 && l2 < 2048);
    printf("SELFTEST:dedup ok (flow bytes %u/%u, no baseline copies)\n",
           (unsigned)l1, (unsigned)l2);

    /* -- fresh-runtime transplant of BOTH flows -- */
    ctxB = new_baseline_ctx(&rtB);
    assert(JS_TTBaselineFingerprint(rtB) == JS_TTBaselineFingerprint(rtA));
    h1 = JS_TTFlowDeserialize(ctxB, b1, l1);
    if (JS_IsException(h1))
        die(ctxB, "deserialize h1");
    h2 = JS_TTFlowDeserialize(ctxB, b2, l2);
    if (JS_IsException(h2))
        die(ctxB, "deserialize h2");

    /* re-serializing the transplanted flow must reproduce the bytes exactly:
       assign ids -> relink is deterministic on both sides */
    b1again = JS_TTFlowSerialize(ctxB, h1, &l1again);
    if (!b1again)
        die(ctxB, "re-serialize");
    assert(l1again == l1 && memcmp(b1again, b1, l1) == 0);
    js_free(ctxB, b1again);
    printf("SELFTEST:byte-stable re-serialization ok\n");

    /* both transplanted flows must share the SAME rebuilt baseline object:
       flow 1's delta view must be visible to flow 2's execution */
    if (JS_TTFlowCheckin(ctxB, h1))
        die(ctxB, "checkin h1");
    expect_str(ctxB, "CONFIG.tag", "cfg-flow", "h1 view in B");
    finish_flow(ctxB, h2, "XTALK:");   /* h2 has no delta: sees h1's view */
    {
        char *last = eval_str(ctxB, "CONFIG.tag");
        assert(!strcmp(last, "cfg-flow"));
        free(last);
    }
    if (JS_TTFlowCheckout(ctxB, h1))
        die(ctxB, "checkout h1");
    expect_str(ctxB, "CONFIG.tag", "cfg", "pristine after h1 checkout");
    printf("SELFTEST:shared identity ok\n");

    /* corrupt input must be rejected, never crash */
    {
        int rejected = 0;
        size_t offs[] = { 7, l1 / 3, l1 / 2, l1 - 2 };
        for (i = 0; i < sizeof(offs) / sizeof(offs[0]); i++) {
            uint8_t *evil = malloc(l1);
            JSValue r;
            memcpy(evil, b1, l1);
            evil[offs[i]] ^= 0x5a;
            r = JS_TTFlowDeserialize(ctxB, evil, l1);
            if (JS_IsException(r)) {
                rejected++;
                JS_FreeValue(ctxB, JS_GetException(ctxB));
            } else {
                JS_FreeValue(ctxB, r);
            }
            free(evil);
        }
        printf("SELFTEST:corruption rejected %d/4 (no crashes)\n", rejected);
        assert(rejected >= 3);
        /* truncations */
        for (i = 1; i < l1; i += (l1 / 37) + 1) {
            JSValue r = JS_TTFlowDeserialize(ctxB, b1, i);
            if (JS_IsException(r))
                JS_FreeValue(ctxB, JS_GetException(ctxB));
            else
                JS_FreeValue(ctxB, r);
        }
        printf("SELFTEST:truncation sweep ok\n");
    }

    /* a drifted baseline must be refused by fingerprint */
    {
        JSRuntime *rt2 = JS_NewRuntime();
        JSContext *c2 = JS_NewContext(rt2);
        const char *extra = "var DRIFT = { x: 1 };\n";
        char *src2 = malloc(strlen(BASELINE_SRC) + strlen(extra) + 1);
        JSValue v, r;
        strcpy(src2, BASELINE_SRC);
        strcat(src2, extra);
        v = JS_Eval(c2, src2, strlen(src2), "baseline.js", JS_EVAL_TYPE_GLOBAL);
        free(src2);
        assert(!JS_IsException(v));
        JS_FreeValue(c2, v);
        assert(!JS_TTBaselineCapture(c2));
        assert(JS_TTBaselineFingerprint(rt2) != JS_TTBaselineFingerprint(rtA));
        r = JS_TTFlowDeserialize(c2, b1, l1);
        assert(JS_IsException(r));
        JS_FreeValue(c2, JS_GetException(c2));
        JS_FreeContext(c2);
        JS_FreeRuntime(rt2);
        printf("SELFTEST:baseline drift refused ok\n");
    }

    /* dropping a transplanted flow (delta included) without resuming must
       not leak: rely on the runtime teardown assertions */
    ctxC = new_baseline_ctx(&rtC);
    {
        JSValue h = JS_TTFlowDeserialize(ctxC, b1, l1);
        if (JS_IsException(h))
            die(ctxC, "deserialize into C");
        JS_RunGC(rtC);
        JS_FreeValue(ctxC, h);   /* abandoned unfinished */
        JS_RunGC(rtC);
    }
    JS_FreeContext(ctxC);
    JS_FreeRuntime(rtC);
    printf("SELFTEST:abandoned-flow teardown ok\n");

    js_free(ctxA, b1);
    js_free(ctxA, b2);
    JS_FreeValue(ctxB, h1);
    JS_FreeValue(ctxB, h2);
    JS_FreeContext(ctxB);
    JS_FreeRuntime(rtB);
    JS_FreeValue(ctxA, g1);
    JS_FreeValue(ctxA, g2);
    JS_FreeContext(ctxA);
    fprintf(stderr, "[teardown rtA]\n");
    JS_FreeRuntime(rtA);
    printf("SELFTEST:teardown ok\n");
    return 0;
}

/* drive a suspended flow to completion feeding next(feed) each step,
   collecting "value|" into buf */
static void collect_flow(JSContext *ctx, JSValueConst g, int feed,
                         char *buf, size_t cap)
{
    JSAtom na = JS_NewAtom(ctx, "next");
    buf[0] = 0;
    for (;;) {
        JSValue arg = JS_NewInt32(ctx, feed);
        JSValue r = JS_Invoke(ctx, (JSValue)g, na, 1, (JSValueConst *)&arg);
        JSValue val, done;
        const char *str;
        int isdone;
        if (JS_IsException(r))
            die(ctx, "next(feed)");
        val = JS_GetPropertyStr(ctx, r, "value");
        done = JS_GetPropertyStr(ctx, r, "done");
        isdone = JS_ToBool(ctx, done);
        str = JS_ToCString(ctx, val);
        if (strlen(buf) + strlen(str) + 2 < cap) {
            strcat(buf, str ? str : "?");
            strcat(buf, "|");
        }
        JS_FreeCString(ctx, str);
        JS_FreeValue(ctx, val);
        JS_FreeValue(ctx, done);
        JS_FreeValue(ctx, r);
        if (isdone)
            break;
    }
    JS_FreeAtom(ctx, na);
}

static void delta_mark(JSContext *ctx, JSValueConst g, const char *mark)
{
    JSValue cfg = get_global(ctx, "CONFIG");
    JSAtom tag = JS_NewAtom(ctx, "tag");
    JSValue nv = JS_NewString(ctx, mark);
    if (JS_TTFlowDeltaWriteProp(ctx, g, cfg, tag, nv))
        die(ctx, "delta mark");
    JS_FreeValue(ctx, nv);
    JS_FreeAtom(ctx, tag);
    JS_FreeValue(ctx, cfg);
}

/* fork: clone a parked flow (two frames deep in yield*, open cell, delta),
   prove independent divergence, two-way then three-way delta isolation,
   baseline sharing by identity, and leak-free teardown */
static int cmd_forktest(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue g, g2, g3;
    char trace_p[2048], trace_s[2048], trace_g[2048];

    /* park at the "inner:1" yield: [outer, inner] chain, mk closure over
       a live local, one delta write, checked out */
    g = start_flow(ctx, 3, NULL);
    write_delta(ctx, g);
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout parent");
    expect_str(ctx, "CONFIG.tag", "cfg", "pristine after checkout");

    g2 = JS_TTFlowFork(ctx, g);
    if (JS_IsException(g2))
        die(ctx, "fork");
    printf("FORK:sibling ok\n");

    /* (b) delta isolation, both directions */
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin parent");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "parent view");
    delta_mark(ctx, g, "parent-mark");
    expect_str(ctx, "CONFIG.tag", "parent-mark", "parent write");
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout parent 2");
    expect_str(ctx, "CONFIG.tag", "cfg", "pristine again");

    if (JS_TTFlowCheckin(ctx, g2))
        die(ctx, "checkin sibling");
    expect_str(ctx, "CONFIG.tag", "cfg-flow",
               "sibling sees fork-time view, not parent-mark");
    delta_mark(ctx, g2, "sib-mark");
    if (JS_TTFlowCheckout(ctx, g2))
        die(ctx, "checkout sibling");
    expect_str(ctx, "CONFIG.tag", "cfg", "pristine after sibling");

    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin parent 3");
    expect_str(ctx, "CONFIG.tag", "parent-mark",
               "parent view survives sibling's writes");
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout parent 3");
    printf("FORK:delta isolation ok\n");

    /* (e) fork-of-fork: the grandchild carries the SIBLING's view */
    g3 = JS_TTFlowFork(ctx, g2);
    if (JS_IsException(g3))
        die(ctx, "fork of fork");
    if (JS_TTFlowCheckin(ctx, g3))
        die(ctx, "checkin g3");
    expect_str(ctx, "CONFIG.tag", "sib-mark", "grandchild inherits sibling");
    delta_mark(ctx, g3, "g3-mark");
    if (JS_TTFlowCheckout(ctx, g3))
        die(ctx, "checkout g3");
    if (JS_TTFlowCheckin(ctx, g2))
        die(ctx, "checkin sibling 2");
    expect_str(ctx, "CONFIG.tag", "sib-mark",
               "sibling view survives grandchild's writes");
    if (JS_TTFlowCheckout(ctx, g2))
        die(ctx, "checkout sibling 2");
    printf("FORK:three-way isolation ok\n");

    /* (c) baseline shared by identity: a host-level mutation of TABLE is
       visible to every fork's future (a clone would show pristine rows) */
    {
        JSValue v = JS_Eval(ctx, "TABLE[2] = 'row-2-mutated';", 26,
                            "probe.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(v))
            die(ctx, "table mutation");
        JS_FreeValue(ctx, v);
    }

    /* (a) resume all three with different feeds; each under its own delta */
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin for run p");
    collect_flow(ctx, g, 1, trace_p, sizeof(trace_p));
    if (JS_TTFlowCheckin(ctx, g2))
        die(ctx, "checkin for run s");
    collect_flow(ctx, g2, 2, trace_s, sizeof(trace_s));
    if (JS_TTFlowCheckin(ctx, g3))
        die(ctx, "checkin for run g");
    collect_flow(ctx, g3, 3, trace_g, sizeof(trace_g));

    printf("TRACE_P:%s\n", trace_p);
    printf("TRACE_S:%s\n", trace_s);
    printf("TRACE_G:%s\n", trace_g);
    assert(strcmp(trace_p, trace_s) != 0);
    assert(strcmp(trace_s, trace_g) != 0);
    assert(strcmp(trace_p, trace_g) != 0);
    assert(strstr(trace_p, "delta-view:parent-mark"));
    assert(strstr(trace_s, "delta-view:sib-mark"));
    assert(strstr(trace_g, "delta-view:g3-mark"));
    assert(strstr(trace_p, "row-2-mutated"));
    assert(strstr(trace_s, "row-2-mutated"));
    assert(strstr(trace_g, "row-2-mutated"));
    printf("FORK:divergent futures ok\n");

    /* also: forking a completed/running flow refuses cleanly */
    {
        JSValue bad = JS_TTFlowFork(ctx, g);   /* g completed above */
        assert(JS_IsException(bad));
        JS_FreeValue(ctx, JS_GetException(ctx));
    }

    /* (d) leak-free teardown: two completed flows, one abandoned fork */
    {
        JSValue g4 = JS_TTFlowFork(ctx, g3);   /* completed -> must refuse */
        assert(JS_IsException(g4));
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, g2);
    JS_FreeValue(ctx, g3);
    /* an extra suspended fork abandoned without resuming */
    {
        JSValue g5 = start_flow(ctx, 3, NULL);
        JSValue g6;
        if (JS_TTFlowCheckout(ctx, g5))
            die(ctx, "checkout g5");
        g6 = JS_TTFlowFork(ctx, g5);
        if (JS_IsException(g6))
            die(ctx, "fork g5");
        JS_FreeValue(ctx, g5);
        JS_FreeValue(ctx, g6);
        JS_RunGC(rt);
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    printf("FORK:teardown ok\n");
    return 0;
}

/* the first resumed step of a machine-parked arm, stringified into buf
   (unwraps a done==2 yield* delegation result exactly like print_step) */
static void resume_first(JSContext *ctx, JSValueConst arm, char *buf,
                         size_t cap)
{
    int done = 0, parked = 0;
    JSValue v = JS_TTFlowResumeParked(ctx, (JSValue)arm, 0, &done, &parked);
    const char *s;
    if (parked || JS_IsException(v))
        die(ctx, "resume arm");
    if (done == 2) {
        JSValue v2 = JS_GetPropertyStr(ctx, v, "value");
        JS_FreeValue(ctx, v);
        v = v2;
    }
    s = JS_ToCString(ctx, v);
    snprintf(buf, cap, "%s|", s ? s : "?");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
}

/* forkhere: fork the RUNNING machine from inside the step hook, at an
   opcode boundary in the middle of helper()'s arithmetic, four frames deep
   (helper <- inner <- outer <- for-of drive). armA = the continue-arm (the
   legacy parked machine), armB/armC = JS_TTForkHere handles, armD = a
   host-side JS_TTFlowFork of the parked machine, abandoned unresumed.
   Proves: (a) diverging futures from the same opcode under per-arm
   injections of the same live local, (b) delta isolation across arms,
   (c) 4 independently suspended machines coexisting in one runtime, a
   handle resuming to completion while the legacy machine stays parked,
   (d) leak-free teardown of an abandoned arm through the state finalizer. */
static int cmd_forkhere(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue g, armB, armC, armD, drive_fn;
    ParkPlan plan;
    JSAtom name_a;
    char traceA[2048], traceB[2048], traceC[2048];
    int parked = 0;

    g = start_flow(ctx, 2, NULL);     /* suspended at inner's k=0 yield */
    write_delta(ctx, g);
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout");

    /* drive under opcode-granularity stepping; the trigger sits on the
       SECOND opcode boundary of helper's middle line at k=1 -- genuinely
       mid-statement, four frames deep */
    plan.line = baseline_line_of("acc = acc + CONFIG.limit");
    plan.countdown = 2;
    plan.parked_line = 0;
    plan.fork_here = 1;
    plan.forked = JS_UNDEFINED;
    JS_TTSetStepHandler(rt, park_handler, &plan);
    JS_TTSetStepFilename(ctx, "baseline.js");
    JS_TTSetGranularity(ctx, 1);
    JS_TTEnableStep(rt, 1);
    drive_fn = get_global(ctx, "drive");
    {
        JSValueConst args[1] = { g };
        JSValue ret = JS_TTCallArgs(ctx, drive_fn, JS_UNDEFINED, 1, args,
                                    &parked);
        if (JS_IsException(ret))
            die(ctx, "fork-here drive");
        if (!parked) {
            fprintf(stderr, "FATAL machine did not park at the fork point\n");
            return 1;
        }
        JS_FreeValue(ctx, ret);
    }
    JS_TTEnableStep(rt, 0);
    armB = plan.forked;
    if (!JS_TTParked(ctx) || !JS_TTFlowParked(ctx, armB)) {
        fprintf(stderr, "FAIL fork-here arms not both suspended\n");
        return 1;
    }
    printf("FORKHERE:split at line %d, both arms suspended\n",
           plan.parked_line);

    /* (d-setup) a host-side fork of the legacy parked machine: a third
       independently suspended machine, to be abandoned unresumed */
    armD = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armD))
        die(ctx, "host-side fork of parked machine");
    if (!JS_TTFlowParked(ctx, armD)) {
        fprintf(stderr, "FAIL armD not suspended\n");
        return 1;
    }

    /* (b) delta isolation across arms: distinct marks, both checked out */
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin A");
    expect_str(ctx, "CONFIG.tag", "cfg-flow", "armA inherits pre-fork view");
    delta_mark(ctx, g, "cfg-A");
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout A");
    expect_str(ctx, "CONFIG.tag", "cfg", "pristine after armA");
    if (JS_TTFlowCheckin(ctx, armB))
        die(ctx, "checkin B");
    expect_str(ctx, "CONFIG.tag", "cfg-flow",
               "armB inherits the fork-time view, not cfg-A");
    delta_mark(ctx, armB, "cfg-B");
    if (JS_TTFlowCheckout(ctx, armB))
        die(ctx, "checkout B");
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin A2");
    expect_str(ctx, "CONFIG.tag", "cfg-A", "armA view survives armB's mark");
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout A2");
    printf("FORKHERE:delta isolation ok\n");

    /* (a) inject different values into the SAME live local (helper's
       argument `a`, an aliased-arg slot: armA through the running chain,
       armB through its handle) */
    name_a = JS_NewAtom(ctx, "a");
    {
        JSValue v = JS_NewInt32(ctx, 10);
        if (!JS_TTSetLocal(ctx, 0, name_a, v)) {
            fprintf(stderr, "FAIL inject armA\n");
            return 1;
        }
        v = JS_NewInt32(ctx, 20);
        if (!JS_TTFlowSetLocal(ctx, armB, 0, name_a, v)) {
            fprintf(stderr, "FAIL inject armB\n");
            return 1;
        }
    }

    /* (c) a third ForkHere INSIDE armA's resume: two opcode boundaries
       later on the same helper line (still k=1, before `a` is read) the
       trigger fires again, the handler splits again, armA re-parks */
    plan.countdown = 2;
    plan.parked_line = 0;
    plan.forked = JS_UNDEFINED;
    JS_TTEnableStep(rt, 1);
    {
        JSValue ret = JS_TTCallResume(ctx, 0, &parked);
        if (JS_IsException(ret))
            die(ctx, "armA resume to second fork");
        if (!parked) {
            fprintf(stderr, "FATAL armA did not re-park\n");
            return 1;
        }
        JS_FreeValue(ctx, ret);
    }
    JS_TTEnableStep(rt, 0);
    armC = plan.forked;
    if (!JS_TTParked(ctx) || !JS_TTFlowParked(ctx, armB) ||
        !JS_TTFlowParked(ctx, armC) || !JS_TTFlowParked(ctx, armD)) {
        fprintf(stderr, "FAIL four machines not all suspended\n");
        return 1;
    }
    printf("FORKHERE:legacy + 3 handles suspended concurrently\n");
    {
        JSValue v = JS_NewInt32(ctx, 30);
        if (!JS_TTFlowSetLocal(ctx, armC, 0, name_a, v)) {
            fprintf(stderr, "FAIL inject armC\n");
            return 1;
        }
    }
    JS_FreeAtom(ctx, name_a);

    /* armB runs to completion WHILE the legacy machine stays parked: the
       handle's machine registers install and restore around the run */
    if (JS_TTFlowCheckin(ctx, armB))
        die(ctx, "checkin B2");
    resume_first(ctx, armB, traceB, sizeof(traceB));
    collect_flow(ctx, armB, 0, traceB + strlen(traceB),
                 sizeof(traceB) - strlen(traceB));
    if (!JS_TTParked(ctx)) {
        fprintf(stderr, "FAIL legacy machine lost its park across armB\n");
        return 1;
    }
    printf("FORKHERE:armB completed around the parked machine\n");

    /* armA (the continue-arm) completes: drive() returns its whole trace */
    if (JS_TTFlowCheckin(ctx, g))
        die(ctx, "checkin A3");
    {
        JSValue ret = JS_TTCallResume(ctx, 0, &parked);
        const char *s;
        if (parked || JS_IsException(ret))
            die(ctx, "armA final resume");
        s = JS_ToCString(ctx, ret);
        snprintf(traceA, sizeof(traceA), "%s", s ? s : "?");
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, ret);
    }

    /* armC: its own mark, then its own future */
    if (JS_TTFlowCheckin(ctx, armC))
        die(ctx, "checkin C");
    delta_mark(ctx, armC, "cfg-C");
    resume_first(ctx, armC, traceC, sizeof(traceC));
    collect_flow(ctx, armC, 0, traceC + strlen(traceC),
                 sizeof(traceC) - strlen(traceC));

    printf("TRACE_A:%s\n", traceA);
    printf("TRACE_B:%s\n", traceB);
    printf("TRACE_C:%s\n", traceC);
    assert(strcmp(traceA, traceB) != 0);
    assert(strcmp(traceA, traceC) != 0);
    assert(strcmp(traceB, traceC) != 0);
    assert(strstr(traceA, "delta-view:cfg-A"));
    assert(strstr(traceB, "delta-view:cfg-B"));
    assert(strstr(traceC, "delta-view:cfg-C"));
    printf("FORKHERE:divergent futures ok\n");

    /* (d) the abandoned arm: survives a full GC suspended, then tears
       down leak-free through the state finalizer, never resumed */
    JS_RunGC(rt);
    if (!JS_TTFlowParked(ctx, armD)) {
        fprintf(stderr, "FAIL armD lost its machine across GC\n");
        return 1;
    }
    JS_FreeValue(ctx, armD);
    JS_RunGC(rt);

    JS_FreeValue(ctx, drive_fn);
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, armB);
    JS_FreeValue(ctx, armC);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);       /* the leak oracle: gc_obj_list must drain */
    printf("FORKHERE:teardown ok\n");
    return 0;
}

/* park the standard machine (outer -> yield* inner -> helper under a for-of
   drive, stopped on helper's middle line at k=1) with the delta written and
   checked out -- ready to fork/serialize */
static JSValue park_std_machine(JSContext *ctx, JSRuntime *rt, ParkPlan *plan,
                                JSValue *pdrive_fn)
{
    JSValue g = start_flow(ctx, 2, NULL);
    int parked = 0;
    write_delta(ctx, g);
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout");
    plan->line = baseline_line_of("acc = acc + CONFIG.limit");
    plan->countdown = 1;
    plan->parked_line = 0;
    plan->fork_here = 0;
    plan->forked = JS_UNDEFINED;
    JS_TTSetStepHandler(rt, park_handler, plan);
    JS_TTSetStepFilename(ctx, "baseline.js");
    JS_TTEnableStep(rt, 1);
    *pdrive_fn = get_global(ctx, "drive");
    {
        JSValueConst args[1] = { g };
        JSValue ret = JS_TTCallArgs(ctx, *pdrive_fn, JS_UNDEFINED, 1, args,
                                    &parked);
        if (JS_IsException(ret))
            die(ctx, "drive");
        if (!parked) {
            fprintf(stderr, "FATAL machine did not park\n");
            exit(1);
        }
        JS_FreeValue(ctx, ret);
    }
    JS_TTEnableStep(rt, 0);
    return g;
}

/* mass: N suspended machines forked from one baseline cost the sum of
   their actual chain depths, not N fixed 2 MB slabs -- hard bounds on the
   measured arena RAM, spot resumes, leak-free mass teardown */
#define NMASS 2000
static JSValue mass_arms[NMASS];

static int cmd_mass(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    ParkPlan plan;
    JSValue drive_fn, g;
    size_t tot_used = 0, tot_reserved = 0;
    char t0[2048], t1[2048], t2[2048];
    int i, parked = 0;

    g = park_std_machine(ctx, rt, &plan, &drive_fn);

    for (i = 0; i < NMASS; i++) {
        mass_arms[i] = JS_TTFlowFork(ctx, g);
        if (JS_IsException(mass_arms[i]))
            die(ctx, "mass fork");
    }
    for (i = 0; i < NMASS; i++) {
        size_t used = 0, reserved = 0;
        int segs = 0;
        if (JS_TTFlowMachineStats(ctx, mass_arms[i], &used, &reserved,
                                  &segs)) {
            fprintf(stderr, "FAIL arm %d has no machine\n", i);
            return 1;
        }
        tot_used += used;
        tot_reserved += reserved;
    }
    printf("MASS:%d machines, used=%zu reserved=%zu (%.0f bytes/machine)\n",
           NMASS, tot_used, tot_reserved, (double)tot_reserved / NMASS);
    /* HARD bounds: reserved tracks the chains actually parked -- a small
       multiple of used plus a per-machine sliver -- and sits orders of
       magnitude below N x 2 MB slabs */
    assert(tot_used >= (size_t)NMASS * 200);
    assert(tot_reserved <= 4 * tot_used + (size_t)NMASS * 2048);
    assert(tot_reserved < (size_t)NMASS * (2u * 1024 * 1024) / 100);
    printf("MASS:arena RAM bound ok\n");

    /* spot-resume three arms across the population: identical futures */
    {
        int picks[3] = { 0, NMASS / 2, NMASS - 1 };
        char *bufs[3] = { t0, t1, t2 };
        int k;
        for (k = 0; k < 3; k++) {
            resume_first(ctx, mass_arms[picks[k]], bufs[k], 2048);
            collect_flow(ctx, mass_arms[picks[k]], 0,
                         bufs[k] + strlen(bufs[k]), 2048 - strlen(bufs[k]));
        }
        assert(strcmp(t0, t1) == 0 && strcmp(t1, t2) == 0);
        assert(strstr(t0, "delta-view:"));
    }
    printf("MASS:spot resumes identical ok\n");

    for (i = 0; i < NMASS; i++)
        JS_FreeValue(ctx, mass_arms[i]);
    {   /* discard the legacy machine through the abort path */
        JSValue ret = JS_TTCallResume(ctx, 1, &parked);
        if (parked)
            die(ctx, "abort did not complete");
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    JS_FreeValue(ctx, drive_fn);
    JS_FreeValue(ctx, g);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    printf("MASS:teardown ok\n");
    return 0;
}

/* deep: a chain grown by recursion under the step hook crosses multiple
   arena segments; it still forks, transplants, evicts and resumes
   byte-identically across the segment boundaries */
static int cmd_deep(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    ParkPlan plan;
    JSValue g, drive_fn, armF, armF2, h1, armFh;
    uint8_t *bytes, *ebytes;
    size_t blen, elen, used = 0, reserved = 0;
    int segs = 0, parked = 0;
    char tF2[2048], tH[2048], tHy[2048], ref[4096];

    /* a 60-deep recursion, parked ~30 frames down on the descent */
    {
        JSValue fn = get_global(ctx, "deepflow");
        JSValue arg = JS_NewInt32(ctx, 60);
        g = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&arg);
        if (JS_IsException(g))
            die(ctx, "deepflow()");
        JS_FreeValue(ctx, fn);
    }
    plan.line = baseline_line_of("return rec(n - 1, a) + 0");
    plan.countdown = 30;
    plan.parked_line = 0;
    plan.fork_here = 0;
    plan.forked = JS_UNDEFINED;
    JS_TTSetStepHandler(rt, park_handler, &plan);
    JS_TTSetStepFilename(ctx, "baseline.js");
    JS_TTEnableStep(rt, 1);
    drive_fn = get_global(ctx, "drive");
    {
        JSValueConst args[1] = { g };
        JSValue ret = JS_TTCallArgs(ctx, drive_fn, JS_UNDEFINED, 1, args,
                                    &parked);
        if (JS_IsException(ret))
            die(ctx, "deep drive");
        if (!parked) {
            fprintf(stderr, "FATAL deep machine did not park\n");
            return 1;
        }
        JS_FreeValue(ctx, ret);
    }
    JS_TTEnableStep(rt, 0);

    /* fork the deep chain: the sibling's machine spans several segments */
    armF = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armF))
        die(ctx, "deep fork");
    if (JS_TTFlowMachineStats(ctx, armF, &used, &reserved, &segs)) {
        fprintf(stderr, "FAIL deep fork has no machine\n");
        return 1;
    }
    printf("DEEP:fork used=%zu reserved=%zu segments=%d\n",
           used, reserved, segs);
    assert(segs >= 2);                    /* crosses segment boundaries */
    assert(used >= 4000);                 /* the ~30 rec frames are real */
    assert(reserved <= 3 * used + 4096);  /* demand growth tracks depth */

    bytes = JS_TTFlowSerialize(ctx, g, &blen);   /* the legacy deep chain */
    if (!bytes)
        die(ctx, "deep serialize");
    h1 = JS_TTFlowDeserialize(ctx, bytes, blen);
    if (JS_IsException(h1))
        die(ctx, "deep deserialize");
    js_free(ctx, bytes);
    {
        int s2 = 0;
        if (JS_TTFlowMachineStats(ctx, h1, NULL, NULL, &s2) || s2 < 2) {
            fprintf(stderr, "FAIL transplanted deep machine not segmented\n");
            return 1;
        }
    }

    armF2 = JS_TTFlowFork(ctx, armF);     /* fork ACROSS the boundaries */
    if (JS_IsException(armF2))
        die(ctx, "deep fork-of-fork");

    ebytes = JS_TTMachineEvict(ctx, armF, &elen);
    if (!ebytes)
        die(ctx, "deep evict");
    if (JS_TTFlowParked(ctx, armF)) {
        fprintf(stderr, "FAIL evicted arm still parked\n");
        return 1;
    }
    armFh = JS_TTMachineHydrate(ctx, ebytes, elen);
    if (JS_IsException(armFh))
        die(ctx, "deep hydrate");
    js_free(ctx, ebytes);

    /* reference future: the legacy machine completes drive() -- resuming
       descends 30 more rec levels INSIDE the machine, then unwinds all of
       them; for the handles below, both directions cross segments */
    {
        JSValue ret = JS_TTCallResume(ctx, 0, &parked);
        const char *s;
        if (parked || JS_IsException(ret))
            die(ctx, "deep reference resume");
        s = JS_ToCString(ctx, ret);
        snprintf(ref, sizeof(ref), "%s", s ? s : "?");
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, ret);
    }

    resume_first(ctx, armFh, tHy, sizeof(tHy));
    collect_flow(ctx, armFh, 0, tHy + strlen(tHy),
                 sizeof(tHy) - strlen(tHy));
    resume_first(ctx, h1, tH, sizeof(tH));
    collect_flow(ctx, h1, 0, tH + strlen(tH), sizeof(tH) - strlen(tH));
    resume_first(ctx, armF2, tF2, sizeof(tF2));
    collect_flow(ctx, armF2, 0, tF2 + strlen(tF2),
                 sizeof(tF2) - strlen(tF2));

    printf("DEEP:ref=%s\n", ref);
    printf("DEEP:handle=%s\n", tHy);
    assert(strcmp(tHy, tH) == 0);
    assert(strcmp(tHy, tF2) == 0);
    assert(strstr(tHy, "deep:"));
    {   /* the handles' first step is the very token the reference joined */
        char tok[256];
        size_t j = 0;
        while (tHy[j] && tHy[j] != '|' && j < 255) {
            tok[j] = tHy[j];
            j++;
        }
        tok[j] = 0;
        assert(j > 5 && strstr(ref, tok));
    }
    printf("DEEP:multi-segment resume/fork/evict byte-identical ok\n");

    JS_FreeValue(ctx, drive_fn);
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, armF);
    JS_FreeValue(ctx, armF2);
    JS_FreeValue(ctx, h1);
    JS_FreeValue(ctx, armFh);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    printf("DEEP:teardown ok\n");
    return 0;
}

/* unbounded: remove-the-last-bound oracle. A machine recurses FAR past
   the old 2 MB per-machine arena cap: the legacy machine parks at a
   legacy-safe depth, forks into a handle, and the handle resumes with the
   step hook armed so it descends another forty thousand rec levels INSIDE
   its own arena and re-parks near the bottom -- a ~10+ MB chain spanning
   dozens of never-moved segments. Asserts the footprint really exceeds
   the old cap while reserved RAM still tracks used bytes (the hard
   Σ-depth bound), that serialization is byte-STABLE across the growth
   (serialize -> hydrate -> re-serialize gives identical bytes, and the
   same again through evict -> hydrate), and that two independent
   hydrations resume across every segment boundary -- all the way down and
   all the way back up -- to identical completions. */
#define UNB_TOTAL 46000
#define UNB_LEGACY 6000
static int cmd_unbounded(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    ParkPlan plan;
    JSValue g, drive_fn, armU, h1, hE;
    uint8_t *s1, *s2, *s3, *ev;
    size_t l1, l2, l3, el, used = 0, reserved = 0;
    int segs = 0, parked = 0, done = 0;
    size_t tcap = 256 * 1024;
    char *tr1 = malloc(tcap), *trE = malloc(tcap);

    assert(tr1 && trE);

    {
        JSValue fn = get_global(ctx, "deepflow");
        JSValue arg = JS_NewInt32(ctx, UNB_TOTAL);
        g = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&arg);
        if (JS_IsException(g))
            die(ctx, "deepflow()");
        JS_FreeValue(ctx, fn);
    }

    /* park the legacy machine at a depth its fixed 2 MB arena allows */
    plan.line = baseline_line_of("return rec(n - 1, a) + 0");
    plan.countdown = UNB_LEGACY;
    plan.parked_line = 0;
    plan.fork_here = 0;
    plan.forked = JS_UNDEFINED;
    JS_TTSetStepHandler(rt, park_handler, &plan);
    JS_TTSetStepFilename(ctx, "baseline.js");
    JS_TTEnableStep(rt, 1);
    drive_fn = get_global(ctx, "drive");
    {
        JSValueConst args[1] = { g };
        JSValue ret = JS_TTCallArgs(ctx, drive_fn, JS_UNDEFINED, 1, args,
                                    &parked);
        if (JS_IsException(ret))
            die(ctx, "unbounded drive");
        if (!parked) {
            fprintf(stderr, "FATAL unbounded machine did not park\n");
            return 1;
        }
        JS_FreeValue(ctx, ret);
    }
    JS_TTEnableStep(rt, 0);

    armU = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armU))
        die(ctx, "unbounded fork");

    {   /* discard the legacy machine through the abort path: only the
           handle's own arena carries the recursion from here on */
        JSValue ret = JS_TTCallResume(ctx, 1, &parked);
        if (parked)
            die(ctx, "abort did not complete");
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, JS_GetException(ctx));
    }

    /* resume the handle and let it recurse the remaining ~40 000 levels
       inside its own arena, re-parking near the bottom */
    plan.countdown = UNB_TOTAL - UNB_LEGACY - 200;
    plan.parked_line = 0;
    JS_TTEnableStep(rt, 1);
    {
        JSValue v = JS_TTFlowResumeParked(ctx, armU, 0, &done, &parked);
        if (JS_IsException(v))
            die(ctx, "unbounded deep resume");
        if (!parked) {
            fprintf(stderr, "FATAL handle did not re-park deep\n");
            return 1;
        }
        JS_FreeValue(ctx, v);
    }
    JS_TTEnableStep(rt, 0);

    if (JS_TTFlowMachineStats(ctx, armU, &used, &reserved, &segs)) {
        fprintf(stderr, "FAIL unbounded handle has no machine\n");
        return 1;
    }
    printf("UNBOUNDED:machine used=%zu reserved=%zu segments=%d\n",
           used, reserved, segs);
    assert(used > 2 * (size_t)(2 * 1024 * 1024)); /* far past the old cap */
    assert(segs >= 10);                           /* many never-moved segments */
    assert(reserved <= used + used / 4 + 65536);  /* growth tracks depth: the
                                                     hard bound, with the
                                                     documented <=12.5% slack
                                                     plus one open segment */

    /* byte-stability across the growth: serialize -> hydrate ->
       re-serialize must reproduce the exact bytes */
    s1 = JS_TTFlowSerialize(ctx, armU, &l1);
    if (!s1)
        die(ctx, "unbounded serialize");
    h1 = JS_TTFlowDeserialize(ctx, s1, l1);
    if (JS_IsException(h1))
        die(ctx, "unbounded deserialize");
    s2 = JS_TTFlowSerialize(ctx, h1, &l2);
    if (!s2)
        die(ctx, "unbounded re-serialize");
    if (l1 != l2 || memcmp(s1, s2, l1) != 0) {
        fprintf(stderr, "FAIL re-serialization differs (%zu vs %zu bytes)\n",
                l1, l2);
        return 1;
    }
    printf("UNBOUNDED:re-serialization byte-identical (%zu bytes)\n", l1);

    /* ... and the same through a full evict -> hydrate cycle */
    ev = JS_TTMachineEvict(ctx, armU, &el);
    if (!ev)
        die(ctx, "unbounded evict");
    hE = JS_TTMachineHydrate(ctx, ev, el);
    if (JS_IsException(hE))
        die(ctx, "unbounded hydrate");
    js_free(ctx, ev);
    s3 = JS_TTFlowSerialize(ctx, hE, &l3);
    if (!s3)
        die(ctx, "unbounded post-evict serialize");
    if (l1 != l3 || memcmp(s1, s3, l1) != 0) {
        fprintf(stderr, "FAIL evict/hydrate serialization differs "
                "(%zu vs %zu bytes)\n", l1, l3);
        return 1;
    }
    printf("UNBOUNDED:evict/hydrate byte-stable (%zu bytes)\n", el);
    js_free(ctx, s1);
    js_free(ctx, s2);
    js_free(ctx, s3);

    /* two independent hydrations unwind every level and every segment
       boundary back up to identical completions */
    resume_first(ctx, h1, tr1, tcap);
    collect_flow(ctx, h1, 0, tr1 + strlen(tr1), tcap - strlen(tr1));
    resume_first(ctx, hE, trE, tcap);
    collect_flow(ctx, hE, 0, trE + strlen(trE), tcap - strlen(trE));
    if (strcmp(tr1, trE) != 0) {
        fprintf(stderr, "FAIL hydrated futures diverge\n");
        return 1;
    }
    assert(strstr(tr1, "deep:"));
    assert(strstr(tr1, "deep-done:"));
    printf("UNBOUNDED:futures identical, %zu trace bytes\n", strlen(tr1));

    free(tr1);
    free(trE);
    JS_FreeValue(ctx, drive_fn);
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, armU);
    JS_FreeValue(ctx, h1);
    JS_FreeValue(ctx, hE);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    printf("PASS: unbounded machine arena (depth %d, past-cap growth, "
           "byte-stable)\n", UNB_TOTAL);
    return 0;
}

/* evict: a suspended machine round-trips through bytes -- freed, hydrated,
   resumed byte-identically -- without disturbing its siblings; the live
   legacy machine refuses; plain yield-suspended flows evict too */
static int cmd_evict(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    ParkPlan plan;
    JSValue g, drive_fn, armX, armY, armX2;
    uint8_t *ebytes;
    size_t elen;
    JSAtom name_a;
    char tX[2048], tY[2048];
    int parked = 0;

    g = park_std_machine(ctx, rt, &plan, &drive_fn);

    armX = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armX))
        die(ctx, "fork armX");
    armY = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armY))
        die(ctx, "fork armY");

    /* identical injections into the twins BEFORE eviction: the injected
       local must travel in the bytes */
    name_a = JS_NewAtom(ctx, "a");
    {
        JSValue v = JS_NewInt32(ctx, 20);
        if (!JS_TTFlowSetLocal(ctx, armX, 0, name_a, v) ||
            !JS_TTFlowSetLocal(ctx, armY, 0, name_a, v)) {
            fprintf(stderr, "FAIL twin injection\n");
            return 1;
        }
    }
    JS_FreeAtom(ctx, name_a);

    /* the live legacy machine refuses to evict */
    {
        size_t l0;
        uint8_t *b0 = JS_TTMachineEvict(ctx, g, &l0);
        assert(b0 == NULL);
        JS_FreeValue(ctx, JS_GetException(ctx));
    }

    ebytes = JS_TTMachineEvict(ctx, armX, &elen);
    if (!ebytes)
        die(ctx, "evict armX");
    printf("EVICT:armX -> %zu bytes\n", elen);
    /* the evicted handle is a completed husk; its siblings are untouched */
    assert(!JS_TTFlowParked(ctx, armX));
    assert(JS_TTFlowParked(ctx, armY));
    assert(JS_TTParked(ctx));

    armX2 = JS_TTMachineHydrate(ctx, ebytes, elen);
    if (JS_IsException(armX2))
        die(ctx, "hydrate armX");
    js_free(ctx, ebytes);
    assert(JS_TTFlowParked(ctx, armX2));

    if (JS_TTFlowCheckin(ctx, armX2))
        die(ctx, "checkin armX2");
    resume_first(ctx, armX2, tX, sizeof(tX));
    collect_flow(ctx, armX2, 0, tX + strlen(tX), sizeof(tX) - strlen(tX));
    if (JS_TTFlowCheckin(ctx, armY))
        die(ctx, "checkin armY");
    resume_first(ctx, armY, tY, sizeof(tY));
    collect_flow(ctx, armY, 0, tY + strlen(tY), sizeof(tY) - strlen(tY));

    printf("EVICT:trace=%s\n", tX);
    assert(strcmp(tX, tY) == 0);   /* byte-identical future across eviction */
    assert(strstr(tX, "delta-view:cfg-flow"));
    printf("EVICT:hydrated future byte-identical to its twin ok\n");

    /* a plain yield-suspended flow evicts too */
    {
        JSValue g2 = start_flow(ctx, 3, NULL), g2h;
        uint8_t *e2;
        size_t l2;
        char t2[2048];
        write_delta(ctx, g2);
        if (JS_TTFlowCheckout(ctx, g2))
            die(ctx, "checkout g2");
        e2 = JS_TTMachineEvict(ctx, g2, &l2);
        if (!e2)
            die(ctx, "evict g2");
        g2h = JS_TTMachineHydrate(ctx, e2, l2);
        if (JS_IsException(g2h))
            die(ctx, "hydrate g2");
        js_free(ctx, e2);
        if (JS_TTFlowCheckin(ctx, g2h))
            die(ctx, "checkin g2h");
        collect_flow(ctx, g2h, 0, t2, sizeof(t2));
        assert(strstr(t2, "after-inner:"));
        JS_FreeValue(ctx, g2);
        JS_FreeValue(ctx, g2h);
    }
    printf("EVICT:yield-suspended eviction ok\n");

    {   /* discard the legacy machine */
        JSValue ret = JS_TTCallResume(ctx, 1, &parked);
        if (parked)
            die(ctx, "abort did not complete");
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    JS_FreeValue(ctx, drive_fn);
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, armX);
    JS_FreeValue(ctx, armY);
    JS_FreeValue(ctx, armX2);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    printf("EVICT:teardown ok\n");
    return 0;
}

/* drain the (checked-in) flow's live queue; parked job callbacks finish as
   their own sub-machines. Returns jobs run; *psub counts the parked ones. */
static int pump_all(JSContext *ctx, JSRuntime *rt, int *psub)
{
    int fired = 0;
    for (;;) {
        int pk = 0;
        int r = JS_TTPumpJob(rt, NULL, &pk);
        if (pk) {
            int pk2 = 1;
            while (pk2) {
                JSValue v = JS_TTCallResume(ctx, 0, &pk2);
                JS_FreeValue(ctx, v);
            }
            if (psub)
                (*psub)++;
            fired++;
            continue;
        }
        if (r < 0)
            die(ctx, "job raised");
        if (r == 0)
            break;
        fired++;
    }
    return fired;
}

static JSValue eval_val(JSContext *ctx, const char *expr)
{
    JSValue v = JS_Eval(ctx, expr, strlen(expr), "probe.js",
                        JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v))
        die(ctx, expr);
    return v;
}

/* settle an await-suspended arm through ITS OWN cloned resolver (read out
   of the suspended frame) and pump its queue dry */
static void settle_arm(JSContext *ctx, JSRuntime *rt, JSValueConst arm,
                       const char *rname, JSValueConst v, int *psub)
{
    JSAtom a = JS_NewAtom(ctx, rname);
    JSValue r = JS_TTFlowGetLocal(ctx, arm, 0, a);
    JSValue ret;
    JS_FreeAtom(ctx, a);
    if (!JS_IsFunction(ctx, r))
        die(ctx, "arm resolver not found");
    ret = JS_Call(ctx, r, JS_UNDEFINED, 1, &v);
    if (JS_IsException(ret))
        die(ctx, "settle");
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, r);
    pump_all(ctx, rt, psub);
}

/* async flows: per-flow job queues, promise-graph fork, await fork with
   diverging settles, for-await fork, evict/hydrate with a pending
   microtask */
static int cmd_asynctest(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    ParkPlan plan;
    JSAtom atom_r;
    int subparks = 0;

    atom_r = JS_NewAtom(ctx, "r");
    plan.line = baseline_line_of("SINK.push(tag");
    plan.countdown = 1;
    plan.parked_line = 0;
    plan.fork_here = 0;
    plan.forked = JS_UNDEFINED;
    JS_TTSetStepHandler(rt, park_handler, &plan);
    JS_TTSetStepFilename(ctx, "baseline.js");

    /* ---- (a) an async function suspended at `await p` forks; the arms
       settle p independently and diverge; a .then chained after the await
       runs as its own parked sub-flow in each arm ---- */
    {
        JSValue af_fn = get_global(ctx, "af");
        JSValue arg = JS_NewInt32(ctx, 7);
        JSValue g, armA, armB, thenret, sinkfn, sv;
        g = JS_Call(ctx, af_fn, JS_UNDEFINED, 1, (JSValueConst *)&arg);
        if (JS_IsException(g))
            die(ctx, "af()");
        JS_FreeValue(ctx, af_fn);
        assert(JS_PromiseState(ctx, g) == JS_PROMISE_PENDING);
        write_delta(ctx, g);            /* delta through the promise handle */
        if (JS_TTFlowCheckout(ctx, g))
            die(ctx, "checkout af");
        armA = JS_TTFlowFork(ctx, g);
        if (JS_IsException(armA))
            die(ctx, "fork armA");
        armB = JS_TTFlowFork(ctx, g);
        if (JS_IsException(armB))
            die(ctx, "fork armB");
        printf("ASYNC:await-suspended flow forked twice\n");

        /* arm A: its own delta mark, its own observer, its own settle */
        if (JS_TTFlowCheckin(ctx, armA))
            die(ctx, "checkin armA");
        delta_mark(ctx, armA, "cfg-A");
        sinkfn = eval_val(ctx, "sink('A')");
        thenret = JS_Invoke(ctx, armA, JS_NewAtom(ctx, "then"), 1,
                            (JSValueConst *)&sinkfn);
        if (JS_IsException(thenret))
            die(ctx, "then armA");
        JS_FreeValue(ctx, thenret);
        JS_FreeValue(ctx, sinkfn);
        plan.countdown = 1;
        JS_TTEnableStep(rt, 1);         /* the sink handler parks mid-run */
        sv = JS_NewString(ctx, "ax");
        settle_arm(ctx, rt, armA, "r", sv, &subparks);
        JS_FreeValue(ctx, sv);
        JS_TTEnableStep(rt, 0);
        assert(JS_PromiseState(ctx, armA) == JS_PROMISE_FULFILLED);

        /* arm B sees the fork-time delta view, not arm A's mark */
        if (JS_TTFlowCheckin(ctx, armB))
            die(ctx, "checkin armB");
        expect_str(ctx, "CONFIG.tag", "cfg-flow",
                   "armB inherits the fork-time view");
        delta_mark(ctx, armB, "cfg-B");
        sinkfn = eval_val(ctx, "sink('B')");
        thenret = JS_Invoke(ctx, armB, JS_NewAtom(ctx, "then"), 1,
                            (JSValueConst *)&sinkfn);
        if (JS_IsException(thenret))
            die(ctx, "then armB");
        JS_FreeValue(ctx, thenret);
        JS_FreeValue(ctx, sinkfn);
        plan.countdown = 1;
        JS_TTEnableStep(rt, 1);
        sv = JS_NewString(ctx, "bx");
        settle_arm(ctx, rt, armB, "r", sv, &subparks);
        JS_FreeValue(ctx, sv);
        JS_TTEnableStep(rt, 0);
        assert(JS_PromiseState(ctx, armB) == JS_PROMISE_FULFILLED);

        assert(subparks >= 2);          /* one parked sub-flow per arm */
        expect_str(ctx, "SINK.join('|')",
                   "A:af7:got=ax:cfg-A|B:af7:got=bx:cfg-B",
                   "diverging await continuations, isolated deltas, "
                   "per-arm sub-flows");
        printf("ASYNC:await fork diverges, deltas isolated, "
               "%d parked sub-flows\n", subparks);

        JS_FreeValue(ctx, g);           /* parent: still suspended, dropped */
        JS_FreeValue(ctx, armA);
        JS_FreeValue(ctx, armB);
    }

    /* ---- (b) for-await over an async iterator, parked mid-loop, forks;
       both arms iterate independently ---- */
    {
        JSValue ait = eval_val(ctx, "mk_ait()");
        JSValue loopy_fn = get_global(ctx, "loopy");
        JSValue lp, bA, bB;
        JSAtom atom_ait = JS_NewAtom(ctx, "ait");
        JSAtom atom_feed = JS_NewAtom(ctx, "feed");
        int k;
        lp = JS_Call(ctx, loopy_fn, JS_UNDEFINED, 1, (JSValueConst *)&ait);
        if (JS_IsException(lp))
            die(ctx, "loopy()");
        JS_FreeValue(ctx, loopy_fn);
        assert(JS_PromiseState(ctx, lp) == JS_PROMISE_PENDING);
        if (JS_TTFlowCheckout(ctx, lp))
            die(ctx, "checkout loopy");
        bA = JS_TTFlowFork(ctx, lp);
        if (JS_IsException(bA))
            die(ctx, "fork bA");
        bB = JS_TTFlowFork(ctx, lp);
        if (JS_IsException(bB))
            die(ctx, "fork bB");
        for (k = 0; k < 2; k++) {
            JSValue arm = k == 0 ? bA : bB;
            const char *v1 = k == 0 ? "a1" : "b1";
            const char *v2 = k == 0 ? "a2" : "b2";
            const char *want = k == 0 ? "a1+a2" : "b1+b2";
            int step;
            if (JS_TTFlowCheckin(ctx, arm))
                die(ctx, "checkin b-arm");
            for (step = 0; step < 2; step++) {
                JSValue it = JS_TTFlowGetLocal(ctx, arm, 0, atom_ait);
                JSValue feed = JS_GetProperty(ctx, it, atom_feed);
                JSValue res = JS_NewObject(ctx);
                JSValue ret;
                if (!JS_IsFunction(ctx, feed))
                    die(ctx, "arm feed not found");
                JS_SetPropertyStr(ctx, res, "value",
                                  JS_NewString(ctx, step ? v2 : v1));
                JS_SetPropertyStr(ctx, res, "done", JS_NewBool(ctx, 0));
                ret = JS_Call(ctx, feed, JS_UNDEFINED, 1,
                              (JSValueConst *)&res);
                if (JS_IsException(ret))
                    die(ctx, "feed");
                JS_FreeValue(ctx, ret);
                JS_FreeValue(ctx, res);
                JS_FreeValue(ctx, feed);
                JS_FreeValue(ctx, it);
                pump_all(ctx, rt, NULL);
            }
            assert(JS_PromiseState(ctx, arm) == JS_PROMISE_FULFILLED);
            {
                JSValue rv = JS_PromiseResult(ctx, arm);
                const char *s = JS_ToCString(ctx, rv);
                if (strcmp(s, want)) {
                    fprintf(stderr, "FAIL for-await arm: %s != %s\n", s,
                            want);
                    return 1;
                }
                JS_FreeCString(ctx, s);
                JS_FreeValue(ctx, rv);
            }
            if (k == 0)
                assert(JS_PromiseState(ctx, bB) == JS_PROMISE_PENDING);
        }
        printf("ASYNC:for-await arms iterate independently\n");
        JS_FreeAtom(ctx, atom_ait);
        JS_FreeAtom(ctx, atom_feed);
        JS_FreeValue(ctx, ait);
        JS_FreeValue(ctx, lp);
        JS_FreeValue(ctx, bA);
        JS_FreeValue(ctx, bB);
    }

    /* ---- (c) evict an await-suspended flow with a queued microtask to
       bytes, free, hydrate, pump: byte-identical continuation, the
       microtask fires exactly once per living copy ---- */
    {
        JSValue mf_fn = get_global(ctx, "mf");
        JSValue mh, tw, h2, sv;
        uint8_t *eb;
        size_t el;
        char res_tw[256], res_h2[256];
        mh = JS_Call(ctx, mf_fn, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(mh))
            die(ctx, "mf()");
        JS_FreeValue(ctx, mf_fn);
        if (JS_TTFlowCheckout(ctx, mh))   /* captures the pending micro job */
            die(ctx, "checkout mf");
        tw = JS_TTFlowFork(ctx, mh);      /* control twin, queue copied */
        if (JS_IsException(tw))
            die(ctx, "fork twin");
        eb = JS_TTMachineEvict(ctx, mh, &el);
        if (!eb)
            die(ctx, "evict mf");
        printf("ASYNC:await+microtask evicted to %u bytes\n", (unsigned)el);
        h2 = JS_TTMachineHydrate(ctx, eb, el);
        if (JS_IsException(h2))
            die(ctx, "hydrate mf");
        js_free(ctx, eb);

        if (JS_TTFlowCheckin(ctx, tw))
            die(ctx, "checkin twin");
        pump_all(ctx, rt, NULL);          /* the twin's micro fires once */
        sv = JS_NewString(ctx, "tv");
        settle_arm(ctx, rt, tw, "r", sv, NULL);
        JS_FreeValue(ctx, sv);
        {
            JSValue rv = JS_PromiseResult(ctx, tw);
            const char *s = JS_ToCString(ctx, rv);
            snprintf(res_tw, sizeof(res_tw), "%s", s ? s : "?");
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, rv);
        }
        if (JS_TTFlowCheckin(ctx, h2))
            die(ctx, "checkin hydrated");
        pump_all(ctx, rt, NULL);          /* the hydrated micro fires once */
        sv = JS_NewString(ctx, "tv");
        settle_arm(ctx, rt, h2, "r", sv, NULL);
        JS_FreeValue(ctx, sv);
        {
            JSValue rv = JS_PromiseResult(ctx, h2);
            const char *s = JS_ToCString(ctx, rv);
            snprintf(res_h2, sizeof(res_h2), "%s", s ? s : "?");
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, rv);
        }
        printf("ASYNC:twin=%s hydrated=%s\n", res_tw, res_h2);
        assert(strcmp(res_tw, res_h2) == 0);
        assert(strcmp(res_tw, "mf:got=tv") == 0);
        /* two living copies ran, one micro each; the evicted original's
           captured job was serialized then freed unfired */
        expect_str(ctx, "MLOG.join(',')", "micro:m,micro:m",
                   "the microtask fired exactly once per copy");
        printf("ASYNC:evict/hydrate continuation byte-identical, "
               "microtask fired once\n");
        JS_FreeValue(ctx, mh);
        JS_FreeValue(ctx, tw);
        JS_FreeValue(ctx, h2);
    }

    JS_FreeAtom(ctx, atom_r);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);       /* the leak oracle */
    printf("ASYNC:teardown ok\n");
    return 0;
}

/* one next(arg) on a generator flow, its .value stringified into buf */
static void next_str(JSContext *ctx, JSValueConst g, JSValueConst arg,
                     char *buf, size_t cap)
{
    JSValue r = JS_Invoke(ctx, (JSValue)g, JS_NewAtom(ctx, "next"), 1,
                          (JSValueConst *)&arg);
    JSValue val;
    const char *s;
    if (JS_IsException(r))
        die(ctx, "next(arg)");
    val = JS_GetPropertyStr(ctx, r, "value");
    s = JS_ToCString(ctx, val);
    snprintf(buf, cap, "%s", s ? s : "?");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, val);
    JS_FreeValue(ctx, r);
}

/* automatic transparent COW: ordinary program writes to shared objects
   are captured per flow -- no host DeltaWrite calls anywhere below */
static int cmd_cowtest(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue g, armA, armB, h, feed;
    uint8_t *bytes;
    size_t blen;
    void *shobj_ptr;
    char out[512];

    {   /* start cowflow to its "ready" yield */
        JSValue fn = get_global(ctx, "cowflow");
        g = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(g))
            die(ctx, "cowflow()");
        JS_FreeValue(ctx, fn);
        next_str(ctx, g, JS_UNDEFINED, out, sizeof(out));
        assert(strcmp(out, "ready") == 0);
    }
    {
        JSValue o = eval_val(ctx, "SHOBJ");
        shobj_ptr = JS_VALUE_GET_PTR(o);
        JS_FreeValue(ctx, o);
    }
    if (JS_TTFlowCheckout(ctx, g))
        die(ctx, "checkout");
    armA = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armA))
        die(ctx, "fork armA");
    armB = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armB))
        die(ctx, "fork armB");

    /* arm A writes shared state in ORDINARY program code */
    if (JS_TTFlowCheckin(ctx, armA))
        die(ctx, "checkin armA");
    feed = JS_NewInt32(ctx, 1);
    next_str(ctx, armA, feed, out, sizeof(out));
    assert(strcmp(out, "wrote:11:arm1:1") == 0);
    expect_str(ctx, "SHOBJ.x", "11", "armA view live");
    expect_str(ctx, "SHARR.join(',')", "arm1", "armA array view");
    {   /* shared identity: the very same object, isolated value */
        JSValue o = eval_val(ctx, "SHOBJ");
        assert(JS_VALUE_GET_PTR(o) == shobj_ptr);
        JS_FreeValue(ctx, o);
    }
    assert(JS_TTFlowDeltaCount(ctx, armA) == 3);  /* SHOBJ, SHARR, SHP */
    {   /* dedup: a second write to a captured cell allocates NOTHING */
        JSMemoryUsage m0, m1;
        JSValue shobj = eval_val(ctx, "SHOBJ");
        JS_ComputeMemoryUsage(rt, &m0);
        JS_SetPropertyStr(ctx, shobj, "x", JS_NewInt32(ctx, 11));
        JS_ComputeMemoryUsage(rt, &m1);
        assert(m1.malloc_count == m0.malloc_count);
        assert(JS_TTFlowDeltaCount(ctx, armA) == 3);
        JS_FreeValue(ctx, shobj);
    }
    if (JS_TTFlowCheckout(ctx, armA))
        die(ctx, "checkout armA");
    expect_str(ctx, "SHOBJ.x", "0", "baseline pristine after armA");
    expect_str(ctx, "SHARR.length", "0", "baseline array pristine");
    printf("COW:armA isolated, baseline pristine, dedup alloc-free\n");

    /* arm B: only its own writes, blind to armA's */
    if (JS_TTFlowCheckin(ctx, armB))
        die(ctx, "checkin armB");
    feed = JS_NewInt32(ctx, 2);
    next_str(ctx, armB, feed, out, sizeof(out));
    assert(strcmp(out, "wrote:12:arm2:1") == 0);
    if (JS_TTFlowCheckout(ctx, armB))
        die(ctx, "checkout armB");
    expect_str(ctx, "SHOBJ.x", "0", "baseline pristine after armB");
    expect_str(ctx, "SHARR.length", "0", "baseline array pristine 2");
    printf("COW:armB isolated from armA\n");

    /* auto-captured delta round-trips the wire: PROP + ARRAY + PROMISE */
    bytes = JS_TTFlowSerialize(ctx, armB, &blen);
    if (!bytes)
        die(ctx, "serialize armB");
    printf("COW:armB auto-delta -> %u bytes\n", (unsigned)blen);
    h = JS_TTFlowDeserialize(ctx, bytes, blen);
    if (JS_IsException(h))
        die(ctx, "hydrate armB");
    js_free(ctx, bytes);
    JS_FreeValue(ctx, armB);          /* the hydrated copy takes its place */
    if (JS_TTFlowCheckin(ctx, h))
        die(ctx, "checkin h");
    expect_str(ctx, "SHOBJ.x", "12", "hydrated auto-delta view");
    expect_str(ctx, "SHARR.join(',')", "arm2", "hydrated array view");
    if (JS_TTFlowCheckout(ctx, h))
        die(ctx, "checkout h");
    expect_str(ctx, "SHOBJ.x", "0", "pristine after hydrated view");
    printf("COW:auto-captured delta round-tripped\n");

    /* the promise oracle: both arms hold a .then on baseline SHP; each
       settle fires ONLY that arm's reaction (reaction lists, the settled
       state, and the capability's resolved flag all ride the delta) */
    if (JS_TTFlowCheckin(ctx, armA))
        die(ctx, "checkin armA 2");
    JS_FreeValue(ctx, eval_val(ctx, "SHP_RES('sv')"));
    pump_all(ctx, rt, NULL);
    expect_str(ctx, "SINK.join(',')", "p1:sv", "armA ran only its reaction");
    if (JS_TTFlowCheckout(ctx, armA))
        die(ctx, "checkout armA 2");
    expect_str(ctx, "SINK.length", "0", "SINK pristine between arms");
    if (JS_TTFlowCheckin(ctx, h))
        die(ctx, "checkin h 2");
    JS_FreeValue(ctx, eval_val(ctx, "SHP_RES('sw')"));
    pump_all(ctx, rt, NULL);
    expect_str(ctx, "SINK.join(',')", "p2:sw", "h ran only its reaction");
    if (JS_TTFlowCheckout(ctx, h))
        die(ctx, "checkout h 2");
    expect_str(ctx, "SINK.length", "0", "SINK pristine at the end");
    printf("COW:per-arm promise reactions (the #4 oracle)\n");

    /* completion while checked in commits; the last commit wins */
    if (JS_TTFlowCheckin(ctx, armA))
        die(ctx, "checkin armA 3");
    feed = JS_NewString(ctx, "za");
    next_str(ctx, armA, feed, out, sizeof(out));
    JS_FreeValue(ctx, feed);
    assert(strcmp(out, "done:11:za") == 0);
    if (JS_TTFlowCheckin(ctx, h))
        die(ctx, "checkin h 3");
    feed = JS_NewString(ctx, "zb");
    next_str(ctx, h, feed, out, sizeof(out));
    JS_FreeValue(ctx, feed);
    assert(strcmp(out, "done:12:zb") == 0);
    expect_str(ctx, "SHOBJ.x", "12", "last commit wins");
    expect_str(ctx, "SHARR.join(',')", "arm2", "last array commit wins");
    printf("COW:completion commits\n");

    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, armA);
    JS_FreeValue(ctx, h);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);       /* the leak oracle */
    printf("COW:teardown ok\n");
    return 0;
}

/* -- taggedtest: payload + host note as a first-class round-tripper ------- */

/* the note is a malloc'd C string; the counters are the oracle: every hook
   call is counted and tg_live tracks blobs the host still owes a free() */
static int tg_clones, tg_serializes, tg_deserializes, tg_frees, tg_live;

static void *tg_note_clone(JSRuntime *rt, void *note)
{
    char *c = strdup((char *)note);
    (void)rt;
    if (!c)
        return NULL;
    tg_clones++;
    tg_live++;
    return c;
}

static int tg_note_serialize(JSRuntime *rt, void *note, DynBuf *db)
{
    (void)rt;
    tg_serializes++;
    return dbuf_put(db, (const uint8_t *)note, strlen((char *)note) + 1);
}

static void *tg_note_deserialize(JSRuntime *rt, const uint8_t *buf, size_t len)
{
    char *c;
    (void)rt;
    if (len == 0 || len > 4096 || buf[len - 1] != '\0')
        return NULL;          /* reject malformed blobs loudly */
    c = malloc(len);
    if (!c)
        return NULL;
    memcpy(c, buf, len);
    tg_deserializes++;
    tg_live++;
    return c;
}

static void tg_note_free(JSRuntime *rt, void *note)
{
    (void)rt;
    tg_frees++;
    tg_live--;
    free(note);
}

static void tg_set_hooks(JSRuntime *rt)
{
    JS_TTSetNoteHooks(rt, tg_note_clone, tg_note_serialize,
                      tg_note_deserialize, tg_note_free);
}

static int tg_payload_a(JSContext *ctx, JSValueConst tagged)
{
    JSValue p = JS_TTPayload(ctx, tagged);
    JSValue av;
    int32_t a = -1;
    if (JS_IsException(p))
        die(ctx, "JS_TTPayload");
    av = JS_GetPropertyStr(ctx, p, "a");
    if (JS_ToInt32(ctx, &a, av))
        die(ctx, "payload.a");
    JS_FreeValue(ctx, av);
    JS_FreeValue(ctx, p);
    return (int)a;
}

static void tg_payload_set_a(JSContext *ctx, JSValueConst tagged, int v)
{
    JSValue p = JS_TTPayload(ctx, tagged);
    if (JS_IsException(p))
        die(ctx, "JS_TTPayload");
    if (JS_SetPropertyStr(ctx, p, "a", JS_NewInt32(ctx, v)) < 0)
        die(ctx, "set payload.a");
    JS_FreeValue(ctx, p);
}

/* start tflow() and advance it to the "t0" yield */
static JSValue tg_start_tflow(JSContext *ctx)
{
    JSValue g = eval_val(ctx, "tflow()");
    JSValue r = JS_Invoke(ctx, g, JS_NewAtom(ctx, "next"), 0, NULL);
    if (JS_IsException(r))
        die(ctx, "tflow next");
    JS_FreeValue(ctx, r);
    return g;
}

static int cmd_taggedtest(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSValue t, tnil, g, g2, g3, gh, armA, armB, tP, tA, tB, t2, th;
    JSAtom at_t, at_u;
    char *H;
    void *nA, *nB;
    uint8_t *bytes;
    size_t blen;

    tg_clones = tg_serializes = tg_deserializes = tg_frees = tg_live = 0;
    tg_set_hooks(rt);
    at_t = JS_NewAtom(ctx, "t");
    at_u = JS_NewAtom(ctx, "u");

    /* --- the value itself: make, inspect, nest ------------------------- */
    H = strdup("H-note-1");
    assert(H);
    tg_live++;                /* H enters the accounting by hand */
    t = JS_TTMakeTagged(ctx, eval_val(ctx, "({a:1})"), H);
    if (JS_IsException(t))
        die(ctx, "JS_TTMakeTagged");
    assert(JS_TTIsTagged(t));
    assert(JS_TTNote(t) == H);
    assert(tg_payload_a(ctx, t) == 1);
    {
        /* payload dups preserve identity */
        JSValue p1 = JS_TTPayload(ctx, t), p2 = JS_TTPayload(ctx, t);
        assert(JS_VALUE_GET_PTR(p1) == JS_VALUE_GET_PTR(p2));
        JS_FreeValue(ctx, p1);
        JS_FreeValue(ctx, p2);
    }
    {
        /* --- JS_TTNarrow: replace the pair in place --------------------- */
        char *N1 = strdup("N-narrow-1"), *N2 = strdup("N-narrow-2");
        JSValue tn, tn2;
        int live0;
        int32_t v = 0;
        assert(N1 && N2);
        tg_live += 2;                        /* N1, N2 enter accounting */
        tn = JS_TTMakeTagged(ctx, JS_NewInt32(ctx, 5), N1);
        if (JS_IsException(tn))
            die(ctx, "narrow: make");
        /* narrow 5/N1 -> 9/N2: old int payload dropped, N1 freed exactly once */
        live0 = tg_live;
        if (JS_TTNarrow(ctx, tn, JS_NewInt32(ctx, 9), N2) < 0)
            die(ctx, "JS_TTNarrow");
        assert(tg_live == live0 - 1);        /* N1 released; N2 already counted */
        assert(JS_TTNote(tn) == N2);
        {
            JSValue p = JS_TTPayload(ctx, tn);
            JS_ToInt32(ctx, &v, p);
            JS_FreeValue(ctx, p);
            assert(v == 9);
        }
        /* independence: narrowing tn does not touch a second tagged value */
        tn2 = JS_TTMakeTagged(ctx, JS_NewInt32(ctx, 1), NULL);
        if (JS_IsException(tn2))
            die(ctx, "narrow: make2");
        if (JS_TTNarrow(ctx, tn, JS_NewInt32(ctx, 100), NULL) < 0)
            die(ctx, "JS_TTNarrow 2");       /* frees N2; tn's note now NULL */
        {
            JSValue p = JS_TTPayload(ctx, tn2);
            v = 0; JS_ToInt32(ctx, &v, p);
            JS_FreeValue(ctx, p);
            assert(v == 1);                  /* tn2 unchanged */
        }
        /* refuse loudly on a non-tagged value, freeing the caller's new pair */
        {
            char *NR = strdup("N-refused");
            JSValue plain = eval_val(ctx, "({})");
            assert(NR);
            tg_live++;                       /* NR enters accounting */
            live0 = tg_live;
            assert(JS_TTNarrow(ctx, plain, JS_NewInt32(ctx, 7), NR) == -1);
            assert(tg_live == live0 - 1);    /* NR freed on the refusal path */
            JS_FreeValue(ctx, JS_GetException(ctx));
            JS_FreeValue(ctx, plain);
        }
        JS_FreeValue(ctx, tn);               /* note already NULL: nothing owed */
        JS_FreeValue(ctx, tn2);
    }
    {
        /* non-tagged probes answer, they do not crash */
        JSValue plain = eval_val(ctx, "({})");
        JSValue e;
        assert(!JS_TTIsTagged(plain));
        assert(JS_TTNote(plain) == NULL);
        e = JS_TTPayload(ctx, plain);
        assert(JS_IsException(e));
        JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, plain);
    }
    {
        /* nesting: a tagged value is a concrete payload like any other */
        JSValue inner = JS_TTMakeTagged(ctx, JS_NewInt32(ctx, 5), NULL);
        JSValue outer2 = JS_TTMakeTagged(ctx, inner, NULL);
        JSValue got = JS_TTPayload(ctx, outer2);
        assert(JS_TTIsTagged(got));
        JS_FreeValue(ctx, got);
        JS_FreeValue(ctx, outer2);  /* frees inner through the payload edge */
    }
    {
        /* a payload<->tagged cycle collects through the mark edge */
        JSValue cp = eval_val(ctx, "({})");
        JSValue ct = JS_TTMakeTagged(ctx, JS_DupValue(ctx, cp), NULL);
        if (JS_IsException(ct))
            die(ctx, "cycle make");
        if (JS_SetPropertyStr(ctx, cp, "cyc", JS_DupValue(ctx, ct)) < 0)
            die(ctx, "cycle prop");
        JS_FreeValue(ctx, cp);
        JS_FreeValue(ctx, ct);
        JS_RunGC(rt);
    }
    printf("TAGGED:make/inspect/nest/gc-cycle ok\n");

    /* --- a suspended flow holds t in a local; fork the flow ------------ */
    g = tg_start_tflow(ctx);
    if (!JS_TTFlowSetLocal(ctx, g, 0, at_t, t)) {
        fprintf(stderr, "FAIL: inject t into tflow\n");
        return 1;
    }
    armA = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armA))
        die(ctx, "fork armA");
    armB = JS_TTFlowFork(ctx, g);
    if (JS_IsException(armB))
        die(ctx, "fork armB");
    assert(tg_clones == 2);   /* one NoteClone per arm */

    tP = JS_TTFlowGetLocal(ctx, g, 0, at_t);
    tA = JS_TTFlowGetLocal(ctx, armA, 0, at_t);
    tB = JS_TTFlowGetLocal(ctx, armB, 0, at_t);
    assert(JS_TTIsTagged(tP) && JS_TTIsTagged(tA) && JS_TTIsTagged(tB));
    /* the parent's local IS t; each arm's is an independent value */
    assert(JS_VALUE_GET_PTR(tP) == JS_VALUE_GET_PTR(t));
    assert(JS_VALUE_GET_PTR(tA) != JS_VALUE_GET_PTR(t));
    assert(JS_VALUE_GET_PTR(tB) != JS_VALUE_GET_PTR(t));
    assert(JS_VALUE_GET_PTR(tA) != JS_VALUE_GET_PTR(tB));
    nA = JS_TTNote(tA);
    nB = JS_TTNote(tB);
    assert(nA && nB && nA != H && nB != H && nA != nB);
    assert(strcmp((char *)nA, "H-note-1") == 0);
    assert(strcmp((char *)nB, "H-note-1") == 0);
    /* a payload mutation in one arm touches nobody else */
    tg_payload_set_a(ctx, tA, 99);
    assert(tg_payload_a(ctx, tA) == 99);
    assert(tg_payload_a(ctx, tB) == 1);
    assert(tg_payload_a(ctx, tP) == 1);
    assert(tg_payload_a(ctx, t) == 1);
    printf("TAGGED:fork independence ok (NoteClone x%d)\n", tg_clones);

    /* --- serialize -> hydrate ------------------------------------------ */
    bytes = JS_TTFlowSerialize(ctx, g, &blen);
    if (!bytes)
        die(ctx, "serialize");
    assert(tg_serializes == 1);
    g2 = JS_TTFlowDeserialize(ctx, bytes, blen);
    if (JS_IsException(g2))
        die(ctx, "deserialize");
    assert(tg_deserializes == 1);
    t2 = JS_TTFlowGetLocal(ctx, g2, 0, at_t);
    assert(JS_TTIsTagged(t2));
    assert(JS_VALUE_GET_PTR(t2) != JS_VALUE_GET_PTR(t));
    assert(tg_payload_a(ctx, t2) == 1);
    {
        void *n2 = JS_TTNote(t2);
        assert(n2 && n2 != H && strcmp((char *)n2, "H-note-1") == 0);
    }
    printf("TAGGED:serialize->hydrate ok (%u bytes)\n", (unsigned)blen);

    /* --- truncation at every byte refuses loudly, note-leak-free -------- */
    {
        int live_before = tg_live;
        size_t cut;
        for (cut = 0; cut < blen; cut++) {
            JSValue bad = JS_TTFlowDeserialize(ctx, bytes, cut);
            assert(JS_IsException(bad));
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        /* cuts that deserialized the note before failing freed it again
           through the shell's finalizer */
        assert(tg_live == live_before);
    }
    printf("TAGGED:truncation fuzz ok\n");

    /* --- loud refusals without hooks; NULL notes still pass ------------ */
    JS_TTSetNoteHooks(rt, NULL, NULL, NULL, NULL);
    {
        uint8_t *b0;
        size_t l0;
        JSValue e;
        b0 = JS_TTFlowSerialize(ctx, g, &l0);
        assert(b0 == NULL);   /* non-NULL note, no NoteSerialize hook */
        JS_FreeValue(ctx, JS_GetException(ctx));
        e = JS_TTFlowFork(ctx, g);
        assert(JS_IsException(e));  /* non-NULL note, no NoteClone hook */
        JS_FreeValue(ctx, JS_GetException(ctx));
        /* bytes carrying a note refuse to hydrate without the hook */
        e = JS_TTFlowDeserialize(ctx, bytes, blen);
        assert(JS_IsException(e));
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    js_free(ctx, bytes);
    tnil = JS_TTMakeTagged(ctx, JS_NewInt32(ctx, 7), NULL);
    g3 = tg_start_tflow(ctx);
    if (!JS_TTFlowSetLocal(ctx, g3, 0, at_u, tnil)) {
        fprintf(stderr, "FAIL: inject u into tflow\n");
        return 1;
    }
    {
        uint8_t *b1;
        size_t l1;
        JSValue g3h, u2, pv;
        int32_t iv = 0;
        b1 = JS_TTFlowSerialize(ctx, g3, &l1);
        if (!b1)
            die(ctx, "serialize NULL-note flow");
        g3h = JS_TTFlowDeserialize(ctx, b1, l1);
        if (JS_IsException(g3h))
            die(ctx, "deserialize NULL-note flow");
        js_free(ctx, b1);
        u2 = JS_TTFlowGetLocal(ctx, g3h, 0, at_u);
        assert(JS_TTIsTagged(u2));
        assert(JS_TTNote(u2) == NULL);
        pv = JS_TTPayload(ctx, u2);
        if (JS_ToInt32(ctx, &iv, pv))
            die(ctx, "NULL-note payload");
        assert(iv == 7);
        JS_FreeValue(ctx, pv);
        JS_FreeValue(ctx, u2);
        JS_FreeValue(ctx, g3h);
    }
    tg_set_hooks(rt);
    printf("TAGGED:hookless refusals + NULL-note pass ok\n");

    /* --- evict -> hydrate (cold bytes) --------------------------------- */
    {
        uint8_t *eb;
        size_t el;
        int sers = tg_serializes, desers = tg_deserializes;
        eb = JS_TTMachineEvict(ctx, g, &el);
        if (!eb)
            die(ctx, "evict");
        assert(tg_serializes == sers + 1);
        /* the host reference keeps the parent's value alive across the
           eviction: its note must NOT have been freed */
        assert(JS_TTNote(t) == H);
        gh = JS_TTMachineHydrate(ctx, eb, el);
        if (JS_IsException(gh))
            die(ctx, "hydrate");
        js_free(ctx, eb);
        assert(tg_deserializes == desers + 1);
        th = JS_TTFlowGetLocal(ctx, gh, 0, at_t);
        assert(JS_TTIsTagged(th));
        assert(tg_payload_a(ctx, th) == 1);
        {
            void *nh = JS_TTNote(th);
            assert(nh && strcmp((char *)nh, "H-note-1") == 0);
        }
    }
    printf("TAGGED:evict->hydrate ok\n");

    /* --- abandoning a forked arm frees its note exactly once ------------ */
    {
        int frees_before = tg_frees;
        JS_FreeValue(ctx, tB);    /* drop the read handle first */
        tB = JS_UNDEFINED;
        JS_FreeValue(ctx, armB);  /* abandon the arm without resuming */
        armB = JS_UNDEFINED;
        assert(tg_frees == frees_before + 1);
    }
    printf("TAGGED:abandoned arm frees its note exactly once ok\n");

    /* --- the surviving arm resumes and completes normally --------------- */
    {
        int frees_before = tg_frees;
        char tr[512];
        if (JS_TTFlowCheckin(ctx, armA))
            die(ctx, "checkin armA");
        collect_flow(ctx, armA, 0, tr, sizeof(tr));
        assert(strstr(tr, "t1:object:0"));
        assert(strstr(tr, "t-end"));
        /* completion freed the frame; our tA dup still pins the arm's
           value (and so its note) */
        assert(tg_frees == frees_before);
        JS_FreeValue(ctx, tA);
        tA = JS_UNDEFINED;
        assert(tg_frees == frees_before + 1);
    }
    printf("TAGGED:surviving arm completes ok\n");

    /* --- teardown: every note followed its value ------------------------ */
    JS_FreeAtom(ctx, at_t);
    JS_FreeAtom(ctx, at_u);
    JS_FreeValue(ctx, t);
    JS_FreeValue(ctx, tnil);
    JS_FreeValue(ctx, tP);
    JS_FreeValue(ctx, t2);
    JS_FreeValue(ctx, th);
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, g2);
    JS_FreeValue(ctx, g3);
    JS_FreeValue(ctx, gh);
    JS_FreeValue(ctx, armA);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);       /* the leak/double-free oracle */
    assert(tg_live == 0);     /* the note-liveness oracle */
    printf("TAGGED:teardown ok (clones=%d serializes=%d deserializes=%d "
           "frees=%d)\n", tg_clones, tg_serializes, tg_deserializes, tg_frees);
    return 0;
}

/* -- combinetest: propagation through value-producing operations ---------- */

/* the Combine hook: derive "C<op>(a,b)" from the operand notes ("-" for an
   untagged operand) and log what the engine reported */
static int cb_calls, cb_last_op, cb_last_n, cb_last_mask;

static void *tg_combine(JSContext *ctx, int op, JSValueConst *args,
                        void **notes, int n)
{
    char buf[512];
    size_t off;
    char *out;
    int i;
    (void)ctx;
    (void)args;
    cb_calls++;
    cb_last_op = op;
    cb_last_n = n;
    cb_last_mask = 0;
    off = (size_t)snprintf(buf, sizeof(buf), "C%d(", op);
    for (i = 0; i < n && off < sizeof(buf) - 8; i++) {
        if (notes[i])
            cb_last_mask |= 1 << i;
        off += (size_t)snprintf(buf + off, sizeof(buf) - off, "%s%s",
                                i ? "," : "",
                                notes[i] ? (char *)notes[i] : "-");
    }
    if (off < sizeof(buf) - 2)
        snprintf(buf + off, sizeof(buf) - off, ")");
    out = strdup(buf);
    if (out)
        tg_live++;                /* freed by tg_note_free with its value */
    return out;
}

/* the Cond hook: record each control-flow observation of a tagged value
   (note string + payload-truthiness branch), and append to a log so two
   timelines' observation streams can be compared byte-for-byte */
static int cnd_calls, cnd_last_taken;
static char cnd_last_note[128];
static char cnd_log[1024];

static void tg_cond(JSContext *ctx, void *note, int taken_true)
{
    size_t off;
    (void)ctx;
    cnd_calls++;
    cnd_last_taken = taken_true;
    snprintf(cnd_last_note, sizeof(cnd_last_note), "%s",
             note ? (char *)note : "-");
    off = strlen(cnd_log);
    if (off + strlen(cnd_last_note) + 8 < sizeof(cnd_log))
        snprintf(cnd_log + off, sizeof(cnd_log) - off, "%s:%d;",
                 cnd_last_note, taken_true);
}

/* a no-op step handler: opens the comparison-journal gate (which requires
   a handler installed) without enabling stepping */
static int tg_step_noop(JSContext *ctx, int line, int col, int depth,
                        int parkable, void *opaque)
{
    (void)ctx; (void)line; (void)col; (void)depth; (void)parkable;
    (void)opaque;
    return 0;
}

/* find a journal entry (op, a, b); nonnegative index if present, with the
   entry's note (borrowed) in *note_out */
static int ct_journal_find(JSRuntime *rt, int want_op, const char *wa,
                           const char *wb, void **note_out)
{
    int i, op;
    const char *a, *b;
    void *nt;

    for (i = 0; i < JS_TTCmpCount(rt); i++) {
        if (JS_TTCmpGet(rt, i, &op, &a, &b, &nt))
            break;
        if (op == want_op && !strcmp(a, wa) && !strcmp(b, wb)) {
            if (note_out)
                *note_out = nt;
            return i;
        }
    }
    return -1;
}

/* install tagged(payload, strdup(note_str)) as a global */
static void ct_set_tagged(JSContext *ctx, const char *name, JSValue payload,
                          const char *note_str)
{
    char *note = NULL;
    JSValue t, glob;
    if (note_str) {
        note = strdup(note_str);
        assert(note);
        tg_live++;
    }
    t = JS_TTMakeTagged(ctx, payload, note);
    if (JS_IsException(t))
        die(ctx, "MakeTagged global");
    glob = JS_GetGlobalObject(ctx);
    if (JS_SetPropertyStr(ctx, glob, name, t) < 0)
        die(ctx, "set tagged global");
    JS_FreeValue(ctx, glob);
}

/* evaluate; the result MUST be tagged; return a dup of its payload */
static JSValue ct_eval_payload(JSContext *ctx, const char *expr)
{
    JSValue v = eval_val(ctx, expr);
    JSValue p;
    if (!JS_TTIsTagged(v)) {
        fprintf(stderr, "FAIL: %s did not produce a tagged value\n", expr);
        exit(1);
    }
    p = JS_TTPayload(ctx, v);
    JS_FreeValue(ctx, v);
    return p;
}

static void ct_check_combine(const char *expr, int want_op, int want_mask,
                             int want_n)
{
    if (want_op >= 0 && cb_last_op != want_op) {
        fprintf(stderr, "FAIL: %s: Combine op %d, want %d\n", expr,
                cb_last_op, want_op);
        exit(1);
    }
    if (want_mask >= 0 && cb_last_mask != want_mask) {
        fprintf(stderr, "FAIL: %s: Combine note mask %d, want %d\n", expr,
                cb_last_mask, want_mask);
        exit(1);
    }
    if (want_n >= 0 && cb_last_n != want_n) {
        fprintf(stderr, "FAIL: %s: Combine n %d, want %d\n", expr,
                cb_last_n, want_n);
        exit(1);
    }
}

/* tagged result with an exact-int payload + the Combine record */
static void ct_expect_int(JSContext *ctx, const char *expr, int want,
                          int want_op, int want_mask, int want_n)
{
    JSValue p;
    int32_t got = -1;
    cb_calls = 0;
    cb_last_op = -1;
    p = ct_eval_payload(ctx, expr);
    if (JS_VALUE_GET_TAG(p) != JS_TAG_INT) {
        fprintf(stderr, "FAIL: %s: payload tag %d, want int\n", expr,
                (int)JS_VALUE_GET_TAG(p));
        exit(1);
    }
    if (JS_ToInt32(ctx, &got, p))
        die(ctx, expr);
    JS_FreeValue(ctx, p);
    if (got != want) {
        fprintf(stderr, "FAIL: %s: payload %d, want %d\n", expr, got, want);
        exit(1);
    }
    ct_check_combine(expr, want_op, want_mask, want_n);
}

/* tagged result with a double payload */
static void ct_expect_num(JSContext *ctx, const char *expr, double want,
                          int want_op)
{
    JSValue p;
    double got = 0;
    cb_calls = 0;
    cb_last_op = -1;
    p = ct_eval_payload(ctx, expr);
    if (JS_ToFloat64(ctx, &got, p))
        die(ctx, expr);
    JS_FreeValue(ctx, p);
    if (got != want) {
        fprintf(stderr, "FAIL: %s: payload %g, want %g\n", expr, got, want);
        exit(1);
    }
    ct_check_combine(expr, want_op, -1, -1);
}

/* tagged result with an exact-string payload (ropes flatten on compare) */
static void ct_expect_string(JSContext *ctx, const char *expr,
                             const char *want, int want_op)
{
    JSValue p;
    const char *s;
    uint32_t tag;
    cb_calls = 0;
    cb_last_op = -1;
    p = ct_eval_payload(ctx, expr);
    tag = JS_VALUE_GET_TAG(p);
    if (tag != JS_TAG_STRING && tag != JS_TAG_STRING_ROPE) {
        fprintf(stderr, "FAIL: %s: payload tag %d, want string\n", expr,
                (int)tag);
        exit(1);
    }
    s = JS_ToCString(ctx, p);
    if (!s || strcmp(s, want)) {
        fprintf(stderr, "FAIL: %s: payload \"%s\", want \"%s\"\n", expr,
                s ? s : "?", want);
        exit(1);
    }
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, p);
    ct_check_combine(expr, want_op, -1, -1);
}

/* tagged result with a boolean payload */
static void ct_expect_bool(JSContext *ctx, const char *expr, int want,
                           int want_op, int want_mask)
{
    JSValue p;
    cb_calls = 0;
    cb_last_op = -1;
    p = ct_eval_payload(ctx, expr);
    if (JS_VALUE_GET_TAG(p) != JS_TAG_BOOL || JS_ToBool(ctx, p) != want) {
        fprintf(stderr, "FAIL: %s: payload not the boolean %d\n", expr, want);
        exit(1);
    }
    JS_FreeValue(ctx, p);
    ct_check_combine(expr, want_op, want_mask, -1);
}

/* the result must be CONCRETE (untagged) and stringify to 'want' */
static void ct_expect_concrete(JSContext *ctx, const char *expr,
                               const char *want)
{
    JSValue v = eval_val(ctx, expr);
    const char *s;
    if (JS_TTIsTagged(v)) {
        fprintf(stderr, "FAIL: %s: unexpectedly tagged\n", expr);
        exit(1);
    }
    s = JS_ToCString(ctx, v);
    if (!s || strcmp(s, want)) {
        fprintf(stderr, "FAIL: %s == \"%s\", want \"%s\"\n", expr,
                s ? s : "?", want);
        exit(1);
    }
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
}

static void ct_expect_throws(JSContext *ctx, const char *expr,
                             const char *needle)
{
    JSValue v = JS_Eval(ctx, expr, strlen(expr), "combine.js",
                        JS_EVAL_TYPE_GLOBAL);
    JSValue e;
    const char *msg;
    if (!JS_IsException(v)) {
        JS_FreeValue(ctx, v);
        fprintf(stderr, "FAIL: %s did not throw\n", expr);
        exit(1);
    }
    e = JS_GetException(ctx);
    msg = JS_ToCString(ctx, e);
    if (needle && (!msg || !strstr(msg, needle))) {
        fprintf(stderr, "FAIL: %s threw \"%s\", want substring \"%s\"\n",
                expr, msg ? msg : "?", needle);
        exit(1);
    }
    JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, e);
}

static int cmd_combinetest(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_baseline_ctx(&rt);
    JSAtom at_t;

    tg_clones = tg_serializes = tg_deserializes = tg_frees = tg_live = 0;
    cb_calls = 0;
    cnd_calls = 0;
    cnd_log[0] = 0;
    tg_set_hooks(rt);
    JS_TTSetCombineHook(rt, tg_combine);
    JS_TTSetCondHook(rt, tg_cond);
    at_t = JS_NewAtom(ctx, "t");

    ct_set_tagged(ctx, "T5", JS_NewInt32(ctx, 5), "H5");
    ct_set_tagged(ctx, "T5B", JS_NewInt32(ctx, 5), "H5B");
    ct_set_tagged(ctx, "TNULL", JS_NULL, "HN");
    ct_set_tagged(ctx, "TUND", JS_UNDEFINED, "HU");
    ct_set_tagged(ctx, "T6", JS_NewInt32(ctx, 6), "H6");
    ct_set_tagged(ctx, "T0", JS_NewInt32(ctx, 0), "H0");
    ct_set_tagged(ctx, "TES", eval_val(ctx, "''"), "HES");
    ct_set_tagged(ctx, "TJ", eval_val(ctx, "({toJSON(){ return 'tj'; }})"),
                  "HJ");
    ct_set_tagged(ctx, "TSTR", eval_val(ctx, "'abc'"), "HS");
    ct_set_tagged(ctx, "TB", eval_val(ctx, "'b'"), "HB");
    ct_set_tagged(ctx, "TGO", eval_val(ctx, "({a: 5})"), "HG");
    ct_set_tagged(ctx, "TGG",
                  eval_val(ctx, "({a: 21, get g() { return this.a * 2; }})"),
                  "HGG");
    ct_set_tagged(ctx, "TCH",
                  eval_val(ctx, "Object.create({ip: 11})"), "HCH");
    ct_set_tagged(ctx, "TSV", eval_val(ctx, "({v: T5})"), "HSV");
    {
        /* TNN = tagged(tagged({z: 9})): nested payload with a data prop */
        char *n_in = strdup("HNI"), *n_out = strdup("HNO");
        JSValue t_in, glob;
        assert(n_in && n_out);
        tg_live += 2;
        t_in = JS_TTMakeTagged(ctx, eval_val(ctx, "({z: 9})"), n_in);
        assert(!JS_IsException(t_in));
        glob = JS_GetGlobalObject(ctx);
        if (JS_SetPropertyStr(ctx, glob, "TNN",
                              JS_TTMakeTagged(ctx, t_in, n_out)) < 0)
            die(ctx, "set TNN");
        JS_FreeValue(ctx, glob);
    }
    {
        /* TNEST = tagged(tagged(0)): nested payloads recurse for
           truthiness; a conditional observes only the OUTER note */
        char *n_in = strdup("HIN"), *n_out = strdup("HOUT");
        JSValue t_in, glob;
        assert(n_in && n_out);
        tg_live += 2;
        t_in = JS_TTMakeTagged(ctx, JS_NewInt32(ctx, 0), n_in);
        assert(!JS_IsException(t_in));
        glob = JS_GetGlobalObject(ctx);
        if (JS_SetPropertyStr(ctx, glob, "TNEST",
                              JS_TTMakeTagged(ctx, t_in, n_out)) < 0)
            die(ctx, "set TNEST");
        JS_FreeValue(ctx, glob);
    }
    ct_set_tagged(ctx, "T2", JS_NewInt32(ctx, 2), "H2");
    ct_set_tagged(ctx, "T3", JS_NewInt32(ctx, 3), "H3");
    ct_set_tagged(ctx, "T9", JS_NewInt32(ctx, 9), "H9");
    ct_set_tagged(ctx, "TY", eval_val(ctx, "'y'"), "HY");
    ct_set_tagged(ctx, "TAB", eval_val(ctx, "'ab'"), "HAB");
    ct_set_tagged(ctx, "TQ", eval_val(ctx, "'q'"), "HQ");
    ct_set_tagged(ctx, "TS5", eval_val(ctx, "'5'"), "HS5");
    ct_set_tagged(ctx, "T42S", eval_val(ctx, "'42'"), "H42");
    ct_set_tagged(ctx, "TSYM", eval_val(ctx, "Symbol('s')"), "HSYM");
    ct_set_tagged(ctx, "TOBJ", eval_val(ctx, "({})"), "HOBJ");
    ct_set_tagged(ctx, "TKEY", eval_val(ctx, "'k'"), "HKEY");

    /* --- arithmetic / bitwise: payload is the engine's own result ------ */
    ct_expect_int(ctx, "T5 + 1", 6, JS_TT_OP_ADD, 1, 2);
    ct_expect_int(ctx, "1 + T5", 6, JS_TT_OP_ADD, 2, 2);
    ct_expect_int(ctx, "T5 * 2", 10, JS_TT_OP_MUL, 1, 2);
    ct_expect_int(ctx, "T5 - 1", 4, JS_TT_OP_SUB, 1, 2);
    ct_expect_num(ctx, "T5 / 2", 2.5, JS_TT_OP_DIV);
    ct_expect_int(ctx, "T5 % 2", 1, JS_TT_OP_MOD, 1, 2);
    ct_expect_int(ctx, "T2 ** T3", 8, JS_TT_OP_POW, 3, 2);
    ct_expect_int(ctx, "T6 & 3", 2, JS_TT_OP_AND, 1, 2);
    ct_expect_int(ctx, "T6 | 1", 7, JS_TT_OP_OR, 1, 2);
    ct_expect_int(ctx, "T6 ^ 1", 7, JS_TT_OP_XOR, 1, 2);
    ct_expect_int(ctx, "T6 << 1", 12, JS_TT_OP_SHL, 1, 2);
    ct_expect_int(ctx, "T6 >> 1", 3, JS_TT_OP_SAR, 1, 2);
    ct_expect_int(ctx, "T6 >>> 1", 3, JS_TT_OP_SHR, 1, 2);
    ct_expect_int(ctx, "~T6", -7, JS_TT_OP_NOT, 1, 1);
    ct_expect_int(ctx, "-T5", -5, JS_TT_OP_NEG, 1, 1);
    printf("COMBINE:arithmetic/bitwise ok\n");

    /* --- inc/dec (pre, post, and through a local) ---------------------- */
    ct_expect_int(ctx, "var z1 = T5; ++z1", 6, JS_TT_OP_INC, 1, 1);
    ct_expect_int(ctx, "var z2 = T5; z2--", 5, JS_TT_OP_DEC, 1, 1);
    assert(cb_calls == 2);        /* post: old and new both derived */
    ct_expect_int(ctx, "z2", 4, -1, -1, -1);
    ct_expect_int(ctx, "(function(){ var n = 1; n += T5; return n; })()",
                  6, JS_TT_OP_ADD, 2, 2);
    printf("COMBINE:inc/dec + add_loc ok\n");

    /* --- concat: the exact engine string, wherever + or templates run -- */
    ct_expect_string(ctx, "'x' + TY", "xy", JS_TT_OP_ADD);
    ct_expect_string(ctx, "TAB + 'cd'", "abcd", JS_TT_OP_ADD);
    ct_expect_string(ctx, "TAB + ''", "ab", JS_TT_OP_ADD);
    ct_expect_string(ctx, "`p${TQ}r`", "pqr", JS_TT_OP_CONCAT);
    assert(cb_calls == 2);        /* one Combine per concat step */
    ct_expect_string(ctx, "'x'.concat(TY, 'z')", "xyz", JS_TT_OP_CONCAT);
    ct_expect_string(ctx, "(function(){ var s = 'x'; s += TY; return s; })()",
                     "xy", JS_TT_OP_ADD);
    printf("COMBINE:concat/templates ok\n");

    /* --- coercions: the REAL coercion of the inner payload ------------- */
    {
        JSValue p;
        cb_calls = 0;
        p = ct_eval_payload(ctx, "+TS5");
        /* the number 5, not the string "5", not NaN: the real ToNumber ran */
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT &&
               JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        ct_check_combine("+TS5", JS_TT_OP_PLUS, 1, 1);
    }
    ct_expect_string(ctx, "String(T9)", "9", JS_TT_OP_TO_STRING);
    ct_expect_int(ctx, "parseInt(T42S)", 42, JS_TT_OP_PARSE_INT, 1, 2);
    ct_expect_int(ctx, "parseInt(T42S, 16)", 66, JS_TT_OP_PARSE_INT, 1, 2);
    ct_expect_int(ctx, "parseFloat(T42S)", 42, JS_TT_OP_PARSE_FLOAT, 1, 1);
    {
        /* a concretely-NaN op stays faithfully NaN (never a masked throw) */
        JSValue p;
        double d = 0;
        cb_calls = 0;
        p = ct_eval_payload(ctx, "TOBJ * 1");
        assert(!JS_IsException(p));
        assert(JS_VALUE_GET_TAG(p) != JS_TAG_STRING);
        if (JS_ToFloat64(ctx, &d, p))
            die(ctx, "TOBJ * 1 payload");
        assert(isnan(d));
        JS_FreeValue(ctx, p);
        ct_check_combine("TOBJ * 1", JS_TT_OP_MUL, 1, 2);
    }
    printf("COMBINE:coercions ok\n");

    /* --- two tagged operands ------------------------------------------- */
    ct_expect_int(ctx, "T2 + T3", 5, JS_TT_OP_ADD, 3, 2);
    printf("COMBINE:two tagged operands ok\n");

    /* --- relational / loose equality produce tagged booleans ----------- */
    ct_expect_bool(ctx, "T5 < 6", 1, JS_TT_OP_LT, 1);
    ct_expect_bool(ctx, "T5 > 6", 0, JS_TT_OP_GT, 1);
    ct_expect_bool(ctx, "T5 <= T5", 1, JS_TT_OP_LTE, 3);
    ct_expect_bool(ctx, "T2 == 2", 1, JS_TT_OP_EQ, 1);
    ct_expect_bool(ctx, "T2 != 2", 0, JS_TT_OP_NEQ, 1);
    printf("COMBINE:relational/loose-eq ok\n");

    /* --- strict equality: the same unwrap -> compare -> re-wrap -------- */
    ct_expect_bool(ctx, "TY === 'y'", 1, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "TY === 'b'", 0, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "T5 === 5", 1, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "5 === T5", 1, JS_TT_OP_STRICT_EQ, 2);
    ct_expect_bool(ctx, "T5 !== 6", 1, JS_TT_OP_STRICT_NEQ, 1);
    /* the payload comparison is the REAL strict one: no coercion... */
    ct_expect_bool(ctx, "T5 === '5'", 0, JS_TT_OP_STRICT_EQ, 1);
    /* ...while loose on the same operands still coerces */
    ct_expect_bool(ctx, "T5 == '5'", 1, JS_TT_OP_EQ, 1);
    /* two tagged: distinct objects with equal payloads compare equal */
    ct_expect_bool(ctx, "T5 === T5B", 1, JS_TT_OP_STRICT_EQ, 3);
    ct_expect_bool(ctx, "T5 === T6", 0, JS_TT_OP_STRICT_EQ, 3);
    printf("COMBINE:strict-eq unwraps ok\n");

    /* --- strict equality against the null/undefined literals -----------
       (these forms used to compile to the is_null/is_undefined short
       opcodes; they now reach the same tagged strict-eq path) */
    ct_expect_bool(ctx, "T5 === null", 0, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "T5 === undefined", 0, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "TNULL === null", 1, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "TUND === undefined", 1, JS_TT_OP_STRICT_EQ, 1);
    ct_expect_bool(ctx, "T5 !== null", 1, JS_TT_OP_STRICT_NEQ, 1);
    /* with a branch: identical control flow to != -- the compare yields
       a tagged boolean, the branch takes its payload's side and the
       cond hook observes it (combined note, taken=1) */
    cb_calls = 0;
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ if (T5 !== null) return 'A'; return 'B'; })()", "A");
    assert(cb_calls == 1 && cb_last_op == JS_TT_OP_STRICT_NEQ);
    assert(cnd_calls == 1 && cnd_last_taken == 1);
    cb_calls = 0;
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ if (T5 != null) return 'A'; return 'B'; })()", "A");
    assert(cb_calls == 1 && cb_last_op == JS_TT_OP_NEQ);
    assert(cnd_calls == 1 && cnd_last_taken == 1);
    printf("COMBINE:strict-eq null/undefined literals ok\n");

    /* --- reflexive: the same tagged object stays concrete, no hook ----- */
    cb_calls = 0;
    ct_expect_concrete(ctx, "T5 === T5", "true");
    ct_expect_concrete(ctx, "T5 !== T5", "false");
    ct_expect_concrete(ctx, "(function(x){ return x === x; })(T5)", "true");
    assert(cb_calls == 0);
    printf("COMBINE:strict-eq reflexive concrete ok\n");

    /* --- switch: each case-compare is the same tagged strict-eq, and
       the branch takes the compare PAYLOAD's side (one cond observation
       per case-compare) --- */
    cb_calls = 0;
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ switch (TY) { case 'y': return 'hit'; "
        "case 'z': return 'z'; default: return 'd'; } })()", "hit");
    assert(cb_calls == 1 && cb_last_op == JS_TT_OP_STRICT_EQ);
    assert(cnd_calls == 1 && cnd_last_taken == 1);
    /* a false-payload compare now correctly falls through to the next
       case: the switch selects by PAYLOAD, exactly like concrete code */
    cb_calls = 0;
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ switch (TY) { case 'z': return 'first'; "
        "case 'y': return 'second'; default: return 'd'; } })()", "second");
    assert(cb_calls == 2 && cb_last_op == JS_TT_OP_STRICT_EQ);
    assert(cnd_calls == 2 && cnd_last_taken == 1);
    printf("COMBINE:switch case-compare ok\n");

    /* --- the default-value probes never unwrap ------------------------- */
    {
        JSValue p;
        cb_calls = 0;
        cnd_calls = 0;
        /* a tagged argument is not `undefined`: the default must not
           fire, the tagged value must ride through, no Combine */
        p = ct_eval_payload(ctx, "(function(a = 99){ return a; })(T5)");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        /* even a tagged UNDEFINED payload is not `undefined` */
        p = ct_eval_payload(ctx, "(function(a = 99){ return a; })(TUND)");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_UNDEFINED);
        JS_FreeValue(ctx, p);
        /* destructuring defaults use the same probe */
        p = ct_eval_payload(ctx,
            "(function(){ var [dv = 7] = [T5]; return dv; })()");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        p = ct_eval_payload(ctx,
            "(function(){ var {q: qv = 7} = {q: T5}; return qv; })()");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        assert(cb_calls == 0);
        assert(cnd_calls == 0);   /* the probe branch is concrete: no
                                     cond observation from a tagged arg */
        /* an absent argument still takes the default */
        ct_expect_concrete(ctx, "(function(a = 99){ return a; })()", "99");
    }
    printf("COMBINE:default probes stay exact ok\n");

    /* --- truthiness is the payload's, everywhere ToBool runs (and only
       branches observe it: ! and Boolean() fire no hook) --- */
    cnd_calls = 0;
    ct_expect_concrete(ctx, "!T0", "true");
    ct_expect_concrete(ctx, "!T5", "false");
    ct_expect_concrete(ctx, "Boolean(TES)", "false");
    ct_expect_concrete(ctx, "Boolean(T5)", "true");
    ct_expect_concrete(ctx, "!!TNULL", "false");
    ct_expect_concrete(ctx, "!!TUND", "false");
    assert(cnd_calls == 0);
    printf("COMBINE:payload truthiness (no hook) ok\n");

    /* --- the cond hook observes control-flow branches ------------------ */
    {
        char want[64];
        /* ?: is a branch */
        cnd_calls = 0;
        ct_expect_concrete(ctx, "T5 ? 'y' : 'n'", "y");
        assert(cnd_calls == 1 && cnd_last_taken == 1 &&
               strcmp(cnd_last_note, "H5") == 0);
        cnd_calls = 0;
        ct_expect_concrete(ctx, "T0 ? 'y' : 'n'", "n");
        assert(cnd_calls == 1 && cnd_last_taken == 0 &&
               strcmp(cnd_last_note, "H0") == 0);
        /* if/else over a plain tagged value */
        cnd_calls = 0;
        ct_expect_concrete(ctx,
            "(function(){ if (T0) return 'A'; return 'B'; })()", "B");
        assert(cnd_calls == 1 && cnd_last_taken == 0);
        /* if over a compare result: the branch observes the COMBINED
           note of the tagged boolean the compare produced */
        cnd_calls = 0;
        cb_calls = 0;
        snprintf(want, sizeof(want), "C%d(HY,-)", JS_TT_OP_STRICT_EQ);
        ct_expect_concrete(ctx,
            "(function(){ if (TY === 'y') return 'A'; return 'B'; })()",
            "A");
        assert(cb_calls == 1);
        assert(cnd_calls == 1 && cnd_last_taken == 1 &&
               strcmp(cnd_last_note, want) == 0);
        /* nested tagged: truthiness recurses, ONE observation, OUTER
           note */
        cnd_calls = 0;
        ct_expect_concrete(ctx, "TNEST ? 'y' : 'n'", "n");
        assert(cnd_calls == 1 && cnd_last_taken == 0 &&
               strcmp(cnd_last_note, "HOUT") == 0);
        /* untagged conditionals never fire */
        cnd_calls = 0;
        ct_expect_concrete(ctx,
            "(function(){ if (5 > 3) return 'A'; return 'B'; })()", "A");
        ct_expect_concrete(ctx, "1 ? 'y' : 'n'", "y");
        assert(cnd_calls == 0);
    }
    printf("COMBINE:cond hook at branches ok\n");

    /* --- short-circuits + the nullish probe ---------------------------- */
    {
        JSValue p;
        /* && short-circuits on the falsy tagged lhs: the RESULT is the
           tagged value itself, and the test was one observation */
        cnd_calls = 0;
        p = ct_eval_payload(ctx, "T0 && 'x'");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT &&
               JS_VALUE_GET_INT(p) == 0);
        JS_FreeValue(ctx, p);
        assert(cnd_calls == 1 && cnd_last_taken == 0 &&
               strcmp(cnd_last_note, "H0") == 0);
        cnd_calls = 0;
        ct_expect_concrete(ctx, "T5 && 'x'", "x");
        assert(cnd_calls == 1 && cnd_last_taken == 1);
        /* || falls through to the rhs on a falsy payload */
        cnd_calls = 0;
        ct_expect_concrete(ctx, "TES || 'y'", "y");
        assert(cnd_calls == 1 && cnd_last_taken == 0 &&
               strcmp(cnd_last_note, "HES") == 0);
        /* ||= branches on the tagged current value too */
        cnd_calls = 0;
        ct_expect_concrete(ctx,
            "(function(){ var v = T0; v ||= 9; return v; })()", "9");
        assert(cnd_calls == 1 && cnd_last_taken == 0);
        /* ?? / ?. are the nullish probe: identity of the PAYLOAD, not
           truthiness -- unwrapped, but never a cond observation */
        cnd_calls = 0;
        ct_expect_concrete(ctx, "TNULL ?? 'z'", "z");
        ct_expect_concrete(ctx, "TUND ?? 'z'", "z");
        p = ct_eval_payload(ctx, "T0 ?? 'z'");   /* 0 is not nullish */
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT &&
               JS_VALUE_GET_INT(p) == 0);
        JS_FreeValue(ctx, p);
        ct_expect_concrete(ctx, "TNULL?.x ?? 'm'", "m");
        assert(cnd_calls == 0);
    }
    printf("COMBINE:short-circuits + nullish ok\n");

    /* --- loops: one observation per condition evaluation --------------- */
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ var i = 0; while (T5) { if (++i >= 3) break; } "
        "return i; })()", "3");
    assert(cnd_calls == 3 && cnd_last_taken == 1);
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ for (; T0 ;) return 'body'; return 'skip'; })()",
        "skip");
    assert(cnd_calls == 1 && cnd_last_taken == 0);
    cnd_calls = 0;
    ct_expect_concrete(ctx,
        "(function(){ var i = 0; do { i++; } while (TES); return i; })()",
        "1");
    assert(cnd_calls == 1 && cnd_last_taken == 0);
    printf("COMBINE:loop conditions ok\n");

    /* --- JSON.stringify refuses a tagged value loudly (v1) --------------
       never a silent {"k":{}} de-tag; forwarding (payload-substituted
       serialize, result wrapped with a Combine'd note) is the documented
       follow-up */
    cb_calls = 0;
    cnd_calls = 0;
    ct_expect_throws(ctx, "JSON.stringify({k: TY})",
                     "reached a tagged value");
    ct_expect_throws(ctx, "JSON.stringify([T5])",
                     "reached a tagged value");
    ct_expect_throws(ctx, "JSON.stringify(T5)",
                     "reached a tagged value");
    /* the refusal names the field the tagged value sits in */
    ct_expect_throws(ctx, "JSON.stringify({k: TY})", "at 'k'");
    ct_expect_throws(ctx, "JSON.stringify([T5])", "at '0'");
    ct_expect_throws(ctx, "JSON.stringify({a:1, deep:{q:[0, T5]}})",
                     "at '1'");
    /* a payload toJSON is NOT consulted in v1 (no re-entry, no silent
       de-tag through the payload's serializer) */
    ct_expect_throws(ctx, "JSON.stringify({k: TJ})",
                     "reached a tagged value");
    assert(cb_calls == 0 && cnd_calls == 0);  /* refusals combine/observe
                                                 nothing */
    /* a replacer that swaps the tagged value out serializes concretely */
    ct_expect_concrete(ctx,
        "JSON.stringify({k: TY}, (kk, vv) => kk === 'k' ? 'safe' : vv)",
        "{\"k\":\"safe\"}");
    /* the untagged path is byte-identical */
    ct_expect_concrete(ctx,
        "JSON.stringify({a:[1,'x',null,true],b:{}})",
        "{\"a\":[1,\"x\",null,true],\"b\":{}}");
    ct_expect_concrete(ctx,
        "JSON.stringify({a:[1,{z:2}]}, null, 1)",
        "{\n \"a\": [\n  1,\n  {\n   \"z\": 2\n  }\n ]\n}");
    printf("COMBINE:JSON.stringify refusal ok\n");

    /* --- string search builtins: unwrap, journal payload+note, forward - */
    {
        JSValue p;
        void *jn;
        char want[64];

        /* the journal gates on a step handler being installed; a no-op
           handler opens it without enabling stepping */
        JS_TTSetStepHandler(rt, tg_step_noop, NULL);
        JS_TTCmpClear(rt);

        /* tagged receiver, via .call (method lookup on the wrapper is
           the property-forwarding follow-up): payload search, payload
           token in the journal WITH the receiver's note, tagged result */
        cb_calls = 0;
        p = ct_eval_payload(ctx,
                            "String.prototype.includes.call(TSTR, 'b')");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_BOOL && JS_ToBool(ctx, p) == 1);
        JS_FreeValue(ctx, p);
        ct_check_combine("includes(TSTR)", JS_TT_OP_INCLUDES, 1, 2);
        assert(ct_journal_find(rt, 1, "abc", "b", &jn) >= 0);
        assert(jn && strcmp((char *)jn, "HS") == 0);

        cb_calls = 0;
        p = ct_eval_payload(ctx,
                            "String.prototype.startsWith.call(TSTR, 'ab')");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_BOOL && JS_ToBool(ctx, p) == 1);
        JS_FreeValue(ctx, p);
        ct_check_combine("startsWith(TSTR)", JS_TT_OP_STARTS_WITH, 1, 2);
        assert(ct_journal_find(rt, 2, "abc", "ab", &jn) >= 0);
        assert(jn && strcmp((char *)jn, "HS") == 0);

        cb_calls = 0;
        p = ct_eval_payload(ctx,
                            "String.prototype.endsWith.call(TSTR, 'bc')");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_BOOL && JS_ToBool(ctx, p) == 1);
        JS_FreeValue(ctx, p);
        ct_check_combine("endsWith(TSTR)", JS_TT_OP_ENDS_WITH, 1, 2);
        assert(ct_journal_find(rt, 3, "abc", "bc", &jn) >= 0);
        assert(jn && strcmp((char *)jn, "HS") == 0);

        /* indexOf / lastIndexOf forward the integer */
        ct_expect_int(ctx, "String.prototype.indexOf.call(TSTR, 'c')", 2,
                      JS_TT_OP_INDEX_OF, 1, 2);
        assert(ct_journal_find(rt, 4, "abc", "c", &jn) >= 0);
        assert(jn && strcmp((char *)jn, "HS") == 0);
        ct_expect_int(ctx, "String.prototype.lastIndexOf.call(TSTR, 'b')",
                      1, JS_TT_OP_LAST_INDEX_OF, 1, 2);

        /* tagged needle on a concrete receiver: the argument's note */
        JS_TTCmpClear(rt);
        ct_expect_bool(ctx, "'xbx'.includes(TB)", 1, JS_TT_OP_INCLUDES, 2);
        assert(ct_journal_find(rt, 1, "xbx", "b", &jn) >= 0);
        assert(jn && strcmp((char *)jn, "HB") == 0);
        assert(JS_TTCmpCount(rt) == 1);   /* one entry per call, never
                                             double-journaled */

        /* a tagged position unwraps for the offset; it names no token */
        ct_expect_int(ctx, "'abcabc'.indexOf('c', T2)", 2,
                      JS_TT_OP_INDEX_OF, 4, 3);
        assert(ct_journal_find(rt, 4, "abcabc", "c", &jn) >= 0);
        assert(jn == NULL);

        /* both concrete: plain result, entry note NULL */
        cb_calls = 0;
        ct_expect_concrete(ctx, "'xy'.includes('y')", "true");
        assert(cb_calls == 0);
        assert(ct_journal_find(rt, 1, "xy", "y", &jn) >= 0 && jn == NULL);

        /* the tagged result branches once through the cond hook */
        cnd_calls = 0;
        snprintf(want, sizeof(want), "C%d(HS,-)", JS_TT_OP_INCLUDES);
        ct_expect_concrete(ctx,
            "String.prototype.includes.call(TSTR, 'b') ? 'y' : 'n'", "y");
        assert(cnd_calls == 1 && cnd_last_taken == 1 &&
               strcmp(cnd_last_note, want) == 0);

        JS_TTSetStepHandler(rt, NULL, NULL);
    }
    printf("COMBINE:string search builtins ok\n");

    /* --- property get forwards to the payload and stays tracked -------- */
    {
        JSValue p;
        const char *s;
        char want[64];

        /* string payload: length + index via the payload's exotic
           string behavior */
        ct_expect_int(ctx, "TSTR.length", 3, JS_TT_OP_GET_FIELD, 1, 2);
        cb_calls = 0;
        p = ct_eval_payload(ctx, "TSTR[0]");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_STRING);
        s = JS_ToCString(ctx, p);
        assert(s && strcmp(s, "a") == 0);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, p);
        ct_check_combine("TSTR[0]", JS_TT_OP_GET_FIELD, 1, 2);

        /* object payload: own, getter (payload `this`), inherited, and
           a missing key (tracked undefined with provenance) */
        ct_expect_int(ctx, "TGO.a", 5, JS_TT_OP_GET_FIELD, 1, 2);
        ct_expect_int(ctx, "TGG.g", 42, JS_TT_OP_GET_FIELD, 1, 2);
        ct_expect_int(ctx, "TCH.ip", 11, JS_TT_OP_GET_FIELD, 1, 2);
        cb_calls = 0;
        p = ct_eval_payload(ctx, "TGO.missing");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_UNDEFINED);
        JS_FreeValue(ctx, p);
        ct_check_combine("TGO.missing", JS_TT_OP_GET_FIELD, 1, 2);

        /* a FUNCTION result returns unwrapped (method lookup is
           resolution, not a data read: no Combine) */
        cb_calls = 0;
        ct_expect_concrete(ctx, "typeof TGO.hasOwnProperty", "function");
        assert(cb_calls == 0);

        /* ...which makes a PLAIN method call work: lookup resolves off
           the payload's prototype, the wrapper stays `this`, and the
           search-builtin intercept takes over -- journal included */
        JS_TTSetStepHandler(rt, tg_step_noop, NULL);
        JS_TTCmpClear(rt);
        cb_calls = 0;
        p = ct_eval_payload(ctx, "TSTR.includes('b')");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_BOOL && JS_ToBool(ctx, p) == 1);
        JS_FreeValue(ctx, p);
        assert(cb_calls == 1 && cb_last_op == JS_TT_OP_INCLUDES);
        {
            void *jn;
            assert(ct_journal_find(rt, 1, "abc", "b", &jn) >= 0);
            assert(jn && strcmp((char *)jn, "HS") == 0);
        }
        JS_TTSetStepHandler(rt, NULL, NULL);

        /* nested tagged payload: reads off the deepest payload, ONE
           wrap with the OUTER note (observed through the cond hook) */
        cnd_calls = 0;
        snprintf(want, sizeof(want), "C%d(HNO,-)", JS_TT_OP_GET_FIELD);
        ct_expect_concrete(ctx, "TNN.z ? 'y' : 'n'", "y");
        assert(cnd_calls == 1 && cnd_last_taken == 1 &&
               strcmp(cnd_last_note, want) == 0);

        /* a stored tagged value flattens: the result is a SINGLE
           wrapper over the stored payload, and the stored value joins
           the hook args with its note (mask 1|4, arity 3) */
        cb_calls = 0;
        p = ct_eval_payload(ctx, "TSV.v");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT &&
               JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        ct_check_combine("TSV.v", JS_TT_OP_GET_FIELD, 5, 3);

        /* a throwing forwarded get propagates unwrapped */
        ct_expect_throws(ctx, "TNULL.x", "null");

        /* tagged KEYS stay pinned -- on concrete and tagged receivers
           alike the key refuses before any forwarding */
        ct_expect_throws(ctx, "({a:1})[TKEY]", NULL);
        ct_expect_throws(ctx, "TGO[TKEY]", NULL);

        /* untagged gets are byte-identical */
        ct_expect_concrete(ctx, "({a:7}).a", "7");
        ct_expect_concrete(ctx, "'xyz'.length", "3");
        ct_expect_concrete(ctx, "[4,5,6][1]", "5");
    }
    printf("COMBINE:property get forwards ok\n");

    /* --- property set forwards to the payload (get/set inverses) ------- */
    {
        JSValue p, tg, pay, f;

        /* the write hits the payload: a second tagged get reads it
           back, the raw payload holds it, the wrapper owns nothing */
        cb_calls = 0;
        p = ct_eval_payload(ctx,
            "(function(){ TGO.foo = 5; return TGO.foo; })()");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        ct_check_combine("TGO.foo readback", JS_TT_OP_GET_FIELD, 1, 2);
        p = ct_eval_payload(ctx, "TGO.foo");   /* second get agrees */
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        tg = eval_val(ctx, "TGO");
        pay = JS_TTPayload(ctx, tg);
        f = JS_GetPropertyStr(ctx, pay, "foo");
        assert(JS_VALUE_GET_TAG(f) == JS_TAG_INT && JS_VALUE_GET_INT(f) == 5);
        JS_FreeValue(ctx, f);
        JS_FreeValue(ctx, pay);
        JS_FreeValue(ctx, tg);
        /* the wrapper stays inert: the RAW own-prop probe (enumeration
           forwards to the payload now, so Object.keys shows the
           payload's view -- only this probe sees the wrapper itself) */
        tg = eval_val(ctx, "TGO");
        assert(JS_TTOwnPropCount(ctx, tg) == 0);       /* wrapper: nothing */
        pay = JS_TTPayload(ctx, tg);
        assert(JS_TTOwnPropCount(ctx, pay) == 2);      /* payload: a + foo */
        JS_FreeValue(ctx, pay);
        JS_FreeValue(ctx, tg);

        /* a tagged value stores AS-IS; read-back flattens with the
           combined note (receiver + stored value, mask 5, arity 3) */
        cb_calls = 0;
        p = ct_eval_payload(ctx,
            "(function(){ TGO.bar = T9; return TGO.bar; })()");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 9);
        JS_FreeValue(ctx, p);
        ct_check_combine("TGO.bar", JS_TT_OP_GET_FIELD, 5, 3);

        /* a payload setter runs with the payload as `this` */
        ct_set_tagged(ctx, "TSET",
                      eval_val(ctx, "({v: 0, set s(x) { this.v = x * 2; }})"),
                      "HSET");
        ct_expect_int(ctx, "TSET.s = 4, TSET.v", 8, JS_TT_OP_GET_FIELD, 1, 2);

        /* string payload: the payload's exotic set semantics -- silent
           no-op in sloppy code, the REAL TypeError in strict, and no
           wrapper property ever appears */
        p = ct_eval_payload(ctx,
            "(function(){ TSTR[0] = 'x'; return TSTR[0]; })()");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_STRING);
        {
            const char *s0 = JS_ToCString(ctx, p);
            assert(s0 && strcmp(s0, "a") == 0);
            JS_FreeCString(ctx, s0);
        }
        JS_FreeValue(ctx, p);
        ct_expect_throws(ctx,
            "(function(){ 'use strict'; TSTR[0] = 'x'; })()", NULL);
        tg = eval_val(ctx, "TSTR");
        assert(JS_TTOwnPropCount(ctx, tg) == 0);   /* wrapper still inert */
        JS_FreeValue(ctx, tg);

        /* a throwing set propagates unwrapped */
        ct_expect_throws(ctx, "TNULL.x = 1", "null");

        /* tagged KEYS still refuse -- on tagged receivers too */
        ct_expect_throws(ctx, "TGO[TKEY] = 1", NULL);

        /* untagged writes byte-identical */
        ct_expect_concrete(ctx,
            "(function(){ var o = {}; o.w = 3; o.w = 4; return o.w; })()",
            "4");
    }
    printf("COMBINE:property set forwards ok\n");

    /* --- a forwarded write to a BASELINE payload routes through COW ---- */
    {
        JSValue p, gcw;
        int n0;

        /* TCFG wraps the baseline CONFIG object itself (created before
           checkin so the global-set is not captured) */
        ct_set_tagged(ctx, "TCFG", eval_val(ctx, "CONFIG"), "HC");
        gcw = tg_start_tflow(ctx);
        if (JS_TTFlowCheckin(ctx, gcw))
            die(ctx, "checkin for cow set");
        n0 = JS_TTFlowDeltaCount(ctx, gcw);
        ct_expect_concrete(ctx, "TCFG.limit = 99", "99");
        /* the forwarded write recorded a first-write delta on CONFIG */
        assert(JS_TTFlowDeltaCount(ctx, gcw) == n0 + 1);
        p = ct_eval_payload(ctx, "TCFG.limit");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 99);
        JS_FreeValue(ctx, p);
        ct_expect_concrete(ctx, "CONFIG.limit", "99");  /* live in-timeline */
        /* dedup: a second write to the captured prop adds no delta */
        ct_expect_concrete(ctx, "TCFG.limit = 100", "100");
        assert(JS_TTFlowDeltaCount(ctx, gcw) == n0 + 1);
        if (JS_TTFlowCheckout(ctx, gcw))
            die(ctx, "checkout for cow set");
        /* outside the timeline the baseline is pristine: isolation */
        ct_expect_concrete(ctx, "CONFIG.limit", "3");
        p = ct_eval_payload(ctx, "TCFG.limit");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 3);
        JS_FreeValue(ctx, p);
        JS_FreeValue(ctx, gcw);
    }
    printf("COMBINE:set-forwarding routes through COW ok\n");

    /* --- has/enumerate forward to the payload --------------------------- */
    {
        JSValue p, tgv, pay;

        /* `in` answers over the payload's chain: concrete, hook-free */
        cb_calls = 0;
        cnd_calls = 0;
        ct_expect_concrete(ctx, "'a' in TGO", "true");
        ct_expect_concrete(ctx, "'nope' in TGO", "false");
        ct_expect_concrete(ctx, "'toString' in TGO", "true"); /* inherited */
        ct_expect_concrete(ctx, "'ip' in TCH", "true");  /* payload proto */
        assert(cb_calls == 0 && cnd_calls == 0);
        /* a primitive payload gets the operator's real TypeError */
        ct_expect_throws(ctx, "'x' in T5", "operand");

        /* keys are the payload's CONCRETE names (join would refuse a
           tagged element via the coercion pin, so joining proves it) */
        ct_expect_concrete(ctx, "Object.keys(TGO).join(',')", "a,foo,bar");
        ct_expect_concrete(ctx,
            "Object.getOwnPropertyNames(TGO).join(',')", "a,foo,bar");
        ct_expect_concrete(ctx, "Reflect.ownKeys(TGO).length", "3");
        ct_expect_concrete(ctx, "Object.keys(TCH).length", "0"); /* own only */

        /* values/entries fetch THROUGH the wrapper: tracked values,
           concrete keys */
        p = ct_eval_payload(ctx, "Object.values(TGO)[0]");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 5);
        JS_FreeValue(ctx, p);
        ct_expect_concrete(ctx, "Object.entries(TGO)[0][0]", "a");
        p = ct_eval_payload(ctx, "Object.entries(TGO)[2][1]");
        assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT && JS_VALUE_GET_INT(p) == 9);
        JS_FreeValue(ctx, p);   /* the stored tagged T9, flattened by 4c */

        /* for-in walks the payload's enumerable chain, proto included */
        ct_expect_concrete(ctx,
            "(function(){ var ks = []; for (var k in TGO) ks.push(k); "
            "return ks.join(','); })()", "a,foo,bar");
        ct_expect_concrete(ctx,
            "(function(){ var ks = []; for (var k in TCH) ks.push(k); "
            "return ks.join(','); })()", "ip");
        /* a string payload enumerates its indices */
        ct_expect_concrete(ctx,
            "(function(){ var ks = []; for (var k in TSTR) ks.push(k); "
            "return ks.join(','); })()", "0,1,2");
        ct_expect_concrete(ctx, "Object.keys(TSTR).join(',')", "0,1,2");

        /* the wrapper itself owns nothing through all of this */
        tgv = eval_val(ctx, "TGO");
        assert(JS_TTOwnPropCount(ctx, tgv) == 0);
        pay = JS_TTPayload(ctx, tgv);
        assert(JS_TTOwnPropCount(ctx, pay) == 3);   /* a, foo, bar */
        JS_FreeValue(ctx, pay);
        JS_FreeValue(ctx, tgv);

        /* untagged paths byte-identical */
        ct_expect_concrete(ctx, "Object.keys({x:1,y:2}).join(',')", "x,y");
        ct_expect_concrete(ctx, "'x' in ({x:1})", "true");
        ct_expect_concrete(ctx,
            "(function(){ var ks = []; for (var k in {q:1}) ks.push(k); "
            "return ks.join(','); })()", "q");
    }
    printf("COMBINE:has/enumerate forward ok\n");

    /* --- a throwing concrete op propagates the real error -------------- */
    cb_calls = 0;
    ct_expect_throws(ctx, "TSYM * 1", "symbol");
    assert(cb_calls == 0);        /* no Combine on a failed op */
    printf("COMBINE:faithful throw ok\n");

    /* --- out-of-scope behavior is EXACTLY today's ----------------------- */
    ct_expect_concrete(ctx, "typeof T5", "object");
    ct_expect_throws(ctx, "({})[TKEY]", NULL);      /* key coercion throws */
    ct_expect_throws(ctx, "var ko = {}; ko[TKEY] = 1", NULL);
    ct_expect_throws(ctx, "String.prototype.charAt.call(TAB, 0)", NULL);
    ct_expect_throws(ctx, "new String(T9)", NULL);
    printf("COMBINE:out-of-scope unchanged ok\n");

    /* --- a propagated result rides problem 1's graph paths -------------- */
    {
        JSValue R, g, arm, tA, g2, t2;
        uint8_t *bytes;
        size_t blen;
        char want_note[64];
        int clones0;
        snprintf(want_note, sizeof(want_note), "C%d(H5,-)", JS_TT_OP_ADD);
        R = eval_val(ctx, "T5 + 1");
        assert(JS_TTIsTagged(R));
        assert(JS_TTNote(R) && strcmp((char *)JS_TTNote(R), want_note) == 0);
        g = tg_start_tflow(ctx);
        if (!JS_TTFlowSetLocal(ctx, g, 0, at_t, R)) {
            fprintf(stderr, "FAIL: inject propagated result\n");
            return 1;
        }
        clones0 = tg_clones;
        arm = JS_TTFlowFork(ctx, g);
        if (JS_IsException(arm))
            die(ctx, "fork with propagated result");
        assert(tg_clones == clones0 + 1);
        tA = JS_TTFlowGetLocal(ctx, arm, 0, at_t);
        assert(JS_TTIsTagged(tA));
        assert(JS_TTNote(tA) != JS_TTNote(R));
        assert(strcmp((char *)JS_TTNote(tA), want_note) == 0);
        bytes = JS_TTFlowSerialize(ctx, g, &blen);
        if (!bytes)
            die(ctx, "serialize propagated result");
        g2 = JS_TTFlowDeserialize(ctx, bytes, blen);
        if (JS_IsException(g2))
            die(ctx, "hydrate propagated result");
        js_free(ctx, bytes);
        t2 = JS_TTFlowGetLocal(ctx, g2, 0, at_t);
        assert(JS_TTIsTagged(t2));
        assert(strcmp((char *)JS_TTNote(t2), want_note) == 0);
        {
            JSValue p = JS_TTPayload(ctx, t2);
            assert(JS_VALUE_GET_TAG(p) == JS_TAG_INT &&
                   JS_VALUE_GET_INT(p) == 6);
            JS_FreeValue(ctx, p);
        }
        JS_FreeValue(ctx, tA);
        JS_FreeValue(ctx, t2);
        JS_FreeValue(ctx, R);
        JS_FreeValue(ctx, g);
        JS_FreeValue(ctx, g2);
        JS_FreeValue(ctx, arm);
    }
    printf("COMBINE:propagated result round-trips ok\n");

    /* --- a strict-eq boolean rides the same graph paths ------------------ */
    {
        JSValue R, g, arm, tA, g2, t2;
        uint8_t *bytes;
        size_t blen;
        char want_note[64];
        int clones0;
        snprintf(want_note, sizeof(want_note), "C%d(H5,-)",
                 JS_TT_OP_STRICT_EQ);
        R = eval_val(ctx, "T5 === 5");
        assert(JS_TTIsTagged(R));
        assert(JS_TTNote(R) && strcmp((char *)JS_TTNote(R), want_note) == 0);
        g = tg_start_tflow(ctx);
        if (!JS_TTFlowSetLocal(ctx, g, 0, at_t, R)) {
            fprintf(stderr, "FAIL: inject strict-eq result\n");
            return 1;
        }
        clones0 = tg_clones;
        arm = JS_TTFlowFork(ctx, g);
        if (JS_IsException(arm))
            die(ctx, "fork with strict-eq result");
        assert(tg_clones == clones0 + 1);
        tA = JS_TTFlowGetLocal(ctx, arm, 0, at_t);
        assert(JS_TTIsTagged(tA));
        assert(JS_TTNote(tA) != JS_TTNote(R));
        assert(strcmp((char *)JS_TTNote(tA), want_note) == 0);
        bytes = JS_TTFlowSerialize(ctx, g, &blen);
        if (!bytes)
            die(ctx, "serialize strict-eq result");
        g2 = JS_TTFlowDeserialize(ctx, bytes, blen);
        if (JS_IsException(g2))
            die(ctx, "hydrate strict-eq result");
        js_free(ctx, bytes);
        t2 = JS_TTFlowGetLocal(ctx, g2, 0, at_t);
        assert(JS_TTIsTagged(t2));
        assert(strcmp((char *)JS_TTNote(t2), want_note) == 0);
        {
            JSValue p = JS_TTPayload(ctx, t2);
            assert(JS_VALUE_GET_TAG(p) == JS_TAG_BOOL &&
                   JS_ToBool(ctx, p) == 1);
            JS_FreeValue(ctx, p);
        }
        JS_FreeValue(ctx, tA);
        JS_FreeValue(ctx, t2);
        JS_FreeValue(ctx, R);
        JS_FreeValue(ctx, g);
        JS_FreeValue(ctx, g2);
        JS_FreeValue(ctx, arm);
    }
    printf("COMBINE:strict-eq result round-trips ok\n");

    /* --- a cond observation is deterministic across fork + hydrate ------
       tflow's t1 probe (t ? typeof t : "null") is one conditional over
       the injected tagged local; resume the original, a forked arm and
       a serialize->hydrate copy, and the three observation streams must
       be byte-identical (the note travels with the value) */
    {
        JSValue R, g, arm, g2;
        uint8_t *bytes;
        size_t blen;
        char obs_direct[sizeof(cnd_log)], obs_arm[sizeof(cnd_log)];
        char obs_hydrated[sizeof(cnd_log)], tr[512];

        R = eval_val(ctx, "T5");
        g = tg_start_tflow(ctx);
        if (!JS_TTFlowSetLocal(ctx, g, 0, at_t, R)) {
            fprintf(stderr, "FAIL: inject tagged local for cond\n");
            return 1;
        }
        arm = JS_TTFlowFork(ctx, g);
        if (JS_IsException(arm))
            die(ctx, "fork for cond determinism");
        bytes = JS_TTFlowSerialize(ctx, g, &blen);
        if (!bytes)
            die(ctx, "serialize for cond determinism");
        g2 = JS_TTFlowDeserialize(ctx, bytes, blen);
        if (JS_IsException(g2))
            die(ctx, "hydrate for cond determinism");
        js_free(ctx, bytes);

        cnd_calls = 0;
        cnd_log[0] = 0;
        collect_flow(ctx, g, 0, tr, sizeof(tr));
        assert(strstr(tr, "t1:object:0"));
        assert(cnd_calls == 1 && cnd_last_taken == 1);
        snprintf(obs_direct, sizeof(obs_direct), "%s", cnd_log);

        cnd_calls = 0;
        cnd_log[0] = 0;
        collect_flow(ctx, arm, 0, tr, sizeof(tr));
        assert(strstr(tr, "t1:object:0"));
        assert(cnd_calls == 1);
        snprintf(obs_arm, sizeof(obs_arm), "%s", cnd_log);

        cnd_calls = 0;
        cnd_log[0] = 0;
        collect_flow(ctx, g2, 0, tr, sizeof(tr));
        assert(strstr(tr, "t1:object:0"));
        assert(cnd_calls == 1);
        snprintf(obs_hydrated, sizeof(obs_hydrated), "%s", cnd_log);

        assert(strcmp(obs_direct, "H5:1;") == 0);
        assert(strcmp(obs_direct, obs_arm) == 0);
        assert(strcmp(obs_direct, obs_hydrated) == 0);

        JS_FreeValue(ctx, R);
        JS_FreeValue(ctx, g);
        JS_FreeValue(ctx, arm);
        JS_FreeValue(ctx, g2);
    }
    printf("COMBINE:cond observation rides fork/hydrate ok\n");

    /* --- a forwarded search result rides the same graph paths ----------- */
    {
        JSValue R, g, arm, tA, g2, t2, pp;
        uint8_t *bytes;
        size_t blen;
        char want_note[64];

        snprintf(want_note, sizeof(want_note), "C%d(HS,-)",
                 JS_TT_OP_INDEX_OF);
        R = eval_val(ctx, "String.prototype.indexOf.call(TSTR, 'c')");
        assert(JS_TTIsTagged(R));
        assert(JS_TTNote(R) && strcmp((char *)JS_TTNote(R), want_note) == 0);
        pp = JS_TTPayload(ctx, R);
        assert(JS_VALUE_GET_TAG(pp) == JS_TAG_INT &&
               JS_VALUE_GET_INT(pp) == 2);
        JS_FreeValue(ctx, pp);
        g = tg_start_tflow(ctx);
        if (!JS_TTFlowSetLocal(ctx, g, 0, at_t, R)) {
            fprintf(stderr, "FAIL: inject search result\n");
            return 1;
        }
        arm = JS_TTFlowFork(ctx, g);
        if (JS_IsException(arm))
            die(ctx, "fork with search result");
        tA = JS_TTFlowGetLocal(ctx, arm, 0, at_t);
        assert(JS_TTIsTagged(tA));
        assert(JS_TTNote(tA) != JS_TTNote(R));
        assert(strcmp((char *)JS_TTNote(tA), want_note) == 0);
        bytes = JS_TTFlowSerialize(ctx, g, &blen);
        if (!bytes)
            die(ctx, "serialize search result");
        g2 = JS_TTFlowDeserialize(ctx, bytes, blen);
        if (JS_IsException(g2))
            die(ctx, "hydrate search result");
        js_free(ctx, bytes);
        t2 = JS_TTFlowGetLocal(ctx, g2, 0, at_t);
        assert(JS_TTIsTagged(t2));
        assert(strcmp((char *)JS_TTNote(t2), want_note) == 0);
        pp = JS_TTPayload(ctx, t2);
        assert(JS_VALUE_GET_TAG(pp) == JS_TAG_INT &&
               JS_VALUE_GET_INT(pp) == 2);
        JS_FreeValue(ctx, pp);
        JS_FreeValue(ctx, tA);
        JS_FreeValue(ctx, t2);
        JS_FreeValue(ctx, R);
        JS_FreeValue(ctx, g);
        JS_FreeValue(ctx, arm);
        JS_FreeValue(ctx, g2);
    }
    printf("COMBINE:search result round-trips ok\n");

    /* --- a forwarded property read rides the same graph paths ----------- */
    {
        JSValue R, g, arm, tA, g2, t2, pp;
        uint8_t *bytes;
        size_t blen;
        char want_note[64];

        snprintf(want_note, sizeof(want_note), "C%d(HS,-)",
                 JS_TT_OP_GET_FIELD);
        R = eval_val(ctx, "TSTR.length");
        assert(JS_TTIsTagged(R));
        assert(JS_TTNote(R) && strcmp((char *)JS_TTNote(R), want_note) == 0);
        pp = JS_TTPayload(ctx, R);
        assert(JS_VALUE_GET_TAG(pp) == JS_TAG_INT &&
               JS_VALUE_GET_INT(pp) == 3);
        JS_FreeValue(ctx, pp);
        g = tg_start_tflow(ctx);
        if (!JS_TTFlowSetLocal(ctx, g, 0, at_t, R)) {
            fprintf(stderr, "FAIL: inject get result\n");
            return 1;
        }
        arm = JS_TTFlowFork(ctx, g);
        if (JS_IsException(arm))
            die(ctx, "fork with get result");
        tA = JS_TTFlowGetLocal(ctx, arm, 0, at_t);
        assert(JS_TTIsTagged(tA));
        assert(strcmp((char *)JS_TTNote(tA), want_note) == 0);
        bytes = JS_TTFlowSerialize(ctx, g, &blen);
        if (!bytes)
            die(ctx, "serialize get result");
        g2 = JS_TTFlowDeserialize(ctx, bytes, blen);
        if (JS_IsException(g2))
            die(ctx, "hydrate get result");
        js_free(ctx, bytes);
        t2 = JS_TTFlowGetLocal(ctx, g2, 0, at_t);
        assert(JS_TTIsTagged(t2));
        assert(strcmp((char *)JS_TTNote(t2), want_note) == 0);
        pp = JS_TTPayload(ctx, t2);
        assert(JS_VALUE_GET_TAG(pp) == JS_TAG_INT &&
               JS_VALUE_GET_INT(pp) == 3);
        JS_FreeValue(ctx, pp);
        JS_FreeValue(ctx, tA);
        JS_FreeValue(ctx, t2);
        JS_FreeValue(ctx, R);
        JS_FreeValue(ctx, g);
        JS_FreeValue(ctx, arm);
        JS_FreeValue(ctx, g2);
    }
    printf("COMBINE:get result round-trips ok\n");

    /* --- teardown -------------------------------------------------------- */
    JS_FreeAtom(ctx, at_t);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);       /* the leak/double-free oracle */
    assert(tg_live == 0);     /* every note (operand + combined) freed */
    printf("COMBINE:teardown ok (combines=%d)\n", cb_calls);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc >= 3 && !strcmp(argv[1], "emit"))
        return cmd_emit(argv[2]);
    if (argc >= 3 && !strcmp(argv[1], "resume"))
        return cmd_resume(argv[2]);
    if (argc >= 3 && !strcmp(argv[1], "emit2"))
        return cmd_emit2(argv[2]);
    if (argc >= 3 && !strcmp(argv[1], "resume2"))
        return cmd_resume2(argv[2]);
    if (argc >= 2 && !strcmp(argv[1], "selftest"))
        return cmd_selftest();
    if (argc >= 2 && !strcmp(argv[1], "forktest"))
        return cmd_forktest();
    if (argc >= 2 && !strcmp(argv[1], "forkhere"))
        return cmd_forkhere();
    if (argc >= 2 && !strcmp(argv[1], "mass"))
        return cmd_mass();
    if (argc >= 2 && !strcmp(argv[1], "unbounded"))
        return cmd_unbounded();
    if (argc >= 2 && !strcmp(argv[1], "deep"))
        return cmd_deep();
    if (argc >= 2 && !strcmp(argv[1], "evict"))
        return cmd_evict();
    if (argc >= 2 && !strcmp(argv[1], "asynctest"))
        return cmd_asynctest();
    if (argc >= 2 && !strcmp(argv[1], "cowtest"))
        return cmd_cowtest();
    if (argc >= 2 && !strcmp(argv[1], "taggedtest"))
        return cmd_taggedtest();
    if (argc >= 2 && !strcmp(argv[1], "combinetest"))
        return cmd_combinetest();
    fprintf(stderr, "usage: flow-harness emit|resume <file> | selftest\n");
    return 2;
}
