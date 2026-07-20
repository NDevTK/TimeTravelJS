// BFS constraint search: learn how the web platform API COULD have been
// used at a moment, by executing candidates against the real paused
// document. suggestEdits() reads the raw material off the live machine
// (events with actual listeners, stylesheet classes, addressable
// elements); explore() forks each candidate as a timeline, composes
// deeper levels breadth-first, and returns only execution-verified
// examples — each one a real recorded future satisfying the goal.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TimeTravelEngine } from "../src/engine.js"

let engine
before(async () => {
  const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
  engine = await TimeTravelEngine.create(bytes)
})

const TOGGLE_HTML = `<style>.done { color: green; } .hot { color: red; }</style>
<ul id="list"><li id="a">a</li><li id="b">b</li></ul><p id="status">-</p>`

const TOGGLE_PROG = `const list = document.getElementById("list");
const status = document.getElementById("status");
list.addEventListener("toggle", (e) => {
  e.target.classList.add("done");
  status.textContent = "toggled";
});
for (const li of document.querySelectorAll("li")) {
  li.addEventListener("toggle", function () { this.classList.add("done"); });
}
console.log(document.querySelectorAll("li").length);
`

test("suggestEdits reads candidate API calls off the live document", async () => {
  await engine.run(TOGGLE_PROG, { html: TOGGLE_HTML })
  const cands = engine.suggestEdits(engine.trace.length - 1, { limit: 12 })
  assert.ok(cands.length > 0 && cands.length <= 12)
  assert.ok(
    cands.some((c) => c.includes(`dispatchEvent(new Event("toggle"`)),
    "proposes the event someone is actually listening for",
  )
  assert.ok(
    cands.some((c) => c.includes(`classList.add("done")`)),
    "proposes classes the stylesheet defines",
  )
  assert.ok(
    cands.every((c) => c.startsWith("document.getElementById(")),
    "every candidate addresses a real element",
  )
  // the engine's position is untouched by suggestion
  assert.equal(engine.pos, engine.trace.length - 1)
})

test("explore synthesizes execution-verified API usage examples", async () => {
  await engine.run(TOGGLE_PROG, { html: TOGGLE_HTML })
  const pos = engine.trace.length - 1
  const goal = `document.querySelectorAll(".done").length >= 1`
  const r = await engine.explore(pos, { goal, depth: 1, maxBranches: 20 })
  assert.equal(r.alreadyTrue, false)
  assert.ok(r.examples.length >= 2, `several distinct usages satisfy the goal (got ${r.examples.length})`)
  assert.ok(
    r.examples.some((e) => e.path[0].includes("dispatchEvent")),
    "learned an event-driven usage (the listener adds the class)",
  )
  assert.ok(
    r.examples.some((e) => e.path[0].includes("classList.add")),
    "learned a direct styling usage",
  )
  // the view came home; losing hypotheses were pruned, examples kept
  assert.equal(engine.branch, 0)
  assert.equal(engine.pos, pos)
  assert.equal(engine.timelines().length, 1 + r.examples.length)
  // every example is a real, jumpable, goal-satisfying timeline
  for (const ex of r.examples) {
    assert.equal(ex.path.length, 1)
    assert.ok(ex.firstTrue != null && ex.firstTrue > 0)
    engine.switchTo(ex.branch, ex.firstTrue)
    const g = engine.consoleEval(goal)
    assert.equal(g.value.v, true, `goal holds at firstTrue on timeline ${ex.branch}`)
  }
  engine.switchTo(0)
})

test("explore composes two API calls when no single call can reach the goal", async () => {
  await engine.run(`console.log(document.querySelectorAll("li").length);`, {
    html: `<style>.only { color: red; }</style><ul id="l"><li>a</li><li>b</li></ul>`,
  })
  const remove = `document.getElementById("l").firstElementChild.remove()`
  const add = `document.querySelector("li").classList.add("only")`
  const goal = `document.querySelectorAll("li").length === 1 && document.querySelector("li").classList.contains("only")`
  const r = await engine.explore(engine.trace.length - 1, {
    goal,
    candidates: [remove, add],
    depth: 2,
  })
  assert.equal(r.examples.length, 1, "exactly one composition works")
  assert.deepEqual(r.examples[0].path, [remove, add], "remove first, then class the survivor")
  // forked at the program's last park, the hypothesis future ends instantly,
  // so the composition is applied back-to-back at the same anchor: the
  // example hangs off the root, and the failed single-call timelines go
  assert.equal(engine.timelines().length, 2, "root + the one verified composition")
  const ex = engine.timelines().find((t) => t.id === r.examples[0].branch)
  assert.equal(ex.parentId, 0)
  engine.switchTo(r.examples[0].branch)
  const g = engine.consoleEval(goal)
  assert.equal(g.value.v, true)
  engine.switchTo(0)
})

test("composition chains through the hypothesis' future when it keeps parking", async () => {
  await engine.run(`let hits = 0;
for (let i = 0; i < 6; i++) {
  hits = hits + 0;
}
console.log(hits);
`)
  // anchor mid-loop: plenty of future parks remain inside the hypothesis
  const anchor = engine.trace.map((e, i) => (e.l === 3 ? i : -1)).filter((i) => i >= 0)[1]
  const r = await engine.explore(anchor, {
    goal: `hits === 2`,
    candidates: ["hits = hits + 1"],
    depth: 2,
  })
  assert.equal(r.examples.length, 1)
  assert.deepEqual(r.examples[0].path, ["hits = hits + 1", "hits = hits + 1"])
  // true chaining: the second call forked INSIDE the first hypothesis'
  // recorded future, so the example timeline is a child of the level-1 one
  const tl = engine.timelines()
  assert.equal(tl.length, 3, "root + level-1 ancestor + example")
  const ex = tl.find((t) => t.id === r.examples[0].branch)
  assert.notEqual(ex.parentId, 0, "example hangs off the level-1 hypothesis")
  assert.ok(ex.forkedAt > anchor, "the second call happened LATER in the hypothesis' future")
  engine.switchTo(r.examples[0].branch, r.examples[0].firstTrue)
  assert.equal(engine.consoleEval("hits").value.v, 2)
  engine.switchTo(0)
})

test("a goal that already holds short-circuits without forking", async () => {
  await engine.run(`console.log(1);`, { html: `<ul><li>a</li><li>b</li></ul>` })
  const r = await engine.explore(engine.trace.length - 1, {
    goal: `document.querySelectorAll("li").length === 2`,
  })
  assert.equal(r.alreadyTrue, true)
  assert.equal(r.explored, 0)
  assert.equal(engine.timelines().length, 1)
})

test("the branch budget caps exploration and losers are pruned", async () => {
  await engine.run(`let x = 0;\nx = 1;\nconsole.log(x);`)
  const r = await engine.explore(engine.trace.length - 1, {
    goal: `x === 999`,
    candidates: ["x = 1", "x = 2", "x = 3", "x = 4", "x = 5"],
    depth: 1,
    maxBranches: 3,
  })
  assert.equal(r.explored, 3)
  assert.equal(r.budgetHit, true)
  assert.equal(r.examples.length, 0)
  assert.ok(r.pruned >= 3)
  assert.equal(engine.timelines().length, 1, "nothing satisfied, nothing retained")
})

test("explore works without a document when candidates are explicit", async () => {
  await engine.run(`let x = 0;\nx = 1;\nconsole.log(x);`)
  assert.throws(() => engine.suggestEdits(), /document/, "auto-suggestion needs a document")
  const r = await engine.explore(engine.trace.length - 1, {
    goal: `x === 5`,
    candidates: ["x = 2", "x = 5"],
    depth: 1,
  })
  assert.equal(r.examples.length, 1)
  assert.deepEqual(r.examples[0].path, ["x = 5"])
  engine.switchTo(r.examples[0].branch, r.examples[0].firstTrue)
  assert.equal(engine.consoleEval("x").value.v, 5)
})
