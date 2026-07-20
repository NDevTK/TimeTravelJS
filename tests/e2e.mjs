// End-to-end test: loads the site in headless Chromium, records the default
// sample, travels through time, and checks the panels.
//   npm run test:e2e
import { chromium } from "playwright-core"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import assert from "node:assert/strict"
import { existsSync, statSync } from "node:fs"

const PORT = 8643
const server = spawn(process.execPath, ["tools/serve.mjs", String(PORT)], { stdio: "inherit" })
const kill = () => {
  try {
    server.kill()
  } catch {}
}
process.on("exit", kill)

async function launchChromium() {
  const preset = "/opt/pw-browsers/chromium"
  if (existsSync(preset) && !statSync(preset).isDirectory()) {
    return chromium.launch({ executablePath: preset })
  }
  return chromium.launch()
}

await sleep(400)
const browser = await launchChromium()
const page = await browser.newPage()
const pageErrors = []
page.on("pageerror", (e) => pageErrors.push(String(e)))
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(msg.text())
})

console.log("→ loading page")
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" })

// the page auto-records the default sample on load
await page.waitForFunction(
  () => window.__timetravel && window.__timetravel.ui.summary && !window.__timetravel.ui.recording,
  null,
  { timeout: 120000 },
)

const summary = await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  return { steps: ui.summary.steps, cow: ui.summary.cow, pos: engine.pos, error: ui.summary.error }
})
console.log("recorded:", summary.steps, "steps · COW savings", (summary.cow.savings * 100).toFixed(2) + "%")
assert.ok(summary.steps > 50, "expected a real recording")
assert.equal(summary.error, null)
assert.equal(summary.pos, summary.steps - 1, "parked at the end")
assert.equal(summary.cow.snapshots, summary.steps, "one resumable snapshot per step")
assert.ok(summary.cow.savings > 0.9, "per-step COW sharing")

const status = await page.textContent("#status-pill")
console.log("status:", status)
assert.match(status, /steps/)

// console panel shows the sorted output at the end
const consoleText = await page.textContent("#console-body")
assert.match(consoleText, /sorted:/, "bubble sort output visible at end")

// --- travel: jump to start — console must be empty there
await page.click("#btn-start")
const consoleAtStart = await page.textContent("#console-body")
assert.match(consoleAtStart, /no output yet/, "console is time-sliced")

// --- step forward a few times, variables appear
await page.click("#btn-fwd")
await page.click("#btn-fwd")
await page.click("#btn-fwd")
const vars = await page.textContent("#vars-body")
assert.match(vars, /numbers|bubbleSort/, "variables panel shows program state")

// --- scrub to the middle and check the array is mid-sort (globals hold lexicals)
const midCheck = await page.evaluate(() => {
  const { engine } = window.__timetravel
  const N = engine.trace.length
  engine.positionTo(Math.floor(N / 2))
  const ins = engine.inspect()
  const nums = ins.globals.find(([k]) => k === "numbers")?.[1]
  return { n: nums?.n, items: nums?.items.map((x) => x.v) }
})
console.log("mid-sort numbers:", midCheck.items?.join(","))
assert.equal(midCheck.n, 7)

// --- breakpoint + reverse continue via UI (line 11 = swaps++)
await page.evaluate(() => {
  const { ui, engine } = window.__timetravel
  ui.breakpoints.add(11)
  engine.positionTo(engine.trace.length - 1)
  ui.syncPosition()
})
await page.click("#btn-rev-continue")
const bpEntry = await page.evaluate(() => {
  const { engine } = window.__timetravel
  return engine.trace[engine.pos]
})
assert.equal(bpEntry.l, 11, "reverse-continue lands on the breakpoint line")

// --- call stack shows the function; deep-frame locals visible
const stackInfo = await page.evaluate(() => {
  const { engine } = window.__timetravel
  const ins = engine.inspect()
  return { stack: ins.stack.map((f) => f.name), swaps: ins.frames[0]?.find(([k]) => k === "swaps")?.[1] }
})
console.log("stack at breakpoint:", stackInfo.stack.join(" > "), "| swaps =", JSON.stringify(stackInfo.swaps))
assert.equal(stackInfo.stack[0], "bubbleSort")
assert.equal(stackInfo.swaps?.t, "num")

// --- console eval reads state at the paused position
await page.fill("#console-input", "swaps + ':' + numbers.length")
await page.press("#console-input", "Enter")
const consoleAfterEval = await page.textContent("#console-body")
assert.match(consoleAfterEval, /:7/, "eval result visible")

// --- fork: apply an edit at the paused frame and re-record the future
const forkPos = await page.evaluate(() => window.__timetravel.engine.pos)
await page.fill("#console-input", "swaps = 100")
await page.press("#console-input", "Shift+Enter")
await page.waitForFunction(
  () => !window.__timetravel.ui.recording && window.__timetravel.ui.summary?.forkedAt != null,
  null,
  { timeout: 120000 },
)
const fork = await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  return { forkedAt: ui.summary.forkedAt, steps: ui.summary.steps, error: ui.summary.error }
})
console.log("forked at", fork.forkedAt, "→", fork.steps, "steps on the new timeline")
assert.equal(fork.forkedAt, forkPos, "fork anchored at the paused step")
assert.equal(fork.error, null)
assert.ok(fork.steps > fork.forkedAt + 3, "a new future was recorded")
const consoleAfterFork = await page.textContent("#console-body")
assert.match(consoleAfterFork, /forked here/, "fork note visible in the console")
// paused BEFORE the final swaps++ with swaps = 100 ⇒ the re-recorded future logs 101
assert.match(consoleAfterFork, /swaps: 101/, "the edit changed the recorded future")
assert.match(await page.textContent("#status-pill"), /forked/)
// the shared prefix is still navigable after the fork
const preForkNums = await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  engine.positionTo(Math.floor(ui.summary.forkedAt / 2))
  ui.syncPosition()
  return engine.inspect().globals.find(([k]) => k === "numbers")?.[1]?.n
})
assert.equal(preForkNums, 7, "pre-fork history intact")

// --- the multiverse: the abandoned future is a clickable sibling timeline
const strip = await page.evaluate(() => {
  const chips = [...document.querySelectorAll(".branch-chip")]
  return { hidden: document.querySelector("#branch-strip").hidden, labels: chips.map((c) => c.textContent) }
})
assert.equal(strip.hidden, false, "branch strip appears once a fork exists")
assert.equal(strip.labels.length, 2, "main + fork")
await page.click(".branch-chip") // first chip = main
await page.waitForFunction(() => window.__timetravel.engine.branch === 0)
// the fork paused before the final swaps++ with swaps=12, so the original
// future ends with 13 — and the forked one (swaps=100) ended with 101
const backOnMain = await page.textContent("#console-body")
assert.match(backOnMain, /swaps: 13/, "the ORIGINAL future is intact and visible again")
assert.ok(!/swaps: 101/.test(backOnMain), "no bleed-through from the forked timeline")
console.log("branch strip: fork retained, original timeline restored on click")

// --- "when" search: the story of one expression through the timeline
await page.fill("#whatif-probe", "swaps")
await page.click("#whatif-when")
const whenRows = await page.evaluate(() => [...document.querySelectorAll(".whatif-result")].map((r) => r.textContent))
assert.ok(whenRows.length >= 3, `swaps changed value several times (${whenRows.length} rows)`)
const lastRowText = whenRows[whenRows.length - 1]
await page.click(".whatif-result:last-child")
const afterJump = await page.evaluate(() => window.__timetravel.engine.pos)
assert.match(lastRowText, new RegExp(`step ${afterJump}(\\D|$)`), "clicking a change row jumps to that step")
console.log("when search:", whenRows.length, "value changes for swaps — row click jumped to step", afterJump)

// --- changed-value highlight: stepping lights up mutated variables
await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  engine.positionTo(Math.floor(engine.trace.length / 2))
  ui.syncPosition()
})
let changedRows = 0
for (let i = 0; i < 5 && !changedRows; i++) {
  await page.click("#btn-fwd")
  changedRows = await page.evaluate(() => document.querySelectorAll(".vrow.vchanged").length)
}
assert.ok(changedRows >= 1, "stepping highlights the variables whose values changed")
console.log("changed-var highlight:", changedRows, "row(s) lit after stepping")

// --- what-if: counterfactual fan-out + BFS probe scan, from mid-recording
await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  engine.positionTo(Math.floor(engine.trace.length / 2))
  ui.syncPosition()
})
await page.fill("#whatif-edits", "swaps = 500\nswaps = -500")
await page.fill("#whatif-probe", "swaps > 400")
await page.click("#whatif-run")
await page.waitForFunction(
  () => !window.__timetravel.ui.recording && document.querySelectorAll(".whatif-result").length === 2,
  null,
  { timeout: 120000 },
)
const whatIfState = await page.evaluate(() => ({
  chips: document.querySelectorAll(".branch-chip").length,
  results: [...document.querySelectorAll(".whatif-result")].map((r) => r.textContent),
  branch: window.__timetravel.engine.branch,
}))
console.log("what-if:", JSON.stringify(whatIfState.results))
assert.equal(whatIfState.chips, 4, "two hypothetical timelines joined the strip")
assert.equal(whatIfState.branch, 0, "view returned to the original timeline")
assert.match(whatIfState.results[0], /first true @/, "probe scan found the divergence point")
assert.ok(!/first true/.test(whatIfState.results[1]), "swaps = -500 never satisfies the probe")
await page.click(".whatif-result") // jump into the first hypothesis at its divergence
const jumped = await page.evaluate(() => {
  const { engine } = window.__timetravel
  const r = engine.consoleEval("swaps")
  return { branch: engine.branch, swaps: r.value?.v }
})
assert.ok(jumped.branch >= 2, "clicked into the hypothetical timeline")
assert.equal(jumped.swaps, 500, "landed on the first state where the probe is true")
console.log("what-if: jumped into hypothesis, swaps =", jumped.swaps, "on timeline", jumped.branch)

// --- the website sample: URL-parameter constraint search through the UI
await page.selectOption("#sample-select", "website")
await page.waitForFunction(
  () => window.__timetravel.ui.summary && !window.__timetravel.ui.recording && window.__timetravel.engine.branch === 0,
  null,
  { timeout: 120000 },
)
const siteConsole = await page.textContent("#console-body")
assert.match(siteConsole, /news\.example\/\?user=ada/, "the page ran under its URL")
assert.match(siteConsole, /theme: light/, "no theme param → default")
await page.fill("#whatif-probe", '!document.getElementById("beta-panel").classList.contains("hidden")')
await page.click("#whatif-params")
await page.waitForFunction(
  () => !window.__timetravel.ui.recording && document.querySelectorAll(".whatif-result").length >= 1,
  null,
  { timeout: 120000 },
)
const paramResults = await page.evaluate(() =>
  [...document.querySelectorAll(".whatif-result")].map((r) => r.textContent),
)
console.log("param search:", JSON.stringify(paramResults))
assert.ok(
  paramResults.some((r) => r.includes("beta=1") && r.includes("user=ada")),
  "found ?beta=1 (keeping the original params) as the feature enabler",
)
await page.click(".whatif-result")
const paramJump = await page.evaluate(() => {
  const { engine } = window.__timetravel
  return {
    branch: engine.branch,
    beta: engine.consoleEval('new URLSearchParams(location.search).get("beta")').value?.v,
    panelShown: engine.consoleEval('!document.getElementById("beta-panel").classList.contains("hidden")').value?.v,
  }
})
assert.ok(paramJump.branch > 0, "jumped into the discovered URL's timeline")
assert.equal(paramJump.beta, "1")
assert.equal(paramJump.panelShown, true)
console.log("param search: jumped into ?beta=1 run — panel visible on timeline", paramJump.branch)

// --- crash sample: error surfaces, timeline navigable, stack panel shows frames
await page.selectOption("#sample-select", "crash")
await page.waitForFunction(
  () => window.__timetravel.ui.summary && !window.__timetravel.ui.recording,
  null,
  { timeout: 120000 },
)
const crash = await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  const N = engine.trace.length
  engine.positionTo(N - 2)
  ui.syncPosition()
  const ins = engine.inspect()
  return { error: ui.summary.error, stack: ins.stack.map((f) => f.name) }
})
console.log("crash error:", JSON.stringify(crash.error).slice(0, 80), "| stack:", crash.stack.join(" > ") || "(top)")
assert.ok(crash.error && crash.error.t === "error", "crash recorded")
assert.equal(
  await page.evaluate(() => document.querySelector("#branch-strip").hidden),
  true,
  "a fresh recording resets the multiverse",
)
const statusCrash = await page.textContent("#status-pill")
assert.match(statusCrash, /crash/i)

// memory panel populated
const memText = await page.textContent("#mem-stats")
assert.match(memText, /COW actually keeps/)

// --- opcode granularity: re-record the crash sample at VM-instruction steps
const lineStepsCrash = await page.evaluate(() => window.__timetravel.ui.summary.steps)
await page.selectOption("#granularity-select", "opcode")
await page.waitForFunction(
  (prev) => {
    const ui = window.__timetravel.ui
    return ui.summary && !ui.recording && ui.summary.steps !== prev
  },
  lineStepsCrash,
  { timeout: 120000 },
)
const opcodeSteps = await page.evaluate(() => window.__timetravel.ui.summary.steps)
console.log("granularity: line =", lineStepsCrash, "steps, opcode =", opcodeSteps, "steps")
assert.ok(opcodeSteps > lineStepsCrash * 2, "opcode granularity records much finer steps")

const fatal = pageErrors.filter((e) => !/favicon/.test(e))
if (fatal.length) {
  console.error("PAGE ERRORS:", fatal)
  process.exit(1)
}

await browser.close()
kill()
console.log("E2E OK ✓")
process.exit(0)
