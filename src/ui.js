// All DOM logic for the TimeTravelJS debugger page.

import { SAMPLES } from "./samples.js"

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}

// ---------------------------------------------------------------------------
// serialized-value rendering
// ---------------------------------------------------------------------------
function inlinePreview(v, depth = 1) {
  if (!v || typeof v !== "object") return span("v-undef", String(v))
  switch (v.t) {
    case "num": return span("v-num", String(v.v))
    case "nan": return span("v-special", "NaN")
    case "str": return span("v-str", JSON.stringify(v.v) + (v.trunc ? `… (${v.trunc} chars)` : ""))
    case "bool": return span("v-bool", String(v.v))
    case "null": return span("v-null", "null")
    case "undef": return span("v-undef", "undefined")
    case "bigint": return span("v-num", v.v + "n")
    case "sym": return span("v-cls", v.v)
    case "fn": return span("v-fn", `ƒ ${v.name || "(anon)"}${v.stepper ? " ⏱" : ""}`)
    case "date": return span("v-cls", v.v)
    case "regexp": return span("v-cls", v.v)
    case "error": return span("v-special", `${v.name}: ${v.msg}`)
    case "getter": return span("v-tdz", "(getter)")
    case "ref": return span("v-tdz", "[circular]")
    case "tdz": return span("v-tdz", "‹not yet declared›")
    case "hole": return span("v-tdz", "‹empty›")
    case "more": return span("v-punct", `${v.cls || "Object"} {…}`)
    case "arr": {
      const s = span(null)
      s.append(span("v-punct", `(${v.n}) [`))
      if (depth > 0) {
        v.items.slice(0, 6).forEach((item, i) => {
          if (i) s.append(span("v-punct", ", "))
          s.append(inlinePreview(item, depth - 1))
        })
        if (v.n > 6 || v.more) s.append(span("v-punct", ", …"))
      } else if (v.n) s.append(span("v-punct", "…"))
      s.append(span("v-punct", "]"))
      return s
    }
    case "typed": {
      const s = span(null)
      s.append(span("v-cls", `${v.cls}(${v.n}) `), span("v-punct", `[${v.items.slice(0, 6).join(", ")}${v.more || v.n > 6 ? ", …" : ""}]`))
      return s
    }
    case "map": {
      const s = span(null)
      s.append(span("v-cls", `Map(${v.n}) `), span("v-punct", "{"))
      if (depth > 0) v.entries.slice(0, 3).forEach(([k, val], i) => {
        if (i) s.append(span("v-punct", ", "))
        s.append(inlinePreview(k, 0), span("v-punct", " ⇒ "), inlinePreview(val, 0))
      })
      if (v.n > 3) s.append(span("v-punct", ", …"))
      s.append(span("v-punct", "}"))
      return s
    }
    case "set": {
      const s = span(null)
      s.append(span("v-cls", `Set(${v.n}) `), span("v-punct", "{"))
      if (depth > 0) v.items.slice(0, 4).forEach((item, i) => {
        if (i) s.append(span("v-punct", ", "))
        s.append(inlinePreview(item, 0))
      })
      if (v.n > 4) s.append(span("v-punct", ", …"))
      s.append(span("v-punct", "}"))
      return s
    }
    case "obj": {
      const s = span(null)
      if (v.cls) s.append(span("v-cls", v.cls + " "))
      s.append(span("v-punct", "{"))
      if (depth > 0) {
        v.props.slice(0, 5).forEach(([k, val], i) => {
          if (i) s.append(span("v-punct", ", "))
          s.append(span("vkey", k), span("v-punct", ": "), inlinePreview(val, depth - 1))
        })
        if (v.props.length > 5 || v.more) s.append(span("v-punct", ", …"))
      } else if (v.props.length) s.append(span("v-punct", "…"))
      s.append(span("v-punct", "}"))
      return s
    }
    default: return span("v-undef", v.t)
  }
}
function span(cls, text) {
  const s = document.createElement("span")
  if (cls) s.className = cls
  if (text !== undefined) s.textContent = text
  return s
}

function childrenOf(v) {
  switch (v.t) {
    case "arr": return v.items.map((item, i) => [String(i), item])
    case "obj": return v.props
    case "typed": return v.items.map((item, i) => [String(i), { t: "num", v: item }])
    case "map": return v.entries.map(([k, val], i) => [`«${i}»`, { t: "obj", cls: "", props: [["key", k], ["value", val]], more: false }])
    case "set": return v.items.map((item, i) => [String(i), item])
    default: return null
  }
}

function treeRow(key, v, keyCls = "vkey", open = false) {
  const row = el("div", "vrow")
  const kids = v && typeof v === "object" ? childrenOf(v) : null
  if (kids && kids.length) {
    const toggle = span("vtoggle", open ? "▾" : "▸")
    row.append(toggle)
    row.append(span(keyCls, key), span("vsep", ": "), inlinePreview(v))
    const box = el("div", "vchildren" + (open ? "" : " collapsed"))
    let built = open
    if (open) for (const [k, child] of kids) box.append(treeRow(k, child, "vkey"))
    toggle.addEventListener("click", () => {
      const collapsed = box.classList.toggle("collapsed")
      toggle.textContent = collapsed ? "▸" : "▾"
      if (!collapsed && !built) {
        built = true
        for (const [k, child] of kids) box.append(treeRow(k, child, "vkey"))
      }
    })
    const wrap = el("div")
    wrap.append(row, box)
    return wrap
  }
  row.append(span("vtoggle", " "), span(keyCls, key), span("vsep", ": "), inlinePreview(v))
  return row
}

// ---------------------------------------------------------------------------
// the debugger UI
// ---------------------------------------------------------------------------
export class DebuggerUI {
  constructor(engine) {
    this.engine = engine
    this.breakpoints = new Set()
    this.evalEntries = [] // {visibleAt, level, text|node}
    this.summary = null
    this.playTimer = null
    this.recording = false

    this.els = {
      sampleSelect: $("#sample-select"),
      runBtn: $("#run-btn"),
      status: $("#status-pill"),
      slider: $("#timeline-slider"),
      canvas: $("#timeline-canvas"),
      posCur: $("#pos-cur"),
      posMax: $("#pos-max"),
      diverged: $("#diverged-badge"),
      gutter: $("#gutter"),
      code: $("#code-input"),
      scroller: $("#editor-scroller"),
      hlLayer: $("#hl-layer"),
      varsBody: $("#vars-body"),
      varsHint: $("#vars-hint"),
      stackBody: $("#stack-body"),
      consoleBody: $("#console-body"),
      consoleInput: $("#console-input"),
      memStats: $("#mem-stats"),
      cpCanvas: $("#cp-canvas"),
      heatCanvas: $("#heat-canvas"),
      playBtn: $("#btn-play"),
    }
    this._buildSamplePicker()
    this._wireEditor()
    this._wireTransport()
    this._wireConsole()
    window.addEventListener("resize", () => this.renderTimeline())
  }

  // ------------------------------------------------------------------ samples
  _buildSamplePicker() {
    for (const s of SAMPLES) {
      const opt = el("option", null, s.name)
      opt.value = s.id
      this.els.sampleSelect.append(opt)
    }
    this.els.sampleSelect.addEventListener("change", () => {
      const sample = SAMPLES.find((s) => s.id === this.els.sampleSelect.value)
      if (sample) {
        this.els.code.value = sample.code
        this.refreshGutter()
        this.record()
      }
    })
    this.els.code.value = SAMPLES[0].code
  }

  // ------------------------------------------------------------------- editor
  _wireEditor() {
    const { code, gutter, scroller } = this.els
    code.addEventListener("input", () => this.refreshGutter())
    scroller.addEventListener("scroll", () => {
      gutter.scrollTop = scroller.scrollTop
    })
    // size the textarea to its content so one scroller rules everything
    this.refreshGutter()
    gutter.addEventListener("click", (e) => {
      const ln = e.target.closest(".ln")
      if (!ln) return
      const line = Number(ln.dataset.line)
      if (this.breakpoints.has(line)) this.breakpoints.delete(line)
      else this.breakpoints.add(line)
      ln.classList.toggle("bp")
      this.renderTimeline()
    })
  }

  refreshGutter() {
    const { code, gutter } = this.els
    const lines = code.value.split("\n").length
    code.rows = lines + 1
    code.style.height = "auto"
    code.style.height = `${Math.max(code.scrollHeight, 380)}px`
    code.style.width = "auto"
    code.style.width = `${Math.max(code.scrollWidth, 100)}px`
    const cur = gutter.childElementCount
    if (cur !== lines) {
      gutter.textContent = ""
      const pad = el("div")
      pad.style.height = "10px"
      gutter.append(pad)
      for (let i = 1; i <= lines; i++) {
        const ln = el("div", "ln" + (this.breakpoints.has(i) ? " bp" : ""), String(i))
        ln.dataset.line = String(i)
        gutter.append(ln)
      }
    }
  }

  highlightCurrent() {
    const { hlLayer, gutter, scroller } = this.els
    hlLayer.textContent = ""
    for (const ln of gutter.querySelectorAll(".ln.cur")) ln.classList.remove("cur")
    const entry = this.currentEntry()
    if (!entry || entry.k === 5) return
    const isErr = entry.k === 2
    const line = entry.k === 0 ? entry.l : entry.k === 1 ? entry.l : this._lastLineBefore()
    if (!line) return
    const endLine = entry.k === 0 ? entry.el : line
    const LH = 21
    const PAD = 10
    const band = el("div", "hl-band" + (isErr ? " hl-err" : ""))
    band.style.top = `${PAD + (line - 1) * LH}px`
    band.style.height = `${(endLine - line + 1) * LH}px`
    this.els.hlLayer.append(band)
    const lnEl = gutter.querySelector(`.ln[data-line="${line}"]`)
    if (lnEl) lnEl.classList.add("cur")
    // keep current line in view
    const y = PAD + (line - 1) * LH
    if (y < scroller.scrollTop + 10 || y > scroller.scrollTop + scroller.clientHeight - 40) {
      scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2)
    }
  }

  _lastLineBefore() {
    const t = this.engine.trace
    for (let i = Math.min(this.engine.pos, t.length) - 1; i >= 0; i--) {
      if (t[i].k === 0) return t[i].l
    }
    return 0
  }

  // --------------------------------------------------------------- transport
  _wireTransport() {
    const nav = (fn) => () => {
      if (!this.summary || this.recording) return
      this.stopPlay()
      fn()
      this.syncPosition()
    }
    $("#btn-start").addEventListener("click", nav(() => this.engine.positionTo(0)))
    $("#btn-end").addEventListener("click", nav(() => this.engine.positionTo(this.engine.trace.length)))
    $("#btn-fwd").addEventListener("click", nav(() => this.stepInto(1)))
    $("#btn-back").addEventListener("click", nav(() => this.stepInto(-1)))
    $("#btn-over").addEventListener("click", nav(() => this.stepOver(1)))
    $("#btn-back-over").addEventListener("click", nav(() => this.stepOver(-1)))
    $("#btn-out").addEventListener("click", nav(() => this.stepOut(1)))
    $("#btn-back-out").addEventListener("click", nav(() => this.stepOut(-1)))
    $("#btn-continue").addEventListener("click", nav(() => this.continueTo(1)))
    $("#btn-rev-continue").addEventListener("click", nav(() => this.continueTo(-1)))
    this.els.playBtn.addEventListener("click", () => this.togglePlay())
    this.els.runBtn.addEventListener("click", () => this.record())

    this.els.slider.addEventListener("input", () => {
      if (!this.summary || this.recording) return
      this.stopPlay()
      this.engine.positionTo(Number(this.els.slider.value))
      this.syncPosition(true)
    })
    this.els.canvas.addEventListener("pointerdown", (e) => this._seekFromCanvas(e, true))
    this.els.canvas.addEventListener("pointermove", (e) => {
      if (e.buttons & 1) this._seekFromCanvas(e, false)
    })

    document.addEventListener("keydown", (e) => {
      if (e.target === this.els.code || e.target === this.els.consoleInput) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target === this.els.code) {
          e.preventDefault()
          this.record()
        }
        return
      }
      if (!this.summary || this.recording) return
      const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        this.record()
        return
      }
      if (!dir) return
      e.preventDefault()
      this.stopPlay()
      if (e.ctrlKey || e.metaKey) this.continueTo(dir)
      else if (e.altKey) this.stepOver(dir)
      else this.stepInto(dir)
      this.syncPosition()
    })
  }

  _seekFromCanvas(e, always) {
    if (!this.summary || this.recording) return
    const rect = this.els.canvas.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const target = Math.round(frac * this.engine.trace.length)
    if (always || target !== this.engine.pos) {
      this.stopPlay()
      this.engine.positionTo(target)
      this.syncPosition(true)
    }
  }

  currentEntry() {
    const t = this.engine.trace
    const p = this.engine.pos
    return p >= 1 ? t[p - 1] : null
  }
  currentDepth() {
    const e = this.currentEntry()
    return e && e.k === 0 ? e.d : 0
  }

  /** next position (searching dir) whose entry passes `pred`; falls to bounds */
  _seek(dir, pred) {
    const t = this.engine.trace
    let p = this.engine.pos + dir
    while (p >= 0 && p <= t.length) {
      if (p === 0 || p === t.length) break
      const entry = t[p - 1]
      if (entry.k !== 5 && pred(entry)) break
      p += dir
    }
    return Math.max(0, Math.min(p, t.length))
  }

  stepInto(dir) {
    this.engine.positionTo(this._seek(dir, () => true))
  }
  stepOver(dir) {
    const d = this.currentDepth()
    this.engine.positionTo(this._seek(dir, (entry) => entry.k !== 0 || entry.d <= d))
  }
  stepOut(dir) {
    const d = this.currentDepth()
    if (d === 0) return this.stepInto(dir)
    this.engine.positionTo(this._seek(dir, (entry) => entry.k !== 0 || entry.d < d))
  }
  continueTo(dir) {
    if (this.breakpoints.size === 0) {
      this.engine.positionTo(dir > 0 ? this.engine.trace.length : 0)
      return
    }
    this.engine.positionTo(this._seek(dir, (entry) => entry.k === 0 && this.breakpoints.has(entry.l)))
  }

  togglePlay() {
    if (this.playTimer) return this.stopPlay()
    if (!this.summary || this.recording) return
    if (this.engine.pos >= this.engine.trace.length) this.engine.positionTo(0)
    this.els.playBtn.classList.add("playing")
    this.els.playBtn.textContent = "⏸ pause"
    this.playTimer = setInterval(() => {
      if (this.engine.pos >= this.engine.trace.length) return this.stopPlay()
      this.stepInto(1)
      this.syncPosition(true)
    }, 90)
  }
  stopPlay() {
    if (this.playTimer) {
      clearInterval(this.playTimer)
      this.playTimer = null
      this.els.playBtn.classList.remove("playing")
      this.els.playBtn.textContent = "▶︎ play"
    }
  }

  // -------------------------------------------------------------- recording
  async record() {
    if (this.recording) return
    this.stopPlay()
    this.recording = true
    this.summary = null
    this.evalEntries = []
    this.els.code.readOnly = true
    this.els.runBtn.disabled = true
    this.setStatus("busy", "recording…")
    this.els.diverged.hidden = true
    try {
      const summary = await this.engine.run(
        this.els.code.value,
        {},
        (p) => this.setStatus("busy", `recording… ${p.steps} steps · ${p.checkpoints} snapshots`),
      )
      this.summary = summary
      for (const w of summary.warnings) {
        this.evalEntries.push({ visibleAt: 0, level: "sys", text: `note: ${w}` })
      }
      if (summary.truncated) {
        this.evalEntries.push({
          visibleAt: 0,
          level: "sys",
          text: `recording stopped after ${summary.steps} steps (budget) — timeline is still fully navigable`,
        })
      }
      const cow = summary.cow
      this.setStatus(
        summary.error ? "err" : "ok",
        summary.error
          ? `crashed after ${summary.steps} steps — travel back to investigate`
          : `${summary.steps} steps · ${cow.snapshots} snapshots · COW saved ${(cow.savings * 100).toFixed(0)}%`,
      )
      this.els.slider.max = String(summary.steps)
      this.els.posMax.textContent = String(summary.steps)
      this.engine.positionTo(summary.steps)
      this.syncPosition()
    } catch (err) {
      this.setStatus("err", err.timeTravelUserError ? "program error" : "engine error")
      this.evalEntries.push({ visibleAt: 0, level: "error", text: String(err.message || err) })
      this.renderConsole()
      if (!err.timeTravelUserError) console.error(err)
    } finally {
      this.recording = false
      this.els.code.readOnly = false
      this.els.runBtn.disabled = false
    }
  }

  setStatus(kind, text) {
    this.els.status.className = `status-pill ${kind}`
    this.els.status.textContent = text
  }

  // ------------------------------------------------------------------ console
  _wireConsole() {
    this.els.consoleInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return
      const src = this.els.consoleInput.value.trim()
      if (!src || !this.summary || this.recording) return
      this.els.consoleInput.value = ""
      const pos = this.engine.pos
      this.evalEntries.push({ visibleAt: pos, level: "input", text: src })
      const res = this.engine.consoleEval(src)
      if (res.error) this.evalEntries.push({ visibleAt: pos, level: "error", text: res.error.v })
      else this.evalEntries.push({ visibleAt: pos, level: "result", node: inlinePreview(res.value, 2) })
      this.renderConsole()
    })
  }

  renderConsole() {
    const body = this.els.consoleBody
    body.textContent = ""
    const pos = this.engine.pos
    const rows = []
    for (const entry of this.engine.consoleEntries) {
      if (entry.visibleAt <= pos) rows.push({ at: entry.visibleAt, level: entry.level, parts: entry.parts })
    }
    for (const entry of this.evalEntries) {
      if (entry.visibleAt <= pos) rows.push({ at: entry.visibleAt, level: entry.level, text: entry.text, node: entry.node })
    }
    rows.sort((a, b) => a.at - b.at)
    if (this.summary && this.summary.error && pos >= this.engine.trace.length) {
      const info = this.summary.error
      rows.push({
        at: pos,
        level: "error",
        text: typeof info === "object" && info ? `${info.name ?? "Error"}: ${info.message ?? String(info)}` : String(info),
      })
    }
    if (!rows.length) {
      body.append(el("div", "empty-note", "no output yet at this point in time"))
      return
    }
    for (const r of rows) {
      const row = el("div", `console-row level-${r.level}`)
      const tag = span("step-tag", `@${r.at}`)
      row.append(tag)
      if (r.parts) {
        r.parts.forEach((p, i) => {
          if (i) row.append(document.createTextNode(" "))
          row.append(p.t === "str" ? document.createTextNode(p.v) : inlinePreview(p, 2))
        })
      } else if (r.node) {
        row.append(r.node.cloneNode(true))
      } else {
        row.append(document.createTextNode(r.text))
      }
      body.append(row)
    }
    body.scrollTop = body.scrollHeight
  }

  // ------------------------------------------------------------------ panels
  syncPosition(lightweight = false) {
    const pos = this.engine.pos
    this.els.slider.value = String(pos)
    this.els.posCur.textContent = String(pos)
    this.els.diverged.hidden = !this.engine.diverged
    this.highlightCurrent()
    this.renderTimeline()
    this.renderConsole()
    if (!lightweight) {
      this.renderInspection()
      this.renderMemory()
    } else {
      this.renderInspection()
    }
  }

  renderInspection() {
    const { varsBody, stackBody, varsHint } = this.els
    varsBody.textContent = ""
    stackBody.textContent = ""
    if (!this.summary) {
      varsBody.append(el("div", "empty-note", "record a program to inspect state"))
      stackBody.append(el("div", "empty-note", "—"))
      return
    }
    const ins = this.engine.inspect()
    const entry = this.currentEntry()
    varsHint.textContent = entry && entry.k === 0 ? `line ${entry.l}` : ""

    const tree = el("div", "vtree")
    if (ins.locals && ins.locals.length) {
      tree.append(el("div", "vgroup-title", "in scope"))
      for (const [k, v] of ins.locals) tree.append(treeRow(k, v, "vkey vkey-local", v && (v.t === "arr" || v.t === "obj") && this._smallEnough(v)))
    }
    if (ins.globals && ins.globals.length) {
      tree.append(el("div", "vgroup-title", "globals (user-defined)"))
      for (const [k, v] of ins.globals) tree.append(treeRow(k, v, "vkey"))
    }
    if (!tree.childElementCount) tree.append(el("div", "empty-note", this.engine.pos === 0 ? "before first statement — step forward" : "no visible variables here"))
    varsBody.append(tree)

    const frames = [...(ins.stack || [])]
    const rows = []
    const curLine = entry && entry.k === 0 ? entry.l : null
    for (let i = frames.length - 1; i >= 0; i--) {
      rows.push({ fn: frames[i].n, loc: i === frames.length - 1 ? curLine : null, callsite: frames[i].l })
    }
    rows.push({ fn: "(top level)", loc: frames.length === 0 ? curLine : null, callsite: null })
    rows.forEach((r, i) => {
      const row = el("div", "stack-row" + (i === 0 ? " stack-top" : ""))
      row.append(el("span", "stack-fn", r.fn))
      const where = r.loc ? `line ${r.loc}` : r.callsite ? `called from line ${r.callsite}` : ""
      row.append(el("span", "stack-loc", where))
      stackBody.append(row)
    })
  }

  _smallEnough(v) {
    if (v.t === "arr") return v.n <= 12
    if (v.t === "obj") return v.props.length <= 8
    return false
  }

  // ----------------------------------------------------------------- timeline
  renderTimeline() {
    const canvas = this.els.canvas
    const dpr = window.devicePixelRatio || 1
    const W = canvas.clientWidth || canvas.parentElement.clientWidth
    const H = 46
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext("2d")
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    if (!this.summary) return
    const t = this.engine.trace
    const N = Math.max(1, t.length)
    const x = (p) => (p / N) * W

    // depth area chart
    let maxD = 1
    for (const entry of t) if (entry.k === 0 && entry.d > maxD) maxD = entry.d
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let i = 0; i < t.length; i++) {
      const d = t[i].k === 0 ? t[i].d : 0
      ctx.lineTo(x(i + 1), H - 6 - (d / maxD) * (H - 18))
    }
    ctx.lineTo(W, H)
    ctx.closePath()
    ctx.fillStyle = "rgba(139, 124, 246, 0.22)"
    ctx.fill()

    // error zone
    const last = t[t.length - 1]
    if (last && last.k === 2) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.15)"
      ctx.fillRect(x(N - 1), 0, W - x(N - 1) + 2, H)
    }
    // phase divider (main program → timers)
    if (this.summary.switchIdx != null) {
      ctx.strokeStyle = "rgba(251, 191, 36, 0.5)"
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x(this.summary.switchIdx + 1), 0)
      ctx.lineTo(x(this.summary.switchIdx + 1), H)
      ctx.stroke()
      ctx.setLineDash([])
    }
    // checkpoints
    for (const cp of this.summary.checkpoints) {
      const frac = Math.min(1, cp.dirtyPages / 64)
      ctx.strokeStyle = `rgba(77, 208, 225, ${0.25 + frac * 0.6})`
      ctx.beginPath()
      ctx.moveTo(x(cp.step), H - 4)
      ctx.lineTo(x(cp.step), H - 4 - 8 - frac * 12)
      ctx.stroke()
    }
    // console events
    for (const entry of this.engine.consoleEntries) {
      ctx.fillStyle = entry.level === "error" ? "#f87171" : entry.level === "warn" ? "#fbbf24" : "#4ade80"
      ctx.beginPath()
      ctx.arc(x(entry.visibleAt), 5, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
    // timer markers
    for (let i = 0; i < t.length; i++) {
      if (t[i].k === 1) {
        ctx.fillStyle = "#fbbf24"
        ctx.fillRect(x(i + 1) - 1.5, 10, 3, 3)
      }
    }
    // breakpoint hits
    if (this.breakpoints.size) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.8)"
      for (let i = 0; i < t.length; i++) {
        if (t[i].k === 0 && this.breakpoints.has(t[i].l)) ctx.fillRect(x(i + 1) - 1, H - 3, 2, 3)
      }
    }
    // needle
    const px = x(this.engine.pos)
    ctx.strokeStyle = "#4dd0e1"
    ctx.shadowColor = "rgba(77, 208, 225, 0.8)"
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.fillStyle = "#4dd0e1"
    ctx.beginPath()
    ctx.moveTo(px - 4, 0)
    ctx.lineTo(px + 4, 0)
    ctx.lineTo(px, 6)
    ctx.closePath()
    ctx.fill()
  }

  // ------------------------------------------------------------------- memory
  renderMemory() {
    const { memStats, cpCanvas, heatCanvas } = this.els
    memStats.textContent = ""
    if (!this.summary) return
    const cow = this.summary.cow
    const stat = (k, v, hi = false) => {
      const row = el("div", "mem-stat")
      row.append(el("span", "k", k), el("span", "v" + (hi ? " hi" : ""), v))
      memStats.append(row)
    }
    stat("VM heap", fmtBytes(this.summary.memBytes))
    stat("snapshots", String(cow.snapshots))
    stat("page size", "4 KB")
    stat("unique pages kept", String(cow.uniquePages))
    stat("full copies would cost", fmtBytes(cow.naiveBytes))
    stat("COW actually keeps", fmtBytes(cow.retainedBytes), true)

    const bar = el("div", "mem-bar-outer")
    const inner = el("div", "mem-bar-inner")
    inner.style.width = `${Math.max(2, (1 - cow.savings) * 100)}%`
    bar.append(inner)
    memStats.append(bar)
    memStats.append(
      el("div", "mem-bar-caption", `sharing unchanged pages between snapshots saves ${(cow.savings * 100).toFixed(1)}% of snapshot memory`),
    )

    // per-checkpoint dirty pages
    {
      const dpr = window.devicePixelRatio || 1
      const W = cpCanvas.clientWidth || 300
      const H = 42
      cpCanvas.width = W * dpr
      cpCanvas.height = H * dpr
      const c = cpCanvas.getContext("2d")
      c.scale(dpr, dpr)
      c.clearRect(0, 0, W, H)
      const cps = this.summary.checkpoints
      if (cps.length) {
        const maxDirty = Math.max(1, ...cps.map((cp) => cp.dirtyPages))
        const bw = Math.max(2, Math.min(14, (W - 4) / cps.length - 2))
        let active = 0
        for (let i = 0; i < cps.length; i++) if (cps[i].step <= this.engine.pos) active = i
        cps.forEach((cp, i) => {
          const h = Math.max(2, (cp.dirtyPages / maxDirty) * (H - 8))
          const bx = 2 + (i * (W - 4)) / cps.length
          c.fillStyle = i === active ? "#4dd0e1" : "rgba(139, 124, 246, 0.55)"
          c.fillRect(bx, H - 2 - h, bw, h)
        })
      }
    }
    // page write heat
    {
      const dpr = window.devicePixelRatio || 1
      const W = heatCanvas.clientWidth || 300
      const H = 26
      heatCanvas.width = W * dpr
      heatCanvas.height = H * dpr
      const c = heatCanvas.getContext("2d")
      c.scale(dpr, dpr)
      c.clearRect(0, 0, W, H)
      const heat = this.summary.pageHeat
      if (heat.length) {
        const pageCount = Math.ceil(this.summary.memBytes / 4096)
        const maxHeat = Math.max(...heat.map(([, n]) => n))
        c.fillStyle = "rgba(255,255,255,0.04)"
        c.fillRect(0, 4, W, H - 8)
        for (const [page, n] of heat) {
          const bx = (page / pageCount) * W
          const alpha = 0.25 + 0.75 * (n / maxHeat)
          c.fillStyle = `rgba(240, 164, 93, ${alpha})`
          c.fillRect(bx, 4, Math.max(1, W / pageCount), H - 8)
        }
      }
    }
  }
}
