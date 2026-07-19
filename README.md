# ⏳ TimeTravelJS

**True suspend/resume time-travel debugging for JavaScript, in your browser.**

A **stackless rewrite of the QuickJS interpreter**, compiled to WebAssembly,
keeps every interpreter frame in linear memory — **no C stack ever spans a
step**. Suspending the machine is just *returning from a function*; resuming
is calling one. At every step (each source line, or each VM instruction in
microscope mode) the complete machine state — heap, frames, program counter,
virtual clock — is bytes, captured as a **copy-on-write page delta**. Time
travel is then just memory: stepping backward applies undo pages, stepping
forward applies redo pages. The program executes **exactly once** —
navigation never re-runs a single instruction, so there is no replay, no
re-execution, and nothing to diverge. And because the suspended machine is
just bytes, history can **fork**: edit a variable at any past moment and let
execution continue from there onto a new timeline.

```
npm start          # serve → http://127.0.0.1:8642/  (static site, no build)
npm test           # unit tests (delta store + engine against the real wasm VM)
npm run test:e2e   # Playwright end-to-end test in headless Chromium
npm run build      # rebuild dist/quickjs-tt.wasm (clang + wasi-libc + binaryen)
```

## What you get

- **Bidirectional stepping** — into / over / out, forwards and backwards, with
  breakpoints and reverse-continue. Every jump lands in microseconds.
- **Real frames** — the variables panel reads arguments, locals, closure
  captures and TDZ slots straight out of the interpreter's stack frames via a
  C-level introspection API. Click any call-stack frame to see its locals.
- **Everything is steppable** — `async`/`await`, promise jobs, generators,
  getters, constructors, class methods, callbacks inside `Array.map`: user
  code is **never transformed**; the VM itself pauses, wherever it is.
- **Time-sliced console** — output appears and disappears as you scrub;
  logging captured values as they were at the moment of the log.
- **Console evaluation at any moment** — expressions run *inside* the paused
  interpreter with the innermost frame's locals in scope, inside a disposable
  transaction. The timeline is immutable by construction.
- **Timeline forking (edit and continue)** — Shift+Enter (or the ⑂ button)
  applies your expression to the *live paused frame* — real locals included,
  via a C-level frame writer — discards the old future and lets the machine
  keep executing from that exact state, recording a new one. Fork without an
  edit and determinism gives you back the identical future, step for step.
- **Virtual time** — `Date.now()` ticks once per step, `setTimeout` runs on a
  virtual clock after the main script, `Math.random()` is seeded; recordings
  are reproducible run to run.
- **A live COW panel** — for the default sample, full per-step snapshots
  would cost ~1 GB; the page-sharing store keeps **under 1 MB** (99.9%
  saved), with per-step dirty-page charts and a heap write heat map.
- **A real write barrier** — every store instruction in the wasm is
  instrumented to mark its 1 KB page in a dirty map, so each step captures
  only pages actually written: **~50 000 recorded steps/s**, independent of
  heap size.
- **Two step granularities** — one snapshot per source line, or flip to
  **opcode steps** and scrub between *every two VM instructions*: watch a
  single expression evaluate sub-term by sub-term.

## How it works

### 1. A stackless interpreter (no source transformation)

`vendor/quickjs/` contains QuickJS 2026-06-04 with its execution core
rewritten (reviewable as `native/quickjs-changes.patch` — at this point it
is honestly a fork, not a patch):

- **all interpreter frames live in a fixed linear-memory arena** — a JS→JS
  call bump-allocates a frame and the *same* dispatch loop continues into
  the callee; a return pops it. No C recursion, no `alloca`. The former C
  parameters (`this`, `new.target`, the argument vector) became per-frame
  fields. QuickJS itself pointed the way: generators and async functions
  already ran on heap-allocated frames — the rewrite generalizes their
  frame model to every call. Recursion depth becomes an exact,
  snapshot-stable limit (an ordinary catchable `stack overflow` ~18 000
  frames deep) instead of a C-stack accident;
- a **step hook in the dispatch loop** that fires per source line — or,
  at opcode granularity, between every two VM instructions — with a
  per-frame pc→line range cache so the check is cheap;
- **frame introspection and editing**: `JS_TTBacktrace()`,
  `JS_TTLocals(level)`, `JS_TTGlobalLexicals()`, and `JS_TTSetLocal()`
  (the fork write-back), all reading/writing the live frames;
- **deterministic time**: `Date.now()`/`new Date()` read a virtual clock that
  advances one unit per step and lives in the data segment — inside every
  snapshot; `Math.random()` gets a fixed seed;
- a source-filename filter so only user code (`program.js`) produces steps.

### 2. Suspending IS returning (with Asyncify as the fallback)

Because no C stack spans a step on the stackless path, parking the machine
is just the dispatch loop *returning to the host*, and resuming is a fresh
call (`JS_TTCallStart`/`JS_TTCallResume`). The suspended machine has **no
wasm activation at all** — its complete state is linear memory, restorable
from any snapshot by construction.

Steps reached while native C frames are genuinely live — a `sort`
comparator, a getter invoked from a C path, generator bodies, promise
jobs — still suspend through Binaryen's **Asyncify** pass: the C stack
unwinds into a fixed buffer inside the data segment and the engine records
the one wasm global (the shadow stack pointer) that a rewind needs. The
recorder mixes both freely, per step; the test suite pins each path.

The driver (`src/vm.js`) owns both protocols in ~250 lines: park-by-return,
one suspendable import for the fallback, deterministic WASI shims. No
Emscripten, no handles, no FFI layer.

### 3. Copy-on-write history with a hardware-style write barrier

WebAssembly has no MMU page traps, so the build synthesizes them:
`native/barrier.mjs` is a post-Asyncify bytecode pass that rewrites **every
store instruction** (plus `memory.copy`/`fill`/`init`) to also mark its 1 KB
page in a dirty map inside the data segment. Each step then captures
O(pages written) instead of O(heap): the recorder reads-and-clears the map,
compares just those pages, and stores old ref + new ref per changed page
(`src/deltastore.js`). Pages are **deduplicated by content** — a loop that
flips a refcount back and forth reuses the same page object. Stepping
backward/forward applies before/after images. An audit mode
(`{ verifyBarrier: true }`, exercised in the test suite) re-scans all of
memory after every step to prove the barrier misses nothing.

### 4. Inspection is a disposable transaction

At a return-parked position it barely deserves the name: restore P's pages
and *call* the inspector — the restored memory **is** the parked machine,
its frame chain live and walkable, repeatably, with nothing to rewind. At an
Asyncify position, inspection is a one-shot transaction: restore the pages
and the recorded stack pointer, rewind into the suspension, run the
inspector or a console evaluation inside the live interpreter, abort the
disposable activation. Either way, whatever the transaction touched is
healed from the page store afterwards. Recorded history is immutable no
matter what an evaluation does.

### 5. Forking is the same machinery, allowed to commit

A fork at position P restores P exactly like an inspection — but instead of
aborting, the optional edit is written back into the real interpreter frame
(`JS_TTSetLocal` updates argument/variable slots and closure cells), history
after P is truncated, and the resumed activation simply keeps recording.
The old future's pages are garbage-collected from the store; the shared
prefix stays byte-identical. Because time and randomness are virtual, a fork
*without* an edit re-records the same future step for step — determinism you
can watch.

```
record:    ▶──▶──▶──▶──▶──▶──▶──▶──▶──▶     (executes ONCE, parking each step)
           □  □  □  □  □  □  □  □  □  □     one COW delta per step
navigate:  ⟵ apply undo pages · apply redo pages ⟶      (no execution at all)
inspect:   restore P → call into the parked machine → heal      (repeatable)
fork:      restore P → apply edit to live frame → CONTINUE ▶──▶──▶ (new future)
```

## Repository layout

```
index.html, styles.css       the site (static, no build step)
dist/quickjs-tt.wasm         the VM (committed artifact, ~2.8 MB)
vendor/quickjs/              QuickJS 2026-06-04, execution core rewritten (MIT)
native/tt-wrap.c             wasm embedder: exports, command loop, setup runtime
native/build.mjs             clang → wasm32-wasi, Binaryen asyncify pass
native/barrier.mjs           wasm bytecode pass: the dirty-page write barrier
native/quickjs-changes.patch the complete QuickJS diff, for review
src/vm.js                    loader + dual park/rewind driver + WASI shims
src/deltastore.js            per-step COW page store (content-deduplicated)
src/engine.js                recorder, delta navigation, inspection, forking
src/ui.js, main.js, samples.js   debugger UI
tests/                       node --test suites + Playwright e2e
tools/serve.mjs              zero-dependency static server
```

Deployment is `git clone` + any static file server (a GitHub Pages workflow
is included). Rebuilding the wasm needs clang with the wasm32-wasi target,
wasi-libc, and `npm i` (binaryen); the artifact is committed so neither the
site nor the tests require a C toolchain.

## Honest limitations

- Recording runs at roughly 50 000 steps/s (write-barrier capture is
  O(pages written) per step, and marked-but-unchanged pages cost one
  compare). Recordings are still capped (default 20 000 steps, 256 MB
  retained); the recorded prefix of a truncated run is fully navigable.
  Opcode granularity multiplies step counts ~5–15×.
- Steps under genuinely live C frames (sort comparators, getters reached
  from C paths, generator bodies, promise jobs, constructors) suspend via
  the Asyncify fallback rather than by return — same capabilities, plus a
  one-rewind-per-activation rule for inspections there. Converting those
  reentry sites to the stackless path is the remaining migration.
- Inlined tail calls keep the caller's frame: proper-tail-call space
  guarantees are traded for park-anywhere (depth is bounded by the 2 MB
  frame arena, ~18 000 frames).
- `eval`'d / `new Function` code steps only if its filename matches the user
  program (it doesn't), and `setInterval` is not provided (`setTimeout`
  chains are).
- Promise jobs and timer callbacks run steppably *after* the main script on
  the virtual clock — ordering is faithful to a single-threaded event loop,
  timing is virtual by design.
- One recording session lives in the VM at a time; pressing Record resets the
  context (the wasm instance is reused).

## License

MIT for TimeTravelJS code. QuickJS is MIT (Fabrice Bellard & Charlie
Gordon) — see `vendor/LICENSES.md` and `vendor/quickjs/LICENSE`.
