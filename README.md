# ⏳ TimeTravelJS

**True suspend/resume time-travel debugging for JavaScript, in your browser.**

A patched QuickJS engine, compiled to WebAssembly, **suspends itself at every
source line** — its entire machine state (heap, stack, program counter, spilled
C stack, virtual clock) becomes bytes in linear memory. Each step is captured
as a **copy-on-write page delta**. Time travel is then just memory: stepping
backward applies undo pages, stepping forward applies redo pages. The program
executes **exactly once** — navigation never re-runs a single instruction, so
there is no replay, no re-execution, and nothing to diverge.

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
- **Virtual time** — `Date.now()` ticks once per step, `setTimeout` runs on a
  virtual clock after the main script, `Math.random()` is seeded; recordings
  are reproducible run to run.
- **A live COW panel** — for the default sample, full per-step snapshots
  would cost ~1 GB; the page-sharing store keeps **under 1 MB** (99.9%
  saved), with per-step dirty-page charts and a heap write heat map.

## How it works

### 1. The VM pauses itself (no source transformation)

`vendor/quickjs/` contains QuickJS 2026-06-04 with a debugger patch
(reviewable as `native/quickjs-changes.patch`):

- a **step hook in the bytecode dispatch loop** that fires whenever execution
  reaches a new source line — or re-enters one via a backward jump (loop
  iterations) — with a per-frame pc→line range cache so the check is cheap;
- **frame introspection**: `JS_TTBacktrace()`, `JS_TTLocals(level)` (reading
  `vardefs`, argument/variable buffers and closure `var_refs`), and
  `JS_TTGlobalLexicals()` for script-level `let`/`const`;
- **deterministic time**: `Date.now()`/`new Date()` read a virtual clock that
  advances one unit per step and lives in the data segment — inside every
  snapshot; `Math.random()` gets a fixed seed;
- a source-filename filter so only user code (`program.js`) produces steps.

### 2. Suspension makes the whole machine a byte array

The build runs Binaryen's **Asyncify** pass over the wasm: when the step
hook's host import decides to pause, the entire wasm call stack unwinds into
a **fixed buffer inside the data segment**. While suspended, the complete
execution state — QuickJS heap, shadow stack, interpreter frames, the
asyncify spill — is linear memory, plus exactly one wasm global (the shadow
stack pointer), which the engine records per step. Restoring those bytes and
rewinding resumes the machine *mid-execution*, at any point in history.

The driver (`src/vm.js`) is ~200 lines and owns the whole protocol: one
suspendable import, entry re-invocation for rewinds, deterministic WASI
shims. No Emscripten, no handles, no FFI layer.

### 3. Copy-on-write history, one snapshot per step

`src/deltastore.js` treats memory as 1 KB pages. Each step stores only the
pages that changed (old ref + new ref), and pages are **deduplicated by
content** — a loop that flips a refcount back and forth reuses the same page
object. WebAssembly has no MMU page traps, so writes are detected by
comparison (documented honestly: software COW; an instrumented write-barrier
build is the planned upgrade). Stepping backward/forward applies before/after
images — O(pages actually touched).

### 4. Inspection is a disposable transaction

To inspect position P: restore P's pages, restore its stack pointer, rewind
the VM into the suspension, and let the wrapper's command loop run the
inspector — `JS_TTLocals` walks *live* frames — or evaluate a console
expression with the frame's locals in scope. Then the activation is aborted.
Whatever the transaction touched is healed from the page store on the next
navigation. Recorded history is immutable no matter what an evaluation does.

```
record:    ▶──▶──▶──▶──▶──▶──▶──▶──▶──▶     (executes ONCE, suspending each step)
           □  □  □  □  □  □  □  □  □  □     one COW delta per step
navigate:  ⟵ apply undo pages · apply redo pages ⟶      (no execution at all)
inspect:   restore P → rewind → read live frames → abort  (disposable)
```

## Repository layout

```
index.html, styles.css       the site (static, no build step)
dist/quickjs-tt.wasm         the VM (committed artifact, ~4.4 MB)
vendor/quickjs/              QuickJS 2026-06-04 + debugger patches (MIT)
native/tt-wrap.c             wasm embedder: exports, command loop, setup runtime
native/build.mjs             clang → wasm32-wasi, Binaryen asyncify pass
native/quickjs-changes.patch the complete QuickJS diff, for review
src/vm.js                    loader + asyncify driver + WASI shims
src/deltastore.js            per-step COW page store (content-deduplicated)
src/engine.js                recorder, delta navigation, transactional inspection
src/ui.js, main.js, samples.js   debugger UI
tests/                       node --test suites + Playwright e2e
tools/serve.mjs              zero-dependency static server
```

Deployment is `git clone` + any static file server (a GitHub Pages workflow
is included). Rebuilding the wasm needs clang with the wasm32-wasi target,
wasi-libc, and `npm i` (binaryen); the artifact is committed so neither the
site nor the tests require a C toolchain.

## Honest limitations

- Write detection is by page comparison (wasm has no dirty bits), so
  recording costs O(heap) per step — around 100–300 steps/s at the default
  6 MB heap. Recordings are capped (default 20 000 steps, 256 MB retained);
  the recorded prefix of a truncated run is fully navigable.
- Step granularity is the source line (QuickJS's pc2line), plus one step per
  loop iteration via backward-jump detection.
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
