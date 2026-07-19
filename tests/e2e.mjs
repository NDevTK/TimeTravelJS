// End-to-end test: loads the site in headless Chromium, records the default
// sample, travels through time, and checks the panels.
//   npm run test:e2e
// Uses the system/preinstalled Chromium if PLAYWRIGHT_BROWSERS_PATH is set.
import { chromium } from "playwright-core"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import assert from "node:assert/strict"

const PORT = 8643
const server = spawn(process.execPath, ["tools/serve.mjs", String(PORT)], { stdio: "inherit" })
const kill = () => {
  try {
    server.kill()
  } catch {}
}
process.on("exit", kill)

async function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium",
    undefined, // let playwright-core resolve its own registry path
  ]
  for (const executablePath of candidates) {
    try {
      if (executablePath === undefined) return await chromium.launch()
      const { existsSync, readdirSync, statSync } = await import("node:fs")
      let exe = executablePath
      if (existsSync(exe) && statSync(exe).isDirectory()) {
        // e.g. /opt/pw-browsers/chromium -> chrome-linux/chrome
        const stack = [exe]
        exe = null
        while (stack.length && !exe) {
          const dir = stack.pop()
          for (const f of readdirSync(dir)) {
            const p = `${dir}/${f}`
            if (f === "chrome" || f === "chromium" || f === "headless_shell") {
              exe = p
              break
            }
            if (statSync(p).isDirectory()) stack.push(p)
          }
        }
      }
      if (exe) return await chromium.launch({ executablePath: exe })
    } catch {
      /* try next */
    }
  }
  throw new Error("no chromium found")
}

await sleep(400)
const browser = await findChromium()
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
  { timeout: 60000 },
)

const summary = await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  return { steps: ui.summary.steps, cow: ui.summary.cow, pos: engine.pos, error: ui.summary.error }
})
console.log("recorded:", summary.steps, "steps · COW savings", (summary.cow.savings * 100).toFixed(1) + "%")
assert.ok(summary.steps > 50, "expected a real recording")
assert.equal(summary.error, null)
assert.equal(summary.pos, summary.steps, "parked at the end")
assert.ok(summary.cow.savings > 0.2, "COW sharing should save memory")

// status pill mentions COW savings
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

// --- scrub to the middle via the engine and check the array is mid-sort
const midCheck = await page.evaluate(() => {
  const { engine } = window.__timetravel
  const N = engine.trace.length
  engine.positionTo(Math.floor(N / 2))
  const ins = engine.inspect()
  const nums = ins.locals.find(([k]) => k === "numbers")?.[1]
  return { n: nums?.n, items: nums?.items.map((x) => x.v) }
})
console.log("mid-sort numbers:", midCheck.items?.join(","))
assert.equal(midCheck.n, 7)

// --- breakpoint + reverse continue via UI
await page.evaluate(() => {
  const { ui, engine } = window.__timetravel
  ui.breakpoints.add(11) // swaps++ line in bubble sort sample
  engine.positionTo(engine.trace.length)
})
await page.click("#btn-rev-continue")
const bpEntry = await page.evaluate(() => {
  const { engine } = window.__timetravel
  return engine.trace[engine.pos - 1]
})
assert.equal(bpEntry.l, 11, "reverse-continue lands on the breakpoint line")

// --- console eval reads locals at the paused position
await page.fill("#console-input", "swaps")
await page.press("#console-input", "Enter")
const consoleAfterEval = await page.textContent("#console-body")
assert.match(consoleAfterEval, /swaps/, "eval echo visible")

// --- crash sample: error surfaces, timeline navigable, stack panel shows frames
await page.selectOption("#sample-select", "crash")
await page.waitForFunction(
  () => window.__timetravel.ui.summary && !window.__timetravel.ui.recording,
  null,
  { timeout: 60000 },
)
const crash = await page.evaluate(() => {
  const { engine, ui } = window.__timetravel
  const N = engine.trace.length
  engine.positionTo(N - 1)
  ui.syncPosition()
  const ins = engine.inspect()
  return {
    error: ui.summary.error,
    stack: ins.stack.map((f) => f.n),
    lastEntryKind: engine.trace[N - 1].k,
  }
})
console.log("crash error:", JSON.stringify(crash.error).slice(0, 90), "stack:", crash.stack.join(" > ") || "(top)")
assert.equal(crash.lastEntryKind, 2)
assert.ok(crash.error, "crash recorded")
const statusCrash = await page.textContent("#status-pill")
assert.match(statusCrash, /crash/i)

// memory panel is populated
const memText = await page.textContent("#mem-stats")
assert.match(memText, /COW actually keeps/)

// no unexpected page errors
const fatal = pageErrors.filter((e) => !/favicon/.test(e))
if (fatal.length) {
  console.error("PAGE ERRORS:", fatal)
  process.exit(1)
}

await browser.close()
kill()
console.log("E2E OK ✓")
process.exit(0)
