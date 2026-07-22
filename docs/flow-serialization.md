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
`(target, saved)` where target is a property slot `(obj, atom)`, a closure
cell (`JSVarRef`), or a structural snapshot (see the automatic-COW section
below), and `saved` always owns *the value not currently installed*:

- The engine records the pre-image once per target (capture is automatic —
  see below; `JS_TTFlowDeltaWriteProp/Cell` remain as the host escape
  hatch for injecting a chosen value), then writes through — the flow's
  view lives in the heap.
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
sibling arrives as an independently suspended machine.

## Exotic flow-private state travels as structure, not slots

Copying visible properties is the wrong model for most built-ins, so each
exotic class serializes (and forks) through its actual internal shape:

- **Map / Set** — the live record list in insertion order (iterator
  tombstones skipped); the reader re-inserts through `map_add_record`, so
  both iteration order and a hash table valid for the *destination*
  process's pointer values are reproduced. `WeakMap`/`WeakSet` refuse by
  name: weak collections hold liveness, not structure.
- **ArrayBuffer** — the byte image plus the detached flag and, for
  resizable buffers, `maxByteLength`; `SharedArrayBuffer` refuses by name
  (its memory belongs to other agents).
- **TypedArray / DataView** — class, byte offset, byte length and the
  length-tracking flag over a *reference* to their buffer's record, so
  two views over one buffer keep sharing after any number of
  serialize/fork hops — a write through one view reads back through its
  twin (the harness asserts exactly that).
- **RegExp** — pattern and flags only; the reader **recompiles**, so the
  wire format never couples to the regexp engine's bytecode. `lastIndex`
  is an ordinary own property and travels with the props.
- **Proxy** — target + handler references plus the callable/revoked bits;
  a rebuilt proxy is a real proxy over the same (transplanted) pair, so
  every `[[Get]]`/`[[Set]]`/`[[Define]]` invariant is enforced by the
  ordinary proxy machinery, and a revoked proxy stays revoked. The
  revocable pair's `revoke` closure — identified C-function state —
  travels too, still wired to its own proxy record. (Other C closures
  keep refusing: an arbitrary function pointer cannot travel.)

The `exotictest` harness command holds all of this to a byte oracle: a
flow parked over one of each class re-serializes byte-identically,
hydrates and forks into copies whose in-flow interrogation (iteration
order, twin-view aliasing, `exec` + `lastIndex`, trap dispatch, revoked
refusal) equals the statically known answer, arms diverge independently,
and the weak refusal leaves the refused flow unharmed. Remaining
refusals stay loud and named — nothing silently corrupts.

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

## Segmented arenas: N machines cost Σ depth, not N slabs

A machine's arena is not a fixed 2 MB slab but a **linked chain of
demand-sized segments** that grows by appending and never by a
realloc-that-moves — live frames carry parent-relative aliases and
open-cell storage pointers, so a block's address is forever. A block
never straddles segments: when the current segment cannot hold a push,
allocation continues in a fresh segment sized to the demand (first
segment ≥ 1 KB, then doubling to a 64 KB ceiling that scales
geometrically once a chain outgrows it — at most ~12.5% slack). A
machine's total is **unbounded**: its depth stops at the runtime memory
limit — ultimately the RAM floor — not at a cap, surfaced as the same
catchable stack overflow. The runtime's own execution arena is the
degenerate case — one fixed 2 MB segment whose exhaustion *is* the
engine's snapshot-stable recursion limit — so normal execution is
unchanged. The `unbounded` harness command holds the claim to bytes: a
machine parked 46 000 frames deep (a ~10 MB, ~40-segment chain, five
times the old cap) re-serializes byte-identically, round-trips through
evict → hydrate to the same bytes, and two independent hydrations
resume across every segment boundary to identical completions.

The hot paths stay hot: push is the same bump-and-compare with a slow
path that enters the next segment; pop is LIFO release to a mark, with a
one-compare fast path (mark inside the current segment) and a crossing
path that finds the mark's segment by **range membership** — segments are
separate allocations, so inter-segment address order means nothing.
Vacated segments stay linked for push/pop reuse at a boundary;
re-parking trims the empty tail, so a suspended machine's footprint is
what its chain actually occupies. `JS_TTFlowMachineStats` reports it
(used chain bytes, reserved RAM, segment count), and the mass harness
holds it to a hard bound: 2 000 suspended machines forked from one
baseline measure ~1.1 KB of arena RAM each — a small multiple of the
chains' actual bytes and two orders of magnitude under N × 2 MB.

The chain-walk and the transplant offset math never see segments (every
wire offset is parent-relative); only the serializer's foreign-block
check is segment-aware: consecutive chain frames must be adjacent within
a segment, or the next frame must open the very next segment from its
base *and* be too big for the tail it left — the exact condition under
which the allocator crosses. The deep harness proves the whole story
across boundaries: a recursion parked 30 frames down forks into a
3-segment machine, transplants, resumes (descending 30 more levels
inside the installed machine — growth mid-run — then unwinding straight
back through every boundary), all byte-identical to the never-segmented
reference.

One GC subtlety: a machine dismantled *during* cycle removal (its flow
died in a cycle) must not free its segments or dup cell values — later
finalizers in the same pass still unlink cells through the frames'
weak slots, and the dying graph must not be mutated. The teardown goes
phase-aware: still-attached cells have their values **moved** out
(refcount-neutral) instead of closed, a zombie `cur_func` (bytecode
pointer already cleared) means the cells die in the same pass and are
left to unlink themselves, and the segments park on a **graveyard**
freed when the pass ends.

## Cold eviction: a suspended machine as bytes on disk

`JS_TTMachineEvict(ctx, flow, &len)` serializes a suspended machine —
chain, private graph, COW delta — through the flow serializer's
classification (it *is* `serialize_flow`), then frees the hot copy by
completing the handle without resuming: the state finalizer dismantles
the machine, its segments, and the delta, and the handle the host keeps
becomes a completed husk. `JS_TTMachineHydrate(ctx, bytes, len)` is
deserialization by another name: it rebuilds a live suspended machine —
in the same runtime or any runtime holding the identically rebuilt
baseline — resumable with `JS_TTFlowResumeParked` as if it had never
left RAM. Hot machines live in RAM; the cold tail is bytes the host can
put anywhere. Requires the flow checked out (as serialization always
has); yield-suspended flows evict the same way; the live legacy machine
refuses (its park state sits on the runtime's own registers). The evict
harness round-trips a forked arm through 242 bytes — injected local and
all — and its hydrated future is byte-identical to its never-evicted
twin, with the parent machine and the sibling untouched throughout.

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

## Tagged values: a concrete payload plus an opaque host annotation

`JS_CLASS_TT_TAGGED` is a first-class value holding a `JSValue payload`
(any concrete value) and a `void *note` (a host blob the engine never
interprets). It exists so a host can pin its own metadata to a value and
have the pair ride every flow operation — no propagation or conditional
behavior yet: a tagged value just exists and round-trips.

```c
JSValue JS_TTMakeTagged(JSContext *ctx, JSValue payload, void *note);
JSValue JS_TTPayload(JSContext *ctx, JSValueConst v);   /* dup of payload */
void   *JS_TTNote(JSValueConst v);                      /* borrowed */
JS_BOOL JS_TTIsTagged(JSValueConst v);
int     JS_TTNarrow(JSContext *ctx, JSValueConst tagged, /* replace pair in place */
                    JSValue new_payload, void *new_note);
void JS_TTSetNoteHooks(JSRuntime*, JSTTNoteCloneFn*, JSTTNoteSerializeFn*,
                       JSTTNoteDeserializeFn*, JSTTNoteFreeFn*);
```

Graph integration follows the existing rules exactly:

- **Classification.** `wr_enumerate` classifies a tagged value as
  flow-private (`TT_REC_TAGGED`, by value); its payload classifies
  recursively like any field — by reference if baseline, by value if
  private. Baseline capture walks the payload as an ordinary edge, so a
  tagged value rooted before capture keeps the everything-reachable-has-
  an-id invariant.
- **GC.** The payload is a marked edge (`js_tt_tagged_mark`), so cycles
  through a tagged value collect; the note is host-owned and released
  through `NoteFree` at finalization — exactly once per living value, in
  whichever process the value dies.
- **Fork.** Each arm gets an independent tagged value: its own payload
  clone (per the payload's own classification) and a `NoteClone`d note.
- **Wire.** The note rides the record shell as an opaque blob
  (`NoteSerialize` writes it, `NoteDeserialize` rebuilds it before the
  record links); serialize→hydrate and evict→hydrate round-trip payload
  and note together.
- **Refusals are loud.** A non-NULL note refuses fork without a clone
  hook and refuses the wire without the serialize (write side) or
  deserialize (read side) hook, with the missing hook named; a NULL note
  never needs any hook.
- **Narrowing.** `JS_TTNarrow(tagged, new_payload, new_note)` replaces the
  pair in place: it frees the old payload and runs `NoteFree` on the old
  note exactly once, taking ownership of the new pair (the
  `JS_TTMakeTagged` convention). It refuses loudly on a non-tagged value,
  freeing the caller's new pair so the error path leaks nothing. It
  touches **only** its argument — no traversal, no aliasing — so narrowing
  one fork arm's already-cloned tagged value cannot reach another arm's.
  That isolation is what lets a host make a forked arm take a different
  path (a narrowed payload evaluates a later branch differently) without
  disturbing the primary arm's value.

The taggedtest harness drives the oracle: accessor API, a
payload↔tagged GC cycle, two forked arms with independent payload copies
and cloned notes (a mutation in one arm touches nobody), wire and evict
round trips through the note hooks, hookless refusals, `NoteFree` exactly
once for an abandoned arm, and a note-liveness counter beside the runtime
leak oracle.

## Tagged propagation through value-producing operations

A tagged operand of a value-producing operation yields a **tagged
result**: the concrete payload of the real operation plus a note derived
from the operand notes through one host hook:

```c
typedef void *JSTTCombineFn(JSContext*, int op, JSValueConst *args,
                            void **notes, int n);
void JS_TTSetCombineHook(JSRuntime *rt, JSTTCombineFn *combine);
```

`args` are the original operand values (wrappers included), `notes[i]`
is `args[i]`'s note (NULL = untagged operand), `op` is a public
`JS_TT_OP_*` code. Without a hook, results are still tagged — their note
is NULL. The rule is uniform at every chokepoint: unwrap each operand's
payload, **re-enter the engine's own operation on the concretes** —
never a re-implementation of `+`, coercion, or concat — then re-wrap the
real result with `JS_TTMakeTagged`. A throwing concrete op propagates
faithfully (and a concretely-NaN op stays NaN: `tagged({}) * 1` is
`tagged(NaN)`, not an error).

**The chokepoints are the existing slow-path helpers, never the
opcodes.** Every fast guard in the dispatch loop is tag-exact
(INT/FLOAT64/STRING/SHORT_BIG_INT pairs), so a tagged value — a heap
object — always misses them and falls into `js_add_slow`,
`js_binary_arith_slow`, `js_unary_arith_slow`, `js_post_inc_slow`,
`js_not_slow`, `js_binary_logic_slow`, `js_shr_slow`,
`js_relational_slow`, `js_eq_slow`, or `js_strict_eq_slow`, each of
which now opens with a tagged intercept that recurses into itself on the
unwrapped payloads.
`JS_ConcatString` carries the same intercept, which is what makes the
template-literal engine propagate: evaluated templates compile to
`"str".concat(part, …)`, and the pristine `js_string_concat` builtin
funnels every step through `JS_ConcatString`. Three coercion pipelines
whose results surface directly as script values re-wrap as well: unary
`+` (through the unary helper), `String(x)` (non-`new` only), and
`parseInt`/`parseFloat` (ToString→StringToNumber pipelines; generic
builtin forwarding stays a follow-up).

One in-loop wrinkle: the stepping machinery coerces object operands to
primitives **before** the slow helpers (`TT_COERCE_SLOT`, so bytecode
`valueOf`/`toString` run as parkable in-loop frames). That macro now
skips tagged values — at operator sites the helper unwraps them, and at
property-KEY sites the C path throws exactly the TypeError the in-loop
coercion would have thrown, which keeps key coercion pinned to today's
behavior.

Strict equality (`===`/`!==` and the `switch` case-compare, which
compiles to the same `strict_eq` opcode) takes the **same unwrap path**
as loose equality: `tagged("a") === "a"` is `tagged(true)`,
`tagged(5) === tagged(5)` (distinct wrappers, equal payloads) is
`tagged(true)`, and `Combine` sees `JS_TT_OP_STRICT_EQ`/`_STRICT_NEQ`
with the original operands. One carve-out: the reflexive compare of a
tagged value against **itself** (`x === x`, the same object) keeps its
concrete identity answer — `true`, no hook call. Two compile-time
consequences keep every spelling of the operator on that one path: the
peephole fusions of `=== null`/`=== undefined` into the `is_null`/
`is_undefined` short opcodes are gone (they would skip the unwrap and
hand the branch a concrete boolean where the unfused compare hands it
the tagged result the cond hook observes), and the parameter/
destructuring **default-value probes** — which are exact-`undefined`
tag tests, not comparisons — now emit `OP_is_undefined` directly, so a
tagged argument (even one whose payload *is* `undefined`) never
triggers a default and never fires a hook.

## Tagged truthiness and conditionals

A tagged value reports its **payload's truthiness** everywhere `ToBool`
runs (nested tagged payloads recurse): `!tagged(0)` is `true`,
`Boolean(tagged(""))` is `false`, and an `if`/`while` branch takes the
payload's side. Value coercion and observation are strictly separate:

```c
typedef void JSTTCondFn(JSContext*, void *note, int taken_true);
void JS_TTSetCondHook(JSRuntime *rt, JSTTCondFn *cond);
```

Only the **control-flow branch opcodes** fire the hook — `if_true`/
`if_false` and their 8-bit shrunk forms, which is where every branching
spelling lands: `if`/`else`, `?:`, `&&`/`||` (and `&&=`/`||=`), and the
`for`/`while`/`do` condition tests, plus a `switch` whose case-compare
produced a tagged boolean (the observed note is then the Combine-derived
note of that compare). One conditional evaluated = one observation, with
the tested value's outer note and the payload-truthiness branch taken;
an untagged operand never calls the hook, and plain coercions (`!`,
`Boolean()`, internal protocol checks like an iterator's `done`) stay
silent. The `??`/`?.` nullish probe is **identity of the payload**, not
truthiness: `tagged(null) ?? z` evaluates `z`, but no cond observation
fires. The hook is per-runtime state, so an observation stream is
deterministic across fork and serialize→hydrate — the note travels with
the value.

## Builtin forwarding, first class: `JSON.stringify`

A structure containing a tagged value used to serialize the wrapper as
a null-proto object — `{"k":{}}` — silently discarding the tag. The
serializer walk now **refuses loudly** instead: reaching a tagged value
(post-`toJSON`, post-replacer) throws
`TypeError: JSON.stringify reached a tagged value at 'k'`, naming the
field (array index or property key; the top level is the spec's `''`
key). The wrapper's null proto means the `toJSON` probe never finds a
method — the payload's own `toJSON` is *not* consulted, so nothing runs
twice and nothing de-tags through the payload's serializer. A replacer
that swaps the tagged value for a concrete one serializes normally; the
untagged path is byte-identical and allocation-free (one class_id
compare on values the walk already classifies). The refusal is the
COW/coercion discipline: a precise worklist entry, not silent
corruption. **Forwarding is the documented follow-up**: a tagged field
makes the whole result tagged — serialize with the payload substituted
for the wrapper, then wrap the result string with a Combine-derived
note (a `JS_TT_OP_JSON` code), because a string derived from a tracked
value stays tracked.

## Builtin forwarding: the string-search five

`String.prototype.indexOf` / `lastIndexOf` / `includes` / `startsWith` /
`endsWith` — the concolic journal's native probes — now **forward**. A
tagged receiver, needle, or position argument unwraps to its payload and
the engine's own C search re-runs on the concretes (one intercept at the
top of each builtin, re-entering itself — no re-implementation). Three
things happen at once:

- **Search on payloads**: `includes.call(tagged("abc"), "b")` searches
  `"abc"`, a tagged needle searches for its payload, and a tagged
  position unwraps to its numeric payload for the offset. (Reaching the
  builtin through a tagged receiver still needs `Function.prototype.call`
  — method *lookup* on the wrapper is the property-forwarding follow-up.)
- **Journal correctly**: the entry records the payload token (never a
  wrapper stringification) **with the tagged operand's note** — the
  receiver's, else the needle's — in a new `TTCmpEnt.note` field
  surfaced by `JS_TTCmpGet` (borrowed from the value; NULL for concrete
  compares; dedup keeps one entry per token and a tagged occurrence
  ties its note to it). One entry per call, exactly as concretely.
- **Forward the result**: the concrete integer/boolean re-wraps via the
  Combine hook (`JS_TT_OP_INDEX_OF` / `_LAST_INDEX_OF` / `_INCLUDES` /
  `_STARTS_WITH` / `_ENDS_WITH` with the original operands), so a
  search over a tracked string yields a tracked result that branches
  through the cond hook and rides fork + serialize→hydrate intact.

The all-concrete path is byte-identical and allocation-free — the
intercept is a tag test per operand already in hand.

## Property get forwards to the payload

Reading a property of a tagged value used to hit the wrapper's null
prototype (`tagged("abc").length` → `undefined`, `.includes` →
TypeError). A get on a tagged **receiver** now forwards to the payload
at the property-get chokepoint — one `JS_CLASS_TT_TAGGED` compare in
the interpreter's inline field walk (routing to the generic path, since
the inline walk would complete the null-proto miss itself) and one in
`JS_GetPropertyInternal`, the `TT_COW_HIT` fast-miss shape; untagged
receivers pay a single predictable class-id test and are otherwise
byte-identical. The forward runs **the engine's own get against the
payload** (string length/index exotics, own/inherited props, getters
with the payload as `this`; a nested tagged payload reads off the
deepest payload), and the result stays tracked:
`JS_TTMakeTagged(v, Combine(JS_TT_OP_GET_FIELD, {receiver, key},
{note, NULL}))` — a missing key yields a *tracked* `undefined` with
provenance. Three sharp edges, by design:

- **A FUNCTION result returns unwrapped** — method lookup is
  resolution, not a data derivation. The receiver stays `this` (the
  compiler's `get_field2` keeps it), so `taggedString.includes("y")`
  now works as a *plain call*: lookup resolves `String.prototype.
  includes` off the payload, and the tagged `this` flows into the
  forwarded search builtins — journal, note, and tagged result intact.
  This closes the `.call`-only caveat.
- **A stored tagged value flattens**: `tagged({v: taggedFive}).v` is a
  single wrapper over `5`, the stored value joining the hook args with
  its note — never wrapper-in-wrapper.
- **Tagged keys stay pinned and cannot cross with receivers**:
  `obj[taggedKey]` (and `taggedReceiver[taggedKey]` — the key coerces
  first) still refuses. `JS_ToPrimitiveFree` now refuses tagged values
  explicitly with the same `TypeError` the empty wrapper produced
  before, so get-forwarding can never leak the payload's `toString`/
  `valueOf`/`Symbol.toPrimitive` into a coercion pipeline and silently
  de-tag — unsupported pipelines stay loud worklist entries. The
  `JSON.stringify` `toJSON` probe likewise skips tagged values,
  keeping the v1 "payload `toJSON` not consulted" pin.

A throwing forwarded get (payload `null`/`undefined`, a throwing
getter) propagates unwrapped. Payload getters run as plain C calls
(defer slots disarmed) so their results flow back through the wrap
rather than a parked frame.

## Property set forwards to the payload

The write side mirrors the read side, making get and set exact
inverses on the payload. A set on a tagged **receiver** forwards at
`JS_SetPropertyInternal`'s receiver branch (one class-id compare, the
`TT_COW_HIT` fast-miss shape) plus a defensive test on the interpreter's
inline fast-set path — that path is own-property-gated and a wrapper
never owns properties, but the test keeps "nothing ever writes the
wrapper" structural. The forward re-enters **the engine's own set on
the payload**: own/inherited setters run with the payload as `this`,
string/array exotic behavior applies (`tagged("abc")[0] = "x"` is the
payload's silent sloppy no-op / real strict TypeError, never a wrapper
property), a throwing set propagates unwrapped, and — the load-bearing
property — **automatic COW capture composes**: a forwarded write to a
baseline payload inside a checked-in flow records the same first-write
delta a direct write records (asserted via the delta count, deduped on
the second write, isolated after checkout), because the real set path
runs, nothing re-implemented. A tagged **value** being stored is stored
as-is — no unwrap, no extra wrap; the get forward flattens it with a
combined note on read-back. Tagged **keys** still refuse on any
receiver (the key coerces before the receiver forwards).

## Has/enumerate forward to the payload

The remaining reflection reads complete get/set. `k in t` answers over
the **payload's** chain (own + inherited) as a **concrete** boolean —
existence is not derived data, so no wrap and no hook, the
reflexive-identity discipline; a non-object payload gets the operator's
real TypeError. `for (k in t)` swaps the payload in at
`build_for_in_iterator`, so the walk is *literally* a for-in over the
payload — enumerability, shadowing, prototype order, string index keys
(`"0","1","2"` for `tagged("abc")`), and the empty loop for a nullish
payload all come from the engine's own iterator. `Object.keys` /
`values` / `entries`, `getOwnPropertyNames`/`Symbols`, and
`Reflect.ownKeys` forward at `JS_GetOwnPropertyNames2`: names and the
enumerability re-check run against the payload (**keys stay concrete
strings** — a tagged key string would poison joins via the coercion
pin), while `values`/`entries` fetch each value **through the
wrapper**, so they ride the get-forward and stay tracked
(`Object.values(tagged({a:5}))` → `[tagged 5]`; a stored tagged value
arrives flattened). Three one-compare class tests; untagged paths
byte-identical and allocation-free.

The wrapper's own raw view is no longer JS-visible, so the suite's
wrapper-inertness proofs moved to a new C probe:
`JS_TTOwnPropCount(ctx, v)` counts v's **unforwarded** shape-level own
properties — 0 for a wrapper before and after forwarded writes and
enumeration, while the payload's count grows. `seal`/`freeze`,
descriptors, `defineProperty`/`deleteProperty`, spread-copy internals,
and `Reflect.set` receiver-mixing keep that raw wrapper view and stay
named follow-ups.

The combinetest harness drives the oracle: exact payloads for
arithmetic/bitwise/shift (`tagged(5)+1 → 6`, `tagged(6)&3 → 2`), concat
in every form (`"x"+tagged("y") → "xy"`, templates via
`"p".concat(tagged("q"),"r") → "pqr"`, `+=` through a local), real
coercions (`+tagged("5")` is the *number* 5; `String(tagged(9)) → "9"`;
`parseInt(tagged("42")) → 42`; nothing collapses to NaN or de-tags),
`Combine` seeing the right op / notes / arity for one- and two-tagged
operand cases, a faithful `TypeError` from `tagged(Symbol()) * 1` with
zero Combine calls, strict equality unwrapping in every spelling
(`tagged(5) === 5` → `tagged(true)`, strict-vs-loose payload semantics
kept distinct, `=== null`/`=== undefined` literal forms, the `switch`
case-compare, reflexive `x === x` staying concrete and hook-free),
default-value probes never unwrapping (a tagged argument — even
`tagged(undefined)` — rides through with zero Combine and zero cond
calls), payload truthiness with the cond hook firing at exactly the
branch sites (`?:`, `if`, `&&`/`||`/`||=`, loop conditions once per
evaluation, switch case-compares payload-selecting their case) and
nowhere else (`!`, `Boolean()`, `??`/`?.` all silent, `??` unwrapping
the payload for its nullish test), `JSON.stringify` refusing loudly at
the named field (`at 'k'`, `at '0'`, nested; payload `toJSON` not
consulted; a replacer swap serializes; untagged structures
byte-identical, pretty-printing included), the search five unwrapping
each operand (receiver via `.call` or plain method call, needle,
position), journaling the payload token with the right note and exactly
one entry per call, and re-wrapping results that branch and round-trip,
property gets forwarding (string length/index, object own/getter/
inherited/missing, nested payloads with the outer note, stored tagged
values flattening with mask 5 arity 3, functions passing through
unwrapped into working plain method calls, throwing gets unwrapped,
tagged keys still refusing on any receiver, untagged gets
byte-identical), property sets forwarding (a second get and the raw
payload both see the write while the wrapper owns nothing — asserted
through the raw `JS_TTOwnPropCount` probe, tagged values stored as-is
and flattened on read-back, payload setters with payload `this`,
string exotic sloppy/strict semantics, throwing and tagged-key sets
refusing, and a baseline-payload write recording exactly one deduped
COW delta that checkout isolates), has/enumerate forwarding (`in` over
own+inherited payload props concrete and hook-free with the real
TypeError for primitive payloads, keys/getOwnPropertyNames/ownKeys as
concrete payload names, values/entries tracked through the wrapper,
for-in over object/proto/string payloads, and the wrapper's raw count
pinned at zero throughout), unchanged out-of-scope behavior (typeof,
tagged property keys, `new String(tagged)`), and
propagated results riding problem 1's fork and serialize→hydrate paths
with their notes intact — including a cond observation stream that is
byte-identical across the original, a forked arm, and a hydrated copy.

## Wire format (`TTFL05`)

```
header    magic, baseline fingerprint (u64), baseline count, flags
          (bit 0: a machine-parked chain travels in these bytes)
atoms     private name strings (interned on read)
records   shell table: kind + allocation parameters (class, fn_id, argc,
          element count, open-cell coordinates, string/symbol bytes,
          tagged-note blob: present flag + NoteSerialize's bytes)
frames    the TrampFrame chain, base first: owner byte (state | arena);
          state: record idx, pc offset, live extent, splice linkage;
          arena: cur_func vref, pc offset, frame kind, call-site argc,
          live extent, parent-relative argument window + receiver slot;
          both: the step-hook line cache
payloads  per record: prototype, properties (atomref, 6-bit shape flags,
          kind-specific payload), fast elements, closure cells, state
          fields, tagged payload vref; then per frame: the owned live
          JSValue range
delta     per-kind pre-image records: PROP obj+atom+saved, PROPX
          +presence+flags, CELL ref+saved, ARRAY element vector+length,
          PROMISE full state/reaction snapshot, PRESOLVED flag, ODATA
          slot, DEAD tombstone (MAP/ABUF refuse: fork-only for now)
jobs      the flow's captured pending job queue: per job, kind byte
          (reaction | thenable) + argument vrefs
root      handle kind + vref (generator object) or base state index
```

Everything is bounds-checked against the tables and the baseline registry;
readers reject bad magic, drifted baselines, out-of-range ids, pc offsets,
stack extents, cell slots, class ids, duplicate frame owners, and truncation
at any byte (fuzzed in the selftest) with a `TypeError` — never a crash.

## Per-flow async machinery: the promise graph and the job queue

The async/promise machinery is per-flow, so await-suspended flows fork,
serialize and evict like everything else.

**The flow's job queue.** A pending `.then`/`.catch`/`.finally` reaction,
a microtask, an async resume is a `JSJobEntry`. While a flow is **checked
in**, the runtime's live job list is by convention *that flow's queue*:
jobs its promises spawn land there and `JS_TTPumpJob` drains them —
reaction handlers still run under park-by-return, so a `.then` chained
after an await runs as its own parked sub-flow. **Checkout captures the
live list's entries into the flow** (`TTFlowJobs`, hung off the base
state, GC-marked, freed with it); **checkin splices them back**. The
queue rides the same single-writer discipline as the delta swaps — one
flow's jobs in flight at a time — and travels in the wire's jobs section
(job kind + argument vrefs; reaction and thenable jobs; anything else
refuses loudly), forks by deep copy, and hydrates back runnable.

**The promise graph classifies like any heap value.** Four record kinds
cover it: `PROMISE` (state, handled flag, result, both reaction lists),
`PROMISE_FUNC` (a resolve/reject capability, pointing at its promise),
`PRESOLVED` (the capability pair's *shared* already-resolved flag — the
pair keeps sharing it across clone and wire), and `ASYNC_RESOLVE` (an
await continuation handler, pinning its state exactly as
`js_async_function_resolve_create` does). A state's `resolving_funcs`
travel in its payload. Baseline promises pass by id; flow-private ones by
value; the two-pass assign→relink swizzle is untouched.

**The result promise is the async flow's handle.** `js_async_function_call`
links the result promise to its state (an owned, GC-marked edge, cleared
on completion, on eviction, and by the finalizer), so every flow API —
fork, serialize, evict, delta writes, checkout/checkin,
`JS_TTFlowGetLocal`/`SetLocal` — accepts it exactly as it accepts a
generator object. Deserialization and fork re-establish the link on the
fresh result promise. `JS_TTFlowGetLocal` (the read dual of `SetLocal`,
walking a suspended flow's frames) is how a host reaches an *arm's own*
cloned resolver or iterator to settle that arm's awaits independently:
fork an `await p` flow, read each arm's `r`, settle A with X and B with
Y, pump — the arms continue past the same await with diverging values,
isolated deltas, and their own reaction sub-flows. Evicting an
await-suspended flow serializes the suspended frame, the pending promise
graph *and* the captured queue, then severs the handle link — the
orphaned await cycle collects on the spot — and hydration brings it back
with the pending microtask firing exactly once. The asynctest harness
drives all three, including a `for await` loop over a flow-private async
iterator forked mid-loop into independently-fed arms.

## Automatic transparent COW

Program writes are isolated without any host call: while a flow is checked
in, the first mutation to each piece of *baseline* state records its
pre-image into that flow's delta, then mutates. Flow-private objects — ones
the running flow created — are never captured; that is the load-bearing
O(shared-state-touched) invariant.

**Classification is a birthmark, not a lookup.** `tt_baseline_add` stamps
one bit on every registered `JSObject`/`JSVarRef`
(`p->tt_baseline`) when the baseline registry is minted, and object/varref
birth clears it. The checked-in flow sits in a runtime register
(`rt->tt_cow_flow`, set last by `Checkin`, cleared first by `Checkout`,
by completion, and by the finalizer). The hot-path gate is two loads:

```c
#define TT_COW_HIT(ctx, pobj) \
    (unlikely((ctx)->rt->tt_cow_flow != NULL) && (pobj)->tt_baseline)
```

With no flow checked in (or a flow touching only its own objects) every
mutation site costs one predictable branch. Because `Checkin`/`Checkout`
run their swaps with the register cleared, the swaps themselves never
re-capture.

**Every mutation site funnels through a chokepoint.** Property set (both
the generic path and the interpreter's inline-cache fast path), property
add (`add_property`) and delete (`delete_property`), fast-array element
stores and `length` changes, `Array.prototype.push`'s fast case, closure
cell writes (a `TT_COW_CELL_CHECK` beside the interpreter's var_ref
stores), promise reaction-list appends (`perform_promise_then`) and
settlement (`fulfill_or_reject_promise`, the capability pair's
already-resolved flag), `Map`/`Set` insert/delete/clear, typed-array and
DataView stores plus the mutating typed-array builtins (fill, set,
copyWithin, reverse, sort) via their backing `ArrayBuffer`, and `Date`'s
`SetThisTimeValue`. A dedup index (pointer-keyed hash in the delta) makes
the second write to an already-captured cell allocation-free.

**Structural targets snapshot, value targets swap.** Beyond `PROP`/`CELL`
slot records, the delta holds: `PROPX` (a presence toggle for adds and
deletes — four states cover add-then-delete round trips, with `DEAD` as
the revivable tombstone), `ARRAY` (the fast array's element vector +
length, swapped as a unit), `PROMISE` (the full `JSPromiseData` snapshot
including both reaction lists — this is what makes `baselineP.then(cb)`
per-flow: each arm's reaction lives only in that arm's delta),
`PRESOLVED` (the resolve/reject pair's shared flag), `MAP` (the whole
`JSMapState`, cloned), `ABUF` (the byte image), and `ODATA` (`Date`'s
time value). All kinds fork; `MAP`/`ABUF` refuse the wire for now
(loudly).

Mutations the delta cannot yet model refuse with a specific `TypeError`
rather than leak across flows: prototype changes to a baseline object,
fast-array demotion (sparse/exotic conversion), weak collections, shared
`ArrayBuffer`s, and deleting a baseline accessor property. Accessor
*redefinition* via `defineProperty` on a baseline object is the known
uncovered edge (plain data-slot redefinition is covered).

The cowtest harness drives the contract end to end: two forked arms run
ordinary `sharedObj.x = v; sharedArr.push(...); sharedP.then(...)` code,
each sees only its own writes while the baseline stays pristine and
pointer-identical, capture adds zero allocation on a repeat write, the
auto-captured delta serializes/hydrates, and finishing an arm commits its
view (last completion wins).

## Scope and limits (v1)

- **Generator flows** (including nested `yield*` chains, flow-private
  closures over live locals, deltas) transplant fully. **Async-function
  flows** (suspended at `await`, with their private promise graph and
  captured job queue) fork, serialize, evict and hydrate; their handle is
  the result promise. **Async generators** remain refused (their request
  queue is a follow-up); a `for await` over a plain flow-private async
  iterator works today, as the harness shows.
- **Machine-parked chains** transplant when every parked frame is a plain
  inlined call or an in-loop generator splice (`METHOD`/`FOROF`/
  `ITERNEXT`/`ITERCALL` shapes) — which is what stepping through ordinary
  generator code produces. Chains running through the reflective residue
  (pumped builtins, proxy traps, deferred accessors, `OP_append` spreads:
  frame kinds whose pops consume side arena blocks) are refused with the
  kind named. Note that a *direct* `g.next()` call from script goes
  through C and is unparkable by the engine's own design; parks form under
  language-level iteration (`for-of`, `yield*`), as in the harness.
- Flow-private values of exotic classes (Map/Set/Proxy/TypedArray,
  heap bigints, `Symbol.for`) are refused with the class named in the
  error; *baseline* objects of any class pass by id. Promises and their
  capability/continuation functions are fully supported (above).
- Delta targets: plain own data properties, presence toggles, closure
  cells, fast arrays, promises, resolve-capability flags, `Date` time
  values fork *and* serialize; `Map`/`Set` state and `ArrayBuffer` bytes
  fork but refuse the wire for now. Prototype changes, fast-array
  demotion, weak collections and SharedArrayBuffers refuse capture
  outright (loud `TypeError` at the mutation).
- A flow checks out only between jobs: a job parked mid-run
  (`tt_job_kind` set) must finish through `JS_TTCallResume` first.
- `JS_TTBaselineCapture` should run before flows start (it forces autoinit
  materialization; a flow started earlier may have materialized private
  copies).

All refusals are loud, specific `TypeError`s at serialization time — never
silent corruption at resume time.
