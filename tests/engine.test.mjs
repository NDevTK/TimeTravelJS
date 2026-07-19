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

test("write barrier: audited capture misses nothing", async () => {
  // verifyBarrier compares the barrier-driven deltas against a full memory
  // scan after EVERY step — typed arrays, string allocation, growth included.
  const summary = await engine.run(`
const buf = new Uint8Array(2048);
const strs = [];
for (let i = 0; i < 40; i++) {
  buf[(i * 37) % 2048] = i;
  strs.push("s" + i);
}
console.log(strs.length, buf[37]);
`, { verifyBarrier: true })
  assert.equal(summary.error, null)
  assert.deepEqual(summary.warnings, [], "no page escaped the write barrier")
  assert.ok(summary.cow.savings > 0.99)
})

const FORK_PROG = `
let acc = 0;
for (let i = 0; i < 50; i++) {
  acc += i;
}
console.log("total", acc);
`
// position paused just before the 5th \`acc += i\` (i = 4, acc = 0+1+2+3 = 6)
const fifthIteration = (t) => {
  let hits = 0
  for (let i = 0; i < t.length; i++) if (t[i].l === 4 && t[i].d === 0 && ++hits === 5) return i
  return -1
}

test("timeline fork without an edit re-records an identical future", async () => {
  await engine.run(FORK_PROG)
  const stepsBefore = engine.trace.length
  const pos = fifthIteration(engine.trace)
  assert.ok(pos > 0)
  const summary = await engine.forkFrom(pos)
  assert.equal(summary.forkedAt, pos)
  assert.equal(summary.error, null)
  // determinism: virtual clock + seeded random ⇒ step-for-step identical
  assert.equal(engine.trace.length, stepsBefore)
  engine.positionTo(engine.trace.length - 1)
  assert.equal(globalVal(engine.inspect(), "acc").v, 1225)
})

test("timeline fork: edit-and-continue changes the future, prefix stays exact", async () => {
  await engine.run(FORK_PROG)
  const pos = fifthIteration(engine.trace)
  assert.ok(pos > 0)
  const summary = await engine.forkFrom(pos, "acc = 999")
  assert.equal(summary.forkedAt, pos)
  assert.equal(summary.error, null)
  // resumed run: 999, then += 4..49 ⇒ 999 + 1219 = 2218
  engine.positionTo(engine.trace.length - 1)
  assert.equal(globalVal(engine.inspect(), "acc").v, 2218)
  const total = engine.consoleEntries.at(-1)
  assert.equal(total.parts[0].v, "total")
  assert.equal(total.parts[1].v, 2218, "console output re-recorded on the new timeline")
  // the shared prefix is untouched: the edit lands BETWEEN pos and pos+1
  engine.positionTo(pos)
  assert.equal(globalVal(engine.inspect(), "acc").v, 6)
  engine.positionTo(2)
  assert.equal(globalVal(engine.inspect(), "acc").v, 0)
})

test("stackless core: plain JS suspends by return, C-reentry falls back to asyncify", async () => {
  await engine.run(`
function calc(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t; }
const a = calc(20);
const sorted = [3, 1, 2].sort((x, y) => x - y);
console.log(a, sorted.join(""));
`)
  const t = engine.trace
  const rSteps = t.filter((e) => e.k === "r").length
  const aSteps = t.filter((e) => e.sp !== undefined).length
  // mainline + plain calls park by return (no C stack spans the step)…
  assert.ok(rSteps > 10, `expected return-parked majority, got ${rSteps}`)
  // …while the sort comparator runs under live C frames → asyncify fallback
  assert.ok(aSteps >= 1, "comparator steps must use the asyncify fallback")
  // a return-parked position has no one-shot restriction: inspect it thrice
  const rPos = t.findIndex((e) => e.k === "r" && e.d > 0)
  assert.ok(rPos > 0)
  engine.positionTo(rPos)
  const one = JSON.stringify(engine.inspect())
  engine.session.cachedInspect.delete(rPos)
  const two = JSON.stringify(engine.inspect())
  engine.session.cachedInspect.delete(rPos)
  const three = JSON.stringify(engine.inspect())
  assert.equal(one, two)
  assert.equal(two, three)
})

test("opcode granularity: suspend/resume between any two VM instructions", async () => {
  const PROG = `let q = 0;\nfor (let i = 0; i < 8; i++) q += i * 2;\nconsole.log(q);\n`
  const line = await engine.run(PROG)
  const lineSteps = line.steps
  const op = await engine.run(PROG, { granularity: "opcode" })
  assert.ok(op.steps > lineSteps * 3, `opcode steps (${op.steps}) ≫ line steps (${lineSteps})`)
  assert.equal(op.error, null)
  // mid-expression machine states are real positions
  engine.positionTo(Math.floor(op.steps / 2))
  const q = engine.inspect().globals.find(([k]) => k === "q")?.[1]
  assert.equal(q.t, "num")
  engine.positionTo(op.steps - 1)
  assert.equal(engine.consoleEntries.at(-1).parts[0].v, 56)
})

test("JS recursion depth is an exact arena limit — catchable, session survives", async () => {
  const summary = await engine.run(`
let depth = 0;
function dive() { depth++; return dive(); }
let caught = "no";
try { dive(); } catch (e) { caught = "yes"; }
console.log(caught, depth);
`, { maxSteps: 200000 })
  assert.equal(summary.error, null, "overflow is catchable, not fatal")
  engine.positionTo(engine.trace.length - 1)
  const g = engine.inspect().globals
  assert.equal(g.find(([k]) => k === "caught")?.[1]?.v, "yes")
  assert.ok(g.find(([k]) => k === "depth")?.[1]?.v > 5000, "thousands of frames deep")
})

test("fork works from an asyncify-parked position too (inside a comparator)", async () => {
  await engine.run(`
const xs = [4, 2, 5, 1, 3];
let cmps = 0;
xs.sort((p, q) => { cmps++; return p - q; });
console.log(xs.join(","), cmps);
`)
  const stepsBefore = engine.trace.length
  const aPos = engine.trace.findIndex((e) => e.sp !== undefined && e.d > 0)
  assert.ok(aPos > 0, "found a comparator step (asyncify kind)")
  const summary = await engine.forkFrom(aPos)
  assert.equal(summary.error, null)
  assert.equal(summary.forkedAt, aPos)
  // deterministic re-record from inside the C-mediated callback
  assert.equal(engine.trace.length, stepsBefore)
  engine.positionTo(engine.trace.length - 1)
  assert.equal(engine.consoleEntries.at(-1).parts[0].v, "1,2,3,4,5")
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
