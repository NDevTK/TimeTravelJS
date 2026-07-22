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
execution continue from there onto a new timeline. An embedded HTML/CSS
engine lives in the same snapshotted memory, so **the document time-travels
with the program** — scrub the timeline and watch the DOM rewind.

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
- **Change tracking through time** — stepping highlights every variable
  whose value differs from the previously viewed moment, and the **🕐
  when** search lists each step where a watched expression *changed*
  value — "when did total go negative?" is one click, and every answer
  row jumps straight to that moment.
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
  via a C-level frame writer — and lets the machine keep executing from that
  exact state, recording a new future. Fork without an edit and determinism
  gives you back the identical future, step for step.
- **The multiverse: forks keep both futures** — the abandoned future stays
  reachable as a sibling timeline (a strip above the scrubber switches
  between them), and because every timeline shares one content-deduplicated
  page pool, a branch costs only the pages it diverges on. Navigation
  between any two moments of any two timelines walks the tree through their
  common ancestor — still pure memory, still no re-execution.
- **"What would have happened if?"** — the what-if panel forks the current
  step once per candidate edit, records every hypothetical future, and
  shows the outcomes side by side with the first step where a probe turns
  true. `searchAll(expr)` BFS-scans a predicate across every state of every
  timeline (each state visited exactly once); `searchChanges(expr)`
  reports every step where an expression's value changed — the 🕐 when
  button; `explore({goal, depth})` goes
  further and *learns how the web platform API could have been used*: it
  reads candidate calls off the live document (events with real listeners,
  stylesheet classes, elements by id), forks each as a timeline, composes
  deeper call sequences breadth-first, and returns only execution-verified
  examples — every one a real, scrubbable recording whose future satisfies
  the goal.
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
- **Website-shaped sessions** — programs get `location`, `URL`,
  `URLSearchParams`, `localStorage`/`sessionStorage` and a `postMessage`
  channel, self-hosted *inside* the machine, so the URL, every storage
  cell and the message queue snapshot, scrub and fork with the rest of
  the state. The machine records which parameters, storage keys and
  message handlers the program actually consulted.
- **Concolic input search that learns, never guesses** — the VM keeps a
  **comparison journal**: every string `===`, `includes`, `startsWith`,
  `endsWith`, `indexOf` the recorded program performs, living in the
  machine itself so it rewinds and forks with each timeline. The
  **"?⑂ inputs" search** answers the real-site question — *which
  `?param=value` / storage value / message payload enables this
  feature?* — by probing each observed input with a canary in a full
  alternate run and reading what that run *compared the canary against*.
  Each observation becomes the next candidate; required formats compose
  across rounds (probe → `pref:<canary>` → `pref:gold`), object message
  protocols reveal their keys through a recording proxy payload, and
  attribution survives case-normalizing programs (the canary is found
  re-cased; learned constants are tried in both spellings). The input
  set is **dynamic**: registries are re-read at every fork's end, so a
  storage key or handler consulted only inside a branch some candidate
  unlocked joins the search mid-flight with the unlocking assignments as
  context. The search **learns from unused logic**: never-fired handlers
  are probed first, runs that execute lines the recording never reached
  explore first, and every answer carries its provenance chain and comes
  back execution-verified.
- **DOM + CSS time travel** — give the session an HTML document and it is
  parsed by an embedded [Lexbor](https://github.com/lexbor/lexbor) engine
  *into the same linear memory as the JS heap*. The DOM tree and CSSOM are
  covered by the same write barrier and the same COW pages as everything
  else, so scrubbing the timeline rewinds the document — every mutation,
  attribute, class toggle and stylesheet — with zero extra machinery, and
  forking a timeline forks the document with it. A live preview panel
  renders the document *as it was* at the selected step. `querySelector`,
  events with capture/target/bubble phases, `getComputedStyle` with real
  cascade (specificity, `!important`, inline overlay) — and event handlers
  are ordinary parked bytecode, steppable like all other code.

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
  frames deep) instead of a C-stack accident. `npm run test:stackless`
  proves the property mechanically: an 8 000-deep JS recursion observes
  ONE C frame address at every step (the C stack does not track JS
  depth), parks and resumes at all 24 004 of its steps, and completes
  inside a 256 KB C stack — where pristine QuickJS segfaults at that
  budget and throws `stack overflow` even at its defaults;
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

### 2. Suspending IS returning (no Asyncify, no stack switching)

Parking the machine is just the dispatch loop *returning to the host*, and
resuming is a fresh call (`JS_TTCallStart`/`JS_TTCallResume`). The
suspended machine has **no wasm activation at all** — its complete state is
linear memory, restorable from any snapshot by construction. Everything
that used to need a C frame between the loop and user code was converted:
constructors, generator creation and resumption, async function segments,
promise reaction / thenable jobs and timer callbacks run **in the loop**
via pre/post protocol halves shared verbatim with the classic C paths, and
the callback-taking Array builtins are self-hosted in the debug runtime.
The Asyncify pass is gone from the build entirely.

Every reentry path a program normally exercises is converted: property
accessors (including under `with` and behind proxy `get`/`set`/
`defineProperty` traps — class fields initializing onto a proxied `this`
included), every coercion the operators perform (`+`, `-`, `*`, `/`,
`%`, `**`, shifts, bitwise ops, comparisons, `++`/`--`, `~`, unary
`+`/`-`, templates, `String()`, computed keys — with `ToNumeric`'s exact
error ordering), `instanceof` via `Symbol.hasInstance`, user iterables
everywhere they appear (`for‑of`, spread, destructuring, and
`.return()` cleanup on early exits like `break` — generator `finally`
blocks included), bound functions and `Function.prototype.call`/`apply`
(tail position included), async generators from creation through
`for await`, and the callback-taking builtins. The test suite gates on
`summary.suppressedSteps === 0` for a program spanning that whole
surface. What still executes under C — counted honestly per recording —
is a residue of genuinely reflective machinery: accessor-defined
`Symbol.toPrimitive` (the trap read itself), iterator `.return` during
exception unwinding, object-spread over accessors, `++` on
object-valued locals, direct `eval` internals, and property-descriptor
reflection utilities.

The driver (`src/vm.js`) is one protocol and ~150 lines: park-by-return
plus deterministic WASI shims. No Emscripten, no handles, no FFI layer.

### 3. Copy-on-write history with a hardware-style write barrier

WebAssembly has no MMU page traps, so the build synthesizes them:
`native/barrier.mjs` is a wasm bytecode pass that rewrites **every
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

It barely deserves the name: restore position P's pages and *call* the
inspector — the restored memory **is** the parked machine, its frame chain
live and walkable, repeatably, with nothing to rewind and no stack state
outside linear memory. Whatever the inspection or console evaluation
touched is healed from the page store afterwards. Recorded history is
immutable no matter what an evaluation does.

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

### 6. The document is part of the machine

Browsers can't time-travel the DOM because the DOM lives outside the JS
engine, mutated by C++ the debugger can't rewind. Here the whole HTML/CSS
engine is *inside* the snapshot boundary: Lexbor's parser, DOM tree, and
CSSOM are compiled into the same wasm module and allocate from the same
linear memory as the QuickJS heap. The write barrier doesn't know the
difference between a JS object write and a DOM child-pointer write — both
dirty a page, both land in the step's COW delta. Restoring step N restores
the document at step N, atomically with the JS heap that references it.

The binding is deliberately thin: C exposes leaf primitives (pointer-sized
node handles; each call runs to completion between steps, so DOM calls
never suppress a snapshot), and the entire DOM API — element wrappers,
`childNodes`, `innerHTML`, event capture/bubble dispatch, the `style`
facade, `getComputedStyle`'s cascade — is self-hosted **in JavaScript
inside the machine**, which means user event handlers and DOM callbacks
park mid-flight like any other code. Nodes detached during a session are
unlinked, never destroyed, so a handle held across `innerHTML = …`
remains valid on every timeline that ever saw it.

### 7. The multiverse: BFS over what could have happened

A recorded timeline answers "what happened". Because suspended machines
are just bytes, the engine also answers "what *would* have happened":
`forkFrom()` keeps the abandoned future as a sibling branch, so history is
a **tree of delta chains** — all interning pages into one shared pool, so
sibling timelines pay only for their divergence; their common prefix is
literally the same chain. Moving between (timeline A, step i) and
(timeline B, step j) walks the tree through the lowest common ancestor:
undo up, move within, redo down — every transition a recorded delta
applied in the direction it was captured. Still zero re-execution.

On top of that tree sit three search primitives:

```js
// fork one timeline per hypothesis off the SAME moment, compare futures
await engine.whatIf(pos, ["item.price = 1", "item.price = 99"],
                    { probe: "total > 20", scan: true })

// BFS a predicate across every state of every timeline —
// shared prefixes are visited exactly once, at the branch that owns them
engine.searchAll("balance < 0")   // → jumpable hits {branch, pos, value}

// constraint search: learn how the web platform API could have been used
await engine.explore(pos, {
  goal: "document.querySelectorAll('.done').length >= 1",
  depth: 2,        // compose up to two calls, breadth-first
})
```

`explore()` generates its candidates from the live document of the moment
being extended — `dispatchEvent` for event types that currently have
listeners registered, `classList.add/remove` for classes the stylesheets
define and the tree uses, `remove()` for elements addressable by id
(`suggestEdits()` exposes the generator; explicit candidate lists work
too, with or without a DOM). Each candidate is forked as a real timeline
and its future actually executes; deeper levels chain from the
hypothesis' last parked moment — "call A, let the program respond, then
call B" — or compose back-to-back at the same anchor when the future ran
to completion. Every returned example is **execution-verified**: a
recorded timeline whose future satisfies the goal, jumpable to the exact
step where it first became true. Timelines that satisfied nothing are
pruned; their pages return to the pool.

For website-shaped programs the same machinery answers configuration
questions — and here nothing is guessed from source text. The machine
keeps a **comparison journal** (every string `===` / `includes` /
`startsWith` / `endsWith` / `indexOf` the program performs, stored in
the machine's own memory so it rewinds and forks with each timeline),
and `exploreParams` runs a concolic BFS over every input the program
demonstrably consulted — URL parameters, storage keys, the message
channel:

```js
await engine.exploreParams({
  goal: { all: [ 'document.body.classList.contains("dark")',
                 '!document.querySelector("#beta-panel").classList.contains("hidden")' ] },
})
// → examples: [{ params: { theme: "dark", beta: "1" }, search: "?user=ada&theme=dark&beta=1",
//      assignments: [{ kind, key, value, via: [{op:"probe"...},{op:"eq",learned:"dark"}] }],
//      branch, firstTrue, newLines, goals: [per-constraint detail] }]
//   learned: every execution-derived value with its provenance chain
//   unlocked: which inputs woke lines the recording never executed
```

Each candidate forks the **earliest parked step** — before the program
has read anything — so each hypothesis is a complete alternate run
inside the same multiverse. Round one probes each input with a canary
value; the journal of that run reports what the program tested the
input against (`=== "solar"`, `startsWith("pref:")`), and each
observation is rewritten into the next round's candidate, so formats
compose: probe → `pref:<canary>` → `pref:gold`, with the whole chain
kept as `via` provenance. Attribution is case-insensitive — a program
that runs `raw.toUpperCase() === "GRANDE"` still carries the canary,
re-cased — and each learned constant is tried in both its literal and
lower-case spellings, so the goal picks the raw form it needs. Numeric
gates are visible the same way: a non-numeric canary pushed through
`Number()`/`parseInt()`/unary `+` compares as `NaN`, the journal
records the lone-NaN entry, and the constant on the other side comes
back exact (`=== 7` teaches `7`) or one past the bound (`> 3` teaches
`4`, `<= 9` teaches `9`). When a transform destroys the canary outright
— `raw.slice(0, 3) === "sky"` — the search falls back to *differential*
attribution: journal entries this candidate's run performed that the
base run never did are new behavior the candidate caused, so their
sides are execution-derived values, tried directly (`"sky"` wins on the
next round, marked `observed` in its provenance). Message
probes deliver a recording proxy whose property reads return marked
strings, so object protocols reveal their keys the same way
(`{type:"sync"}`, then `{type:"sync", mode:"fast"}` behind an `&&`).
The input set grows as the search runs: registries are re-read at each
fork's end, so when `?mode=x` unlocks a branch that reads
`localStorage.getItem("secret")` — a key invisible to the original
recording — `secret` joins the BFS as a discovered input whose every
candidate re-applies `mode=x` as context, and each storage input
targets the storage object it was actually read from. The base run's
own journal seeds round zero for free, and **unused logic guides the
search**: inputs whose handlers never fired as-run are probed first,
and children of runs that executed never-reached lines explore first. Goals compose as `{all,
any, none}` with every constraint reported separately; when no single
input satisfies a compound goal, the most promising singles — ranked by
how many constraints they did satisfy — are combined pairwise.

## Repository layout

```
index.html, styles.css       the site (static, no build step)
dist/quickjs-tt.wasm         the VM (committed artifact, ~2.5 MB)
vendor/quickjs/              QuickJS 2026-06-04, execution core rewritten (MIT);
                             the wasm host interface lives inside quickjs.c
                             (a __wasi__-guarded section — native builds skip it)
vendor/lexbor/               Lexbor HTML/CSS engine subset (Apache-2.0)
native/tt-dom.c              Lexbor binding: DOM/CSS leaf primitives for the VM
native/build.mjs             clang → wasm32-wasi → Binaryen optimize
native/barrier.mjs           wasm bytecode pass: the dirty-page write barrier
native/quickjs-changes.patch the complete QuickJS diff, for review
src/vm.js                    loader + dual park/rewind driver + WASI shims
src/vm/tt-setup.js           interim in-VM substrate (being ported to native C)
src/deltastore.js            per-step COW page store (content-deduplicated)
src/engine.js                recorder, delta navigation, inspection, forking
src/ui.js, main.js, samples.js   debugger UI
tests/                       node --test suites + Playwright e2e
tests/flow/                  native harness: cross-process flow transplant
                             (npm run test:flow, needs a C compiler)
docs/flow-serialization.md   suspended-flow serialization design
tools/serve.mjs              zero-dependency static server
tools/html5lib-run.mjs       html5lib tree-construction suite through the engine
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
- Steps inside user code reached through the remaining reflective C
  machinery — accessor-defined `Symbol.toPrimitive`, iterator `.return`
  during exception unwinding (the non-error path is converted),
  object-spread over accessor properties, `++`/`--` on object-valued
  locals, direct `eval` internals, descriptor-reflection helpers —
  execute correctly but cannot become snapshots; they are counted per
  recording as `suppressedSteps` (0 for the entire probe corpus and the
  engine test suite's full-surface gate program).
- Inlined tail calls keep the caller's frame: proper-tail-call space
  guarantees are traded for park-anywhere (execution depth is bounded by
  the fixed 2 MB frame arena, ~18 000 frames — exact and
  snapshot-stable). Suspended flow machines have no such cap: their
  segmented arenas grow to the runtime memory limit, and the flow
  harness proves a 46 000-frame machine (5× the old bound) serializing,
  evicting and resuming byte-identically.
- `eval`'d / `new Function` code steps only if its filename matches the user
  program (it doesn't), and `setInterval` is not provided (`setTimeout`
  chains are).
- Promise jobs and timer callbacks run steppably *after* the main script on
  the virtual clock — ordering is faithful to a single-threaded event loop,
  timing is virtual by design.
- One recording session lives in the VM at a time; pressing Record resets the
  context (the wasm instance is reused).
- The DOM is a *document* model, not a renderer: there is no layout, no
  pixels, no `getBoundingClientRect` — `getComputedStyle` reports the
  cascade (selector re-match at read time with specificity, `!important`,
  and the inline overlay), not used values. Parsing runs with the HTML
  scripting flag off (`<noscript>` builds a subtree; inline `<script>`
  contents are inert text). `childNodes`/`querySelectorAll` return static
  arrays, not live collections, and the `style` facade parses declarations
  with simple `;`/`:` splitting. The preview panel re-renders serialized
  HTML in a sandboxed iframe — faithful structure and styles, browser
  layout.
- `explore()` demonstrates usages; it does not prove absence. The search
  is bounded (beam width, depth, `maxBranches` fork budget) and the
  auto-candidate vocabulary is deliberately small — events with live
  listeners, stylesheet/tree classes, elements with ids, consulted
  storage keys (bring explicit candidates for anything else). Once a
  hypothesis' future has run to completion there is no "later" left
  inside it, so deeper calls compose back-to-back at the fork moment
  instead. The page-heat visualization aggregates writes across all
  timelines.
- The web substrate is a *model*, not a browser: `location` mutations
  never navigate (no page loads, no `fetch`/XHR, no history stack),
  `URL` parses absolute `scheme://host` URLs plus relative forms against
  a base, storage is in-memory per session, and `postMessage` delivers
  synchronously to same-realm handlers (messages queue until a listener
  exists, so anchor-time injections reach handlers registered later).
  Input-read tracking sees `URLSearchParams`/storage accessors and
  `message` listeners, not hand-rolled string parsing of
  `location.search`.
- The comparison journal sees **string-to-string** comparisons (plus
  `includes`/`startsWith`/`endsWith`/`indexOf`) and **lone-NaN numeric**
  comparisons — `===`/`==`/`<`/`<=`/`>`/`>=` where exactly one side is
  NaN, the signature of a non-numeric input pushed through
  `Number()`/`parseInt()`/unary `+`. Comparisons between two *finite*
  numbers (`n === 42` after a numeric guard already admitted `n`), regex
  tests and comparisons against `null`/`undefined` don't journal;
  entries degrade to ASCII and cap at 64 chars / 384 entries. Case
  transforms are survived (attribution is case-insensitive), and a
  canary destroyed outright (sliced, remapped) falls back to
  differential attribution — comparisons the base run never performed
  are tried directly — which recovers plain constants but not composed
  formats. Values reachable only through hostile transforms (hashing)
  can be handed to `exploreParams` as `{extraValues}` — they enter the
  same BFS and derive further from there.

## Conformance: tc39/test262

The rewritten core is checked against the full conformance suite with the
official `run-test262` harness compiled natively against this repo's
`quickjs.c` (`tools/test262/`, upstream QuickJS 2026-06-04's runner with
quickjs-libc trimmed to three inlined helpers): **58 / 83 558 errors over
the full corpus in both sloppy and strict variants — the failing-test
list is byte-identical to pristine QuickJS 2026-06-04**, before and after
every stage of the stackless migration (inlined calls, arena frames,
constructor/generator/async conversion, job pumps, stackless module
evaluation). The rewrite is semantics-preserving across the language
surface.

**Forced preemption is a first-class oracle, not a sample.** `run.sh
preempt` drives every test through the exact stackless path the debugger
uses: a step handler parks the machine at EVERY parkable step — each
source line and each loop back-edge — the host resumes it from the heap
frame chain, promise jobs pump through `JS_TTPumpJob`, and module bodies
evaluate through the stackless InnerModuleEvaluation machine, so a test
run is tens of thousands of park/resume round trips. The result is the
**same 58 / 83 558, byte-identical to the classic list**, with
engagement measured rather than assumed: **97.2% of 192 M park requests
fired** (the rest are counted suppressed steps inside the documented
reflective C residue), **every test that executes user code fired real
parks — zero tests passed with preemption silently unengaged** — and
per-test counters land in a CSV (`-M`). `run.sh opcode` repeats the
whole corpus parking **between every two VM instructions**.

```
sh tools/test262/run.sh            # classic drive: must match test262_errors.txt
sh tools/test262/run.sh preempt    # park at every step + engagement metric
sh tools/test262/run.sh opcode     # park between every two VM instructions
```

**Sanitizer- and aliasing-clean over the same corpus.** The full suite —
both the classic drive and the forced-preemption drive — runs under
AddressSanitizer + UndefinedBehaviorSanitizer with **zero reports** (the
sweep flushed out three latent upstream UBs, all fixed: `ToInt32`/
`ToInt64` negating `INT_MIN`, `memcpy(NULL, 0)` on zero-length
typed-array slices, and `size * 3 / 2` growth arithmetic overflowing
`int` on gigabyte strings), and the native flow-serialization suite is
sanitizer-clean too. A strict-aliasing differential — the corpus at
`-O2` under default aliasing vs `-fno-strict-aliasing`, per-test reports
compared — is outcome-identical, so no behavior anywhere depends on
type-punning the optimizer is entitled to break.

On top of that, `tools/test262-stepped.mjs` runs a corpus sample through
the ENGINE with per-step snapshotting enabled and lets each test's own
assertions judge: stepping does not alter semantics. Current samples:
`language/statements` 295 pass / 3 fail (decorators and `using` are
unsupported proposals; `tco-*` is the deliberate proper-tail-call space
trade — inlined tail calls keep the caller frame), `language/expressions`
216 pass / 3 fail (dynamic `import` needs a module host). Suppressed
steps across those ~570 stepped runs (each in both sloppy and strict
variants): 144, all inside the reflective residue listed above — the
ordinary language surface records every step.

```
node tools/test262-stepped.mjs <path-to-test262-clone> test/language/statements 7
```

## Conformance: html5lib-tests (the DOM's test262)

HTML parsing has its own conformance suite: the
[html5lib-tests](https://github.com/html5lib/html5lib-tests)
tree-construction corpus (the suite browsers themselves use). Each fixture
is parsed by the *embedded* Lexbor via `engine.run({ html })`, then the
tree is dumped in html5lib format **by a JS program running inside the
debugger with stepping enabled** — so every passing test exercises the
parser, the C binding, and the self-hosted DOM view at once:

**1589 pass / 3 fail / 200 skipped.** The 3 failures are one upstream
Lexbor deviation: `<?…>` bogus-comment handling (the HTML spec turns
`<?import ns="foo">` into a comment node; Lexbor builds an XML-style
processing instruction and keeps only the target). The 200 skips are
fragment-parsing cases (`#document-fragment`) and scripting-flag-on
expectations (`#script-on`) — the engine exposes whole-document parsing
with scripting off.

```
node tools/html5lib-run.mjs <html5lib-tests-clone>/tree-construction
```

Next rungs on this ladder: `css-parsing-tests` for the CSS tokenizer/parser
and the WPT `dom/nodes` corpus for DOM API behavior.

## License

MIT for TimeTravelJS code. QuickJS is MIT (Fabrice Bellard & Charlie
Gordon); Lexbor is Apache-2.0 (Alexander Borisov) — see
`vendor/LICENSES.md`, `vendor/quickjs/LICENSE` and `vendor/lexbor/LICENSE`.
