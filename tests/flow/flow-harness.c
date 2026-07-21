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
 */
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

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
    fprintf(stderr, "usage: flow-harness emit|resume <file> | selftest\n");
    return 2;
}
