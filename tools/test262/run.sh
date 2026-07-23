#!/bin/sh
# Build the native test262 harness against the repo's rewritten engine and
# run the conformance suite. Two oracles:
#
#   sh tools/test262/run.sh            classic evaluation (the upstream
#                                      run-test262 drive; must match
#                                      test262_errors.txt exactly)
#   sh tools/test262/run.sh preempt    forced preemption: every test runs
#                                      through the park-by-return path,
#                                      parking at EVERY parkable step (each
#                                      source line + every loop back-edge)
#                                      and resuming from the heap frame
#                                      chain; jobs and module bodies drive
#                                      through the same protocol. Reports a
#                                      park-engagement metric next to the
#                                      pass rate; per-test counters land in
#                                      build/preempt-metrics.csv.
#   sh tools/test262/run.sh opcode     forced preemption between every two
#                                      VM instructions (slower, strictest)
#
# Needs a clone of tc39/test262 at (or symlinked to) tools/test262/test262,
# checked out at the commit QuickJS 2026-06-04 pins, with its
# tests/test262.patch applied:
#   git clone https://github.com/tc39/test262.git
#   cd test262 && git checkout 5c8206929d81b2d3d727ca6aac56c18358c8d790
#   patch -p1 < <quickjs-2026-06-04>/tests/test262.patch
set -e
cd "$(dirname "$0")"
Q=../../vendor/quickjs
CC="${CC:-cc}"
BUILD=build
mkdir -p "$BUILD"

$CC -O2 -g -Wall -I"$Q" -D_GNU_SOURCE -DCONFIG_VERSION='"tt-262"' \
    -o "$BUILD/run-test262" run-test262.c \
    "$Q/quickjs.c" "$Q/cutils.c" "$Q/libregexp.c" "$Q/libunicode.c" "$Q/dtoa.c" \
    -lm -lpthread

if [ ! -e test262/features.txt ]; then
    echo "test262 corpus not found: clone tc39/test262 into tools/test262/test262" >&2
    echo "(commit 5c8206929d81b2d3d727ca6aac56c18358c8d790 + quickjs tests/test262.patch)" >&2
    exit 1
fi

case "${1:-classic}" in
classic)
    exec "$BUILD/run-test262" -c test262.conf -a ;;
preempt)
    exec "$BUILD/run-test262" -P -c test262.conf -a -M "$BUILD/preempt-metrics.csv" ;;
opcode)
    exec "$BUILD/run-test262" -P -G 1 -c test262.conf -a -M "$BUILD/preempt-opcode-metrics.csv" ;;
*)
    echo "usage: run.sh [classic|preempt|opcode]" >&2
    exit 2 ;;
esac
