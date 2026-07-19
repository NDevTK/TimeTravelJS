// DOM+CSS time travel against the real wasm build: Lexbor lives in the
// same linear memory as the JS heap, so every per-step COW snapshot
// carries the whole document — these tests prove the DOM scrubs, forks,
// and replays exactly like the rest of the machine.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TimeTravelEngine } from "../src/engine.js"

let engine
before(async () => {
  const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
  engine = await TimeTravelEngine.create(bytes)
})

const globalVal = (ins, name) => ins.globals?.find(([k]) => k === name)?.[1]
const countOf = (dom, re) => (dom.match(re) || []).length

test("the DOM is part of every snapshot: scrubbing rewinds the tree", async () => {
  const summary = await engine.run(`
const list = document.getElementById("list");
for (let i = 1; i <= 5; i++) {
  const li = document.createElement("li");
  li.textContent = "item " + i;
  list.appendChild(li);
}
list.firstElementChild.remove();
console.log(document.querySelectorAll("li").length);
`, { html: `<ul id="list"></ul>` })
  assert.equal(summary.error, null)
  assert.equal(summary.suppressedSteps, 0, "DOM primitives never suppress a step")

  const t = engine.trace
  const counts = []
  for (let p = 0; p < t.length; p++) {
    engine.positionTo(p)
    counts.push(countOf(engine.inspect().dom, /<li/g))
  }
  // monotone growth 0..5 then the removal drops it to 4 — each recorded
  // step's serialized tree is that exact historical document
  assert.equal(counts[0], 0)
  assert.equal(Math.max(...counts), 5)
  assert.equal(counts[counts.length - 1], 4)
  for (let i = 1; i < counts.length; i++)
    assert.ok(Math.abs(counts[i] - counts[i - 1]) <= 1, "one mutation per step boundary")
  engine.positionTo(t.length - 1)
  assert.match(engine.inspect().dom, /<li>item 2<\/li><li>item 3<\/li>/)
})

test("forking forks the document; prefixes stay byte-identical", async () => {
  await engine.run(`
const box = document.getElementById("box");
for (let i = 0; i < 4; i++) {
  const p = document.createElement("p");
  p.textContent = "p" + i;
  box.appendChild(p);
}
console.log(box.children.length);
`, { html: `<div id="box"></div>` })
  const t = engine.trace
  const mid = Math.floor(t.length / 2)
  engine.positionTo(mid)
  const domAtMid = engine.inspect().dom
  const stepsBefore = t.length

  // no-edit fork: determinism replays the identical DOM future
  await engine.forkFrom(mid)
  assert.equal(engine.trace.length, stepsBefore)
  engine.positionTo(mid)
  assert.equal(engine.inspect().dom, domAtMid, "shared prefix byte-identical")
  engine.positionTo(engine.trace.length - 1)
  const finalA = engine.inspect().dom

  // edited fork: mutate the LIVE document at that moment
  await engine.forkFrom(mid, "document.getElementById('box').setAttribute('data-fork', 'yes')")
  engine.positionTo(engine.trace.length - 1)
  const finalB = engine.inspect().dom
  assert.ok(finalB.includes('data-fork="yes"'), "the fork's future carries the DOM edit")
  assert.equal(countOf(finalB, /<p>/g), countOf(finalA, /<p>/g), "same structure otherwise")
  engine.positionTo(mid)
  assert.equal(engine.inspect().dom, domAtMid, "pre-fork pages untouched by the edit")
})

test("events: capture → target → bubble, handlers park like any code", async () => {
  const summary = await engine.run(`
const order = [];
const outer = document.getElementById("outer");
const inner = document.getElementById("inner");
document.addEventListener("ping", () => { order.push("doc-capture"); }, true);
outer.addEventListener("ping", () => { order.push("outer-capture"); }, { capture: true });
outer.addEventListener("ping", (e) => { order.push("outer-bubble:" + (e.target === inner)); });
inner.addEventListener("ping", function (e) {
  order.push("target:" + (this === inner) + ":" + e.eventPhase);
});
inner.addEventListener("once", () => { order.push("once"); }, { once: true });
const notCancelled = inner.dispatchEvent(new Event("ping", { bubbles: true }));
inner.dispatchEvent(new Event("once"));
inner.dispatchEvent(new Event("once"));
const ce = new CustomEvent("data", { detail: { n: 42 } });
let detail = 0;
inner.addEventListener("data", (e) => { detail = e.detail.n; });
inner.dispatchEvent(ce);
const cancelled = !inner.dispatchEvent(Object.assign(new Event("stop", { cancelable: true }), {}));
inner.addEventListener("stop", (e) => e.preventDefault());
const prevented = !inner.dispatchEvent(new Event("stop", { cancelable: true }));
console.log(order.join("|"), notCancelled, detail, cancelled, prevented);
`, { html: `<div id="outer"><span id="inner"></span></div>` })
  assert.equal(summary.error, null)
  assert.equal(summary.suppressedSteps, 0, "event handlers are ordinary parked bytecode")
  const parts = engine.consoleEntries.at(-1).parts
  assert.equal(parts[0].v, "doc-capture|outer-capture|target:true:2|outer-bubble:true|once")
  assert.equal(parts[1].v, true)
  assert.equal(parts[2].v, 42)
  assert.equal(parts[3].v, false, "no listener → not cancelled")
  assert.equal(parts[4].v, true, "preventDefault on cancelable event")
})

test("CSS: stylesheet cascade, inline override, dynamic restyle", async () => {
  const summary = await engine.run(`
const a = document.getElementById("a");
const b = document.getElementById("b");
const cs1 = getComputedStyle(a);
const before = cs1.color + "/" + cs1["font-size"];
a.style.color = "red";
const after = getComputedStyle(a).color;
b.classList.add("hot");
const hot = getComputedStyle(b).color;
a.style.fontSize = "9px";
const inline = a.getAttribute("style");
a.style.removeProperty("color");
const removed = getComputedStyle(a).color;
document.addStyleSheet("#b { margin: 7px; }");
const margin = getComputedStyle(b).margin;
console.log(before, after, hot, inline, removed, margin);
`, { html: `<style>p { color: blue; font-size: 12px; } .hot { color: orange; }</style>
<p id="a">A</p><p id="b">B</p>` })
  assert.equal(summary.error, null)
  assert.equal(summary.suppressedSteps, 0)
  const p = engine.consoleEntries.at(-1).parts
  assert.equal(p[0].v, "blue/12px", "stylesheet cascade visible via getComputedStyle")
  assert.equal(p[1].v, "red", "inline style wins")
  assert.equal(p[2].v, "orange", "class toggle re-matches rules (mutation-tracked)")
  assert.equal(p[3].v, "color: red; font-size: 9px", "style facade writes the attribute")
  assert.equal(p[4].v, "blue", "removeProperty falls back to the stylesheet")
  assert.equal(p[5].v, "7px", "runtime-attached stylesheet applies")
})

test("innerHTML/textContent replace children safely; handles stay valid", async () => {
  const summary = await engine.run(`
const box = document.getElementById("box");
const old = box.firstElementChild;         // hold a handle across replacement
box.innerHTML = "<em>new</em><span>era</span>";
const detachedOk = old.textContent === "old" && old.parentNode === null;
box.firstElementChild.textContent = "NEW";
const t = document.createElement("div");
t.innerHTML = "<i>x</i>";
t.textContent = "flat";
console.log(detachedOk, box.innerHTML, t.outerHTML, old.outerHTML);
`, { html: `<div id="box"><b>old</b></div>` })
  assert.equal(summary.error, null)
  const p = engine.consoleEntries.at(-1).parts
  assert.equal(p[0].v, true, "replaced nodes are detached, not destroyed")
  assert.equal(p[1].v, "<em>NEW</em><span>era</span>")
  assert.equal(p[2].v, "<div>flat</div>")
  assert.equal(p[3].v, "<b>old</b>", "the detached node is still fully usable")
})

test("selectors: querySelectorAll, matches, closest, getElementsBy*", async () => {
  const summary = await engine.run(`
const rows = document.querySelectorAll("ul > li.row");
const second = document.querySelector("li.row:nth-child(2)");
const hits = [
  rows.length,
  second.textContent,
  second.matches(".row"),
  second.matches(".nope"),
  second.closest("ul").id,
  document.getElementsByTagName("li").length,
  document.getElementsByClassName("row").length,
];
console.log(hits.join(","));
`, { html: `<ul id="u"><li class="row">a</li><li class="row">b</li><li>c</li></ul>` })
  assert.equal(summary.error, null)
  assert.equal(engine.consoleEntries.at(-1).parts[0].v, "2,b,true,false,u,3,2")
})

test("DOM values render as elements in inspection and console", async () => {
  await engine.run(`
const el = document.querySelector("b");
console.log(el);
globalThis.grabbed = el;
`, { html: `<b class="x">bold</b>` })
  const logged = engine.consoleEntries.at(-1).parts[0]
  assert.equal(logged.t, "dom")
  assert.equal(logged.name, "B")
  assert.match(logged.html, /<b class="x">bold<\/b>/)
  engine.positionTo(engine.trace.length - 1)
  const g = globalVal(engine.inspect(), "grabbed")
  assert.equal(g.t, "dom")
})

test("JS-only sessions are unaffected: no document global, no dom field", async () => {
  const summary = await engine.run(`console.log(typeof document, typeof getComputedStyle);`)
  assert.equal(summary.error, null)
  assert.equal(engine.consoleEntries.at(-1).parts[0].v, "undefined")
  engine.positionTo(engine.trace.length - 1)
  assert.equal(engine.inspect().dom, undefined)
})
