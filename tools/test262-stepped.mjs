// Run a sample of tc39/test262 through the TimeTravelJS engine WITH
// STEPPING ENABLED — every step a COW snapshot — and let each test's own
// assertions be the verdict. Proves that recording does not alter language
// semantics.
//
//   node tools/test262-stepped.mjs <path-to-test262> [subdir] [sampleEvery]
//
// e.g. node tools/test262-stepped.mjs ../test262 test/language/statements 7
//
// Handles [noStrict]/[onlyStrict]/[negative]/includes; skips [module] and
// [async] (the engine has its own event loop; async coverage lives in the
// engine test suite). Reports pass/fail plus suppressed-step counts.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { TimeTravelEngine } from "../src/engine.js"

const [, , corpus, subdir = "test/language/statements", everyArg = "7"] = process.argv
if (!corpus) {
  console.error("usage: node tools/test262-stepped.mjs <test262-dir> [subdir] [sampleEvery]")
  process.exit(2)
}
const every = Math.max(1, Number(everyArg) | 0)

const harnessDir = join(corpus, "harness")
const harnessCache = new Map()
const harness = (name) => {
  if (!harnessCache.has(name)) harnessCache.set(name, readFileSync(join(harnessDir, name), "utf8"))
  return harnessCache.get(name)
}

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith(".js") && !name.endsWith("_FIXTURE.js")) files.push(p)
  }
}
walk(join(corpus, subdir))
files.sort()
const sample = files.filter((_, i) => i % every === 0)

const meta = (src) => {
  const m = src.match(/\/\*---([\s\S]*?)---\*\//)
  const y = m ? m[1] : ""
  const flags = (y.match(/flags:\s*\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim())
  const includes = (y.match(/includes:\s*\[([^\]]*)\]/)?.[1] ??
    [...y.matchAll(/^\s*-\s*(\S+\.js)\s*$/gm)].map((x) => x[1]).join(",") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
  const negative = /negative:/.test(y)
  return { flags, includes, negative }
}

const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
const engine = await TimeTravelEngine.create(bytes)

let pass = 0, fail = 0, skip = 0, suppressedTotal = 0
const failures = []
for (const file of sample) {
  const src = readFileSync(file, "utf8")
  const { flags, includes, negative } = meta(src)
  if (flags.includes("module") || flags.includes("async") || flags.includes("CanBlockIsFalse")) {
    skip++
    continue
  }
  const preludes = ["assert.js", "sta.js", ...includes].map(harness).join("\n")
  const variants = []
  if (!flags.includes("onlyStrict")) variants.push(preludes + "\n" + src)
  if (!flags.includes("noStrict") && !flags.includes("raw"))
    variants.push('"use strict";\n' + preludes + "\n" + src)
  let ok = true
  for (const code of variants) {
    let summary
    try {
      summary = await engine.run(code, { maxSteps: 300000 })
    } catch (e) {
      ok = false
      break
    }
    suppressedTotal += summary.suppressedSteps ?? 0
    const errored = summary.error != null || summary.truncated
    if (negative ? summary.error == null : errored) {
      ok = false
      break
    }
  }
  if (ok) pass++
  else {
    fail++
    failures.push(file.slice(corpus.length + 1))
  }
}

console.log(`stepped test262 [${subdir}, every ${every}th]:`)
console.log(`  ${pass} pass, ${fail} fail, ${skip} skipped of ${sample.length} sampled (${files.length} total)`)
console.log(`  suppressed steps across all runs: ${suppressedTotal}`)
if (failures.length) {
  console.log("  failures:")
  for (const f of failures.slice(0, 20)) console.log("   -", f)
  process.exit(1)
}
