// Full engine tests against the real QuickJS WebAssembly VM (runs in Node).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { TimeTravelEngine } from "../src/engine.js"

let engine
before(async () => {
  engine = await TimeTravelEngine.create()
})
after(() => {
  engine.dispose()
})

const findLocal = (ins, name) => ins.locals?.find(([k]) => k === name)?.[1]

test("record → rewind → replay round-trips state exactly", async () => {
  const summary = await engine.run(`
    function fib(n) { return n <= 1 ? n : fib(n - 1) + fib(n - 2); }
    const results = [];
    for (let i = 0; i <= 7; i++) {
      results.push(fib(i));
    }
    console.log("fibs", results.join(","));
  `)
  assert.equal(summary.error, null)
  assert.ok(summary.steps > 50)
  assert.ok(summary.cow.snapshots >= 2)
  assert.ok(summary.cow.savings > 0, "COW must save memory vs naive copies")

  const N = engine.trace.length
  // find the 3rd top-level visit of the loop body statement (line 5)
  let hits = 0
  let pos = 0
  for (let i = 0; i < N; i++) {
    const t = engine.trace[i]
    if (t.k === 0 && t.d === 0 && t.l === 5 && ++hits === 3) {
      pos = i + 1
      break
    }
  }
  assert.ok(pos > 0)
  engine.positionTo(pos)
  const rewound = findLocal(engine.inspect(), "results")
  assert.equal(rewound.n, 2, "at 3rd loop iteration, results has 2 entries")

  engine.positionTo(N)
  const finalArr = findLocal(engine.inspect(), "results")
  assert.equal(finalArr.n, 8)
  assert.deepEqual(
    finalArr.items.map((x) => x.v),
    [0, 1, 1, 2, 3, 5, 8, 13],
  )
  assert.equal(engine.diverged, false, "replay must match the recording")
})

test("console output is time-sliced by position", async () => {
  await engine.run(`
    for (let i = 1; i <= 3; i++) console.log("tick", i);
  `)
  const N = engine.trace.length
  engine.positionTo(N)
  assert.equal(engine.consoleEntries.length, 3)
  const firstLogAt = engine.consoleEntries[0].visibleAt
  engine.positionTo(firstLogAt)
  const visible = engine.consoleEntries.filter((e) => e.visibleAt <= engine.pos)
  assert.equal(visible.length, 1)
  // navigating back and forth must not duplicate console entries
  engine.positionTo(0)
  engine.positionTo(N)
  assert.equal(engine.consoleEntries.length, 3)
})

test("crashing programs keep a navigable timeline up to the error", async () => {
  const summary = await engine.run(`
    const xs = [1, 2, 3];
    let sum = 0;
    for (const x of xs) sum += x;
    null.boom;
  `)
  assert.ok(summary.error, "error recorded")
  const N = engine.trace.length
  assert.equal(engine.trace[N - 1].k, 2)
  engine.positionTo(N - 1)
  const sum = findLocal(engine.inspect(), "sum")
  assert.equal(sum.v, 6, "state just before the crash is inspectable")
})

test("virtual timers replay deterministically", async () => {
  const summary = await engine.run(`
    const order = [];
    setTimeout(() => { order.push("b"); console.log("b at", Date.now()); }, 50);
    setTimeout(() => { order.push("a"); console.log("a at", Date.now()); }, 10);
    console.log("main done");
  `)
  assert.equal(summary.error, null)
  assert.ok(summary.switchIdx !== null, "timer phase exists")
  const N = engine.trace.length
  engine.positionTo(N)
  const order = engine.inspect().locals?.find(([k]) => k === "order")?.[1]
  assert.deepEqual(order.items.map((x) => x.v), ["a", "b"])
  // rewind into the middle of the timer phase and replay through the switch
  engine.positionTo(2)
  engine.positionTo(N)
  assert.equal(engine.diverged, false)
})

test("console eval reads locals; mutations are discarded on navigation", async () => {
  await engine.run(`
    const langs = ["js", "ts"];
    let n = langs.length;
    console.log(n);
  `)
  const N = engine.trace.length
  engine.positionTo(N)
  const read = engine.consoleEval("langs.join('+') + '!' ")
  assert.equal(read.value.v, "js+ts!")
  const mut = engine.consoleEval("langs.push('rs'), langs.length")
  assert.equal(mut.value.v, 3)
  engine.positionTo(N - 1)
  engine.positionTo(N)
  const after = findLocal(engine.inspect(), "langs")
  assert.equal(after.n, 2, "mutation from console eval must be discarded")
})

test("step budget truncates but leaves a working timeline", async () => {
  const summary = await engine.run(`let spin = 0; for (;;) spin++;`, { maxSteps: 500 })
  assert.equal(summary.truncated, true)
  assert.ok(engine.trace.length <= 500)
  engine.positionTo(Math.floor(engine.trace.length / 2))
  const spin = findLocal(engine.inspect(), "spin")
  assert.ok(typeof spin.v === "number")
})

test("second run replaces the first cleanly", async () => {
  await engine.run(`console.log("one");`)
  const s2 = await engine.run(`console.log("two"); let x = 5;`)
  assert.equal(s2.error, null)
  engine.positionTo(engine.trace.length)
  assert.equal(engine.consoleEntries.length, 1)
  assert.equal(engine.consoleEntries[0].parts[0].v, "two")
})
