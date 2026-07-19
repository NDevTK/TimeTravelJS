// TimeTravelJS engine: drives a QuickJS (WebAssembly) VM through an
// instrumented user program, taking copy-on-write snapshots of the VM's
// linear memory at checkpoints, and navigates time by restoring the nearest
// checkpoint and deterministically replaying forward.
//
// Position model: `pos` = number of trace entries executed. Position 0 is
// "program loaded, nothing run". Each trace entry corresponds to one poke of
// the active generator (plus, for some kinds, pending-job pumping).
//
// Trace entry kinds:
//   0 step          — a statement step: {k:0, l, c, el, ec, d}
//   1 timer marker  — virtual timer fired: {k:1, l, at}
//   5 phase switch  — main program finished; timer pump begins: {k:5, info}
//   3 done          — everything finished: {k:3}
//   2 error         — user program threw: {k:2, info}

import { newQuickJSWASMModuleFromVariant } from "../vendor/quickjs-emscripten-core/index.mjs"
import variant from "../vendor/quickjs-singlefile-browser-release-sync/index.mjs"
import { SnapshotStore } from "./snapshots.js"
import { instrument, wrapProgram } from "./instrument.js"
import { VM_RUNTIME_SOURCE } from "./vmruntime.js"

const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now()

let modulePromise = null
export function loadQuickJS() {
  if (!modulePromise) modulePromise = newQuickJSWASMModuleFromVariant(variant)
  return modulePromise
}

export class TimeTravelEngine {
  static async create() {
    const engine = new TimeTravelEngine()
    engine.QuickJS = await loadQuickJS()
    engine.memory = engine.QuickJS.getWasmMemory()
    return engine
  }

  constructor() {
    this.session = null
  }

  mem() {
    return new Uint8Array(this.memory.buffer)
  }

  /** Instrument + load a program into a fresh VM and record its execution. */
  async run(source, opts = {}, onProgress = null) {
    this.dispose() // tear down any previous session
    const { code, warnings } = instrument(source) // throws timeTravelUserError on bad input

    const rt = this.QuickJS.newRuntime()
    rt.setMemoryLimit(256 * 1024 * 1024)
    rt.setMaxStackSize(1024 * 1024)
    const ctx = rt.newContext()

    const s = {
      rt,
      ctx,
      source,
      warnings,
      trace: [],
      consoleEntries: [], // {visibleAt, level, parts}
      checkpoints: [], // {step, snap}
      store: new SnapshotStore(),
      cpInterval: opts.cpInterval ?? 32,
      maxSteps: opts.maxSteps ?? 20000,
      maxCheckpoints: 360,
      switchIdx: Infinity,
      pos: 0,
      finished: false,
      truncated: false,
      diverged: false,
      stateDirty: false,
      replaying: false,
      deadline: Infinity,
      handles: {},
      snapMsTotal: 0,
      cachedInspect: null,
    }
    this.session = s

    rt.setInterruptHandler(() => now() > s.deadline)

    // host console sink — must exist before the runtime source is evaluated
    const hostout = ctx.newFunction("__tt_hostout", (jsonHandle) => {
      const raw = ctx.getString(jsonHandle)
      if (s.replaying) return
      try {
        const { level, parts } = JSON.parse(raw)
        s.consoleEntries.push({ visibleAt: s.trace.length + 1, level, parts })
      } catch {
        s.consoleEntries.push({ visibleAt: s.trace.length + 1, level: "log", parts: [{ t: "str", v: raw }] })
      }
    })
    ctx.setProp(ctx.global, "__tt_hostout", hostout)
    hostout.dispose()

    this._evalOrThrow(VM_RUNTIME_SOURCE, "tt-runtime.js")
    this._evalOrThrow(wrapProgram(code, "__tt_gen1"), "user-program.js")

    // The ONLY long-lived handle. Created before checkpoint 0, so its
    // in-heap refcount contribution is present in every snapshot and the
    // books balance at teardown no matter where the timeline is parked.
    s.handles.poke = ctx.getProp(ctx.global, "__tt_poke")

    // checkpoint 0: program loaded, nothing executed
    this._takeCheckpoint()

    await this._record(onProgress)
    this._takeCheckpoint(true)
    return this.summary()
  }

  _evalOrThrow(code, filename) {
    const { ctx } = this.session
    const res = ctx.evalCode(code, filename)
    if (res.error) {
      const info = ctx.dump(res.error)
      res.error.dispose()
      const err = new Error(typeof info === "object" && info && info.message ? `${info.name ?? "Error"}: ${info.message}` : String(info))
      err.timeTravelUserError = true
      throw err
    }
    res.value.dispose()
  }

  // -------------------------------------------------------------------------
  // recording
  // -------------------------------------------------------------------------
  async _record(onProgress) {
    const s = this.session
    for (;;) {
      const t0 = now()
      s.deadline = t0 + 2500
      let terminal = false
      do {
        if (s.trace.length >= s.maxSteps) {
          s.truncated = true
          terminal = true
          break
        }
        terminal = this._advanceRecord()
      } while (!terminal && now() - t0 < 12)
      if (onProgress) onProgress(this.progress())
      if (terminal) break
      await new Promise((r) => setTimeout(r, 0))
    }
    s.deadline = Infinity
    s.finished = true
    s.pos = s.trace.length
    s.cachedInspect = null
  }

  /** Execute one trace entry at record time. Returns true when terminal. */
  _advanceRecord() {
    const s = this.session
    const phase2 = s.trace.length > s.switchIdx
    const r = this._poke(phase2)
    let terminal = false
    if (r.type === "yield" && Array.isArray(r.value)) {
      if (r.value[0] === 0) {
        s.trace.push({ k: 0, l: r.value[1], c: r.value[2], el: r.value[3], ec: r.value[4], d: r.value[5] })
      } else {
        s.trace.push({ k: 1, l: r.value[1], at: r.value[2] })
        this._runJobs()
      }
    } else if (r.type === "yield") {
      // instrumented code should only yield step arrays; tolerate anything else
      s.trace.push({ k: 0, l: 0, c: 0, el: 0, ec: 0, d: 0 })
    } else if (r.type === "done") {
      if (!phase2 && s.switchIdx === Infinity) {
        s.trace.push({ k: 5 })
        s.switchIdx = s.trace.length - 1
        this._runJobs()
        this._createPump()
      } else {
        s.trace.push({ k: 3 })
        this._runJobs()
        terminal = true
      }
    } else {
      s.trace.push({ k: 2, info: r.info })
      terminal = true
    }
    this._maybeCheckpoint()
    return terminal
  }

  _poke(phase2) {
    const { ctx } = this.session
    const res = ctx.callFunction(this.session.handles.poke, ctx.undefined, phase2 ? ctx.true : ctx.false)
    if (res.error) {
      const info = ctx.dump(res.error)
      res.error.dispose()
      return { type: "error", info }
    }
    const h = res.value
    const doneH = ctx.getProp(h, "done")
    const done = ctx.dump(doneH)
    doneH.dispose()
    let value
    if (!done) {
      const vH = ctx.getProp(h, "value")
      value = ctx.dump(vH)
      vH.dispose()
    }
    h.dispose()
    return done ? { type: "done" } : { type: "yield", value }
  }

  _runJobs() {
    const res = this.session.rt.executePendingJobs()
    if (res.error) {
      const info = this.session.ctx.dump(res.error)
      res.error.dispose()
      if (!this.session.replaying) {
        this.session.consoleEntries.push({
          visibleAt: this.session.trace.length,
          level: "error",
          parts: [{ t: "str", v: `Unhandled rejection: ${info && info.message ? info.message : String(info)}` }],
        })
      }
    }
  }

  _createPump() {
    this._evalOrThrow("globalThis.__tt_gen2 = __tt_pump();\"ok\"", "tt-pump.js")
  }

  _maybeCheckpoint() {
    const s = this.session
    const lastCp = s.checkpoints[s.checkpoints.length - 1]
    if (s.trace.length - lastCp.step < s.cpInterval) return
    this._takeCheckpoint()
    // adaptive interval: keep snapshot overhead and checkpoint count in bounds
    const avgMs = s.snapMsTotal / s.checkpoints.length
    if (avgMs > 5 && s.cpInterval < 4096) s.cpInterval *= 2
    if (s.checkpoints.length > s.maxCheckpoints) {
      const keep = []
      for (let i = 0; i < s.checkpoints.length; i++) {
        if (i === 0 || i === s.checkpoints.length - 1 || i % 2 === 1) keep.push(s.checkpoints[i])
      }
      const kept = new Set(keep.map((cp) => cp.snap.id))
      s.store.prune((snap) => !kept.has(snap.id))
      s.checkpoints = keep
      s.cpInterval = Math.min(s.cpInterval * 2, 4096)
    }
  }

  _takeCheckpoint(force = false) {
    const s = this.session
    const last = s.checkpoints[s.checkpoints.length - 1]
    if (!force && last && last.step === s.trace.length) return
    if (force && last && last.step === s.trace.length) return
    const t0 = now()
    const snap = s.store.take(this.mem(), s.trace.length)
    s.snapMsTotal += now() - t0
    s.checkpoints.push({ step: s.trace.length, snap })
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------

  /** Move the VM to position `pos` (0..trace.length). */
  positionTo(target) {
    const s = this.session
    if (!s || !s.finished) throw new Error("no finished recording")
    target = Math.max(0, Math.min(target, s.trace.length))
    if (target === s.pos && !s.stateDirty) return s.pos

    const t0 = now()
    s.deadline = t0 + 5000
    // Replaying forward from the current position is fine unless state was
    // perturbed (console eval) or we need to go backward.
    if (target < s.pos || s.stateDirty) {
      let cp = s.checkpoints[0]
      for (const c of s.checkpoints) {
        if (c.step <= target) cp = c
        else break
      }
      s.store.restore(cp.snap, this.mem())
      s.pos = cp.step
      s.stateDirty = false
    }
    s.replaying = true
    try {
      while (s.pos < target) {
        this._replayEntry(s.trace[s.pos])
        s.pos++
      }
    } finally {
      s.replaying = false
      s.deadline = Infinity
    }
    s.cachedInspect = null
    return s.pos
  }

  _replayEntry(entry) {
    const s = this.session
    if (entry.k === 5) {
      const r = this._poke(false) // the poke that discovers gen1 completion
      if (r.type === "yield") s.diverged = true
      this._runJobs()
      this._createPump()
      return
    }
    const phase2 = s.pos > s.switchIdx
    const r = this._poke(phase2)
    if (entry.k === 0) {
      if (!(r.type === "yield" && Array.isArray(r.value) && r.value[1] === entry.l && r.value[2] === entry.c)) {
        s.diverged = true
      }
    } else if (entry.k === 1) {
      this._runJobs()
    } else if (entry.k === 3) {
      this._runJobs()
    }
    // k === 2: the same error is re-thrown during replay; nothing to do
  }

  // -------------------------------------------------------------------------
  // inspection
  // -------------------------------------------------------------------------

  /** Locals/stack/globals at the current position (cached per position). */
  inspect() {
    const s = this.session
    if (!s) return null
    if (s.cachedInspect) return s.cachedInspect
    const res = s.ctx.evalCode("__tt_inspect()", "tt-inspect.js")
    let data = { locals: null, stack: [], globals: [] }
    if (res.error) {
      res.error.dispose()
    } else {
      try {
        data = JSON.parse(s.ctx.dump(res.value))
      } catch {
        /* keep defaults */
      }
      res.value.dispose()
    }
    s.cachedInspect = data
    return data
  }

  /**
   * Evaluate an expression against the live VM state at the current position.
   * Mutations are possible; the timeline is marked dirty so the next
   * navigation restores from a clean snapshot (changes are discarded).
   */
  consoleEval(src) {
    const s = this.session
    if (!s) return { error: { t: "str", v: "no program loaded" } }
    const t0 = now()
    s.deadline = t0 + 2000
    const wrapped = `JSON.stringify(__tt_ser(__tt_evalAt(${JSON.stringify(String(src))}), 4))`
    const res = s.ctx.evalCode(wrapped, "tt-eval.js")
    s.deadline = Infinity
    s.stateDirty = true
    s.cachedInspect = null
    if (res.error) {
      const info = s.ctx.dump(res.error)
      res.error.dispose()
      const msg = info && typeof info === "object" && info.message ? `${info.name ?? "Error"}: ${info.message}` : String(info)
      return { error: { t: "str", v: msg } }
    }
    let out
    try {
      out = JSON.parse(s.ctx.dump(res.value))
    } catch {
      out = { t: "str", v: "(unserializable)" }
    }
    res.value.dispose()
    return { value: out }
  }

  // -------------------------------------------------------------------------
  // info / teardown
  // -------------------------------------------------------------------------
  progress() {
    const s = this.session
    return {
      steps: s.trace.length,
      checkpoints: s.checkpoints.length,
      memBytes: this.memory.buffer.byteLength,
      cow: s.store.stats(),
    }
  }

  summary() {
    const s = this.session
    const last = s.trace[s.trace.length - 1]
    return {
      steps: s.trace.length,
      truncated: s.truncated,
      warnings: s.warnings,
      error: last && last.k === 2 ? last.info : null,
      switchIdx: s.switchIdx === Infinity ? null : s.switchIdx,
      cow: s.store.stats(),
      checkpoints: s.checkpoints.map((c) => ({ step: c.step, dirtyPages: c.snap.dirtyPages, newBytes: c.snap.newBytes })),
      pageHeat: [...s.store.pageWriteHeat.entries()],
      memBytes: this.memory.buffer.byteLength,
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
  get diverged() {
    return this.session ? this.session.diverged : false
  }

  dispose() {
    const s = this.session
    if (!s) return
    this.session = null
    try {
      if (s.handles.poke) s.handles.poke.dispose()
      s.ctx.dispose()
      s.rt.dispose()
    } catch (e) {
      // Abandon the runtime rather than crash the page; the wasm heap leaks
      // a few MB but the next session gets a fresh runtime.
      console.warn("TimeTravelJS: teardown failed, abandoning VM instance", e)
    }
    s.store.clear()
  }
}
