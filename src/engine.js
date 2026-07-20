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

/**
 * Goal specs: a bare expression, a list (all must hold), or
 * {all: [...], any: [...], none: [...]} — real invariants are usually
 * several constraints, so every evaluation reports per-constraint detail.
 */
const normGoal = (goal) =>
  typeof goal === "string"
    ? { all: [goal], any: [], none: [] }
    : Array.isArray(goal)
      ? { all: goal, any: [], none: [] }
      : { all: goal.all ?? [], any: goal.any ?? [], none: goal.none ?? [] }

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

    s.source = String(source)
    s.url = opts.url != null ? String(opts.url) : "https://example.test/"
    // optional URL: the program reads its parameters off `location` /
    // URLSearchParams — self-hosted IN the machine, so the URL (and what
    // was read from it) snapshots and forks with everything else
    if (opts.url != null) {
      const u = this.vm.writeString(String(opts.url))
      const rc = this.vm.exports.tt_set_url(u.ptr, u.len)
      this.vm.exports.tt_free(u.ptr)
      if (rc !== 0) throw new Error(`invalid url: ${opts.url}`)
    }

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
      const hasDoc = fetch(`JSON.stringify(typeof document !== "undefined")`) === true
      const out = []
      const seen = new Set()
      const push = (c) => {
        if (!seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
      }
      const q = (id) => `document.getElementById(${JSON.stringify(id)})`
      let ids = []
      if (hasDoc) {
        ids = fetch(`JSON.stringify([...document.querySelectorAll("[id]")].slice(0, 8).map((e) => e.id))`) ?? []
        const evTypes = fetch(`JSON.stringify(document.__eventTypes.slice(0, 6))`) ?? []
        const cssClasses =
          fetch(
            `JSON.stringify((() => { const s = new Set(); for (const st of document.querySelectorAll("style")) for (const m of st.textContent.match(/\\.[A-Za-z_][A-Za-z0-9_-]*/g) || []) s.add(m.slice(1)); return [...s].slice(0, 6); })())`,
          ) ?? []
        const docClasses =
          fetch(
            `JSON.stringify((() => { const s = new Set(); for (const e of document.querySelectorAll("*")) for (const c of e.classList) s.add(c); return [...s].slice(0, 6); })())`,
          ) ?? []
        // behavioral first: events someone is actually listening for
        for (const id of ids) for (const t of evTypes) push(`${q(id)}.dispatchEvent(new Event(${JSON.stringify(t)}, { bubbles: true }))`)
        // styling: classes the CSS knows about, on and off
        for (const id of ids) for (const c of cssClasses) push(`${q(id)}.classList.add(${JSON.stringify(c)})`)
        for (const id of ids) for (const c of docClasses) push(`${q(id)}.classList.remove(${JSON.stringify(c)})`)
      }
      // unused logic: a registered message handler that no message ever
      // reached is a dormant feature — probe the channel (exploreParams
      // learns real payloads from the handler's own comparisons)
      const msg = fetch(`JSON.stringify(typeof __messageStats === "function" ? __messageStats() : null)`)
      if (msg && msg.handlers > 0 && msg.posted === 0)
        push(`postMessage("ttprobe0"); postMessage(__msgProbe("ttprobe0"))`)
      // shared state: storage keys the program actually consulted (each
      // storage object keeps its own read registry), with values LEARNED
      // from the run itself — the comparison journal holds what each read
      // was tested against ("plain" === "fancy" teaches "fancy"), so
      // suggestions are values the code demonstrably reacts to
      let journal = null
      for (const store of ["localStorage", "sessionStorage"]) {
        const storKeys = fetch(`JSON.stringify(${store}.__reads.slice(0, 6))`) ?? []
        if (!storKeys.length) continue
        journal ??= this.comparisons()
        for (const k of storKeys) {
          const asRun = fetch(`JSON.stringify(${store}.getItem(${JSON.stringify(k)}))`)
          const attributed = journal.filter((e) => e.a === asRun || e.b === asRun).map((e) => (e.a === asRun ? e.b : e.a))
          const pool = attributed.length ? attributed : journal.flatMap((e) => [e.a, e.b])
          const vals = [...new Set(pool)]
            .filter((v) => v.length >= 1 && v.length <= 32 && v !== asRun && !storKeys.includes(v))
            .slice(0, 3)
          for (const v of vals) push(`${store}.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`)
        }
        for (const k of storKeys) push(`${store}.removeItem(${JSON.stringify(k)})`)
      }
      // structure last
      for (const id of ids) push(`${q(id)}.remove()`)
      if (!out.length)
        throw new Error("nothing observable to suggest — no document and no storage reads; pass explicit candidates")
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
    if (!goal) throw new Error("explore needs a goal")
    const spec = normGoal(goal)
    const goalX = this._goalExpr(spec)
    const saveView = s.view
    const savePos = s.pos
    pos = Math.max(0, Math.min(pos ?? savePos, this._compositeLen(saveView) - 1))
    while (pos > 0 && !this._entryAt(pos)?.entry) pos-- // hypotheses need a parked machine
    if (!this._entryAt(pos)?.entry) throw new Error("no parked step to explore from")

    this.positionTo(pos)
    const g0 = this._evalGoal(spec)
    if (g0.ok) {
      this.positionTo(savePos)
      return { alreadyTrue: true, examples: [], explored: 0, pruned: 0, budgetHit: false, baseline: g0.detail }
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
            const g = this._evalGoal(spec)
            const satisfied = g.ok
            const path = [...node.path, edit]
            if (satisfied) {
              const scan = this.searchAll(goalX, { branch: b, limit: 1 })
              examples.push({
                path,
                branch: b,
                steps: summary.steps,
                error: summary.error,
                firstTrue: scan.hits.length ? scan.hits[0].pos : null,
                goals: g.detail,
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

  /** Evaluate a goal spec at the current position — per-constraint detail. */
  _evalGoal(spec) {
    const detail = []
    const truthyOf = (expr) => {
      const r = this.consoleEval(expr)
      return { truthy: !r.error && envTruthy(r.value), error: r.error ?? null, value: r.value ?? null }
    }
    let ok = true
    for (const expr of spec.all) {
      const t = truthyOf(expr)
      detail.push({ expr, kind: "all", ok: t.truthy, value: t.value, error: t.error })
      if (!t.truthy) ok = false
    }
    if (spec.any.length) {
      let some = false
      for (const expr of spec.any) {
        const t = truthyOf(expr)
        detail.push({ expr, kind: "any", ok: t.truthy, value: t.value, error: t.error })
        if (t.truthy) some = true
      }
      if (!some) ok = false
    }
    for (const expr of spec.none) {
      const t = truthyOf(expr)
      detail.push({ expr, kind: "none", ok: !t.truthy, value: t.value, error: t.error })
      if (t.truthy) ok = false
    }
    return { ok, detail }
  }

  /** One boolean expression equivalent to the whole spec (for scans). */
  _goalExpr(spec) {
    const parts = spec.all.map((e) => `(${e})`)
    if (spec.any.length) parts.push(`(${spec.any.map((e) => `(${e})`).join(" || ")})`)
    for (const e of spec.none) parts.push(`!(${e})`)
    return parts.join(" && ") || "true"
  }

  /**
   * The comparison journal at the current position: every string
   * comparison the recorded program performed up to this moment — `===`,
   * includes, startsWith, endsWith, indexOf — as {op, a, b}. The journal
   * lives inside the machine's linear memory, so it rewinds, forks and
   * prunes with everything else: at a fork's end it holds exactly that
   * alternate run's comparisons, and transactional goal evaluations heal
   * away without polluting it. This is how the debugger LEARNS values by
   * running code branches instead of guessing them.
   */
  comparisons() {
    const s = this.session
    if (!s.finished) return []
    try {
      this.positionTo(s.pos)
      this.vm.clearDirtyMap()
      const ptr = this.vm.exports.tt_cmp_json()
      let out = []
      if (ptr) {
        const mem = this.mem()
        let end = ptr
        while (mem[end] !== 0) end++
        const text = new TextDecoder().decode(mem.subarray(ptr, end))
        this.vm.exports.tt_free(ptr)
        const OPS = ["eq", "includes", "startsWith", "endsWith", "indexOf"]
        out = JSON.parse(text).map(([op, a, b]) => ({ op: OPS[op] ?? "eq", a, b }))
      }
      this._healTransaction()
      return out
    } catch (e) {
      this.vm.normalize()
      s.memDirty = true
      return []
    }
  }

  /**
   * Concolic search over the program's external inputs: find the URL
   * parameter, storage value or postMessage payload that leads to an
   * outcome — "which ?param enables this feature?", "what message wakes
   * this handler?" Nothing is guessed from source text: every candidate
   * VALUE is learned by running code branches. A canary probe forks a
   * full alternate run per input (from the EARLIEST parked step, before
   * anything was read); the machine's comparison journal then reports
   * what that run tested the input against — equals "solar", startsWith
   * "pref:" — and each observation becomes the next, better-shaped
   * candidate, so required formats compose across rounds: probe →
   * "pref:<canary>" → "pref:gold". Message probes deliver a recording
   * payload whose property reads return marked strings, so object
   * protocols reveal their keys ({type:"sync"}, then {type:"sync",
   * mode:"fast"}) the same way. Attribution is case-insensitive — a
   * program that upper/lower-cases its input before comparing still
   * carries the canary, and the learned constant is emitted in both its
   * literal and lower-case spellings so the goal picks the raw form it
   * needs. The input set itself is dynamic: registries are re-read at
   * every fork's end, so a storage key or message handler consulted only
   * inside a branch some candidate unlocked joins the search mid-flight,
   * with the unlocking assignments re-applied as context for all its own
   * candidates. The debugger also learns from unused logic: inputs whose
   * handlers never fired as-run are probed first, children of runs that
   * executed lines the original recording never reached explore first,
   * and `unlocked` reports which inputs woke dormant code. Every example
   * is execution-verified and jumpable via switchTo(example.branch,
   * example.firstTrue).
   */
  async exploreParams({
    goal,
    params = null,
    extraValues = [],
    rounds = 4,
    maxBranches = 48,
    pairTop = 4,
    keep = "examples",
    onProgress = null,
  } = {}) {
    const s = this.session
    if (!s.finished) throw new Error("no finished recording")
    if (!goal) throw new Error("exploreParams needs a goal")
    const spec = normGoal(goal)
    const goalX = this._goalExpr(spec)
    const saveView = s.view
    const savePos = s.pos
    const len = this._compositeLen(saveView)

    // the program as-run: constraint status + observed reads live at the END
    this.positionTo(len - 1)
    const base = this._evalGoal(spec)
    if (base.ok) {
      this.positionTo(savePos)
      return { alreadyTrue: true, examples: [], explored: 0, pruned: 0, budgetHit: false, baseline: base.detail }
    }
    const fetch = (expr) => {
      const r = this.consoleEval(expr)
      if (r.error || r.value?.t !== "str" || r.value.trunc) return null
      try {
        return JSON.parse(r.value.v)
      } catch {
        return null
      }
    }

    // ---- inputs: every external channel the program demonstrably consulted
    const observed = fetch(`JSON.stringify(location.__paramReads.slice(0, 12))`) ?? []
    const baseSearch = fetch(`JSON.stringify(location.search)`) ?? ""
    const msgStats = fetch(`JSON.stringify(typeof __messageStats === "function" ? __messageStats() : null)`)
    const inputs = []
    for (const k of (params ?? observed).slice(0, 8)) inputs.push({ kind: "param", key: k })
    if (!params) {
      for (const store of ["localStorage", "sessionStorage"])
        for (const k of fetch(`JSON.stringify(${store}.__reads.slice(0, 6))`) ?? []) inputs.push({ kind: "storage", key: k, store })
      if (msgStats && msgStats.handlers > 0) inputs.push({ kind: "message", key: null, neverFired: msgStats.posted === 0 })
    }
    if (!inputs.length) {
      this.positionTo(savePos)
      throw new Error("the program consulted no URL parameters, storage keys or message handlers — pass {params: [...]}")
    }
    // unused logic first: a handler no message ever reached is a dormant
    // feature — probing it is the most promising place to start
    inputs.sort((a, b) => (b.neverFired ? 1 : 0) - (a.neverFired ? 1 : 0))
    for (const inp of inputs) {
      inp.asRun =
        inp.kind === "param"
          ? fetch(`JSON.stringify(new URLSearchParams(location.search).get(${JSON.stringify(inp.key)}))`)
          : inp.kind === "storage"
            ? fetch(`JSON.stringify(${inp.store}.getItem(${JSON.stringify(inp.key)}))`)
            : null
    }
    // the base run's own journal seeds round 0 for free: everything the
    // program compared its real inputs against, before a single fork
    const baseJournal = this.comparisons()
    const baseLines = new Set()
    for (const e of this.trace) if (e.entry && e.l > 0) baseLines.add(e.l)

    // the anchor: the earliest parked step — inputs change before any read
    let anchor = 0
    while (anchor < len - 1 && !this._entryAt(anchor)?.entry) anchor++
    if (!this._entryAt(anchor)?.entry) throw new Error("no parked step to fork from")

    const basePairs = []
    {
      const qs = String(baseSearch).replace(/^\?/, "")
      if (qs)
        for (const part of qs.split("&")) {
          if (!part) continue
          const i = part.indexOf("=")
          basePairs.push([decodeURIComponent(i < 0 ? part : part.slice(0, i)), i < 0 ? "" : decodeURIComponent(part.slice(i + 1))])
        }
    }
    const searchWith = (overrides) => {
      const pairs = basePairs.map((p) => p.slice())
      for (const [k, v] of overrides) {
        const at = pairs.findIndex((p) => p[0] === k)
        if (at >= 0) pairs[at] = [k, v]
        else pairs.push([k, v])
      }
      return "?" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    }
    const satCount = (detail) => detail.filter((d) => d.ok).length
    const CAP = 128
    const canary = (i) => `ttc${i}z`

    const editFor = (assignments) => {
      const parts = []
      const paramPairs = assignments.filter((a) => a.kind === "param").map((a) => [a.key, a.value])
      if (paramPairs.length) parts.push(`location.search = ${JSON.stringify(searchWith(paramPairs))}`)
      for (const a of assignments) {
        if (a.kind === "storage") parts.push(`${a.store ?? "localStorage"}.setItem(${JSON.stringify(a.key)}, ${JSON.stringify(a.value)})`)
        else if (a.kind === "message") {
          if (a.probe) parts.push(`postMessage(${JSON.stringify(a.marker)}); postMessage(__msgProbe(${JSON.stringify(a.marker)}))`)
          else if (a.oprobe) parts.push(`postMessage(__msgProbe(${JSON.stringify(a.marker)}, ${a.overrides}))`)
          else parts.push(`postMessage(${a.value})`)
        }
      }
      return parts.join("; ")
    }

    const created = []
    const examples = []
    const singles = []
    const unlocked = []
    const learned = []
    const learnedSeen = new Set()
    const tried = inputs.map(() => new Set())
    const MAXI = 12
    const inputKeyOf = (x) => x.kind + "\0" + (x.key ?? "") + "\0" + (x.store ?? "")
    const known = new Set(inputs.map(inputKeyOf))
    let explored = 0
    let budgetHit = false
    let round = 0

    const runCandidate = async (assignments, wantJournal) => {
      s.view = saveView
      const edit = editFor(assignments)
      const summary = await this.forkFrom(anchor, edit)
      const b = s.view
      created.push(b)
      explored++
      this.positionTo(summary.steps - 1)
      const g = this._evalGoal(spec)
      // unused logic: lines this alternate run executed that the original
      // recording never reached — evidence the input woke dormant code
      const nl = new Set()
      for (const e of s.branches[b].trace) if (e.entry && e.l > 0 && !baseLines.has(e.l)) nl.add(e.l)
      const newLines = [...nl].sort((x, y) => x - y)
      const rec = {
        assignments: assignments.map((a) => ({
          kind: a.kind,
          key: a.key ?? null,
          ...(a.store ? { store: a.store } : {}),
          value: a.kind === "message" && a.probe ? "(probe)" : a.kind === "message" && a.oprobe ? `(probe ${a.overrides})` : a.value,
          via: a.via ?? [],
        })),
        edit,
        branch: b,
        steps: summary.steps,
        error: summary.error,
        goals: g.detail,
        satisfied: g.ok,
        newLines,
      }
      if (assignments.some((a) => a.probe || a.oprobe)) rec.probe = true
      const paramPairs = assignments.filter((a) => a.kind === "param").map((a) => [a.key, a.value])
      if (paramPairs.length) {
        rec.params = Object.fromEntries(paramPairs)
        rec.search = searchWith(paramPairs)
      }
      if (newLines.length) unlocked.push({ lines: newLines.slice(0, 16), assignments: rec.assignments, branch: b, satisfied: g.ok })
      if (g.ok) {
        const scan = this.searchAll(goalX, { branch: b, limit: 1 })
        rec.firstTrue = scan.hits.length ? scan.hits[0].pos : null
        examples.push(rec)
      }
      // dynamic discovery: an alternate run may consult inputs the original
      // recording never touched — a read sitting behind the very branch this
      // candidate unlocked. Re-read the registries at this fork's end and
      // let every new channel join the search, carrying the assignments
      // that revealed it as required context for all its own candidates.
      const fresh = []
      if (wantJournal && inputs.length < MAXI) {
        const seen = (fetch(`JSON.stringify(location.__paramReads.slice(0, 12))`) ?? []).map((k) => ({ kind: "param", key: k }))
        for (const store of ["localStorage", "sessionStorage"])
          for (const k of fetch(`JSON.stringify(${store}.__reads.slice(0, 8))`) ?? []) seen.push({ kind: "storage", key: k, store })
        const ms = fetch(`JSON.stringify(typeof __messageStats === "function" ? __messageStats() : null)`)
        if (ms && ms.handlers > 0) seen.push({ kind: "message", key: null, neverFired: ms.posted === 0 })
        for (const cand of seen) {
          if (inputs.length >= MAXI) break
          if (cand.key != null && /ttc\d+z/i.test(cand.key)) continue // our own canary echoed back as a key
          const ik = inputKeyOf(cand)
          if (known.has(ik)) continue
          known.add(ik)
          cand.discovered = true
          cand.under = edit
          cand.ctx = assignments.map((a) => ({
            kind: a.kind,
            key: a.key ?? null,
            store: a.store ?? null,
            value: a.value,
            probe: !!a.probe,
            oprobe: !!a.oprobe,
            overrides: a.overrides ?? null,
            marker: a.marker ?? null,
          }))
          cand.asRun = cand.kind === "param" ? (basePairs.find((p) => p[0] === cand.key)?.[1] ?? null) : null
          const idx = inputs.length
          inputs.push(cand)
          tried.push(new Set())
          if (cand.asRun != null) tried[idx].add(String(cand.asRun))
          fresh.push(idx)
        }
      }
      const journal = wantJournal && !g.ok ? this.comparisons() : []
      if (onProgress) onProgress({ explored, found: examples.length, round })
      return { rec, journal, fresh }
    }

    // ---- concolic derivation: a node is a candidate value for one input,
    // carrying the marker to look for in the journal and its provenance
    const deriveFrom = (journal, node) => {
      const inp = inputs[node.i]
      const m = node.marker
      const kids = []
      if (!m || !journal.length) return kids
      const mprobe = inp.kind === "message" && (node.probe || node.oprobe)
      const inj = node.probe && inp.kind === "message" ? m : node.oprobe ? node.overrides : node.value
      const wrapVal = (raw) => (node.probe && inp.kind === "message" ? JSON.stringify(raw) : raw)
      const seenKid = new Set()
      const emit = (value, marker, viaAdd) => {
        if (value == null || value.length > CAP || seenKid.has(value)) return
        if (inp.kind === "message") {
          try {
            JSON.parse(value)
          } catch {
            return
          }
        }
        if (marker != null && !value.includes(marker)) marker = null
        seenKid.add(value)
        const via = [...node.via, ...viaAdd].slice(-8)
        kids.push({ i: node.i, value, marker, via })
        const lk = inp.kind + "\0" + (inp.key ?? "") + "\0" + (inp.store ?? "") + "\0" + value
        if (!learnedSeen.has(lk)) {
          learnedSeen.add(lk)
          learned.push({ input: { kind: inp.kind, key: inp.key ?? null, ...(inp.store ? { store: inp.store } : {}) }, value, via })
        }
      }
      const emitGeneric = (raw, marker, viaEnt) => {
        const value = wrapVal(raw)
        emit(value, marker, [viaEnt])
        if (node.oprobe) {
          // keep probing: unresolved marked leaves may guard further keys
          try {
            const p = JSON.parse(value)
            if (p && typeof p === "object" && value.includes(m))
              kids.push({ i: node.i, oprobe: true, overrides: value, marker: m, via: [...node.via, { ...viaEnt, probing: true }].slice(-8) })
          } catch {
            /* not an object payload — nothing to continue probing */
          }
        }
      }
      // rewrite the marker region of `inj` to satisfy `side op other`. When
      // the side carries the canary in a different case, the program
      // normalized case before comparing — so the constant it compared
      // against is normalized too, and the raw input that produces it is
      // likely its lower-case spelling: emit both variants and let
      // execution decide which one the goal actually needs.
      const mLow = m.toLowerCase()
      const rewrite = (op, side, other, folded) => {
        const ci = side.toLowerCase().indexOf(mLow)
        const P = side.slice(0, ci)
        const S = side.slice(ci + m.length)
        const out = []
        const variants = (learned) => (folded && learned.toLowerCase() !== learned ? [learned, learned.toLowerCase()] : [learned])
        if (op === "eq") {
          const X =
            other.startsWith(P) && other.endsWith(S) && other.length >= P.length + S.length
              ? other.slice(P.length, other.length - S.length)
              : other
          for (const v of variants(X))
            out.push([inj.replace(m, v), v.length ? v : null, v === X ? { op: "eq", learned: X } : { op: "eq", learned: X, folded: v }])
          return out
        }
        if (!other.length) return out
        if (op === "startsWith") {
          const need = other.startsWith(P) ? other.slice(P.length) : other
          for (const v of variants(need))
            if (v.length)
              out.push([inj.replace(m, v + m), m, v === need ? { op: "startsWith", learned: other } : { op: "startsWith", learned: other, folded: v }])
          return out
        }
        if (op === "endsWith") {
          const need = other.endsWith(S) ? other.slice(0, other.length - S.length) : other
          for (const v of variants(need))
            if (v.length)
              out.push([inj.replace(m, m + v), m, v === need ? { op: "endsWith", learned: other } : { op: "endsWith", learned: other, folded: v }])
          return out
        }
        for (const v of variants(other)) out.push([inj.replace(m, m + v), m, v === other ? { op, learned: other } : { op, learned: other, folded: v }])
        return out
      }
      const baseOver = node.oprobe ? JSON.parse(node.overrides) : {}
      const keyNeeds = new Map()
      const keyVia = []
      for (const e of journal) {
        // case-insensitive: a program that upper/lower-cases its input
        // before comparing still carries the canary, just re-cased
        const aHas = e.a.toLowerCase().includes(mLow)
        const bHas = e.b.toLowerCase().includes(mLow)
        if (aHas === bHas) continue // marker on both sides or neither: not attributable
        const side = aHas ? e.a : e.b
        const other = aHas ? e.b : e.a
        const folded = !side.includes(m)
        if (mprobe && side.startsWith(m + ".")) {
          // object protocol: the probe proxy returned "<marker>.<key>" for
          // a property read — this key was consulted and tested here
          const key = side.slice(m.length + 1)
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || Object.prototype.hasOwnProperty.call(baseOver, key)) continue
          const leaf = !aHas || e.op === "eq" ? other : e.op === "startsWith" ? other + m : e.op === "endsWith" ? m + other : m + other
          if (!leaf.length) continue
          const merged = { ...baseOver, [key]: leaf }
          const txt = JSON.stringify(merged)
          emit(txt, txt.includes(m) ? m : leaf, [{ op: e.op, key, learned: other }])
          kids.push({
            i: node.i,
            oprobe: true,
            overrides: txt,
            marker: m,
            via: [...node.via, { op: e.op, key, learned: other, probing: true }].slice(-8),
          })
          if (!keyNeeds.has(key)) {
            keyNeeds.set(key, leaf)
            keyVia.push({ op: e.op, key, learned: other })
          }
          continue
        }
        if (!aHas && e.op !== "eq") {
          // our value is the ARGUMENT — constant.op(ourValue): matching the
          // whole receiver satisfies any of these tests
          if (other.length) {
            emitGeneric(inj.replace(m, other), other, { op: e.op, learned: other })
            if (folded && other.toLowerCase() !== other)
              emitGeneric(inj.replace(m, other.toLowerCase()), other.toLowerCase(), { op: e.op, learned: other, folded: other.toLowerCase() })
          }
          continue
        }
        for (const r of rewrite(e.op, side, other, folded)) emitGeneric(r[0], r[1], r[2])
      }
      if (keyNeeds.size > 1) {
        // several keys tested in one run: combine every learned constraint
        // into a single payload (plus a probe continuation for more keys)
        const merged = { ...baseOver }
        for (const [k, v] of keyNeeds) merged[k] = v
        const txt = JSON.stringify(merged)
        emit(txt, txt.includes(m) ? m : keyNeeds.values().next().value, keyVia)
        kids.push({ i: node.i, oprobe: true, overrides: txt, marker: m, via: [...node.via, ...keyVia].slice(-8) })
      }
      return kids
    }

    // ---- seeds: one canary probe per input; derivations of each input's
    // as-run value against the base journal (round 0, no forks spent);
    // caller-supplied extras
    let frontier = []
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]
      frontier.push({ i, probe: true, value: canary(i), marker: canary(i), via: [{ op: "probe", value: canary(i) }] })
      if (inp.asRun != null) tried[i].add(inp.kind === "message" ? JSON.stringify(inp.asRun) : String(inp.asRun))
      if (typeof inp.asRun === "string" && inp.asRun.length >= 2 && inp.kind !== "message")
        frontier.push(...deriveFrom(baseJournal, { i, value: inp.asRun, marker: inp.asRun, via: [{ op: "as-run", value: inp.asRun }] }))
      for (const v of extraValues)
        frontier.push({
          i,
          value: inp.kind === "message" ? JSON.stringify(String(v)) : String(v),
          marker: String(v),
          via: [{ op: "seed", value: String(v) }],
        })
    }

    try {
      bfs: while (frontier.length && round < rounds) {
        round++
        // unused-logic guidance: children of runs that unlocked lines the
        // original recording never executed explore first
        frontier.sort((a, b) => (b.parentNew ?? 0) - (a.parentNew ?? 0))
        const next = []
        for (const node of frontier) {
          const key = node.probe ? "\0probe" : node.oprobe ? "\0oprobe:" + node.overrides : node.value
          if (key == null || key.length > CAP + 16 || tried[node.i].has(key)) continue
          tried[node.i].add(key)
          if (explored >= maxBranches) {
            budgetHit = true
            break bfs
          }
          const inp = inputs[node.i]
          // a discovered input only exists inside the branch that revealed
          // it: every candidate for it re-applies the unlocking assignments
          const assigns = [...(inp.ctx ?? []), { ...node, kind: inp.kind, key: inp.key, store: inp.store }]
          const { rec, journal, fresh } = await runCandidate(assigns, true)
          singles.push(rec)
          for (const idx of fresh)
            next.push({
              i: idx,
              probe: true,
              value: canary(idx),
              marker: canary(idx),
              parentNew: rec.newLines.length + 1,
              via: [{ op: "discovered", under: rec.edit }, { op: "probe", value: canary(idx) }],
            })
          if (rec.satisfied) continue
          for (const kid of deriveFrom(journal, node)) {
            kid.parentNew = rec.newLines.length
            next.push(kid)
          }
        }
        frontier = next
      }
      // compound goals: no single input sufficed — combine the most
      // promising finished singles (partial credit ranks them) pairwise
      if (!examples.length && inputs.length > 1 && !budgetHit) {
        const ranked = singles
          .filter((r) => !r.error && !r.probe && r.assignments.length === 1 && !/ttc\d+z/.test(r.assignments[0].value))
          .sort((a, b) => satCount(b.goals) - satCount(a.goals))
          .slice(0, pairTop)
        pairsLoop: for (let i = 0; i < ranked.length; i++) {
          for (let j = i + 1; j < ranked.length; j++) {
            const a = ranked[i].assignments[0]
            const c = ranked[j].assignments[0]
            if (a.kind === c.kind && a.key === c.key) continue
            if (explored >= maxBranches) {
              budgetHit = true
              break pairsLoop
            }
            await runCandidate([{ ...a }, { ...c }], false)
          }
        }
      }
    } finally {
      s.view = saveView
      this.positionTo(savePos)
    }
    let pruned = 0
    if (keep === "examples") {
      const keepSet = new Set(examples.map((e) => e.branch))
      for (const id of created) if (s.branches[id] && !keepSet.has(id)) pruned += this.pruneBranch(id).length
    }
    unlocked.sort((a, b) => b.lines.length - a.lines.length)
    return {
      alreadyTrue: false,
      examples,
      explored,
      pruned,
      budgetHit,
      baseline: base.detail,
      inputs: inputs.map((x) => {
        const o = { kind: x.kind, key: x.key, asRun: x.asRun ?? null, neverFired: !!x.neverFired }
        if (x.store) o.store = x.store
        if (x.discovered) {
          o.discovered = true
          o.under = x.under
        }
        return o
      }),
      learned,
      unlocked: unlocked.slice(0, 6).map((u) => ({ ...u, branch: s.branches[u.branch] ? u.branch : null })),
    }
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
