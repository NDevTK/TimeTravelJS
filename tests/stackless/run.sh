#!/bin/sh
# Build and run the stackless probe: mechanical proof that JS recursion
# depth never touches the C stack (one hook-observed C frame address at
# JS depth 1 and 12 000), that the machine parks by return and resumes at
# every step of that recursion, and that the whole engine completes it
# inside a 256 KB C stack.
set -e
cd "$(dirname "$0")"
Q=../../vendor/quickjs
CC="${CC:-cc}"
BUILD=build
mkdir -p "$BUILD"

$CC -O1 -g -Wall -I"$Q" -D_GNU_SOURCE -DCONFIG_VERSION='"tt-probe"' \
    -o "$BUILD/probe" probe.c \
    "$Q/quickjs.c" "$Q/cutils.c" "$Q/libregexp.c" "$Q/libunicode.c" "$Q/dtoa.c" \
    -lm -lpthread

exec "$BUILD/probe"
