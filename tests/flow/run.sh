#!/bin/sh
# Build the native flow-serialization harness and prove the cross-process
# round trip: a flow parked in process A resumes byte-identically in a
# fresh process B (traces diffed), plus the in-process selftest suite.
set -e
cd "$(dirname "$0")"
Q=../../vendor/quickjs
CC="${CC:-cc}"
BUILD=build
mkdir -p "$BUILD"

$CC -O1 -g -Wall -I"$Q" -D_GNU_SOURCE -DCONFIG_VERSION='"tt-flow"' \
    -o "$BUILD/flow-harness" flow-harness.c \
    "$Q/quickjs.c" "$Q/cutils.c" "$Q/libregexp.c" "$Q/libunicode.c" "$Q/dtoa.c" \
    -lm -lpthread

echo "== process A: park + serialize + reference future =="
"$BUILD/flow-harness" emit "$BUILD/flow.bin" | tee "$BUILD/a.out"
echo "== process B: fresh runtime + deserialize + resume =="
"$BUILD/flow-harness" resume "$BUILD/flow.bin" | tee "$BUILD/b.out"

grep '^POST:' "$BUILD/a.out" > "$BUILD/a.trace"
grep '^POST:' "$BUILD/b.out" > "$BUILD/b.trace"
if ! cmp -s "$BUILD/a.trace" "$BUILD/b.trace"; then
    echo "FAIL: resumed trace differs from reference"
    diff "$BUILD/a.trace" "$BUILD/b.trace" || true
    exit 1
fi
# the two processes must also agree on the baseline they rebuilt
grep '^BASELINE:' "$BUILD/a.out" > "$BUILD/a.base"
grep '^BASELINE:' "$BUILD/b.out" > "$BUILD/b.base"
if ! cmp -s "$BUILD/a.base" "$BUILD/b.base"; then
    echo "FAIL: baseline fingerprint drifted between processes"
    exit 1
fi
echo "PASS: cross-process resume is byte-identical ($(wc -l < "$BUILD/a.trace") trace lines)"

echo "== process A: machine-park inside helper (TrampFrame chain) =="
"$BUILD/flow-harness" emit2 "$BUILD/flow2.bin" | tee "$BUILD/a2.out"
echo "== process B: transplant the parked machine + resume =="
"$BUILD/flow-harness" resume2 "$BUILD/flow2.bin" | tee "$BUILD/b2.out"

grep '^POST:' "$BUILD/a2.out" > "$BUILD/a2.trace"
grep '^POST:' "$BUILD/b2.out" > "$BUILD/b2.trace"
if ! cmp -s "$BUILD/a2.trace" "$BUILD/b2.trace"; then
    echo "FAIL: machine-parked resume trace differs from reference"
    diff "$BUILD/a2.trace" "$BUILD/b2.trace" || true
    exit 1
fi
echo "PASS: machine-parked chain resumes byte-identically ($(wc -l < "$BUILD/a2.trace") trace lines)"

echo "== selftest =="
"$BUILD/flow-harness" selftest
echo "== forktest =="
"$BUILD/flow-harness" forktest
echo "== forkhere (machine-as-value) =="
"$BUILD/flow-harness" forkhere
echo "== mass (segmented arenas: N machines, O(sum depth) RAM) =="
"$BUILD/flow-harness" mass
echo "== deep (chains across segment boundaries) =="
"$BUILD/flow-harness" deep
echo "== evict (cold machines to bytes and back) =="
"$BUILD/flow-harness" evict
echo "== asynctest (per-flow job queues, await fork, evict+microtask) =="
"$BUILD/flow-harness" asynctest
echo "== cowtest (automatic transparent COW capture) =="
"$BUILD/flow-harness" cowtest
echo "== taggedtest (tagged values: payload + host note round-trips) =="
"$BUILD/flow-harness" taggedtest
echo "== combinetest (tagged propagation through value-producing ops) =="
"$BUILD/flow-harness" combinetest
echo "PASS: flow serialization suite"
