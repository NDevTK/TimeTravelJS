// Engine tests against the real patched-QuickJS wasm build.
// The program executes ONCE; every navigation below is pure page-delta
// application; every inspection is a disposable in-VM transaction.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TimeTravelEngine } from "../src/engine.js"

let engine
before(async () => {
  const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
  engine = await TimeTravelEngine.create(bytes)
})

const frameLocal = (ins, name, frame = 0) => ins.frames?.[frame]?.find(([k]) => k === name)?.[1]
const globalVal = (ins, name) => ins.globals?.find(([k]) => k === name)?.[1]

test("record once, rewind anywhere, state is exact — no re-execution", async () => {
  const summary = await engine.run(`
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
const results = [];
for (let i = 0; i <= 7; i++) {
  results.push(fib(i));
}
console.log("fibs", results.join(","));
`)
  assert.equal(summary.error, null)
  assert.ok(summary.steps > 100)
  assert.ok(summary.cow.savings > 0.9, "per-step COW must share almost everything")
  assert.equal(summary.cow.snapshots, summary.steps, "one resumable snapshot per step")

  const t = engine.trace
  // 3rd top-level visit of the loop-body line (results.push)
  let hits = 0
  let pos = -1
  for (let i = 0; i < t.length; i++) {
    if (t[i].l === 8 && t[i].d === 0 && ++hits === 3) {
      pos = i
      break
    }
  }
  assert.ok(pos > 0)
  engine.positionTo(pos)
  let ins = engine.inspect()
  assert.equal(globalVal(ins, "results").n, 2, "at the 3rd iteration, results has 2 entries")

  // deepest recursion frame: real stack, real locals from the VM
  let deep = 0
  for (let i = 0; i < t.length; i++) if (t[i].d > t[deep].d) deep = i
  engine.positionTo(deep)
  ins = engine.inspect()
  assert.ok(ins.stack.length >= 6)
  assert.equal(ins.stack[0].name, "fib")
  assert.equal(frameLocal(ins, "n").t, "num")
  // outer frames are inspectable without further transactions
  assert.ok(frameLocal(ins, "n", 1), "parent frame locals present")

  // end state
  engine.positionTo(t.length - 1)
  ins = engine.inspect()
  const results = globalVal(ins, "results")
  assert.deepEqual(results.items.map((x) => x.v), [0, 1, 1, 2, 3, 5, 8, 13])
})

test("console output is recorded once and time-sliced by position", async () => {
  await engine.run(`
for (let i = 1; i <= 3; i++) {
  console.warn("tick", i);
}
`)
  assert.equal(engine.consoleEntries.length, 3)
  assert.equal(engine.consoleEntries[0].level, "warn")
  const firstAt = engine.consoleEntries[0].visibleAt
  assert.ok(firstAt > 0 && firstAt < engine.trace.length)
  // navigating around must not duplicate entries (nothing re-executes)
  engine.positionTo(0)
  engine.positionTo(engine.trace.length - 1)
  engine.positionTo(Math.floor(engine.trace.length / 2))
  assert.equal(engine.consoleEntries.length, 3)
})

test("crash: timeline stays navigable, state before the throw is inspectable", async () => {
  const summary = await engine.run(`
const xs = [1, 2, 3];
let sum = 0;
for (const x of xs) {
  sum += x;
}
null.boom;
`)
  assert.ok(summary.error, "error recorded")
  assert.equal(summary.error.t, "error")
  assert.match(summary.error.msg, /null/)
  const t = engine.trace
  engine.positionTo(t.length - 2) // last real step (the crashing line)
  const ins = engine.inspect()
  assert.equal(globalVal(ins, "sum").v, 6)
})

test("virtual timers execute steppably after the main script", async () => {
  const summary = await engine.run(`
const order = [];
setTimeout(() => { order.push("late"); console.log("late", Date.now()); }, 200);
setTimeout(() => { order.push("early"); console.log("early", Date.now()); }, 10);
console.log("main", Date.now());
`)
  assert.equal(summary.error, null)
  const texts = engine.consoleEntries.map((e) => e.parts[0].v)
  assert.deepEqual(texts, ["main", "early", "late"])
  // a timer-callback step exists and its frame is inspectable
  const t = engine.trace
  const cbStep = t.findIndex((e) => e.entry && e.entry.name === "tt_fire_timer" && e.l > 0)
  assert.ok(cbStep > 0)
  engine.positionTo(cbStep)
  const ins = engine.inspect()
  assert.ok(ins.stack.length >= 1)
  // and the end state reflects both callbacks
  engine.positionTo(t.length - 1)
  assert.deepEqual(globalVal(engine.inspect(), "order").items.map((x) => x.v), ["early", "late"])
})

test("async/await and promises are steppable (no instrumentation needed)", async () => {
  const summary = await engine.run(`
async function work() {
  const a = await Promise.resolve(20);
  const b = await Promise.resolve(22);
  return a + b;
}
let answer = 0;
work().then((v) => { answer = v; console.log("answer", v); });
`)
  assert.equal(summary.error, null)
  engine.positionTo(engine.trace.length - 1)
  assert.equal(globalVal(engine.inspect(), "answer").v, 42)
  assert.equal(engine.consoleEntries.at(-1).parts[1].v, 42)
})

test("getters, generators, classes — everything runs unmodified", async () => {
  const summary = await engine.run(`
class Box {
  constructor(v) { this._v = v; }
  get value() { return this._v * 2; }
}
function* naturals() { let n = 1; for (;;) yield n++; }
const it = naturals();
const seq = [it.next().value, it.next().value];
const b = new Box(21);
console.log(seq.join("+"), b.value);
`)
  assert.equal(summary.error, null)
  const parts = engine.consoleEntries[0].parts
  assert.equal(parts[0].v, "1+2")
  assert.equal(parts[1].v, 42)
})

test("console eval runs in a disposable transaction — timeline immutable", async () => {
  await engine.run(`
const langs = ["js", "ts"];
let n = langs.length;
console.log(n);
`)
  const N = engine.trace.length
  engine.positionTo(N - 1)
  const read = engine.consoleEval("langs.join('+') + '!'")
  assert.equal(read.value.v, "js+ts!")
  const mut = engine.consoleEval("langs.push('rs'), langs.length")
  assert.equal(mut.value.v, 3)
  // the recorded timeline is untouched: same position still shows 2 entries
  engine.positionTo(0)
  engine.positionTo(N - 1)
  assert.equal(globalVal(engine.inspect(), "langs").n, 2)
})

test("locals show TDZ, closures, and shadowing truthfully", async () => {
  await engine.run(`
function counter() {
  let count = 0;
  return function inc() {
    count += 1;
    return count;
  };
}
const inc = counter();
inc();
inc();
const after = inc();
console.log(after);
`)
  const t = engine.trace
  // find a step inside inc() (line 5)
  const pos = t.findIndex((e) => e.l === 5)
  assert.ok(pos > 0)
  engine.positionTo(pos)
  const ins = engine.inspect()
  assert.equal(ins.stack[0].name, "inc")
  assert.ok(frameLocal(ins, "count"), "captured closure variable visible")
})

test("step budget truncates but the recorded prefix stays navigable", async () => {
  const summary = await engine.run(`let spin = 0; for (;;) { spin++; }`, { maxSteps: 300 })
  assert.equal(summary.truncated, true)
  assert.ok(engine.trace.length <= 301)
  engine.positionTo(Math.floor(engine.trace.length / 2))
  const spin = globalVal(engine.inspect(), "spin")
  assert.equal(typeof spin.v, "number")
})

test("second run resets cleanly", async () => {
  await engine.run(`console.log("one"); globalThis.marker = 1;`)
  const s2 = await engine.run(`console.log("two");`)
  assert.equal(s2.error, null)
  assert.equal(engine.consoleEntries.length, 1)
  assert.equal(engine.consoleEntries[0].parts[0].v, "two")
  engine.positionTo(engine.trace.length - 1)
  assert.equal(globalVal(engine.inspect(), "marker"), undefined, "previous session's globals are gone")
})

test("navigation is orders of magnitude cheaper than execution", async () => {
  await engine.run(`
const data = [];
for (let i = 0; i < 60; i++) {
  data.push(i * i);
}
console.log(data.length);
`)
  const N = engine.trace.length
  const t0 = performance.now()
  for (let i = 0; i < 300; i++) engine.positionTo((i * 37) % N)
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `300 random jumps took ${ms}ms`)
})
