# Vendored third-party licenses

## QuickJS (vendor/quickjs/) — version 2026-06-04

Copyright (c) 2017-2025 Fabrice Bellard and Charlie Gordon, MIT License —
see `vendor/quickjs/LICENSE`. The sources carry TimeTravelJS debugger
patches; the complete diff against the pristine release is
`native/quickjs-changes.patch`.

Build-time-only tools (not shipped): clang/LLVM (Apache-2.0 WITH
LLVM-exception), wasi-libc (Apache-2.0/MIT), Binaryen (Apache-2.0),
playwright-core (Apache-2.0).

## Lexbor

`vendor/lexbor/` vendors the Lexbor HTML/DOM/CSS engine
(https://github.com/lexbor/lexbor), Apache License 2.0 — see
`vendor/lexbor/LICENSE` and `vendor/lexbor/VERSION` for the exact
upstream commit. Modules included: core, dom, html, css, selectors,
style, tag, ns, ports/posix (the encoding/unicode/url modules are not
needed and not vendored).
