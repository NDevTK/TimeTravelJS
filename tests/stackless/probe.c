/*
 * TimeTravelJS stackless probe.
 *
 * Proves — mechanically, not by assertion — that the rewritten engine
 * keeps NO C-stack state between JavaScript frames:
 *
 *   flat      One uninterrupted run of a 8 000-deep JS recursion, with a
 *             step hook that records __builtin_frame_address(0) at every
 *             step. A C-recursive interpreter descends one C frame per JS
 *             call, so the hook's frame address would march downward with
 *             JS depth; a stackless interpreter dispatches every JS frame
 *             from the SAME loop activation, so the address must be
 *             byte-identical at JS depth 1 and JS depth 8 000. The probe
 *             asserts exactly one distinct address across all steps.
 *
 *   preempt   The same recursion parked BY RETURN at every parkable step
 *             and resumed from the heap frame chain — tens of thousands
 *             of suspend/resume round trips through main(), each leaving
 *             no wasm/C activation behind. Asserts every park request
 *             fired and the final value is exact.
 *
 *   tinystack Both of the above again, inside a pthread whose entire C
 *             stack is 256 KB. 8 000 C-recursive interpreter frames need
 *             megabytes (pristine QuickJS throws InternalError "stack
 *             overflow" here by design — its JS depth is a C-stack
 *             accident); the stackless engine completes because JS depth
 *             lives in the frame arena, not the C stack.
 *
 * Build/run: sh tests/stackless/run.sh   (or: npm run test:stackless)
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>

#include "quickjs.h"

#define DEPTH 8000

static const char *PROGRAM =
    "function f(n) {\n"
    "  if (n <= 0)\n"
    "    return 0;\n"
    "  return 1 + f(n - 1);\n"
    "}\n"
    "f(" /* depth appended at runtime */;

typedef struct {
    uintptr_t addrs[4];      /* distinct hook C-frame addresses seen */
    long long counts[4];     /* steps observed at each */
    int naddrs;
    long long requested;     /* handler invocations */
    long long fired;         /* parks taken */
    int max_depth;           /* deepest JS frame depth reported */
    int park;                /* 1 = request a park at every parkable step */
} Probe;

static int probe_step_handler(JSContext *ctx, int line, int col, int depth,
                              int parkable, void *opaque)
{
    Probe *p = opaque;
    uintptr_t fa = (uintptr_t)__builtin_frame_address(0);
    int i;

    (void)ctx; (void)line; (void)col;
    for (i = 0; i < p->naddrs; i++) {
        if (p->addrs[i] == fa)
            break;
    }
    if (i == p->naddrs && p->naddrs < 4)
        p->addrs[p->naddrs++] = fa;
    if (i < 4)
        p->counts[i]++;
    p->requested++;
    if (depth > p->max_depth)
        p->max_depth = depth;
    if (p->park && parkable) {
        p->fired++;
        return 2;
    }
    return 0;
}

static int fail(const char *what)
{
    fprintf(stderr, "FAIL: %s\n", what);
    return 1;
}

/* Run the deep recursion under the given probe mode; returns 0 on success. */
static int run_probe(const char *label, int park)
{
    JSRuntime *rt;
    JSContext *ctx;
    Probe probe;
    char src[256];
    JSValue fn, v;
    int parked = 0, ret = 1;
    long long resumes = 0;

    rt = JS_NewRuntime();
    if (!rt)
        return fail("JS_NewRuntime");
    ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        return fail("JS_NewContext");
    }

    memset(&probe, 0, sizeof(probe));
    probe.park = park;
    JS_TTSetStepHandler(rt, probe_step_handler, &probe);
    JS_TTEnableStep(rt, 1);

    snprintf(src, sizeof(src), "%s%d);\n", PROGRAM, DEPTH);
    fn = JS_Eval(ctx, src, strlen(src), "probe.js",
                 JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(fn)) {
        fail("compile");
        goto out;
    }
    v = JS_TTCallStart(ctx, fn, &parked);
    while (parked) {
        JS_FreeValue(ctx, v);
        resumes++;
        v = JS_TTCallResume(ctx, 0, &parked);
    }
    if (JS_IsException(v)) {
        JSValue e = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, e);
        fprintf(stderr, "FAIL: %s: exception: %s\n", label, s ? s : "?");
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
        goto out;
    }
    {
        int32_t n = -1;
        JS_ToInt32(ctx, &n, v);
        JS_FreeValue(ctx, v);
        if (n != DEPTH) {
            fprintf(stderr, "FAIL: %s: f(%d) = %d\n", label, DEPTH, n);
            goto out;
        }
    }
    if (probe.max_depth < DEPTH) {
        fprintf(stderr, "FAIL: %s: max JS depth %d < %d\n",
                label, probe.max_depth, DEPTH);
        goto out;
    }
    /* The stackless property itself. Uninterrupted run: ONE loop
       activation dispatches every JS frame, so the hook must observe ONE
       C frame address no matter how deep the JS recursion is. Preempt
       run: the initial JS_TTCallStart entry and the JS_TTCallResume
       re-entries are two distinct host->loop call paths (two addresses),
       but each is depth-invariant — every resume, whether it lands at JS
       depth 2 or 8000, re-enters at the identical C position, so all
       resumed steps share one dominant address. */
    if (!park) {
        if (probe.naddrs != 1) {
            fprintf(stderr, "FAIL: %s: %d distinct hook C-frame addresses "
                    "(C stack tracks JS depth?)\n", label, probe.naddrs);
            goto out;
        }
    } else {
        long long dominant = 0;
        int i;
        for (i = 0; i < probe.naddrs; i++)
            if (probe.counts[i] > dominant)
                dominant = probe.counts[i];
        if (probe.naddrs > 2 || dominant < probe.requested - 1) {
            fprintf(stderr, "FAIL: %s: %d distinct hook C-frame addresses, "
                    "dominant %lld/%lld (resume C depth tracks JS depth?)\n",
                    label, probe.naddrs, dominant, probe.requested);
            goto out;
        }
    }
    if (park && probe.fired != probe.requested) {
        fprintf(stderr, "FAIL: %s: %lld of %lld park requests fired\n",
                label, probe.fired, probe.requested);
        goto out;
    }
    printf("PROBE %-9s steps=%lld parks=%lld resumes=%lld max_js_depth=%d "
           "distinct_c_frames=%d\n",
           label, probe.requested, probe.fired, resumes, probe.max_depth,
           probe.naddrs);
    ret = 0;
out:
    JS_TTEnableStep(rt, 0);
    JS_TTSetStepHandler(rt, NULL, NULL);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return ret;
}

static void *tiny_stack_main(void *arg)
{
    intptr_t r = 0;
    (void)arg;
    r |= run_probe("tiny-flat", 0);
    r |= run_probe("tiny-park", 1);
    return (void *)r;
}

int main(void)
{
    pthread_t th;
    pthread_attr_t attr;
    void *tret = (void *)1;
    int r = 0;

    r |= run_probe("flat", 0);
    r |= run_probe("preempt", 1);

    /* the whole engine — parser included — inside a 256 KB C stack:
       ~21 bytes of C stack per JS frame would already burst it */
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 256 * 1024);
    if (pthread_create(&th, &attr, tiny_stack_main, NULL) != 0)
        return fail("pthread_create");
    pthread_join(th, &tret);
    pthread_attr_destroy(&attr);
    r |= (int)(intptr_t)tret;

    if (r == 0)
        printf("PASS: stackless probe (depth %d, 256 KB C stack included)\n",
               DEPTH);
    return r;
}
