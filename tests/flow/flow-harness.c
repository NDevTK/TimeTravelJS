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
"function* inner(a) {\n"
"  var t = 0.5;\n"
"  for (var k = 0; k < a; k++) {\n"
"    t += k;\n"
"    try { yield \"inner:\" + k + \":\" + t + \":\" + TABLE[k % TABLE.length]; }\n"
"    catch (e) { yield \"caught:\" + e; }\n"
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

int main(int argc, char **argv)
{
    if (argc >= 3 && !strcmp(argv[1], "emit"))
        return cmd_emit(argv[2]);
    if (argc >= 3 && !strcmp(argv[1], "resume"))
        return cmd_resume(argv[2]);
    if (argc >= 2 && !strcmp(argv[1], "selftest"))
        return cmd_selftest();
    fprintf(stderr, "usage: flow-harness emit|resume <file> | selftest\n");
    return 2;
}
