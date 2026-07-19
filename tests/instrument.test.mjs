// Semantics tests for the instrumentation transform. The instrumented code
// runs in a bare node:vm sandbox with the same __tt_* runtime that QuickJS
// uses, so these tests verify pure transform correctness without WebAssembly.
import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { instrument, wrapProgram } from "../src/instrument.js"
import { VM_RUNTIME_SOURCE } from "../src/vmruntime.js"

function runProgram(src, { maxSteps = 50000 } = {}) {
  const { code, warnings } = instrument(src)
  const logs = []
  const sandbox = { __tt_hostout: (json) => logs.push(JSON.parse(json)) }
  const ctx = vm.createContext(sandbox)
  vm.runInContext(VM_RUNTIME_SOURCE, ctx)
  vm.runInContext(wrapProgram(code), ctx)
  const gen = sandbox.__tt_gen1
  const steps = []
  let r
  let error = null
  try {
    for (r = gen.next(); !r.done; r = gen.next()) {
      steps.push(r.value)
      if (steps.length > maxSteps) throw new Error("step budget exceeded")
    }
  } catch (e) {
    error = e
  }
  // run the timer pump like the engine does
  if (!error) {
    const pump = vm.runInContext("__tt_pump()", ctx)
    try {
      for (r = pump.next(); !r.done; r = pump.next()) {
        steps.push(r.value)
        if (steps.length > maxSteps) throw new Error("step budget exceeded")
      }
    } catch (e) {
      error = e
    }
  }
  return { steps, logs, sandbox, ctx, error, warnings }
}

const partText = (p) => (p.t === "undef" ? "undefined" : p.t === "null" ? "null" : p.v !== undefined ? p.v : p.t)
const logText = (logs) => logs.map((l) => l.parts.map(partText).join(" "))

test("plain statements, loops, functions compute correctly and yield steps", () => {
  const { steps, logs, error } = runProgram(`
    function add(a, b) { return a + b; }
    let total = 0;
    for (let i = 1; i <= 4; i++) total = add(total, i);
    console.log("total", total);
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "total 10")
  assert.ok(steps.length > 10)
  const depths = steps.filter((s) => s[0] === 0).map((s) => s[5])
  assert.ok(Math.max(...depths) >= 1, "steps inside add() should record depth ≥ 1")
})

test("recursion, closures, classes, new, methods", () => {
  const { logs, error } = runProgram(`
    function fib(n) { return n <= 1 ? n : fib(n - 1) + fib(n - 2); }
    function counter() { let c = 0; return () => ++c; }
    const inc = counter();
    inc(); inc();
    class Box {
      constructor(v) { this.v = v; }
      double() { this.v *= 2; return this.v; }
      static make(v) { return new Box(v); }
    }
    const b = Box.make(5);
    b.double();
    console.log(fib(9), inc(), b.v);
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "34 3 10")
})

test("callbacks passed to natives run atomically but correctly", () => {
  const { logs, error } = runProgram(`
    const xs = [1, 2, 3, 4].map(function double(x) { return x * 2; });
    const sum = xs.reduce((a, x) => a + x, 0);
    const found = xs.find((x) => x > 5);
    console.log(xs.join(","), sum, found);
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "2,4,6,8 20 6")
})

test("call/apply/bind on instrumented functions", () => {
  const { logs, error } = runProgram(`
    function greet(greeting) { return greeting + ", " + this.name; }
    const who = { name: "ada" };
    const a = greet.call(who, "hi");
    const b = greet.apply(who, ["yo"]);
    const c = greet.bind(who)("hey");
    console.log(a, b, c);
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "hi, ada yo, ada hey, ada")
})

test("try/catch/finally, throw, switch, labeled break", () => {
  const { logs, error } = runProgram(`
    function risky(n) {
      if (n > 2) throw new Error("too big: " + n);
      return n;
    }
    let caught = "";
    let ok = 0;
    for (let i = 1; i <= 5; i++) {
      try { ok += risky(i); }
      catch (e) { caught = e.message; break; }
      finally { ok += 100; }
    }
    let kind = "";
    switch (ok) {
      case 303: kind = "expected"; break;
      default: kind = "odd:" + ok;
    }
    outer: for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i * j === 2) break outer;
      }
    }
    console.log(kind, caught);
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "expected too big: 3")
})

test("uncaught user errors propagate out of the generator", () => {
  const { error } = runProgram(`
    const o = {};
    o.missing.boom;
  `)
  assert.ok(error, "expected error")
  assert.match(String(error.message), /undefined|null|not an object|cannot read/i)
})

test("user generators and async functions run raw but work", () => {
  const { logs, error } = runProgram(`
    function* naturals() { let n = 1; for (;;) yield n++; }
    const it = naturals();
    const first = [it.next().value, it.next().value, it.next().value];
    console.log("gen", first.join(""));
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "gen 123")
})

test("virtual timers fire in order on the virtual clock", () => {
  const { logs, error } = runProgram(`
    setTimeout(() => console.log("late", Date.now()), 200);
    setTimeout(() => console.log("early", Date.now()), 10);
    console.log("main", Date.now());
  `)
  assert.equal(error, null)
  const texts = logText(logs)
  assert.match(texts[0], /^main /)
  assert.match(texts[1], /^early /)
  assert.match(texts[2], /^late /)
})

test("Math.random and Date are deterministic across runs", () => {
  const src = `console.log(Math.random(), Math.random(), Date.now());`
  const a = runProgram(src)
  const b = runProgram(src)
  assert.deepEqual(logText(a.logs), logText(b.logs))
})

test("scope thunks capture locals including TDZ", () => {
  const { sandbox, ctx } = (() => {
    const { code } = instrument(`
      let a = 1;
      {
        let b = 2;
        a = a + b; // pause here would see a and b
        let c = 3;
        a = a + c;
      }
    `)
    const sandbox = { __tt_hostout: () => {} }
    const c = vm.createContext(sandbox)
    vm.runInContext(VM_RUNTIME_SOURCE, c)
    vm.runInContext(wrapProgram(code), c)
    return { sandbox, ctx: c }
  })()
  const gen = sandbox.__tt_gen1
  // step until we're paused at the `a = a + b` statement (line 5)
  let r = gen.next()
  while (!r.done) {
    if (r.value[0] === 0 && r.value[1] === 5) break
    r = gen.next()
  }
  const pairs = vm.runInContext("__tt_scope()", ctx)
  const names = Object.fromEntries(pairs.map(([k, v]) => [k, v]))
  assert.equal(names.a, 1)
  assert.equal(names.b, 2)
  assert.ok(names.c && names.c.__tt_isTdz, "c is declared later — should show TDZ marker")
})

test("reserved prefix is rejected with a friendly error", () => {
  assert.throws(() => instrument("let __tt_x = 1;"), /reserved/)
})

test("syntax errors are reported as user errors", () => {
  try {
    instrument("let a = ;")
    assert.fail("should have thrown")
  } catch (e) {
    assert.ok(e.timeTravelUserError)
    assert.match(e.message, /syntax error/i)
  }
})

test("optional chaining calls stay plain but execute", () => {
  const { logs, error } = runProgram(`
    const api = { get(x) { return x * 3; } };
    const missing = null;
    console.log(api?.get(2), missing?.get(2));
  `)
  assert.equal(error, null)
  assert.equal(logText(logs)[0], "6 undefined")
})

test("getters are not invoked by inspection serializer", () => {
  const { ctx, error } = runProgram(`
    let hits = 0;
    const obj = { get evil() { hits += 1; return "boo"; }, safe: 1 };
    globalThis.exported = obj;
    console.log("done", hits);
  `)
  assert.equal(error, null)
  const out = vm.runInContext('JSON.stringify(__tt_ser(globalThis.exported, 3))', ctx)
  assert.match(out, /getter/)
  const hits = vm.runInContext("__tt_evalAt('hits')", ctx)
  assert.equal(hits, 0, "serializer must never trigger user getters")
})
