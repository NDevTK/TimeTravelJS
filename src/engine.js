// TimeTravelJS engine — true suspend/resume time travel on a stackless VM.
//
// The program executes exactly once. The interpreter keeps every frame in a
// linear-memory arena, so on the common path no C stack spans a step: the
// VM suspends by RETURNING to the host ('r' steps — resuming is a plain
// call), and the engine captures a copy-on-write page delta of the entire
// machine. Steps reached under live C frames (sort comparators, getters,
// generator bodies, promise jobs) suspend through Asyncify instead ('a'
// steps — the C stack spills into linear memory and resuming rewinds it).
// Navigation applies deltas backward/forward — pure memory writes, no
// re-execution, no replay, no determinism requirements.
//
// Inspection at an 'r' position is trivial: restore the pages and walk the
// live frames with a plain call — repeatable at will. At an 'a' position it
// is a one-shot transaction: restore, set the shadow stack pointer, rewind,
// inspect inside the live interpreter, abort the disposable activation.
// Either way the delta store keeps history pristine; whatever a transaction
// perturbs is healed from the page store afterwards.

import { QuickJSVM, STEP_CONTINUE, STEP_ABORT, STEP_INSPECT_ABORT, STEP_EVAL_ABORT, STEP_EVAL_CONTINUE } from "./vm.js"
import { DeltaStore } from "./deltastore.js"

const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now()

const OUT_CONSOLE = 0
const OUT_INSPECT = 1
const OUT_EVAL = 2
const OUT_EVAL_DONE = 3
const OUT_JOBS_DONE = 4
const OUT_TIMER_DONE = 5

const LEVELS = ["log", "info", "warn", "error"]

export class TimeTravelEngine {
  static async create(wasmBytes) {
    const engine = new TimeTravelEngine()
    engine.vm = await QuickJSVM.instantiate(wasmBytes, {
      onStep: (line, col, depth) => engine._onStep(line, col, depth),
      onOut: (kind, text) => engine._onOut(kind, text),
      onInterrupt: () => now() > engine._deadline,
    })
    engine._resetSession()
    return engine
  }

  constructor() {
    this.session = null
    this._deadline = Infinity
    this._mode = "idle" // idle | record | transact
    this._transact = null
  }

  mem() {
    return new Uint8Array(this.vm.memory.buffer)
  }

  _resetSession() {
    this.session = {
      trace: [], // {l, c, d, entry} — entry = which export activation this step suspended in
      consoleEntries: [], // {visibleAt, level, parts}
      store: new DeltaStore(),
      pos: 0,
      finished: false,
      truncated: false,
      error: null, // {name, msg} envelope of an uncaught program error
      result: null, // serialized completion value
      memDirty: false, // live memory drifted from store.liveTable (transaction ran)
      maxSteps: 20000,
      byteBudget: 256 * 1024 * 1024,
      warnings: [],
      cachedInspect: new Map(), // pos -> parsed inspection
      evalResult: null,
      phase: "main",
    }
  }

  // ---- hook plumbing ------------------------------------------------------
  _onStep(line, col, depth) {
    if (this._mode === "record") return "suspend" // engine captures after unwind completes
    if (this._mode === "transact") return "suspend" // second hook hit during a transaction: parks (then aborted)
    return STEP_CONTINUE
  }

  _onOut(kind, text) {
    const s = this.session
    if (kind === OUT_CONSOLE) {
      if (this._mode !== "record") return // transactional activations don't append console output
      try {
        const msg = JSON.parse(text)
        s.consoleEntries.push({ visibleAt: s.trace.length, level: LEVELS[msg.level] ?? "log", parts: msg.parts })
      } catch {
        s.consoleEntries.push({ visibleAt: s.trace.length, level: "log", parts: [{ t: "str", v: text }] })
      }
      return
    }
    if (kind === OUT_INSPECT) {
      if (this._transact) this._transact.inspect = text
      return
    }
    if (kind === OUT_EVAL) {
      if (this._transact) this._transact.evalResult = text
      return
    }
    if (kind === OUT_EVAL_DONE && this._mode === "record") {
      try {
        const env = JSON.parse(text)
        if (env && env.error) s.error = env.error
        else if (env) s.result = env.ok
      } catch {
        /* ignore */
      }
    }
  }

  // ---- recording ----------------------------------------------------------
  /**
   * Load + record a program. The program runs to completion (or budget) with
   * a COW delta captured at every step. Returns the summary.
   */
  async run(source, opts = {}, onProgress = null) {
    const s0 = this.session
    if (s0 && this.vm.suspended) this._abortActivation()
    if (s0 && s0.programPtr) {
      // Live memory may be parked at any historical position. Return it to
      // the true end-of-run state (where the program buffer and allocator
      // are consistent with reality) before freeing and resetting.
      if (s0.finished && s0.trace.length) this.positionTo(s0.trace.length - 1)
      if (s0.memDirty) {
        s0.store.heal(this.mem())
        s0.memDirty = false
      }
      this.vm.exports.tt_free(s0.programPtr)
      const rc = this.vm.exports.tt_reset()
      if (rc !== 0) throw new Error(`tt_reset failed: ${rc}`)
      this.vm._initAsyncifyArea() // the healed heap may carry a mid-suspension header
    }
    this._resetSession()
    const s = this.session
    if (opts.maxSteps) s.maxSteps = opts.maxSteps
    if (opts.verifyBarrier) s.verifyBarrier = true
    // granularity: "line" (default) or "opcode" — suspend between every two
    // VM instructions of user code
    this.vm.exports.tt_set_granularity(opts.granularity === "opcode" ? 1 : 0)

    const { ptr, len } = this.vm.writeString(source)
    s.programPtr = ptr
    this._mode = "record"
    this._lastYield = now()
    this._deadline = now() + 2500
    this._onProgress = onProgress

    const origOnStep = this._onStep.bind(this)
    this._onStep = (line, col, depth) => {
      this._lastLine = line
      this._lastCol = col
      this._lastDepth = depth
      return origOnStep(line, col, depth)
    }
    try {
      const ok = await this._pumpSteps(this.vm.drive("tt_eval", ptr, len), { name: "tt_eval", args: [ptr, len] })
      await this._drainPhases(ok)
    } finally {
      this._mode = "idle"
      this._deadline = Infinity
      this._onStep = origOnStep
      this._onProgress = null
    }
    s.finished = true
    s.pos = s.trace.length - 1
    if (onProgress) onProgress(this.progress())
    return this.summary()
  }

  /**
   * Fork the timeline: discard everything after `pos`, apply an optional
   * edit at that moment, and let execution CONTINUE from there, recording a
   * new future. Uses only proven suspension patterns: one rewind of the
   * restored activation, then the ordinary record cycle going forward.
   */
  async forkFrom(pos, editSrc = null, onProgress = null) {
    const s = this.session
    if (!s || !s.finished) throw new Error("no finished recording")
    pos = Math.max(0, Math.min(pos, s.trace.length - 1))
    const entry = s.trace[pos]
    if (!entry.entry) throw new Error("cannot fork at an idle position")

    this.positionTo(pos)
    // truncate history: the live table is already AT pos
    s.store.truncateTo(pos)
    s.trace.length = pos + 1
    s.consoleEntries = s.consoleEntries.filter((e) => e.visibleAt <= pos)
    for (const key of [...s.cachedInspect.keys()]) if (key > pos) s.cachedInspect.delete(key)
    s.error = null
    s.result = null
    s.truncated = false
    s.finished = false
    s.forkedAt = pos

    this._mode = "record"
    this._lastYield = now()
    this._deadline = now() + 2500
    this._onProgress = onProgress
    this.vm.clearDirtyMap()
    const origOnStep = this._onStep.bind(this)
    this._onStep = (line, col, depth) => {
      this._lastLine = line
      this._lastCol = col
      this._lastDepth = depth
      return origOnStep(line, col, depth)
    }
    try {
      let r
      if (entry.k === "r") {
        // return-parked fork: the restored memory is the whole machine.
        // Apply the edit with a plain call, then continue with another.
        if (editSrc != null) {
          this.vm.stagedArg = new TextEncoder().encode(String(editSrc))
          this.vm.exports.tt_eval_parked(1)
          // the edit's dirty pages stay marked: they belong to pos+1's delta
        }
        this.vm.adoptSuspension(null, "r")
        r = this.vm.resume(STEP_CONTINUE)
      } else {
        this.vm.adoptSuspension(entry.entry)
        this.vm.exports.__stack_pointer.value = entry.sp
        if (editSrc != null) {
          this.vm.stagedArg = new TextEncoder().encode(String(editSrc))
          r = this.vm.resume(STEP_EVAL_CONTINUE)
        } else {
          r = this.vm.resume(STEP_CONTINUE)
        }
      }
      const ok = await this._pumpSteps(r, entry.entry)
      await this._drainPhases(ok)
    } finally {
      this._mode = "idle"
      this._deadline = Infinity
      this._onStep = origOnStep
      this._onProgress = null
      this.vm.stagedArg = null
    }
    s.finished = true
    s.pos = s.trace.length - 1
    if (onProgress) onProgress(this.progress())
    return this.summary()
  }

  /** Drive one activation, capturing a COW delta per suspension. */
  async _pumpSteps(r, entryTag) {
    const s = this.session
    while (r.suspended) {
      const isR = r.park === "r"
      const e = isR
        ? {
            // parked by return: the stackless path — no live wasm activation,
            // no stack pointer to save; the machine is nothing but memory
            l: this.vm.exports.tt_park_line(),
            c: this.vm.exports.tt_park_col(),
            d: this.vm.exports.tt_park_depth(),
            entry: this.vm.entry ?? entryTag,
            k: "r",
          }
        : {
            // asyncify suspension (C frames live): record the activation to
            // rewind and the shadow stack pointer it must resume from
            l: this._lastLine,
            c: this._lastCol,
            d: this._lastDepth,
            entry: this.vm.entry ?? entryTag,
            sp: this.vm.exports.__stack_pointer.value,
          }
      s.trace.push(e)
      if (s.trace.length === 1) {
        // base image: full scan (excluding the barrier's own map region)
        this.vm.clearDirtyMap()
        s.store.capture(this.mem(), 0, [this.vm.mapExclusion()])
      } else {
        s.store.captureFrom(this.mem(), this.vm.readAndClearDirtyPages())
      }
      if (s.verifyBarrier) {
        const bad = s.store.audit(this.mem(), [this.vm.mapExclusion()])
        if (bad.length) s.warnings.push(`barrier missed pages at step ${s.trace.length - 1}: ${bad.slice(0, 8).join(",")}`)
      }
      if (s.trace.length >= s.maxSteps || s.store.poolBytes > s.byteBudget) {
        s.truncated = true
        this._abortActivation()
        return false
      }
      if (now() - this._lastYield > 12) {
        if (this._onProgress) this._onProgress(this.progress())
        await new Promise((res) => setTimeout(res, 0))
        this._lastYield = now()
      }
      this._deadline = now() + 2500
      r = this.vm.resume(STEP_CONTINUE)
    }
    return true
  }

  /** After the main activation: promise jobs + virtual timers, then the end state. */
  async _drainPhases(ok) {
    const s = this.session
    let rounds = 0
    while (ok && !s.truncated && rounds++ < 10000) {
      if (this.vm.exports.tt_pending_jobs()) {
        ok = await this._pumpSteps(this.vm.drive("tt_run_jobs"), { name: "tt_run_jobs", args: [] })
        continue
      }
      if (this.vm.exports.tt_timer_count() > 0) {
        s.trace.push({ l: 0, c: 0, d: 0, entry: null, timer: true })
        s.store.captureFrom(this.mem(), this.vm.readAndClearDirtyPages(), 1)
        ok = await this._pumpSteps(this.vm.drive("tt_fire_timer"), { name: "tt_fire_timer", args: [] })
        continue
      }
      break
    }
    if (ok) {
      s.trace.push({ l: 0, c: 0, d: 0, entry: null, end: true })
      s.store.captureFrom(this.mem(), this.vm.readAndClearDirtyPages(), 2)
    }
  }

  /** Abort the current suspended activation: unwind to idle, mark memory dirty. */
  _abortActivation() {
    if (!this.vm.suspended) return
    const keep = this._mode
    this._mode = "abort"
    try {
      let r = this.vm.resume(STEP_ABORT)
      // an abort can only terminate the activation; if it somehow suspends
      // again, keep aborting
      let guard = 0
      while (r.suspended && guard++ < 4) r = this.vm.resume(STEP_ABORT)
    } finally {
      this._mode = keep === "record" ? "idle" : keep
      this.session.memDirty = true
    }
  }

  // ---- navigation (pure memory, no execution) -----------------------------
  /** Move the debugger position. O(deltas between here and there). */
  positionTo(target) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    target = Math.max(0, Math.min(target, s.trace.length - 1))
    const mem = this.mem()
    if (s.memDirty) {
      s.store.heal(mem)
      s.memDirty = false
    }
    while (s.pos < target) this.session.store.applyForward(++s.pos, mem)
    while (s.pos > target) this.session.store.applyBackward(s.pos--, mem)
    return s.pos
  }

  // ---- transactional inspection / evaluation ------------------------------
  /**
   * Inspect the current position: restores its state, rewinds the VM into
   * the suspension, runs the in-VM inspector, aborts the activation.
   */
  inspect() {
    const s = this.session
    if (!s.finished) return null
    const cached = s.cachedInspect.get(s.pos)
    if (cached) return cached
    const entry = s.trace[s.pos]
    let parsed = { stack: [], frames: [], globals: [] }
    this._transact = { inspect: null }
    this._deadline = now() + 3000
    try {
      this.positionTo(s.pos)
      this.vm.clearDirtyMap()
      if (entry.k === "r") {
        // return-parked position: the restored memory IS the parked machine —
        // walk its live frames with a plain call. No rewind, no SP, no
        // one-shot restriction.
        this.vm.exports.tt_inspect_parked()
      } else if (entry.entry) {
        this.vm.adoptSuspension(entry.entry)
        this._mode = "transact"
        this.vm.exports.__stack_pointer.value = entry.sp
        // one-shot: the wrapper inspects, then aborts this activation itself
        const r = this.vm.resume(STEP_INSPECT_ABORT)
        if (r.suspended) this._abortActivation()
        this.vm.abandonSuspension()
      } else {
        // idle positions (end-of-program, pre-timer): plain synchronous call
        this.vm.exports.tt_inspect_idle()
      }
      if (this._transact.inspect) parsed = JSON.parse(this._transact.inspect)
      this._healTransaction()
    } catch (e) {
      this.session.warnings.push(`inspection failed at ${s.pos}: ${e}`)
      this.vm.normalize()
      s.memDirty = true
    } finally {
      this._mode = "idle"
      this._transact = null
      this._deadline = Infinity
    }
    s.cachedInspect.set(s.pos, parsed)
    return parsed
  }

  /** Repair transaction writes using the barrier's dirty list — O(touched). */
  _healTransaction() {
    const pages = this.vm.readAndClearDirtyPages()
    this.session.store.heal(this.mem(), pages)
    this.session.memDirty = false
  }

  /**
   * Evaluate a console expression against the state at the current position.
   * Mutations only touch the disposable transaction — the timeline is
   * immutable by construction.
   */
  consoleEval(src) {
    const s = this.session
    if (!s.finished) return { error: { t: "str", v: "no program loaded" } }
    const entry = s.trace[s.pos]
    this._transact = { evalResult: null }
    this.vm.stagedArg = new TextEncoder().encode(String(src))
    this._deadline = now() + 3000
    try {
      this.positionTo(s.pos)
      this.vm.clearDirtyMap()
      if (entry.k === "r") {
        this.vm.exports.tt_eval_parked(0)
      } else if (entry.entry) {
        this.vm.adoptSuspension(entry.entry)
        this._mode = "transact"
        this.vm.exports.__stack_pointer.value = entry.sp
        const r = this.vm.resume(STEP_EVAL_ABORT)
        if (r.suspended) this._abortActivation()
        this.vm.abandonSuspension()
      } else {
        this.vm.exports.tt_eval_idle()
      }
      const raw = this._transact.evalResult
      this._healTransaction()
      if (raw) {
        const env = JSON.parse(raw)
        if (env && env.error) return { error: env.error }
        if (env) return { value: env.ok }
      }
      return { error: { t: "str", v: "evaluation produced no result" } }
    } catch (e) {
      this.vm.normalize()
      s.memDirty = true
      return { error: { t: "str", v: String(e) } }
    } finally {
      this._mode = "idle"
      this._transact = null
      this._deadline = Infinity
      this.vm.stagedArg = null
    }
  }

  // ---- info ---------------------------------------------------------------
  progress() {
    const s = this.session
    return {
      steps: s.trace.length,
      checkpoints: s.store.count,
      memBytes: this.vm.memory.buffer.byteLength,
      cow: s.store.stats(),
    }
  }

  summary() {
    const s = this.session
    return {
      steps: s.trace.length,
      truncated: s.truncated,
      warnings: s.warnings,
      error: s.error,
      result: s.result,
      cow: s.store.stats(),
      forkedAt: s.forkedAt ?? null,
      dirtyCounts: s.store.dirtyCounts(),
      pageHeat: [...s.store.pageHeat.entries()],
      memBytes: this.vm.memory.buffer.byteLength,
    }
  }

  get trace() {
    return this.session ? this.session.trace : []
  }
  get pos() {
    return this.session ? this.session.pos : 0
  }
  get consoleEntries() {
    return this.session ? this.session.consoleEntries : []
  }
}
