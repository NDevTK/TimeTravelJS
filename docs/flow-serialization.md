# Flow serialization: transplanting a suspended flow into a fresh process

`vendor/quickjs/quickjs.c` (section "TimeTravelJS: cross-process flow
serialization") implements

```c
static uint8_t *serialize_flow(JSContext *ctx, JSAsyncFunctionState *base,
                               JSValueConst root, int root_kind, size_t *plen);
static JSAsyncFunctionState *deserialize_flow(JSRuntime *rt,
                                              const uint8_t *buf, size_t len,
                                              JSValue *proot);
```

with the public wrappers `JS_TTFlowSerialize` / `JS_TTFlowDeserialize` /
`JS_TTFlowResumeParked` / `JS_TTFlowFork` and the baseline registry
`JS_TTBaselineCapture*` (declared in `quickjs.h`). A *flow* is a suspended computation rooted at a
`JSAsyncFunctionState` — the struct QuickJS uses for both generator and
async-function activations — plus its parked TrampFrame chain and a
per-flow COW delta of first-writes against shared baseline objects. The
chain covers both suspension styles: a flow parked at a yield (each
`yield*` level contributes its state's heap frame) and a flow parked
*mid-call* by the step hook's park-by-return, where the chain additionally
carries the arena frames of the helpers it was inside. The proof harness
is `tests/flow/` (`sh tests/flow/run.sh`, or `npm run test:flow`): process
A parks one flow at a yield inside a `yield*` chain and another four
frames deep inside a helper call, records deltas, and serializes; process
B rebuilds the baseline from the same source, restores the bytes, and
resumes both — futures compared **byte for byte**.

## The contract

Both processes must build the same *baseline* before flows move:

1. evaluate byte-identical baseline code (same script, same order), then
2. call `JS_TTBaselineCapture(ctx)`.

Capture walks the heap breadth-first from the global object in a fixed
structural order and assigns every reachable entity a **stable id**: its
ordinal in that walk. Because the walk order is a pure function of the heap
shape and the heaps are built identically, id *N* in process A and id *N* in
process B name "the same" object. Two guards keep this honest:

- **Forced materialization.** QuickJS installs intrinsic methods and
  `fn.prototype` lazily (`JS_PROP_AUTOINIT`). First *read* materializes a
  fresh object — so a flow that touched `%GeneratorPrototype%.next` before
  capture-time in one process and after it in the other would disagree about
  what exists. Capture therefore forces every autoinit property it walks
  (`JS_AutoInitProperty`, in shape order) so both processes materialize the
  same objects at the same ids *before* any flow runs.
- **A fingerprint** (order/kind/class hash over the registration sequence,
  embedded in every flow's bytes) rejects transplants into a drifted
  baseline with a clear error instead of undefined behavior.

The registry holds one reference per entry (objects, function bytecodes,
detached closure cells, symbols), pinning the baseline for the runtime's
lifetime; `JS_FreeRuntime` releases it automatically.

## 1. The stable-id scheme: by-reference vs by-value

Every `JSValue` reachable from the frames and the delta is classified at
serialization time by one pointer lookup:

- **baseline (by reference)** — the pointer is in the registry. The wire
  carries `(id << 2) | 1`, a few bytes, regardless of the object's size.
- **flow-private (by value)** — everything else. The value joins the flow's
  private record table and is copied structurally: plain objects and arrays
  (prototype, property flags, accessors), closures (function-id + captured
  cells + own props), generator wrappers, nested suspended
  `JSAsyncFunctionState`s, strings, symbols (identity deduplicated within
  the flow), `JSVarRef` cells, primitive wrappers.
- **immediates** — ints, doubles, booleans, `undefined`/`null`,
  TDZ `uninitialized`, catch offsets, short bigints — travel inline.

A value reference (`vref`) is one uleb128 whose low two bits select the
space: `0` inline, `1` baseline id, `2` private record index. Property keys
use the same split: atoms below `JS_ATOM_END` (the predefined table compiled
into both processes) and array indices pass as numbers; anything else is
interned via a private atom table; symbol keys reference the symbol value.

**The dedup guarantee:** a baseline object shared across N serialized flows
is serialized **zero** times — each flow carries only its uleb id, and all N
flows relink to the *same* rebuilt object in the fresh process. The selftest
asserts this three ways: the flow bytes of two flows closing over a 64-row
baseline table are ~190 bytes each and contain no row data; a delta written
through flow 1 is visible to transplanted flow 2 (same object identity); and
re-serializing a transplanted flow reproduces the original bytes exactly.

## 2. The two-pass swizzle

Serialization and deserialization are both structured as *assign ids → 
relink*, which is what makes cycles free and re-serialization byte-stable:

- **Write, pass A (assign):** a queued BFS from the base state discovers
  every private entity exactly once and appends it to the record table
  (`wr_enum_value` / `wr_scan_children`); the pointer→index map is the id
  assignment. No bytes are produced.
- **Write, pass B (relink):** shells, frames, payloads, delta and root are
  emitted against the now-complete maps; every pointer becomes an id.
- **Read, pass 1 (assign):** every record shell is allocated *empty* —
  objects with null prototypes, closures with zeroed cell tables, states
  with `JS_UNDEFINED`-filled frames — and indexed (`recs[i]`). Baseline ids
  resolve through the registry immediately.
- **Read, pass 2 (relink):** every field, property, stack slot, cell, delta
  record and the root are decoded against the complete table; forward
  references and cycles (a frame slot holding the flow's own generator
  object, mutually referencing private objects) need no special casing.

## 3. `cur_pc` relocation: function-id + offset

Bytecode addresses are meaningless across processes. Function bytecodes are
part of the baseline registry (`TT_BASE_FUNC_BC`), registered depth-first
through each function's constant pool so the numbering is purely structural.
A parked frame's pc serializes as `(fn_id, cur_pc - b->byte_code_buf)`; the
reader rebases it onto the fresh process's identical bytecode
(`b->byte_code_buf + pc_off` after bounds-checking `pc_off ≤ byte_code_len`)
and cross-checks that the frame's restored function object actually carries
that same `JSFunctionBytecode` — a pc can never be relocated against the
wrong function. Code outside the baseline (`eval`'d at flow-time) is
refused at serialization with a precise error.

## 4. The TrampFrame chain and var_ref reconstruction

The frame table lists the flow's parked frames outermost-first, frame 0 =
the base state's own frame. Two owner kinds coexist in one chain:

- **state-owned heap frames** — the base, suspended `yield*` states, and
  (when the machine is parked mid-run) nested generators spliced in-loop.
  A `chained` entry carries its splice linkage (`tt_aux_i` shape,
  call-site argc, and the owning generator record) so its pop delivers
  results to the caller frame exactly as the original splice would.
- **arena TrampFrames** — plain inlined calls (`TT_FRAME_CALL`,
  `CALL_METHOD`, `TAIL`, `TAIL_METHOD`) left parked by the step hook's
  park-by-return. Serialization validates the chain against this subset
  (kinds whose pops touch no side arena blocks) and checks the arena
  extent is exactly the chain's frames, contiguously — pump descriptors or
  other foreign blocks refuse loudly. The frame record carries the
  relocated pc, call-site argc, live extent, and the **parent-relative
  offsets** of its argument window and method receiver: QuickJS aliases
  `arg_buf` into the caller's operand stack when `argc >= arg_count`, and
  the rebuild reproduces that aliasing (and the copied-argument layout
  otherwise) exactly, so ownership on pop is byte-for-byte the engine's.
  `cur_func` is decoded for geometry, validated bit-identical against the
  parent's callee slot, then converted to the engine's borrow.

Every frame's owned range `[owned_start, cur_sp)` — where `owned_start` is
`arg_buf` for heap frames and the allocation block for arena frames — is
replayed value-by-value in the payload; aliased windows travel exactly
once, with their owner. Geometry (`arg_alloc + var_count + stack_size`
slots plus `var_ref_count` cells) re-derives from the function bytecode,
never trusted from the wire; extents, offsets, and the step-hook line
cache (carried so a stepping host resumes byte-identically) are all
bounds-checked. On success the rebuilt chain becomes the flow's **own
suspended machine** — a `TTMachine` handle with its own arena, adopted by
the base state — so any number of transplants coexist in one runtime and
resume independently (see "The suspended machine as a first-class
value").

Closure cells rebuild over those stacks with a two-frame address: the
frame the cell *registers on* (its `var_refs[]` slot) and the frame that
*owns its storage* — distinct exactly when a captured argument lives in an
aliased window. Cells on heap frames pin their owning state, mirroring
`get_var_ref`; cells on arena frames do not, mirroring the engine.

Closure cells rebuild over those stacks:

- **closed cells** (`is_detached`, the variable's frame is gone) rebuild as
  self-contained `JSVarRef`s owning their value.
- **open cells** — a closure created inside the flow captured a still-live
  local — serialize as `(frame_idx, var_ref_idx, slot)` where `slot` is the
  arg/var index recovered from `pvalue`'s offset in the owning frame. The
  reader recreates the cell exactly as `get_var_ref()` would have:
  `pvalue = &frame->arg_buf[slot]` (or `var_buf`), registered in the
  frame's `var_refs[var_ref_idx]` slot — which stays **weak**, mirroring
  the engine — while the cell takes one pinning reference on its owning
  async state. Assignments through the transplanted closure hit the
  transplanted frame slot, and vice versa, exactly as before the move.
- **baseline cells** (module/global lexicals captured from baseline
  closures) pass by registry id like any shared entity; a flow's write to
  one is a delta record, not a copy.

## 5. Refcount/GC reconciliation

The restored graph must be neither leaked nor double-freed, including when
the host drops it unresumed. The rules:

- Every record is built holding exactly **one construction reference**,
  owned by the swizzle table. Every link made during pass 2 — a property, a
  stack slot, a closure cell entry, `gd->func_state` — takes its own
  reference. When the graph is complete, `rd_release()` drops all
  construction references: what the graph (and the returned root handle)
  reaches survives at the correct count; anything unreachable frees on the
  spot. On a mid-parse error the same release runs over the partial table,
  so corrupt bytes cannot leak.
- States and cells are registered with the cycle collector at creation
  (`add_gc_object`), and open cells pin their owning state exactly like
  `get_var_ref` does — so the engine's existing collector semantics (the
  closure ⇄ frame ⇄ state cycle is collectable; `free_var_ref` clears the
  weak slot and unpins) hold for transplanted flows unchanged. The
  selftest ends every scenario with `JS_FreeRuntime`, whose
  `assert(list_empty(&rt->gc_obj_list))` is the leak/double-free oracle,
  and runs a full `JS_RunGC` over the freshly rebuilt graph before it ever
  executes.
- **Every owned reference must be a visible GC edge.** The per-flow delta
  taught this the hard way: its records own references (target object,
  displaced value, cell), and leaving them out of the async state's
  `mark_children` made delta targets look externally rooted during
  `JS_FreeRuntime`'s final collection, reviving intrinsic clusters that
  then outlived the GC (caught by the teardown assertion). The delta is
  marked via `tt_flow_delta_mark()` from the `JS_GC_OBJ_TYPE_ASYNC_FUNCTION`
  mark path; any future extension hanging values off a flow must follow the
  same rule.

## The per-flow COW delta

A flow's first-writes against shared baseline state are records of
`(target, saved)` where target is a property slot `(obj, atom)` or a closure
cell (`JSVarRef`), and `saved` always owns *the value not currently
installed*:

- `JS_TTFlowDeltaWriteProp/Cell` records the pre-image once (moving it into
  the record), then writes through — the flow's view lives in the heap.
- `JS_TTFlowCheckout` swaps every record newest-first: the baseline shows
  pristine values, the records hold the flow's view. This is the state
  flows serialize in (enforced), so the wire's delta *is* the flow's view.
- `JS_TTFlowCheckin` swaps oldest-first. In the fresh process this installs
  the flow's view over the pristine rebuilt baseline while capturing the
  fresh pre-images — so a later checkout heals the baseline exactly.

Check-in/out are pure swaps: refcount-neutral by construction, in either
process. The delta rides on the base `JSAsyncFunctionState` (`tt_delta`)
and is freed with it.

## Forking: the same swizzle, into live objects

`JS_TTFlowFork(ctx, flow)` clones a suspended flow into a concurrent
sibling **in the same runtime**: both resume and diverge independently
over the shared baseline. It is the serializer with the byte buffer
removed — pass A (`wr_enumerate`) classifies and indexes exactly as for
serialization, then a clone pass allocates every sibling shell (assign)
and a relink pass fills it from the *live* parent objects instead of
decoding bytes:

- **baseline entities share**: a registry hit costs one reference bump,
  and both flows keep pointing at the very same object — the fork test
  proves identity by mutating a baseline table row and seeing the change
  in every fork's future.
- **flow-private state deep-copies**: the `JSAsyncFunctionState` chain
  (frames rebuilt with `async_func_init` geometry; `cur_pc` copies
  verbatim — same runtime, same bytecode), private closures (bytecode
  shared by refcount — fork does not require baseline membership, so
  eval'd-code flows fork even though they refuse to serialize), plain
  objects/arrays/wrappers, and closure cells. Open cells reattach over
  the sibling stacks with `get_var_ref`'s rules (weak slot, state pin),
  preserving the registration-frame/storage-frame distinction.
- **strings and symbols share**: immutable, so siblings alias them —
  a symbol keeps one identity across the family.
- **the COW delta copies**: the sibling gets an independent first-write
  log carrying the parent's fork-time view; each flow applies its own
  delta on check-in and heals the baseline on check-out. Fork (like
  serialization) requires the flow checked out — two checked-in deltas
  over the same cells would corrupt the swap discipline — and the
  sibling arrives checked out. Forks of forks nest arbitrarily; the
  test drives three-way isolation.

Reconciliation follows the deserializer: one construction reference per
clone, dropped once the graph is linked; the returned handle keeps what
it reaches. Machine-parked flows fork **in place**: the parked TrampFrame
chain rebuilds inside the sibling's own arena (next section) with
identical geometry, so every parent-relative offset — argument windows,
method receivers, open-cell storage slots — transfers verbatim, and the
sibling arrives as an independently suspended machine. Async functions
and exotic private classes refuse with the serializer's errors.

## The suspended machine as a first-class value

A parked machine used to be a runtime singleton (`rt->tt_parked_frame` +
the shared frame arena). It is now a **per-flow value**: `TTMachine`, a
handle owning the flow's parked chain *and its own frame arena*, hung off
the base `JSAsyncFunctionState`. The private arena is not an indulgence —
the engine's arena is a bump allocator, so two suspended chains sharing it
could only be resumed LIFO; giving each machine its own arena makes any
number of suspensions resumable in any order.

The runtime's arena/park fields become the **active machine's registers**:
`JS_TTFlowResumeParked` installs the handle's registers (saving the
host's, which may themselves be a parked legacy machine's), re-enters the
dispatch loop, and on a re-park captures the registers back into the
handle. The legacy host-entered machine (`JS_TTCallStart`/`JS_TTCallArgs`/
`JS_TTCallResume`, the wasm contract) still lives directly on the runtime
fields, untouched — a handle can resume to completion *while the legacy
machine stays parked*, and vice versa.

Ownership is GC-honest, per the delta's rule (every owned reference must
be a visible edge): the state's `mark_children` walks the suspended
chain's arena frames and marks their owned slots, so cycles through a
parked machine are collectable and nothing becomes a phantom root.
While the machine is *installed* (running), its `parked_frame` is
cleared and the chain is C-stack rooted, exactly like a live frame chain.
Teardown needs no resume at all: `__async_func_free` dismantles an
attached machine first — mirroring the engine's pop per frame (close the
frame's cells, free its owned range) before releasing the arena — so
dropping the last reference to a suspended arm is leak-free.

`JS_TTForkHere(ctx)` is the seam the solver uses: callable **only from
inside the step handler**, at any opcode. The running frame's `sp` exists
only in the dispatch loop's locals, so `TT_STEP_CHECK` publishes it in a
transient (`rt->tt_step_sp`) for the duration of the callback; ForkHere
stamps it into the innermost frame, walks down to the outermost generator
state on the chain (frames below it — the driver loop, the host entry —
stay put), finds the flow's generator object by value on those driver
frames, and runs the machine fork with the running chain as the override.
It returns the **fork-arm**: a suspended machine handle that resumes from
that very opcode via `JS_TTFlowResumeParked`. The **continue-arm** is the
running machine itself — the handler returns 0 to let it run on, or 2 to
park it for `JS_TTCallResume`. `OP_if_true` on an unknown becomes "both
arms run": inject different values for the same live local per arm
(`JS_TTSetLocal` through the parked chain, `JS_TTFlowSetLocal` through a
handle) and the futures diverge from the same program counter.
`JS_TTFlowParked` reports whether a handle currently holds a parked
machine. The forkhere harness drives the whole property: a fork taken
mid-arithmetic four frames deep, a second fork taken *inside the first
arm's resume*, four machines suspended concurrently in one runtime, three
divergent futures, and an arm abandoned without resuming that tears down
leak-free.

## Resuming a transplanted machine

A flow serialized while machine-parked arrives EXECUTING **with its own
machine handle** — deserialization rebuilds the chain straight into a
fresh `TTMachine`'s arena, so any number of transplants coexist in one
runtime (the old one-parked-machine-per-runtime guard is gone; the
resume2 harness now proves two transplants of the same bytes park and
resume independently). The base frame is rebuilt as a C entry
(`TT_FRAME_ENTRY`), so when the chain finishes or the generator yields,
the dispatch loop returns to the host instead of to a caller frame that
stayed behind in the source process — the fresh process's host *becomes*
the driver. `JS_TTFlowResumeParked(ctx, flow, cmd, &done, &parked)`
installs the machine's registers and re-enters the loop at the innermost
frame (`JS_CALL_FLAG_TT_RESUME`), completing the interrupted `next()`:
`done` follows the generator protocol (0 yield, 1 return, 2 `yield*`
delegation result), `parked` reports a re-park (captured back into the
handle) if the fresh host steps too. `cmd 1` aborts instead: an
Interrupted error unwinds helper → nested generators → base through the
engine's own exception path, completing the flow — one leak-free way to
discard a parked flow (simply dropping the handle is the other).
Afterwards the flow is an ordinary suspended generator, driven with
`next()`. A flow parked inside the *live legacy* machine is refused with
a pointer to `JS_TTCallResume`.

## Wire format (`TTFL02`)

```
header    magic, baseline fingerprint (u64), baseline count, flags
          (bit 0: a machine-parked chain travels in these bytes)
atoms     private name strings (interned on read)
records   shell table: kind + allocation parameters (class, fn_id, argc,
          element count, open-cell coordinates, string/symbol bytes)
frames    the TrampFrame chain, base first: owner byte (state | arena);
          state: record idx, pc offset, live extent, splice linkage;
          arena: cur_func vref, pc offset, frame kind, call-site argc,
          live extent, parent-relative argument window + receiver slot;
          both: the step-hook line cache
payloads  per record: prototype, properties (atomref, 6-bit shape flags,
          kind-specific payload), fast elements, closure cells, state
          fields; then per frame: the owned live JSValue range
delta     (target, value) records: PROP obj+atom / CELL ref, then the view
root      handle kind + vref (generator object) or base state index
```

Everything is bounds-checked against the tables and the baseline registry;
readers reject bad magic, drifted baselines, out-of-range ids, pc offsets,
stack extents, cell slots, class ids, duplicate frame owners, and truncation
at any byte (fuzzed in the selftest) with a `TypeError` — never a crash.

## Scope and limits (v1)

- **Generator flows** (including nested `yield*` chains, flow-private
  closures over live locals, deltas) transplant fully. `async function` /
  async-generator states are *refused at serialization*: an await-suspended
  flow's identity is entangled with its promise's reaction lists and job
  queue; transplanting severs external awaiters, so restoring them is a
  job-queue feature, not a value-graph one. The state serializer is
  class-general (`resolving_funcs` travel in the format) for that follow-up.
- **Machine-parked chains** transplant when every parked frame is a plain
  inlined call or an in-loop generator splice (`METHOD`/`FOROF`/
  `ITERNEXT`/`ITERCALL` shapes) — which is what stepping through ordinary
  generator code produces. Chains running through the reflective residue
  (pumped builtins, proxy traps, deferred accessors, `OP_append` spreads:
  frame kinds whose pops consume side arena blocks) are refused with the
  kind named. Note that a *direct* `g.next()` call from script goes
  through C and is unparkable by the engine's own design; parks form under
  language-level iteration (`for-of`, `yield*`), as in the harness.
- Flow-private values of exotic classes (Map/Set/Proxy/TypedArray/promises,
  heap bigints, `Symbol.for`) are refused with the class named in the
  error; *baseline* objects of any class pass by id.
- Delta targets must be plain own data properties or detached cells.
- `JS_TTBaselineCapture` should run before flows start (it forces autoinit
  materialization; a flow started earlier may have materialized private
  copies).

All refusals are loud, specific `TypeError`s at serialization time — never
silent corruption at resume time.
