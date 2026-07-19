// The multiverse: forking RETAINS the abandoned future as a sibling
// timeline. All timelines share one content-deduplicated page pool, so a
// branch costs only what it diverges on; navigation between any two
// moments of any two timelines walks the tree through their common
// ancestor. whatIf() forks candidate edits off the same moment (the
// breadth-first frontier) and searchAll() BFS-scans a predicate across
// every state of every timeline, visiting each state exactly once.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TimeTravelEngine } from "../src/engine.js"

let engine
before(async () => {
  const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
  engine = await TimeTravelEngine.create(bytes)
})

const SUM_PROG = `let x = 0;
for (let i = 1; i <= 6; i++) {
  x = x + i;
}
console.log(x);
`

const evalNum = (src) => {
  const r = engine.consoleEval(src)
  assert.equal(r.error, undefined, `eval ${src}: ${JSON.stringify(r.error)}`)
  return r.value.v
}

/** positions parked at a given 1-based source line, in the current view */
const parksAtLine = (line) =>
  engine.trace.map((e, i) => (e.l === line ? i : -1)).filter((i) => i >= 0)

test("forking retains the abandoned future as a sibling timeline", async () => {
  const summary = await engine.run(SUM_PROG)
  assert.equal(summary.error, null)
  const rootSteps = engine.trace.length
  engine.positionTo(rootSteps - 1)
  assert.equal(evalNum("x"), 21)

  // fork at the 4th visit to the loop body (x === 6, i === 4 pending)
  const forkPos = parksAtLine(3)[3]
  engine.positionTo(forkPos)
  assert.equal(evalNum("x"), 6)
  const forked = await engine.forkFrom(forkPos, "x = 100")
  assert.equal(forked.error, null)
  assert.equal(forked.branch, 1)
  engine.positionTo(engine.trace.length - 1)
  assert.equal(evalNum("x"), 115, "edited future: 100 + 4 + 5 + 6")

  // the ORIGINAL timeline is still there, untouched
  const tl = engine.timelines()
  assert.equal(tl.length, 2)
  assert.equal(tl[0].id, 0)
  assert.equal(tl[1].parentId, 0)
  assert.equal(tl[1].forkedAt, forkPos)
  assert.equal(tl[1].edit, "x = 100")
  engine.switchTo(0)
  assert.equal(engine.trace.length, rootSteps, "abandoned future fully retained")
  assert.equal(evalNum("x"), 21, "root future unchanged by the fork")
  // console history of the root still ends with its own log
  const rootLog = engine.consoleEntries.at(-1)
  assert.equal(rootLog.parts[0].v, 21)
  // the fork's composite console inherits only the pre-fork prefix
  engine.switchTo(1)
  assert.equal(engine.consoleEntries.at(-1).parts[0].v, 115)
})

test("cross-branch navigation is exact at every step, both directions", async () => {
  await engine.run(SUM_PROG)
  const steps = engine.trace.length
  // guarded: at state 0 the `let x` binding does not exist yet
  const readX = () => evalNum(`typeof x === "undefined" ? -999 : x`)
  // oracle: x at every root position
  const rootX = []
  for (let p = 0; p < steps; p++) {
    engine.positionTo(p)
    rootX.push(readX())
  }
  const forkPos = parksAtLine(3)[2]
  await engine.forkFrom(forkPos, "x = 50")
  const forkSteps = engine.trace.length
  const forkX = []
  for (let p = 0; p < forkSteps; p++) {
    engine.positionTo(p)
    forkX.push(readX())
  }
  // prefix states are literally shared
  for (let p = 0; p <= forkPos; p++) assert.equal(forkX[p], rootX[p], `shared prefix @${p}`)
  assert.notEqual(forkX.at(-1), rootX.at(-1))

  // bounce across the fork boundary repeatedly, far apart and adjacent
  const probes = [
    [0, steps - 1],
    [1, forkSteps - 1],
    [0, forkPos],
    [1, forkPos + 1],
    [0, 0],
    [1, forkSteps - 2],
    [0, steps - 2],
    [1, 0],
  ]
  for (const [b, p] of probes) {
    engine.switchTo(b, p)
    const want = b === 0 ? rootX[p] : forkX[p]
    assert.equal(readX(), want, `branch ${b} @${p}`)
    assert.equal(engine.branch, b)
    assert.equal(engine.pos, p)
  }
})

test("a fork inside a shared prefix hangs off the ancestor that owns it", async () => {
  await engine.run(SUM_PROG)
  const parks = parksAtLine(3)
  await engine.forkFrom(parks[4], "x = 100") // branch 1, child of root
  // current view is branch 1; fork at a position INSIDE the root prefix
  await engine.forkFrom(parks[1], "x = 7") // branch 2 — sibling, not grandchild
  // and one inside branch 1's OWN segment
  engine.switchTo(1)
  const ownPos = engine.trace.length - 3
  await engine.forkFrom(ownPos, null) // branch 3 — child of branch 1
  const tl = engine.timelines()
  assert.deepEqual(
    tl.map((t) => [t.id, t.parentId, t.depth]),
    [
      [0, null, 0],
      [1, 0, 1],
      [2, 0, 1],
      [3, 1, 2],
    ],
  )
  // the pure replay (no edit) reproduces its parent's future exactly
  engine.switchTo(3)
  const replayed = evalNum("x")
  engine.switchTo(1)
  assert.equal(evalNum("x"), replayed, "no-edit fork replays the identical future")
})

test("BFS search visits every state of every timeline exactly once", async () => {
  await engine.run(SUM_PROG)
  const parks = parksAtLine(3)
  await engine.forkFrom(parks[3], "x = 100")
  engine.switchTo(0)
  await engine.forkFrom(parks[1], "x = 40")
  const tl = engine.timelines()
  const ownSteps = (t) => t.steps - (t.forkedAt == null ? 0 : t.forkedAt + 1)
  const totalStates = tl.reduce((n, t) => n + ownSteps(t), 0)

  const { hits, visited, errors } = engine.searchAll("true", { limit: 100000 })
  assert.equal(errors, 0)
  assert.equal(visited, totalStates, "each state visited exactly once — shared prefixes not re-scanned")
  assert.equal(hits.length, totalStates)
  // breadth-first: all root states first (pos ascending), then branch 1's
  // own states, then branch 2's
  const branchOrder = [...new Set(hits.map((h) => h.branch))]
  assert.deepEqual(branchOrder, [0, 1, 2])
  const rootHits = hits.filter((h) => h.branch === 0).map((h) => h.pos)
  assert.deepEqual(rootHits, [...Array(tl[0].steps).keys()])
  for (const t of tl.slice(1)) {
    const own = hits.filter((h) => h.branch === t.id).map((h) => h.pos)
    assert.equal(own.length, ownSteps(t))
    assert.equal(own[0], t.forkedAt + 1, "a branch's own states start right after its fork point")
  }
})

test("searchAll finds the timeline where the invariant breaks", async () => {
  await engine.run(`let balance = 10;
const charges = [2, 3, 1, 2];
for (const c of charges) {
  balance -= c;
}
console.log(balance);
`)
  engine.positionTo(engine.trace.length - 1)
  assert.equal(evalNum("balance"), 2, "root never goes negative")
  const forkPos = parksAtLine(4)[1]
  const forked = await engine.forkFrom(forkPos, "balance = 1")
  const { hits } = engine.searchAll("balance < 0", { limit: 1000 })
  assert.ok(hits.length > 0, "the counterfactual timeline breaks the invariant")
  assert.ok(
    hits.every((h) => h.branch === forked.branch),
    "no hit on the original timeline",
  )
  assert.ok(hits[0].pos > forkPos)
  // the hit is jumpable: switch to that exact moment
  engine.switchTo(hits[0].branch, hits[0].pos)
  assert.ok(evalNum("balance") < 0)
})

test("whatIf: a counterfactual table over candidate edits at one moment", async () => {
  const summary = await engine.run(`let x = 3;
let y = 0;
y = x * 2;
if (y > 10) { throw new Error("boom"); }
console.log("ok", y);
`)
  assert.equal(summary.error, null)
  const pos = parksAtLine(3)[0]
  engine.positionTo(pos)
  const beforeBranch = engine.branch
  const rows = await engine.whatIf(pos, ["x = 10", "x = 5", "x = 0"], { probe: "y", scan: true })

  assert.equal(rows.length, 3)
  assert.ok(rows[0].error && rows[0].error.t === "error", "x=10 → y=20 → boom")
  assert.equal(rows[0].error.name, "Error")
  assert.equal(rows[1].error, null)
  assert.equal(rows[1].probe.value.v, 10, "x=5 → y=10, no throw")
  assert.equal(rows[2].error, null)
  assert.equal(rows[2].probe.value.v, 0, "x=0 → y stays 0")
  // scan: first state where the probe turns truthy — never for y=0
  assert.ok(rows[0].firstTrue != null && rows[0].firstTrue > pos)
  assert.ok(rows[1].firstTrue != null)
  assert.equal(rows[2].firstTrue, null)
  // the view returned to where it was; all hypotheses remain jumpable
  assert.equal(engine.branch, beforeBranch)
  assert.equal(engine.pos, pos)
  assert.equal(engine.timelines().length, 4)
  engine.switchTo(rows[0].branch)
  assert.equal(evalNum("y"), 20)
  const err = engine.summary()
  assert.equal(err.error.name, "Error")
})

test("the multiverse shares pages: forks cost their divergence, not a recording", async () => {
  await engine.run(`const arr = [];
for (let i = 0; i < 120; i++) {
  arr.push(i);
}
console.log(arr.length);
`)
  const alone = engine.summary().cow.retainedBytes
  const forkPos = engine.trace.length - 8
  await engine.forkFrom(forkPos, "arr[0] = -1")
  engine.switchTo(0)
  await engine.forkFrom(forkPos, "arr[1] = -2")
  engine.switchTo(0)
  await engine.forkFrom(forkPos, null)
  const withThree = engine.summary().cow.retainedBytes
  assert.ok(
    withThree < alone * 1.7,
    `three timelines nearly free: ${alone} → ${withThree} bytes (${(withThree / alone).toFixed(2)}×)`,
  )
})

test("pruning a timeline frees its pages and re-roots the view", async () => {
  await engine.run(SUM_PROG)
  const forkPos = parksAtLine(3)[2]
  const forked = await engine.forkFrom(forkPos, "x = 1000")
  await engine.forkFrom(engine.trace.length - 2, null) // grandchild of root via branch 1
  const before = engine.summary().cow.retainedBytes
  assert.equal(engine.timelines().length, 3)

  // prune while VIEWING inside the doomed subtree: view lands on the base state
  const dead = engine.pruneBranch(forked.branch)
  assert.deepEqual(dead.sort(), [1, 2], "descendants pruned with their ancestor")
  assert.equal(engine.branch, 0)
  assert.equal(engine.pos, forkPos)
  assert.equal(engine.timelines().length, 1)
  assert.ok(engine.summary().cow.retainedBytes <= before)
  assert.throws(() => engine.switchTo(forked.branch))
  // the surviving timeline still navigates end to end
  engine.positionTo(engine.trace.length - 1)
  assert.equal(evalNum("x"), 21)
  engine.positionTo(1)
  assert.equal(evalNum("x"), 0)
})

test("DOM multiverse: what-if over document edits, search across documents", async () => {
  await engine.run(
    `const l = document.getElementById("l");
for (let i = 0; i < 3; i++) {
  const li = document.createElement("li");
  li.textContent = "x" + i;
  l.appendChild(li);
}
console.log(l.children.length);
`,
    { html: `<ul id="l"></ul>` },
  )
  // first moment with exactly two list items
  const two = engine.searchAll("document.querySelectorAll('li').length === 2", { limit: 1 })
  assert.ok(two.hits.length === 1)
  const pos = two.hits[0].pos

  const rows = await engine.whatIf(
    pos,
    [
      "document.querySelectorAll('li')[0].classList.add('done')",
      "document.getElementById('l').firstElementChild.remove()",
    ],
    { probe: "document.querySelectorAll('.done').length", scan: true },
  )
  assert.equal(rows[0].probe.value.v, 1)
  assert.ok(rows[0].firstTrue != null)
  assert.equal(rows[1].probe.value.v, 0)
  assert.equal(rows[1].firstTrue, null)

  // three timelines, three different final documents
  engine.switchTo(0)
  const domRoot = engine.inspect().dom
  engine.switchTo(rows[0].branch)
  const domDone = engine.inspect().dom
  engine.switchTo(rows[1].branch)
  const domRemoved = engine.inspect().dom
  assert.equal((domRoot.match(/<li/g) || []).length, 3)
  assert.match(domDone, /class="done"/)
  assert.equal((domDone.match(/<li/g) || []).length, 3)
  assert.equal((domRemoved.match(/<li/g) || []).length, 2)
  assert.ok(!domRemoved.includes("done"))
  // the divergence is searchable across the whole multiverse
  const done = engine.searchAll("document.querySelector('.done') !== null", { limit: 1000 })
  assert.ok(done.hits.length > 0)
  assert.ok(done.hits.every((h) => h.branch === rows[0].branch))
})
