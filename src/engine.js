// TimeTravelJS engine — true suspend/resume time travel on a stackless VM.
//
// The program executes exactly once per timeline. The interpreter keeps
// every frame in a linear-memory arena, so no C stack ever spans a step:
// the VM suspends by RETURNING to the host and the engine captures a
// copy-on-write page delta of the entire machine. Resuming — now or from
// any restored snapshot — is a plain call. Navigation applies deltas
// backward/forward: pure memory writes, no re-execution, no replay, no
// determinism requirements.
//
// History is a TREE. Forking does not discard the abandoned future — it
// stays reachable as a sibling timeline, and because all timelines share
// one content-deduplicated page pool, a branch costs only the pages it
// actually diverges on. Navigation between any two moments of any two
// timelines walks the tree through their common ancestor: undo up, redo
// down. That turns the debugger from "what happened" into "what would
// have happened": whatIf() forks a set of candidate edits off the same
// moment (the breadth-first frontier), and searchAll() BFS-scans a
// predicate across every state of every timeline, visiting each state
// exactly once.
//
// Inspection is trivial by construction: restore the position's pages and
// walk the live frames with a plain call — repeatable at will; whatever a
// transaction perturbs is healed from the page store afterwards.

import { QuickJSVM, STEP_CONTINUE, STEP_ABORT } from "./vm.js"
import { DeltaStore } from "./deltastore.js"

const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now()

const OUT_CONSOLE = 0
const OUT_INSPECT = 1
const OUT_EVAL = 2
const OUT_EVAL_DONE = 3
const OUT_JOBS_DONE = 4
const OUT_TIMER_DONE = 5

const LEVELS = ["log", "info", "warn", "error"]

/** truthiness of a serialized value envelope (for search predicates) */
const envTruthy = (v) => {
  if (!v) return false
  switch (v.t) {
    case "undef":
    case "null":
    case "nan":
    case "tdz":
    case "hole":
      return false
    case "bool":
    case "num":
      return !!v.v
    case "str":
      return v.v.length > 0
    case "bigint":
      return v.v !== "0" && v.v !== "0n"
    default:
      return true // objects, arrays, functions, dom nodes, dates, …
  }
}

export class TimeTravelEngine {
  static async create(wasmBytes) {
    const engine = new TimeTravelEngine()
    engine.vm = await QuickJSVM.instantiate(wasmBytes, {
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
      // the branch tree. branches[0] = the root timeline; a fork appends a
      // branch whose chain hangs at (parentId, forkPos). Pruned slots are null.
      branches: [this._newBranch(0, null, -1, null)],
      view: 0, // which timeline the linear trace/pos API presents
      at: { branchId: 0, local: 0 }, // where the LIVE memory actually is
      pos: 0, // global position within the view timeline's composite
      version: 0, // bumped when the tree changes (invalidates composites)
      compCache: new Map(), // branchId -> {v, arr} composite trace
      consoleCache: new Map(), // branchId -> {v, arr} composite console
      consoleEntries: [], // kept for shape-compat; real storage is per branch
      store: new DeltaStore(),
      finished: false,
      memDirty: false, // live memory drifted from store.liveTable (transaction ran)
      maxSteps: 20000,
      byteBudget: 256 * 1024 * 1024,
      warnings: [],
      cachedInspect: new Map(), // "branch:local" -> parsed inspection
      evalResult: null,
      phase: "main",
      recBranch: null, // branch currently being recorded onto
      recPrefixLen: 0, // composite length of the recording branch's prefix
    }
  }

  _newBranch(id, parentId, forkPos, edit) {
    return {
      id,
      parentId,
      forkPos, // local position in the PARENT's chain this branch hangs at
      edit, // the edit source applied at the fork (null = pure replay)
      trace: [], // {l, c, d, entry} — this branch's OWN steps
      console: [], // console entries recorded on this branch (global visibleAt)
      error: null,
      result: null,
      truncated: false,
      forkedAt: null, // global pos of the base state in this branch's composite
    }
  }

  // ---- tree geometry ------------------------------------------------------
  /** root-first segments of a timeline: [{id, upto}] — upto inclusive */
  _segments(bid) {
    const s = this.session
    const segs = []
    let b = s.branches[bid]
    let upto = b.trace.length - 1
    while (b) {
      segs.push({ id: b.id, upto })
      if (b.parentId == null) break
      upto = b.forkPos
      b = s.branches[b.parentId]
    }
    return segs.reverse()
  }

  _compositeLen(bid) {
    let n = 0
    for (const seg of this._segments(bid)) n += seg.upto + 1
    return n
  }

  _prefixLen(bid) {
    return this._compositeLen(bid) - this.session.branches[bid].trace.length
  }

  /** map a global position in `bid`'s composite to the owning (branch, local) */
  _mapGlobal(bid, g) {
    const segs = this._segments(bid)
    let off = 0
    for (const seg of segs) {
      const len = seg.upto + 1
      if (g < off + len) return { branchId: seg.id, local: g - off }
      off += len
    }
    const last = segs[segs.length - 1]
    return { branchId: last.id, local: last.upto }
  }

  _entryAt(g) {
    const s = this.session
    const { branchId, local } = this._mapGlobal(s.view, g)
    return s.branches[branchId].trace[local]
  }

  _composite(bid) {
    const s = this.session
    const cached = s.compCache.get(bid)
    if (cached && cached.v === s.version && s.finished) return cached.arr
    const arr = []
    for (const { id, upto } of this._segments(bid)) {
      const t = s.branches[id].trace
      for (let i = 0; i <= upto; i++) arr.push(t[i])
    }
    if (s.finished) s.compCache.set(bid, { v: s.version, arr })
    return arr
  }

  _consoleComposite(bid) {
    const s = this.session
    const cached = s.consoleCache.get(bid)
    if (cached && cached.v === s.version && s.finished) return cached.arr
    const arr = []
    let off = 0
    for (const { id, upto } of this._segments(bid)) {
      // console entries carry GLOBAL visibleAt stamped at record time; the
      // path up to their branch is fixed at fork creation, so the same
      // coordinate is valid in every descendant composite
      for (const e of s.branches[id].console) if (e.visibleAt <= off + upto) arr.push(e)
      off += upto + 1
    }
    if (s.finished) s.consoleCache.set(bid, { v: s.version, arr })
    return arr
  }

  // ---- hook plumbing ------------------------------------------------------
  _onOut(kind, text) {
    const s = this.session
    if (kind === OUT_CONSOLE) {
      if (this._mode !== "record" || !s.recBranch) return // transactional activations don't append console output
      const visibleAt = s.recPrefixLen + s.recBranch.trace.length
      try {
        const msg = JSON.parse(text)
        s.recBranch.console.push({ visibleAt, level: LEVELS[msg.level] ?? "log", parts: msg.parts })
      } catch {
        s.recBranch.console.push({ visibleAt, level: "log", parts: [{ t: "str", v: text }] })
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
    if (kind === OUT_EVAL_DONE && this._mode === "record" && s.recBranch) {
      try {
        const env = JSON.parse(text)
        if (env && env.error) s.recBranch.error = env.error
        else if (env) s.recBranch.result = env.ok
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
      // Live memory may be parked at any historical position of any branch.
      // Return it to a true end-of-run state (where the program buffer and
      // allocator are consistent with reality) before freeing and resetting.
      if (s0.finished && this._compositeLen(s0.view) > 0) this.positionTo(this._compositeLen(s0.view) - 1)
      if (s0.memDirty) {
        s0.store.heal(this.mem())
        s0.memDirty = false
      }
      this.vm.exports.tt_free(s0.programPtr)
      const rc = this.vm.exports.tt_reset()
      if (rc !== 0) throw new Error(`tt_reset failed: ${rc}`)
    }
    this._resetSession()
    const s = this.session
    if (opts.maxSteps) s.maxSteps = opts.maxSteps
    if (opts.verifyBarrier) s.verifyBarrier = true
    // granularity: "line" (default) or "opcode" — suspend between every two
    // VM instructions of user code
    this.vm.exports.tt_set_granularity(opts.granularity === "opcode" ? 1 : 0)

    // optional HTML document: parsed by the embedded Lexbor into the SAME
    // linear memory, so the DOM+CSSOM time-travels through the ordinary
    // per-step COW snapshots (and forks fork the document)
    if (opts.html != null) {
      const h = this.vm.writeString(String(opts.html))
      const rc = this.vm.exports.tt_dom_load(h.ptr, h.len)
      this.vm.exports.tt_free(h.ptr)
      if (rc !== 0) throw new Error(`tt_dom_load failed: ${rc}`)
    }

    const { ptr, len } = this.vm.writeString(source)
    s.programPtr = ptr
    this._mode = "record"
    s.recBranch = s.branches[0]
    s.recPrefixLen = 0
    this._lastYield = now()
    this._deadline = now() + 2500
    this._onProgress = onProgress

    try {
      const ok = await this._pumpSteps(this.vm.drive("tt_eval", ptr, len), { name: "tt_eval" })
      await this._drainPhases(ok)
    } finally {
      this._mode = "idle"
      this._deadline = Infinity
      this._onProgress = null
    }
    s.finished = true
    s.version++
    const root = s.branches[0]
    s.at = { branchId: 0, local: root.trace.length - 1 }
    s.pos = root.trace.length - 1
    s.recBranch = null
    if (onProgress) onProgress(this.progress())
    return this.summary()
  }

  /**
   * Fork the timeline at `pos` (a global position in the current view):
   * apply an optional edit to the live machine at that moment and let
   * execution CONTINUE from there, recording a NEW timeline. The abandoned
   * future is retained — it stays navigable as a sibling branch sharing
   * every pre-fork page. The new branch hangs off whichever ancestor
   * actually owns the forked step, so forking inside a shared prefix
   * creates true siblings.
   */
  async forkFrom(pos, editSrc = null, onProgress = null) {
    const s = this.session
    if (!s || !s.finished) throw new Error("no finished recording")
    pos = Math.max(0, Math.min(pos, this._compositeLen(s.view) - 1))
    const { branchId: baseBid, local: baseLocal } = this._mapGlobal(s.view, pos)
    const entry = s.branches[baseBid].trace[baseLocal]
    if (!entry.entry) throw new Error("cannot fork at an idle position")

    this.positionTo(pos) // live memory → the base state
    const id = s.branches.length
    const chainId = s.store.newChain()
    if (chainId !== id) throw new Error(`branch/chain id skew: ${id} vs ${chainId}`)
    const nb = this._newBranch(id, baseBid, baseLocal, editSrc == null ? null : String(editSrc))
    nb.forkedAt = pos
    s.branches.push(nb)
    s.view = id
    s.finished = false
    s.recBranch = nb
    s.recPrefixLen = pos + 1

    this._mode = "record"
    this._lastYield = now()
    this._deadline = now() + 2500
    this._onProgress = onProgress
    this.vm.clearDirtyMap()
    try {
      // return-parked fork: the restored memory is the whole machine.
      // Apply the edit with a plain call, then continue with another.
      if (editSrc != null) {
        this.vm.stagedArg = new TextEncoder().encode(String(editSrc))
        this.vm.exports.tt_eval_parked(1)
        // the edit's dirty pages stay marked: they belong to the branch's first delta
      }
      this.vm.adoptSuspension()
      const r = this.vm.resume(STEP_CONTINUE)
      const ok = await this._pumpSteps(r, entry.entry)
      await this._drainPhases(ok)
    } finally {
      this._mode = "idle"
      this._deadline = Infinity
      this._onProgress = null
      this.vm.stagedArg = null
    }
    s.finished = true
    s.version++
    s.at = { branchId: id, local: nb.trace.length - 1 }
    s.pos = s.recPrefixLen + nb.trace.length - 1
    s.recBranch = null
    if (onProgress) onProgress(this.progress())
    return this.summary()
  }

  /** Drive one activation, capturing a COW delta per suspension. */
  async _pumpSteps(r, entryTag) {
    const s = this.session
    const b = s.recBranch
    while (r.suspended) {
      // parked by return: no live wasm activation, no stack pointer —
      // the machine is nothing but memory
      b.trace.push({
        l: this.vm.exports.tt_park_line(),
        c: this.vm.exports.tt_park_col(),
        d: this.vm.exports.tt_park_depth(),
        entry: entryTag,
        k: "r",
      })
      if (b.id === 0 && b.trace.length === 1) {
        // base image: full scan (excluding the barrier's own map region)
        this.vm.clearDirtyMap()
        s.store.capture(this.mem(), 0, [this.vm.mapExclusion()])
      } else {
        s.store.captureFrom(this.mem(), this.vm.readAndClearDirtyPages(), 0, b.id)
      }
      if (s.verifyBarrier) {
        const bad = s.store.audit(this.mem(), [this.vm.mapExclusion()])
        if (bad.length)
          s.warnings.push(`barrier missed pages at step ${s.recPrefixLen + b.trace.length - 1}: ${bad.slice(0, 8).join(",")}`)
      }
      if (s.recPrefixLen + b.trace.length >= s.maxSteps || s.store.poolBytes > s.byteBudget) {
        b.truncated = true
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
    const b = s.recBranch
    let rounds = 0
    while (ok && !b.truncated && rounds++ < 10000) {
      if (this.vm.exports.tt_pending_jobs()) {
        ok = await this._pumpSteps(this.vm.drive("tt_run_jobs"), { name: "tt_run_jobs", args: [] })
        continue
      }
      if (this.vm.exports.tt_timer_count() > 0) {
        b.trace.push({ l: 0, c: 0, d: 0, entry: null, timer: true })
        s.store.captureFrom(this.mem(), this.vm.readAndClearDirtyPages(), 1, b.id)
        ok = await this._pumpSteps(this.vm.drive("tt_fire_timer"), { name: "tt_fire_timer", args: [] })
        continue
      }
      break
    }
    if (ok) {
      b.trace.push({ l: 0, c: 0, d: 0, entry: null, end: true })
      s.store.captureFrom(this.mem(), this.vm.readAndClearDirtyPages(), 2, b.id)
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
  /** Move the debugger position within the view timeline. O(deltas walked). */
  positionTo(target) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    const len = this._compositeLen(s.view)
    target = Math.max(0, Math.min(target, len - 1))
    const { branchId, local } = this._mapGlobal(s.view, target)
    this._navigateTo(branchId, local)
    s.pos = target
    return target
  }

  /**
   * Move the LIVE memory to state (branch, local) — the tree walk. Undo the
   * current path up to the lowest common ancestor, move within it, redo down
   * the target path. Every transition is a recorded delta applied in the
   * direction it was captured; crossing a fork boundary is exact because a
   * branch's first delta was captured against the parent state it hangs at.
   */
  _navigateTo(tb, tl) {
    const s = this.session
    const mem = this.mem()
    if (s.memDirty) {
      s.store.heal(mem)
      s.memDirty = false
    }
    const pathOf = (bid, local) => {
      const arr = []
      let b = s.branches[bid]
      let p = local
      while (b) {
        arr.push({ id: b.id, pos: p })
        p = b.forkPos
        b = b.parentId != null ? s.branches[b.parentId] : null
      }
      return arr.reverse() // root-first
    }
    const A = pathOf(s.at.branchId, s.at.local)
    const B = pathOf(tb, tl)
    let k = 0
    while (k + 1 < A.length && k + 1 < B.length && A[k + 1].id === B[k + 1].id) k++
    // undo the tail of the current path above the common branch
    for (let lvl = A.length - 1; lvl > k; lvl--) {
      const { id, pos } = A[lvl]
      for (let i = pos; i >= 0; i--) s.store.applyBackward(i, mem, id)
    }
    // move within the common branch
    let cur = A[k].pos
    const want = B[k].pos
    while (cur < want) s.store.applyForward(++cur, mem, A[k].id)
    while (cur > want) s.store.applyBackward(cur--, mem, A[k].id)
    // redo down into the target path
    for (let lvl = k + 1; lvl < B.length; lvl++) {
      const { id, pos } = B[lvl]
      for (let i = 0; i <= pos; i++) s.store.applyForward(i, mem, id)
    }
    s.at = { branchId: tb, local: tl }
  }

  // ---- the multiverse -----------------------------------------------------
  /** All live timelines, root-first, with tree metadata. */
  timelines() {
    const s = this.session
    const depth = new Map()
    const out = []
    for (const b of s.branches) {
      if (!b) continue
      depth.set(b.id, b.parentId == null ? 0 : depth.get(b.parentId) + 1)
      out.push({
        id: b.id,
        parentId: b.parentId,
        depth: depth.get(b.id),
        forkedAt: b.forkedAt,
        edit: b.edit,
        steps: this._compositeLen(b.id),
        error: b.error,
        truncated: b.truncated,
        current: b.id === s.view,
      })
    }
    return out
  }

  /** Present another timeline through the linear trace/pos API. */
  switchTo(branchId, pos = null) {
    const s = this.session
    if (!s.finished) throw new Error("recording in progress")
    if (!s.branches[branchId]) throw new Error(`no timeline ${branchId}`)
    s.view = branchId
    return this.positionTo(pos == null ? this._compositeLen(branchId) - 1 : pos)
  }

  /** Delete a timeline and its descendants; their pages are freed. */
  pruneBranch(branchId) {
    const s = this.session
    if (!s.finished) throw new Error("recording in progress")
    if (branchId === 0) throw new Error("cannot prune the root timeline")
    const doomed = s.branches[branchId]
    if (!doomed) throw new Error(`no timeline ${branchId}`)
    const dead = new Set([branchId])
    let grew = true
    while (grew) {
      grew = false
      for (const b of s.branches) {
        if (b && b.parentId != null && dead.has(b.parentId) && !dead.has(b.id)) {
          dead.add(b.id)
          grew = true
        }
      }
    }
    // move the live state and the view off the doomed subtree first: the
    // pruned branch's base state survives on its parent
    if (dead.has(s.view) || dead.has(s.at.branchId)) {
      this._navigateTo(doomed.parentId, doomed.forkPos)
      s.view = doomed.parentId
      s.pos = this._prefixLen(doomed.parentId) + doomed.forkPos
    }
    for (const id of dead) s.branches[id] = null
    s.store.prune(dead)
    s.cachedInspect.clear()
    s.version++
    return [...dead]
  }

  /**
   * BFS across the multiverse: evaluate `expr` at every recorded state of
   * every timeline — shared prefixes are visited exactly once, at the
   * branch that owns them; breadth-first by fork depth, then creation
   * order. Returns truthy hits as {branch, pos, local, value}, where pos
   * is a global position valid after switchTo(branch).
   */
  searchAll(expr, { limit = 200, branch = null } = {}) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    const saveView = s.view
    const savePos = s.pos
    const alive = s.branches.filter(Boolean)
    const depth = new Map()
    for (const b of alive) depth.set(b.id, b.parentId == null ? 0 : depth.get(b.parentId) + 1)
    const order =
      branch != null
        ? [s.branches[branch]].filter(Boolean)
        : alive.slice().sort((a, b) => depth.get(a.id) - depth.get(b.id) || a.id - b.id)
    const hits = []
    let visited = 0
    let errors = 0
    try {
      outer: for (const b of order) {
        const prefix = this._prefixLen(b.id)
        s.view = b.id
        for (let local = 0; local < b.trace.length; local++) {
          this.positionTo(prefix + local)
          const r = this.consoleEval(expr)
          visited++
          if (r.error) {
            errors++
            continue
          }
          if (envTruthy(r.value)) {
            hits.push({ branch: b.id, pos: prefix + local, local, value: r.value })
            if (hits.length >= limit) break outer
          }
        }
      }
    } finally {
      s.view = saveView
      this.positionTo(savePos)
    }
    return { hits, visited, errors }
  }

  /**
   * "What would have happened if?" — the counterfactual frontier. Fork the
   * SAME moment once per candidate edit (breadth-first level of the tree),
   * record each hypothetical future, and report the outcomes side by side.
   * With `probe`, the expression is evaluated at each new timeline's end;
   * with `scan`, also BFS-scan the new timeline for the FIRST state where
   * the probe turns truthy. All timelines stay recorded and jumpable; the
   * view returns to where it was.
   */
  async whatIf(pos, edits, { probe = null, scan = false, onProgress = null } = {}) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    const saveView = s.view
    const savePos = s.pos
    pos = Math.max(0, Math.min(pos, this._compositeLen(saveView) - 1))
    const out = []
    try {
      for (const edit of edits) {
        s.view = saveView // every hypothesis forks the SAME state
        const summary = await this.forkFrom(pos, edit, onProgress)
        const rec = {
          edit: edit == null ? null : String(edit),
          branch: s.view,
          forkedAt: pos,
          steps: summary.steps,
          error: summary.error,
          result: summary.result,
          truncated: summary.truncated,
        }
        if (probe != null) {
          this.positionTo(summary.steps - 1)
          const r = this.consoleEval(probe)
          rec.probe = r.error ? { error: r.error } : { value: r.value }
          if (scan) {
            const found = this.searchAll(probe, { branch: rec.branch, limit: 1 })
            rec.firstTrue = found.hits.length ? found.hits[0].pos : null
          }
        }
        out.push(rec)
      }
    } finally {
      s.view = saveView
      this.positionTo(savePos)
    }
    return out
  }

  /**
   * Candidate web-platform API calls for the CURRENT moment, read off the
   * live document itself: events that actually have listeners registered
   * right now, classes the stylesheets define, classes present in the
   * tree, elements addressable by id. These are the raw material for
   * explore() — each is a real call that COULD have been made here.
   */
  suggestEdits(pos = null, { limit = 12 } = {}) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    const savePos = s.pos
    if (pos != null) this.positionTo(pos)
    try {
      const fetch = (expr) => {
        const r = this.consoleEval(expr)
        if (r.error || !r.value || r.value.t !== "str" || r.value.trunc) return null
        try {
          return JSON.parse(r.value.v)
        } catch {
          return null
        }
      }
      const hasDoc = fetch(`JSON.stringify(typeof document !== "undefined")`)
      if (hasDoc !== true) throw new Error("suggestEdits reads the live document — pass explicit candidates instead")
      const ids = fetch(`JSON.stringify([...document.querySelectorAll("[id]")].slice(0, 8).map((e) => e.id))`) ?? []
      const evTypes = fetch(`JSON.stringify(document.__eventTypes.slice(0, 6))`) ?? []
      const cssClasses =
        fetch(
          `JSON.stringify((() => { const s = new Set(); for (const st of document.querySelectorAll("style")) for (const m of st.textContent.match(/\\.[A-Za-z_][A-Za-z0-9_-]*/g) || []) s.add(m.slice(1)); return [...s].slice(0, 6); })())`,
        ) ?? []
      const docClasses =
        fetch(
          `JSON.stringify((() => { const s = new Set(); for (const e of document.querySelectorAll("*")) for (const c of e.classList) s.add(c); return [...s].slice(0, 6); })())`,
        ) ?? []
      const out = []
      const seen = new Set()
      const push = (c) => {
        if (!seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
      }
      const q = (id) => `document.getElementById(${JSON.stringify(id)})`
      // behavioral first: events someone is actually listening for
      for (const id of ids) for (const t of evTypes) push(`${q(id)}.dispatchEvent(new Event(${JSON.stringify(t)}, { bubbles: true }))`)
      // styling: classes the CSS knows about, on and off
      for (const id of ids) for (const c of cssClasses) push(`${q(id)}.classList.add(${JSON.stringify(c)})`)
      for (const id of ids) for (const c of docClasses) push(`${q(id)}.classList.remove(${JSON.stringify(c)})`)
      // structure last
      for (const id of ids) push(`${q(id)}.remove()`)
      return out.slice(0, limit)
    } finally {
      this.positionTo(savePos)
    }
  }

  /**
   * BFS constraint search over the multiverse: learn how the web platform
   * API could have been used HERE to make `goal` true. Level 1 forks one
   * timeline per candidate call; deeper levels compose calls — "call A,
   * let the future play out, then call B" — by forking each surviving
   * hypothesis at its last parked moment. Candidates come from
   * suggestEdits() (the live document of the state being extended) unless
   * given explicitly. Every returned example is execution-verified: a
   * real recorded timeline whose future satisfies the goal, jumpable via
   * switchTo(example.branch, example.firstTrue). Timelines that satisfied
   * nothing are pruned (keep: "all" retains them).
   */
  async explore(pos, { goal, candidates = null, depth = 2, beam = 6, maxBranches = 48, keep = "examples", onProgress = null } = {}) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    if (!goal) throw new Error("explore needs a goal expression")
    const saveView = s.view
    const savePos = s.pos
    pos = Math.max(0, Math.min(pos ?? savePos, this._compositeLen(saveView) - 1))
    while (pos > 0 && !this._entryAt(pos)?.entry) pos-- // hypotheses need a parked machine
    if (!this._entryAt(pos)?.entry) throw new Error("no parked step to explore from")

    this.positionTo(pos)
    const g0 = this.consoleEval(goal)
    if (!g0.error && envTruthy(g0.value)) {
      this.positionTo(savePos)
      return { alreadyTrue: true, examples: [], explored: 0, pruned: 0, budgetHit: false }
    }

    const created = []
    const examples = []
    let explored = 0
    let budgetHit = false
    // a frontier node = where to fork (anchor) + edits to re-apply there
    // (`prefix`) + the human-readable call sequence so far (`path`)
    let frontier = [{ branch: saveView, pos, prefix: [], path: [] }]
    try {
      for (let level = 1; level <= depth && frontier.length && !budgetHit; level++) {
        const next = []
        for (const node of frontier) {
          if (budgetHit) break
          let cands = candidates
          if (!cands) {
            this.switchTo(node.branch, node.pos)
            cands = this.suggestEdits(null, { limit: 12 })
          }
          for (const edit of cands) {
            if (explored >= maxBranches) {
              budgetHit = true
              break
            }
            s.view = node.branch
            const summary = await this.forkFrom(node.pos, [...node.prefix, edit].join("; "))
            const b = s.view
            created.push(b)
            explored++
            this.positionTo(summary.steps - 1)
            const g = this.consoleEval(goal)
            const satisfied = !g.error && envTruthy(g.value)
            const path = [...node.path, edit]
            if (satisfied) {
              const scan = this.searchAll(goal, { branch: b, limit: 1 })
              examples.push({
                path,
                branch: b,
                steps: summary.steps,
                error: summary.error,
                firstTrue: scan.hits.length ? scan.hits[0].pos : null,
                goal: g.value,
              })
            } else if (!summary.error && level < depth) {
              // extend from this hypothesis' last parked moment — a state that
              // CONTAINS the edit. If its whole remaining future ran without
              // parking (nothing left to interleave), compose the next call
              // back-to-back at the same anchor instead: "A; B".
              let p = summary.steps - 1
              while (p > summary.forkedAt && !this._entryAt(p)?.entry) p--
              if (p > summary.forkedAt && this._entryAt(p)?.entry)
                next.push({ branch: b, pos: p, prefix: [], path })
              else next.push({ branch: node.branch, pos: node.pos, prefix: [...node.prefix, edit], path })
            }
            if (onProgress) onProgress({ level, explored, found: examples.length })
          }
        }
        frontier = next.slice(0, beam)
      }
    } finally {
      s.view = saveView
      this.positionTo(savePos)
    }
    let pruned = 0
    if (keep === "examples") {
      const keepSet = new Set()
      for (const ex of examples) {
        let b = s.branches[ex.branch]
        while (b) {
          keepSet.add(b.id)
          b = b.parentId != null ? s.branches[b.parentId] : null
        }
      }
      for (const id of created) if (s.branches[id] && !keepSet.has(id)) pruned += this.pruneBranch(id).length
    }
    return { alreadyTrue: false, examples, explored, pruned, budgetHit }
  }

  // ---- transactional inspection / evaluation ------------------------------
  /**
   * Inspect the current position: restores its state, rewinds the VM into
   * the suspension, runs the in-VM inspector, aborts the activation.
   */
  inspect() {
    const s = this.session
    if (!s.finished) return null
    const { branchId, local } = this._mapGlobal(s.view, s.pos)
    const key = branchId + ":" + local
    const cached = s.cachedInspect.get(key)
    if (cached) return cached
    const entry = s.branches[branchId].trace[local]
    let parsed = { stack: [], frames: [], globals: [] }
    this._transact = { inspect: null }
    this._deadline = now() + 3000
    try {
      this.positionTo(s.pos)
      this.vm.clearDirtyMap()
      if (entry.k === "r") {
        // return-parked position: the restored memory IS the parked machine —
        // walk its live frames with a plain call, repeatably.
        this.vm.exports.tt_inspect_parked()
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
    s.cachedInspect.set(key, parsed)
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
    const entry = this._entryAt(s.pos)
    this._transact = { evalResult: null }
    this.vm.stagedArg = new TextEncoder().encode(String(src))
    this._deadline = now() + 3000
    try {
      this.positionTo(s.pos)
      this.vm.clearDirtyMap()
      if (entry.k === "r") {
        this.vm.exports.tt_eval_parked(0)
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
    const steps = s.recBranch ? s.recPrefixLen + s.recBranch.trace.length : this._compositeLen(s.view)
    return {
      steps,
      checkpoints: s.store.count,
      memBytes: this.vm.memory.buffer.byteLength,
      cow: s.store.stats(),
    }
  }

  _compositeDirty(bid) {
    const s = this.session
    const arr = []
    for (const { id, upto } of this._segments(bid)) {
      const counts = s.store.dirtyCounts(id)
      for (let i = 0; i <= upto; i++) arr.push(counts[i])
    }
    return arr
  }

  summary() {
    const s = this.session
    const b = s.branches[s.view]
    return {
      steps: this._compositeLen(s.view),
      truncated: b.truncated,
      warnings: s.warnings,
      error: b.error,
      result: b.result,
      cow: s.store.stats(),
      suppressedSteps: this.vm.exports.tt_suppressed(),
      forkedAt: b.forkedAt ?? null,
      branch: b.id,
      branches: s.branches.filter(Boolean).length,
      dirtyCounts: this._compositeDirty(s.view),
      pageHeat: [...s.store.pageHeat.entries()],
      memBytes: this.vm.memory.buffer.byteLength,
    }
  }

  get trace() {
    const s = this.session
    if (!s) return []
    if (s.branches.length === 1) return s.branches[0].trace
    return this._composite(s.view)
  }
  get pos() {
    return this.session ? this.session.pos : 0
  }
  get branch() {
    return this.session ? this.session.view : 0
  }
  get consoleEntries() {
    const s = this.session
    if (!s) return []
    if (s.branches.length === 1) return s.branches[0].console
    return this._consoleComposite(s.view)
  }
}
