# ⏳ TimeTravelJS

**Time-travel debugging for JavaScript, in your browser, powered by QuickJS on WebAssembly with copy-on-write memory snapshots.**

Write a program, hit **Record**, then scrub anywhere in its execution history: step *backward* statement by statement, reverse-continue to a breakpoint, inspect every local variable at any moment, and watch the console un-print itself as you rewind. No server, no build step — a static page.

```
npm start          # serve locally → http://127.0.0.1:8642/
npm test           # unit tests (transform, COW store, engine vs real QuickJS)
npm run test:e2e   # Playwright end-to-end test in headless Chromium
```

## How it works

Three ideas compose into a time machine:

### 1. Every statement is a resumable suspension point

User code is instrumented (parsed with [acorn](https://github.com/acornjs/acorn), regenerated with [astring](https://github.com/davidbonnet/astring)) so that each function becomes a **pair**:

- a hidden *generator* carrying the real body, which `yield`s a step marker
  `[0, line, col, endLine, endCol, depth]` before every statement, and
- a plain *façade* function that runs the generator to completion atomically
  when something uninstrumented (a native like `Array.prototype.map`, or code
  we chose not to transform) calls it.

Call sites inside instrumented code go through `yield* __tt_call(...)`, which
delegates into the callee's hidden generator — so stepping recurses through
user function calls, and the whole program becomes one big generator that the
host pokes one step at a time. The key property: **while suspended at a
`yield`, every local, closure, and stack frame lives in the QuickJS heap** —
not on the C stack.

### 2. The whole VM is one snapshottable byte array

QuickJS is compiled to WebAssembly ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)),
so the entire VM — heap, globals, suspended generator frames, the PRNG state,
the virtual clock — lives inside one linear memory. Because the program only
ever pauses while suspended (VM idle, wasm stack unwound), restoring that
memory byte-for-byte restores *the entire program state*, mid-execution.

### 3. Snapshots are copy-on-write

Snapshotting 16 MB per checkpoint would be absurd, so the store
(`src/snapshots.js`) treats memory as 4 KB pages and keeps **immutable page
tables that share every unchanged page with the previous snapshot** — only
dirty pages are copied. WebAssembly has no hardware page-protection traps, so
writes are detected by comparison (software COW). Checkpoints typically retain
a few percent of their naive cost; the *copy-on-write memory* panel in the UI
shows the live numbers and a page-write heat map.

**Navigation** = restore the nearest checkpoint at-or-before the target step
(again writing only differing pages), then replay forward by poking the
generator. Replay is deterministic because time is virtualized (`Date.now`,
`new Date()`, `performance.now` follow a step-driven virtual clock stored in
the heap), `Math.random` is a seeded PRNG stored in the heap, and timers are
virtual (`setTimeout` queues into the heap; callbacks run steppably after the
main script on the virtual clock). Reverse-step is just "restore + replay
N−1" — and with checkpoints every few dozen steps, it feels instant.

```
record:   ▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶──▶
               □ checkpoint      □ checkpoint      □ checkpoint
                                        (pages shared unless dirty)
step back to t=13:
               restore □ (t=10) ──▶──▶──▶ replay 3 steps → t=13
```

## What the debugger gives you

- **Bidirectional stepping** — into / over / out, forwards *and* backwards.
- **Breakpoints with reverse-continue** — run backwards to the last time a
  line executed. Finding *"when did this variable go wrong?"* becomes trivial.
- **Timeline scrubber** — with a call-depth silhouette, checkpoint ticks
  (brightness = dirty pages), console events, timer firings, and error zones.
- **Variables panel** — every binding lexically visible at the paused
  statement (params, locals, closures, TDZ shown as ‹not yet declared›),
  captured by generated scope thunks, serialized getter-safely inside the VM.
- **Call stack** with call-site lines.
- **Time-sliced console** — output appears/disappears as you scrub; logging
  records values *as they were at the moment of the log*.
- **Debug console** — evaluate expressions against the live VM at the paused
  moment (locals are in scope). Mutations are allowed but discarded on the
  next navigation, keeping the recorded timeline truthful.
- **COW memory panel** — snapshot count, unique pages, naive-vs-actual bytes,
  per-checkpoint dirty pages, and a heap page-write heat map.

## Repository layout

```
index.html, styles.css      the site (buildless, static)
src/instrument.js           acorn-based generator transform
src/vmruntime.js            support runtime evaluated inside QuickJS
src/engine.js               record / checkpoint / restore+replay driver
src/snapshots.js            page-level copy-on-write snapshot store
src/ui.js, src/main.js      debugger UI
src/samples.js              sample programs
vendor/                     vendored ESM deps (quickjs-emscripten, acorn, astring)
tests/                      node --test suites + Playwright e2e
tools/serve.mjs             zero-dependency static server
```

The site runs entirely from static files; `vendor/` contains the exact ESM
builds it uses (QuickJS wasm is embedded base64 in the singlefile variant), so
`git clone` + any static file server is a working deployment. GitHub Pages
serves it as-is via the included workflow.

## Honest limitations

Graceful degradation is the rule: anything the instrumenter doesn't transform
still *runs correctly*, it just executes atomically (no stepping inside).

- Callbacks invoked *by natives* (`map`, `forEach`, …) run atomically.
- `async`/`await`, user generators, getters/setters, class constructors,
  methods using `super`/private fields, `with`, and computed-key methods run
  uninstrumented. Promise `.then` callbacks execute between steps after the
  main script (microtask pumping is deterministic during replay).
- `setInterval` is not supported; `setTimeout` chains are.
- Top-level `var`/`function` live in the wrapper scope, not on `globalThis`
  (they still show in the variables panel).
- One statement = one step: intra-expression pauses only happen at calls.
- Programs are capped (default 20 000 steps) to keep recordings snappy; the
  truncated timeline remains fully navigable.
- Deep instrumented recursion is bounded by the VM stack (generator delegation
  resumes through each frame).

## Why "COW", exactly?

Classic time-travel debuggers fork the process and let the OS's copy-on-write
page tables make checkpoints cheap. A browser tab has no `fork()`, no `mmap`,
no dirty bits — but it *does* have the VM's entire universe as one byte array.
TimeTravelJS reproduces the same economics in userland: immutable shared pages,
copies only on detected writes, restores that touch only differing pages. Same
idea, different substrate.

## License

MIT for this project's code. Vendored dependencies keep their own licenses —
see `vendor/LICENSES.md` (QuickJS and quickjs-emscripten are MIT; acorn and
astring are MIT).
