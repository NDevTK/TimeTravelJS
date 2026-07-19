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
const statusCrash = await page.textContent("#status-pill")
assert.match(statusCrash, /crash/i)

// memory panel populated
const memText = await page.textContent("#mem-stats")
assert.match(memText, /COW actually keeps/)

const fatal = pageErrors.filter((e) => !/favicon/.test(e))
if (fatal.length) {
  console.error("PAGE ERRORS:", fatal)
  process.exit(1)
}

await browser.close()
kill()
console.log("E2E OK ✓")
process.exit(0)
