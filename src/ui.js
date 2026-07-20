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
      htmlInput: $("#html-input"),
      urlInput: $("#url-input"),
      domPanel: $("#panel-dom"),
      domFrame: $("#dom-preview"),
      granularitySelect: $("#granularity-select"),
      runBtn: $("#run-btn"),
      status: $("#status-pill"),
      slider: $("#timeline-slider"),
      canvas: $("#timeline-canvas"),
      posCur: $("#pos-cur"),
      posMax: $("#pos-max"),
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
      branchStrip: $("#branch-strip"),
      whatifEdits: $("#whatif-edits"),
      whatifProbe: $("#whatif-probe"),
      whatifSuggest: $("#whatif-suggest"),
      whatifRun: $("#whatif-run"),
      whatifParams: $("#whatif-params"),
      whatifResults: $("#whatif-results"),
    }
    this._evalByBranch = new Map() // branchId -> saved evalEntries of that view
    this._buildSamplePicker()
    this._wireEditor()
    this._wireTransport()
    this._wireConsole()
    this._wireWhatIf()
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
        if (this.els.htmlInput) this.els.htmlInput.value = sample.html || ""
        if (this.els.urlInput) this.els.urlInput.value = sample.url || ""
        this.refreshGutter()
        this.record()
      }
    })
    this.els.granularitySelect?.addEventListener("change", () => this.record())
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
    if (!entry) return
    const isErr = !!(entry.end && this.summary && this.summary.error)
    const line = entry.l || this._lastLineBefore()
    if (!line) return
    const endLine = line
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
    for (let i = Math.min(this.engine.pos, t.length - 1); i >= 0; i--) {
      if (t[i].l) return t[i].l
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
    $("#btn-end").addEventListener("click", nav(() => this.engine.positionTo(this.maxPos)))
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
    const target = Math.round(frac * this.maxPos)
    if (always || target !== this.engine.pos) {
      this.stopPlay()
      this.engine.positionTo(target)
      this.syncPosition(true)
    }
  }

  currentEntry() {
    return this.engine.trace[this.engine.pos] ?? null
  }
  currentDepth() {
    const e = this.currentEntry()
    return e ? e.d : 0
  }

  get maxPos() {
    return Math.max(0, this.engine.trace.length - 1)
  }

  /** next position (searching dir) whose entry passes `pred`; falls to bounds */
  _seek(dir, pred) {
    const t = this.engine.trace
    let p = this.engine.pos + dir
    while (p > 0 && p < t.length - 1) {
      if (pred(t[p])) break
      p += dir
    }
    return Math.max(0, Math.min(p, this.maxPos))
  }

  stepInto(dir) {
    this.engine.positionTo(this._seek(dir, () => true))
  }
  stepOver(dir) {
    const d = this.currentDepth()
    this.engine.positionTo(this._seek(dir, (entry) => !entry.entry || entry.d <= d))
  }
  stepOut(dir) {
    const d = this.currentDepth()
    if (d === 0) return this.stepInto(dir)
    this.engine.positionTo(this._seek(dir, (entry) => !entry.entry || entry.d < d))
  }
  continueTo(dir) {
    if (this.breakpoints.size === 0) {
      this.engine.positionTo(dir > 0 ? this.maxPos : 0)
      return
    }
    this.engine.positionTo(this._seek(dir, (entry) => entry.entry && this.breakpoints.has(entry.l)))
  }

  togglePlay() {
    if (this.playTimer) return this.stopPlay()
    if (!this.summary || this.recording) return
    if (this.engine.pos >= this.maxPos) this.engine.positionTo(0)
    this.els.playBtn.classList.add("playing")
    this.els.playBtn.textContent = "⏸ pause"
    this.playTimer = setInterval(() => {
      if (this.engine.pos >= this.maxPos) return this.stopPlay()
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
    this._evalByBranch = new Map()
    if (this.els.whatifResults) this.els.whatifResults.textContent = ""
    this.els.code.readOnly = true
    this.els.runBtn.disabled = true
    this.setStatus("busy", "recording…")
    try {
      const htmlSrc = this.els.htmlInput?.value ?? ""
      const urlSrc = this.els.urlInput?.value ?? ""
      const summary = await this.engine.run(
        this.els.code.value,
        {
          granularity: this.els.granularitySelect?.value === "opcode" ? "opcode" : "line",
          html: htmlSrc.trim() ? htmlSrc : undefined,
          url: urlSrc.trim() ? urlSrc : undefined,
        },
        (p) => this.setStatus("busy", `recording… ${p.steps} steps · ${p.checkpoints} snapshots`),
      )
      const cow = summary.cow
      this._afterRecord(
        summary,
        summary.error
          ? `crashed after ${summary.steps} steps — travel back to investigate`
          : `${summary.steps} steps · one snapshot each · COW saved ${(cow.savings * 100).toFixed(1)}%`,
      )
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

  /**
   * Fork the timeline at the current position: the future is discarded, the
   * (optional) edit runs against the LIVE paused frame, and execution
   * continues from that exact machine state, recording a new future.
   */
  async fork(editSrc) {
    if (this.recording || !this.summary) return
    this.stopPlay()
    this.recording = true
    const pos = this.engine.pos
    const fromBranch = this.engine.branch
    const warnsBefore = this.summary.warnings.length
    this.els.runBtn.disabled = true
    this.setStatus("busy", `⑂ forking at step ${pos}…`)
    try {
      const summary = await this.engine.forkFrom(pos, editSrc || null, (p) =>
        this.setStatus("busy", `⑂ recording new future… ${p.steps} steps`),
      )
      // the abandoned future is RETAINED as a sibling timeline; its eval
      // entries stay with it, the new branch inherits only the shared prefix
      this._evalByBranch.set(fromBranch, this.evalEntries)
      this.evalEntries = this.evalEntries.filter((entry) => entry.visibleAt <= pos)
      this.evalEntries.push({
        visibleAt: pos,
        level: "sys",
        text: editSrc ? `⑂ forked here — edit applied: ${editSrc}` : "⑂ forked here — future re-recorded",
      })
      this._afterRecord(
        summary,
        summary.error
          ? `forked timeline crashed after ${summary.steps} steps`
          : `⑂ forked at step ${pos} — ${summary.steps} steps on the new timeline`,
        warnsBefore,
      )
    } catch (err) {
      this.setStatus("err", "fork failed")
      this.evalEntries.push({ visibleAt: 0, level: "error", text: String(err.message || err) })
      this.renderConsole()
      console.error(err)
    } finally {
      this.recording = false
      this.els.runBtn.disabled = false
    }
  }

  /** shared post-recording refresh: notes, status, slider bounds, jump to end */
  _afterRecord(summary, statusText, newWarningsFrom = 0) {
    this.summary = summary
    for (const w of summary.warnings.slice(newWarningsFrom)) {
      this.evalEntries.push({ visibleAt: 0, level: "sys", text: `note: ${w}` })
    }
    if (summary.truncated) {
      this.evalEntries.push({
        visibleAt: 0,
        level: "sys",
        text: `recording stopped after ${summary.steps} steps (budget) — timeline is still fully navigable`,
      })
    }
    this.setStatus(summary.error ? "err" : "ok", statusText)
    this.els.slider.max = String(this.maxPos)
    this.els.posMax.textContent = String(this.maxPos)
    this.engine.positionTo(this.maxPos)
    this.syncPosition()
    this.renderBranches()
  }

  // ---------------------------------------------------------- the multiverse
  renderBranches() {
    const strip = this.els.branchStrip
    if (!strip || !this.engine.timelines) return
    const tl = this.summary ? this.engine.timelines() : []
    strip.hidden = tl.length <= 1
    strip.textContent = ""
    if (tl.length <= 1) return
    strip.append(el("span", "branch-label", "timelines"))
    for (const t of tl) {
      const chip = el("button", "branch-chip" + (t.current ? " current" : "") + (t.error ? " errored" : ""))
      const name = t.id === 0 ? "main" : `⑂${t.forkedAt}`
      chip.append(span("branch-name", "· ".repeat(t.depth) + name))
      if (t.edit) chip.append(span("branch-edit", t.edit.length > 26 ? t.edit.slice(0, 25) + "…" : t.edit))
      chip.append(span("branch-steps", `${t.steps}${t.error ? " ✖" : ""}`))
      chip.title =
        (t.id === 0 ? "the original recording" : t.edit ? `forked at step ${t.forkedAt} with edit: ${t.edit}` : `re-recorded from step ${t.forkedAt}`) +
        ` — ${t.steps} steps` + (t.error ? " · crashed" : "")
      chip.addEventListener("click", () => this.switchTimeline(t.id))
      strip.append(chip)
    }
  }

  switchTimeline(id, pos = null) {
    if (this.recording || !this.summary || !this.engine.switchTo) return
    if (id === this.engine.branch && pos == null) return
    this.stopPlay()
    this._evalByBranch.set(this.engine.branch, this.evalEntries)
    this.evalEntries = this._evalByBranch.get(id) ?? []
    this.engine.switchTo(id, pos ?? undefined)
    this.summary = this.engine.summary()
    this.els.slider.max = String(this.maxPos)
    this.els.posMax.textContent = String(this.maxPos)
    this.syncPosition()
    this.renderBranches()
    const t = this.engine.timelines().find((x) => x.id === id)
    this.setStatus(
      this.summary.error ? "err" : "ok",
      `timeline ${id === 0 ? "main" : "⑂" + (t?.forkedAt ?? id)} — ${this.summary.steps} steps`,
    )
  }

  _wireWhatIf() {
    this.els.whatifRun?.addEventListener("click", () => this.runWhatIf())
    this.els.whatifParams?.addEventListener("click", () => this.runParamSearch())
    this.els.whatifSuggest?.addEventListener("click", () => {
      if (this.recording || !this.summary || !this.engine.suggestEdits) return
      try {
        const list = this.engine.suggestEdits(null, { limit: 8 })
        this.els.whatifEdits.value = list.join("\n")
        this.setStatus("ok", `✨ ${list.length} candidate API calls read off the live document`)
      } catch (err) {
        this.setStatus("err", String(err.message || err))
      }
    })
  }

  async runWhatIf() {
    if (this.recording || !this.summary || !this.engine.whatIf) return
    const edits = (this.els.whatifEdits?.value ?? "").split("\n").map((s) => s.trim()).filter(Boolean)
    if (!edits.length) {
      this.setStatus("ok", "what-if: add one edit per line first")
      return
    }
    const probe = (this.els.whatifProbe?.value ?? "").trim() || null
    // hypotheses need a parked machine: walk back off idle end/timer markers
    let pos = this.engine.pos
    const trace = this.engine.trace
    while (pos > 0 && !trace[pos]?.entry) pos--
    if (!trace[pos]?.entry) {
      this.setStatus("err", "no parked step to fork from")
      return
    }
    this.stopPlay()
    this.recording = true
    this.els.runBtn.disabled = true
    this.setStatus("busy", `⑂ exploring ${edits.length} counterfactual timeline${edits.length > 1 ? "s" : ""} from step ${pos}…`)
    try {
      const rows = await this.engine.whatIf(pos, edits, { probe, scan: !!probe })
      this.summary = this.engine.summary() // cow stats now include the new timelines
      this.renderWhatIfResults(pos, probe, rows)
      this.renderBranches()
      this.renderMemory()
      this.setStatus("ok", `⑂ ${rows.length} timelines explored from step ${pos} — all jumpable`)
    } catch (err) {
      this.setStatus("err", "what-if failed")
      this.evalEntries.push({ visibleAt: 0, level: "error", text: String(err.message || err) })
      this.renderConsole()
      console.error(err)
    } finally {
      this.recording = false
      this.els.runBtn.disabled = false
    }
  }

  /** "?⑂ inputs": which ?param / storage value / message reaches the goal? */
  async runParamSearch() {
    if (this.recording || !this.summary || !this.engine.exploreParams) return
    const goal = (this.els.whatifProbe?.value ?? "").trim()
    if (!goal) {
      this.setStatus("ok", "input search: put a goal expression in the probe field first")
      return
    }
    this.stopPlay()
    this.recording = true
    this.els.runBtn.disabled = true
    this.setStatus("busy", "?⑂ probing external inputs — learning values from the code's own branches…")
    try {
      const r = await this.engine.exploreParams({
        goal,
        onProgress: (p) => this.setStatus("busy", `?⑂ round ${p.round} · ${p.explored} runs · ${p.found} satisfy the goal`),
      })
      this.summary = this.engine.summary()
      this.renderParamResults(goal, r)
      this.renderBranches()
      this.renderMemory()
      this.setStatus(
        "ok",
        r.alreadyTrue
          ? "the goal already holds on this run"
          : `?⑂ ${r.examples.length} of ${r.explored} learned candidate runs reach the goal`,
      )
    } catch (err) {
      this.setStatus("err", String(err.message || err))
    } finally {
      this.recording = false
      this.els.runBtn.disabled = false
    }
  }

  /** provenance chain of a learned value: probe → startsWith "pref:" → eq "gold" */
  viaText(assignments) {
    const parts = []
    for (const a of assignments ?? []) {
      for (const v of a.via ?? []) {
        if (v.op === "probe") parts.push("probe")
        else if (v.op === "discovered") parts.push(`discovered under ${v.under}`)
        else if (v.op === "as-run" || v.op === "seed") parts.push(`${v.op} "${v.value}"`)
        else parts.push(`${v.op}${v.key ? ` .${v.key}` : ""} → "${v.learned ?? ""}"${v.folded ? ` (as "${v.folded}")` : ""}`)
      }
    }
    return parts.join(" · ")
  }

  renderParamResults(goal, r) {
    const box = this.els.whatifResults
    if (!box) return
    box.textContent = ""
    box.append(el("div", "whatif-head", r.alreadyTrue ? `already true as-run · ${goal}` : `input search · goal: ${goal}`))
    for (const ex of r.examples) {
      const row = el("button", "whatif-result")
      row.append(span("whatif-edit", ex.search ?? ex.edit))
      const out = span("whatif-outcome")
      out.append(span("v-punct", `→ ${ex.steps} steps`))
      if (ex.newLines?.length) out.append(span("whatif-first", ` +${ex.newLines.length} new lines`))
      if (ex.firstTrue != null) out.append(span("whatif-first", ` first true @${ex.firstTrue}`))
      row.append(out)
      const via = this.viaText(ex.assignments)
      row.title = `a full alternate run — learned by execution: ${via || "(as given)"} — click to jump in`
      row.addEventListener("click", () => this.switchTimeline(ex.branch, ex.firstTrue ?? undefined))
      box.append(row)
    }
    if (!r.alreadyTrue && !r.examples.length) {
      box.append(el("div", "whatif-head", `no satisfying input among ${r.explored} learned candidates`))
      for (const l of (r.learned ?? []).slice(0, 6))
        box.append(el("div", "whatif-head", `learned but not sufficient: ${l.input.kind}${l.input.key ? " " + l.input.key : ""} = ${l.value}`))
    }
  }

  renderWhatIfResults(pos, probe, rows) {
    const box = this.els.whatifResults
    if (!box) return
    box.textContent = ""
    box.append(el("div", "whatif-head", `at step ${pos}${probe ? ` · probe: ${probe}` : ""}`))
    for (const r of rows) {
      const row = el("button", "whatif-result")
      row.append(span("whatif-edit", r.edit ?? "(replay)"))
      const out = span("whatif-outcome")
      if (r.error) out.append(span("v-special", `✖ ${r.error.name ?? "error"}: ${r.error.msg ?? ""}`))
      else if (r.probe) {
        out.append(span("v-punct", "→ "))
        out.append(r.probe.error ? span("v-special", "probe error") : inlinePreview(r.probe.value, 1))
      } else out.append(span("v-punct", `→ ${r.steps} steps`))
      if (r.firstTrue != null) out.append(span("whatif-first", ` first true @${r.firstTrue}`))
      row.append(out)
      row.title = `jump into this timeline (${r.steps} steps)`
      row.addEventListener("click", () => this.switchTimeline(r.branch, r.firstTrue ?? undefined))
      box.append(row)
    }
  }

  setStatus(kind, text) {
    this.els.status.className = `status-pill ${kind}`
    this.els.status.textContent = text
  }

  // ------------------------------------------------------------------ console
  _wireConsole() {
    const doFork = () => {
      if (!this.summary || this.recording) return
      const src = this.els.consoleInput.value.trim()
      this.els.consoleInput.value = ""
      this.fork(src)
    }
    this.els.consoleInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return
      if (e.shiftKey) {
        e.preventDefault()
        doFork()
        return
      }
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
    $("#fork-btn").addEventListener("click", doFork)
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
    if (this.summary && this.summary.error && pos >= this.engine.trace.length - 1) {
      const info = this.summary.error
      rows.push({
        at: pos,
        level: "error",
        text: info && info.t === "error" ? `Uncaught ${info.name}: ${info.msg}` : `Uncaught error: ${JSON.stringify(info)}`,
      })
    }
    if (!rows.length) {
      body.append(el("div", "empty-note", "no output yet at this point in time"))
      return
    }
    for (const r of rows) {
      const row = el("div", `console-row level-${r.level}`)
      row.append(span("step-tag", `@${r.at} `))
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
    this.selectedFrame = 0
    const pos = this.engine.pos
    this.els.slider.value = String(pos)
    this.els.posCur.textContent = String(pos)
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

  renderDom(ins) {
    const { domPanel, domFrame } = this.els
    if (!domPanel || !domFrame) return
    if (!ins || ins.dom == null) {
      domPanel.hidden = true
      this._lastDom = null
      return
    }
    domPanel.hidden = false
    if (ins.dom !== this._lastDom) {
      this._lastDom = ins.dom
      domFrame.srcdoc = ins.dom
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
    const ins = this.engine.inspect() // {stack, frames, globals} — innermost first
    this.renderDom(ins)
    const entry = this.currentEntry()
    const frameIdx = Math.min(this.selectedFrame ?? 0, Math.max(0, (ins.frames?.length ?? 1) - 1))
    varsHint.textContent = entry && entry.l ? `line ${entry.l}` : entry?.end ? "program finished" : ""

    const tree = el("div", "vtree")
    const locals = ins.frames?.[frameIdx] ?? []
    if (locals.length) {
      const fname = ins.stack?.[frameIdx]?.name
      tree.append(el("div", "vgroup-title", frameIdx === 0 ? "in scope" : `frame: ${fname || "(anonymous)"}`))
      for (const [k, v] of locals) tree.append(treeRow(k, v, "vkey vkey-local", v && (v.t === "arr" || v.t === "obj") && this._smallEnough(v)))
    }
    if (ins.globals && ins.globals.length) {
      tree.append(el("div", "vgroup-title", "top level & globals"))
      for (const [k, v] of ins.globals) tree.append(treeRow(k, v, "vkey"))
    }
    if (!tree.childElementCount) tree.append(el("div", "empty-note", this.engine.pos === 0 ? "before first statement — step forward" : "no visible variables here"))
    varsBody.append(tree)

    // call stack: innermost first; rows click-select the frame to inspect
    const stack = ins.stack ?? []
    const rows = stack.map((f, i) => ({ fn: f.name || "(anonymous)", line: f.line, idx: i }))
    if (!rows.length) rows.push({ fn: entry?.end ? "(finished)" : "(top level)", line: entry?.l ?? 0, idx: 0 })
    rows.forEach((r) => {
      const row = el("div", "stack-row" + (r.idx === frameIdx ? " stack-top" : ""))
      row.style.cursor = "pointer"
      row.append(el("span", "stack-fn", r.fn))
      row.append(el("span", "stack-loc", r.line ? `line ${r.line}` : ""))
      row.addEventListener("click", () => {
        this.selectedFrame = r.idx
        this.renderInspection()
      })
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
    const N = Math.max(1, t.length - 1)
    const x = (p) => (p / N) * W

    // depth area chart
    let maxD = 1
    for (const entry of t) if (entry.d > maxD) maxD = entry.d
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let i = 0; i < t.length; i++) {
      ctx.lineTo(x(i), H - 6 - ((t[i].d || 0) / maxD) * (H - 18))
    }
    ctx.lineTo(W, H)
    ctx.closePath()
    ctx.fillStyle = "rgba(139, 124, 246, 0.22)"
    ctx.fill()

    // error zone at the end of a crashed program
    if (this.summary.error) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.18)"
      ctx.fillRect(x(Math.max(0, t.length - 2)), 0, W, H)
    }
    // per-step COW dirty pages — brightness = how much memory that step touched
    const dirty = this.summary.dirtyCounts ?? []
    if (dirty.length > 1) {
      let maxDirty = 1
      for (let i = 1; i < dirty.length; i++) if (dirty[i] > maxDirty) maxDirty = dirty[i]
      for (let i = 1; i < dirty.length; i++) {
        const frac = Math.min(1, dirty[i] / maxDirty)
        if (frac <= 0.02) continue
        ctx.strokeStyle = `rgba(77, 208, 225, ${0.15 + frac * 0.7})`
        ctx.beginPath()
        ctx.moveTo(x(i), H - 4)
        ctx.lineTo(x(i), H - 4 - 3 - frac * 14)
        ctx.stroke()
      }
    }
    // console events
    for (const entry of this.engine.consoleEntries) {
      ctx.fillStyle = entry.level === "error" ? "#f87171" : entry.level === "warn" ? "#fbbf24" : "#4ade80"
      ctx.beginPath()
      ctx.arc(x(Math.min(entry.visibleAt, N)), 5, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
    // timer markers
    for (let i = 0; i < t.length; i++) {
      if (t[i].timer) {
        ctx.fillStyle = "#fbbf24"
        ctx.fillRect(x(i) - 1.5, 10, 3, 3)
      }
    }
    // breakpoint hits
    if (this.breakpoints.size) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.8)"
      for (let i = 0; i < t.length; i++) {
        if (t[i].entry && this.breakpoints.has(t[i].l)) ctx.fillRect(x(i) - 1, H - 3, 2, 3)
      }
    }
    // fork point — where this timeline diverged from the recording before it
    if (this.summary.forkedAt != null) {
      const fx = x(Math.min(this.summary.forkedAt, N))
      ctx.strokeStyle = "rgba(240, 164, 93, 0.85)"
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(fx, 0)
      ctx.lineTo(fx, H)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = "#f0a45d"
      ctx.font = "11px system-ui, sans-serif"
      ctx.fillText("⑂", fx + 4, 11)
    }
    // needle
    const px = x(Math.min(this.engine.pos, N))
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
    stat("snapshots (1/step)", String(cow.snapshots))
    stat("page size", "1 KB")
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

    // per-step dirty pages (downsampled into bins)
    {
      const dpr = window.devicePixelRatio || 1
      const W = cpCanvas.clientWidth || 300
      const H = 42
      cpCanvas.width = W * dpr
      cpCanvas.height = H * dpr
      const c = cpCanvas.getContext("2d")
      c.scale(dpr, dpr)
      c.clearRect(0, 0, W, H)
      const dirty = this.summary.dirtyCounts ?? []
      if (dirty.length > 1) {
        const bins = Math.min(dirty.length - 1, Math.floor(W / 3))
        const per = (dirty.length - 1) / bins
        const binned = []
        for (let b = 0; b < bins; b++) {
          let m = 0
          for (let i = Math.floor(1 + b * per); i < Math.floor(1 + (b + 1) * per) && i < dirty.length; i++) {
            if (dirty[i] > m) m = dirty[i]
          }
          binned.push(m)
        }
        const maxDirty = Math.max(1, ...binned)
        const activeBin = Math.min(bins - 1, Math.floor((this.engine.pos - 1) / per))
        binned.forEach((v, b) => {
          const h = Math.max(1, (v / maxDirty) * (H - 6))
          c.fillStyle = b === activeBin ? "#4dd0e1" : "rgba(139, 124, 246, 0.55)"
          c.fillRect(b * (W / bins), H - 2 - h, Math.max(1.5, W / bins - 1), h)
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
        const pageCount = Math.ceil(this.summary.memBytes / 1024)
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
