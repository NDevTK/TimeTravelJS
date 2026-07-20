// Website-shaped sessions: the machine carries location/URL/
// URLSearchParams, localStorage/sessionStorage and a postMessage channel —
// self-hosted inside the snapshot boundary, with read registries recording
// which inputs the program actually consulted. exploreParams() then answers
// the real-site question — WHICH ?param / storage value / message payload
// leads to an outcome — with NO guessing: canary probes fork full alternate
// runs, the machine's comparison journal reports what each run tested the
// input against, and every observation becomes the next candidate. Required
// formats compose across rounds (probe → "pref:<canary>" → "pref:gold"),
// object message protocols reveal their keys through a recording proxy, and
// runs that execute lines the original recording never reached — unused
// logic — are reported and explored first.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TimeTravelEngine } from "../src/engine.js"

let engine
before(async () => {
  const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
  engine = await TimeTravelEngine.create(bytes)
})

const SITE_HTML = `<style>
body { background: white; }
body.dark { background: #10141d; }
body.solar { background: #fdf6e3; }
.hidden { display: none; }
</style>
<h1 id="title">news</h1>
<section id="beta-panel" class="hidden"><p>beta tools</p></section>
<p id="status"></p>`

const SITE_PROG = `const params = new URLSearchParams(location.search);
const saved = localStorage.getItem("theme");
const theme = params.get("theme") || saved || "light";
if (theme === "dark" || theme === "solar") {
  document.body.classList.add(theme);
}
if (params.get("beta") === "1") {
  document.getElementById("beta-panel").classList.remove("hidden");
}
const who = params.get("user") || "anonymous";
document.getElementById("status").textContent = who + " / " + theme;
console.log("theme:", theme, "| beta:", params.get("beta"));
`

test("the machine has a URL substrate: location, URL, params, storage", async () => {
  const summary = await engine.run(
    `const p = new URLSearchParams(location.search);
const u = new URL("/api/items?page=2", location.href);
localStorage.setItem("visits", "3");
sessionStorage.setItem("tab", "news");
console.log(location.hostname, location.pathname, p.get("q"), u.searchParams.get("page"));
console.log(localStorage.getItem("visits"), localStorage.length, sessionStorage.getItem("tab"));
location.hash = "results";
console.log(location.href);
`,
    { url: "https://shop.example:8080/search?q=lamp&sort=price" },
  )
  assert.equal(summary.error, null)
  assert.equal(summary.suppressedSteps, 0, "the substrate is ordinary in-machine JS")
  const logs = engine.consoleEntries.map((e) => e.parts.map((p) => String(p.v)).join(" "))
  assert.equal(logs[0], "shop.example /search lamp 2")
  assert.equal(logs[1], "3 1 news")
  assert.equal(logs[2], "https://shop.example:8080/search?q=lamp&sort=price#results")
})

test("storage is shared state that time-travels with everything else", async () => {
  await engine.run(`localStorage.setItem("count", "1");
localStorage.setItem("count", "2");
localStorage.removeItem("count");
console.log("done");
`)
  const at = (p) => {
    engine.positionTo(p)
    const r = engine.consoleEval(`localStorage.getItem("count")`)
    return r.value.t === "null" ? null : r.value.v
  }
  const seen = []
  for (let p = 0; p < engine.trace.length; p++) seen.push(at(p))
  // scrubbing rewinds the store: null → "1" → "2" → null
  assert.equal(seen[0], null)
  assert.ok(seen.includes("1"))
  assert.ok(seen.includes("2"))
  assert.equal(seen[seen.length - 1], null)
  assert.ok(seen.indexOf("1") < seen.indexOf("2"))
})

test("read registries record what the program consulted", async () => {
  await engine.run(SITE_PROG, { html: SITE_HTML, url: "https://news.example/?user=ada" })
  engine.positionTo(engine.trace.length - 1)
  const params = engine.consoleEval(`JSON.stringify(location.__paramReads)`)
  const stor = engine.consoleEval(`JSON.stringify(localStorage.__reads)`)
  assert.deepEqual(JSON.parse(params.value.v).sort(), ["beta", "theme", "user"])
  assert.deepEqual(JSON.parse(stor.value.v), ["theme"])
})

test("the comparison journal: what the run tested strings against, per timeline moment", async () => {
  await engine.run(SITE_PROG, { html: SITE_HTML, url: "https://news.example/?user=ada" })
  engine.positionTo(engine.trace.length - 1)
  const journal = engine.comparisons()
  // theme === "dark" || theme === "solar" with theme as-run "light"
  assert.ok(journal.some((e) => e.op === "eq" && e.a === "light" && e.b === "dark"))
  assert.ok(journal.some((e) => e.op === "eq" && e.a === "light" && e.b === "solar"))
  // the journal is part of the machine: at step 0 nothing has been compared
  engine.positionTo(0)
  assert.equal(engine.comparisons().length, 0, "rewinding rewinds the journal")
})

test("exploreParams finds the URL parameter that enables a feature — by learning, not guessing", async () => {
  await engine.run(SITE_PROG, { html: SITE_HTML, url: "https://news.example/?user=ada" })
  const r = await engine.exploreParams({
    goal: `!document.getElementById("beta-panel").classList.contains("hidden")`,
  })
  assert.equal(r.alreadyTrue, false)
  assert.ok(r.examples.length >= 1)
  const ex = r.examples.find((e) => e.params?.beta === "1")
  assert.ok(ex, `?beta=1 discovered (got ${JSON.stringify(r.examples.map((e) => e.params))})`)
  assert.match(ex.search, /user=ada/, "the run's original parameters are preserved")
  assert.ok(ex.firstTrue != null, "jumpable to the exact step the panel appeared")
  // provenance: the value came from the probe run's own comparison
  const via = ex.assignments[0].via
  assert.equal(via[0].op, "probe")
  assert.deepEqual(via[via.length - 1], { op: "eq", learned: "1" })
  // unused logic: this run executed the reveal line the recording never reached
  assert.ok(ex.newLines.length >= 1, "the satisfying run unlocked dormant code")
  assert.ok(
    r.unlocked.some((u) => u.assignments.some((a) => a.key === "beta")),
    "the unlocked report attributes the dormant line to ?beta",
  )
  // the example is a full alternate run of the site under that URL
  engine.switchTo(ex.branch, ex.steps - 1)
  assert.equal(engine.consoleEval(`location.search.includes("beta=1")`).value.v, true)
  assert.match(engine.inspect().dom, /beta tools/)
  engine.switchTo(0)
  assert.equal(engine.pos, engine.trace.length - 1, "view restored")
})

test("exploreParams learns a colour value by running code branches", async () => {
  await engine.run(SITE_PROG, { html: SITE_HTML, url: "https://news.example/" })
  // "solar" is in no default list and is never mined from source text: the
  // canary probe's alternate run performs theme === "solar", the journal
  // reports it, and the observation becomes the candidate
  const r = await engine.exploreParams({
    goal: `document.body.classList.contains("solar")`,
  })
  assert.ok(r.examples.length >= 1)
  const ex = r.examples[0]
  assert.equal(ex.params.theme, "solar")
  assert.equal(ex.assignments[0].via[0].op, "probe")
  assert.deepEqual(ex.assignments[0].via.at(-1), { op: "eq", learned: "solar" })
  assert.ok(
    r.learned.some((l) => l.input.kind === "param" && l.input.key === "theme" && l.value === "solar"),
    "the learned report carries the execution-derived value",
  )
  engine.switchTo(ex.branch)
  assert.match(engine.inspect().dom, /class="solar"/)
  engine.switchTo(0)
})

test("required formats compose across rounds: startsWith('pref:'), then === 'gold'", async () => {
  await engine.run(
    `const raw = new URLSearchParams(location.search).get("pref") || "";
let plan = "free";
if (raw.startsWith("pref:")) {
  const val = raw.slice(5);
  if (val === "gold") plan = "premium";
}
console.log(plan);
`,
    { url: "https://shop.example/" },
  )
  const r = await engine.exploreParams({ goal: `plan === "premium"` })
  assert.ok(r.examples.length >= 1)
  const ex = r.examples[0]
  assert.equal(ex.params.pref, "pref:gold")
  // the chain: probe → the format constraint → the value behind it
  assert.deepEqual(
    ex.assignments[0].via.map((v) => v.op),
    ["probe", "startsWith", "eq"],
  )
  assert.equal(ex.assignments[0].via[1].learned, "pref:")
  assert.equal(ex.assignments[0].via[2].learned, "gold")
  assert.equal(r.explored, 3, "probe → pref:<canary> → pref:gold — three runs, zero guesses")
})

test("postMessage is an input channel: a dormant handler's payload is learned", async () => {
  await engine.run(
    `let unlocked = false;
window.addEventListener("message", (e) => {
  if (e.data === "open-sesame") unlocked = true;
});
console.log("idle");
`,
    { url: "https://app.example/" },
  )
  const r = await engine.exploreParams({ goal: `unlocked === true` })
  // the handler was registered but no message ever arrived: unused logic
  assert.deepEqual(r.inputs, [{ kind: "message", key: null, asRun: null, neverFired: true }])
  assert.ok(r.examples.length >= 1)
  const ex = r.examples[0]
  assert.equal(ex.edit, `postMessage("open-sesame")`)
  assert.deepEqual(ex.assignments[0].via.at(-1), { op: "eq", learned: "open-sesame" })
  assert.ok(ex.newLines.length >= 1, "the message woke a line the recording never executed")
})

test("object message protocols reveal their keys through the recording probe", async () => {
  await engine.run(
    `let mode = "idle";
onmessage = (e) => {
  if (e.data.type === "sync" && e.data.speed === "fast") mode = "turbo";
};
console.log(mode);
`,
    { url: "https://app.example/" },
  )
  const r = await engine.exploreParams({ goal: `mode === "turbo"` })
  assert.ok(r.examples.length >= 1)
  // key 1 learned from the probe proxy, key 2 from the continuation probe
  // that carries key 1's real value — the && guard is walked, not guessed
  const ex = r.examples.find((e) => !e.probe)
  assert.ok(ex, "a plain (probe-free) payload satisfies the goal")
  assert.equal(ex.edit, `postMessage({"type":"sync","speed":"fast"})`)
  const keys = ex.assignments[0].via.filter((v) => v.key).map((v) => [v.key, v.learned])
  assert.deepEqual(keys, [
    ["type", "sync"],
    ["speed", "fast"],
  ])
})

test("compound goals: no single input suffices, promising singles pair up", async () => {
  await engine.run(SITE_PROG, { html: SITE_HTML, url: "https://news.example/" })
  const r = await engine.exploreParams({
    goal: {
      all: [
        `document.body.classList.contains("dark")`,
        `!document.getElementById("beta-panel").classList.contains("hidden")`,
      ],
    },
    maxBranches: 60,
  })
  assert.ok(r.examples.length >= 1, "a pairwise combination satisfies both constraints")
  const ex = r.examples[0]
  assert.equal(ex.params.theme, "dark")
  assert.equal(ex.params.beta, "1")
  assert.ok(ex.goals.every((g) => g.ok), "per-constraint detail: both hold")
  assert.equal(ex.goals.length, 2)
  // baseline detail shows the as-run page satisfied neither
  assert.ok(r.baseline.every((g) => !g.ok))
  engine.switchTo(0)
})

test("goal specs: any / none combinators evaluate with detail", async () => {
  await engine.run(`let mode = "off";\nmode = "off";\nconsole.log(mode);`)
  const r = await engine.explore(engine.trace.length - 1, {
    goal: { any: [`mode === "a"`, `mode === "b"`], none: [`mode === "off"`] },
    candidates: [`mode = "a"`, `mode = "zzz"`],
    depth: 1,
  })
  assert.equal(r.examples.length, 1)
  assert.deepEqual(r.examples[0].path, [`mode = "a"`])
  const kinds = r.examples[0].goals.map((g) => [g.kind, g.ok])
  assert.deepEqual(kinds, [
    ["any", true],
    ["any", false],
    ["none", true],
  ])
})

test("per-storage registries: sessionStorage keys are learned and targeted in their own store", async () => {
  await engine.run(
    `const token = sessionStorage.getItem("token");
const theme = localStorage.getItem("theme");
let live = false;
if (token === "beta-pass") live = true;
console.log(live);
`,
    { url: "https://app.example/" },
  )
  // each storage object keeps its own read registry — no cross-pollution
  engine.positionTo(engine.trace.length - 1)
  assert.deepEqual(JSON.parse(engine.consoleEval(`JSON.stringify(localStorage.__reads)`).value.v), ["theme"])
  assert.deepEqual(JSON.parse(engine.consoleEval(`JSON.stringify(sessionStorage.__reads)`).value.v), ["token"])
  const r = await engine.exploreParams({ goal: `live === true` })
  assert.ok(r.examples.length >= 1)
  // the learned write goes to the storage object the program actually read
  assert.equal(r.examples[0].edit, `sessionStorage.setItem("token", "beta-pass")`)
  assert.equal(r.inputs.find((x) => x.key === "token").store, "sessionStorage")
  assert.equal(r.inputs.find((x) => x.key === "theme").store, "localStorage")
})

test("case-normalized comparisons still teach the raw value that the goal needs", async () => {
  await engine.run(
    `const raw = new URLSearchParams(location.search).get("size") || "";
let cup = "none";
if (raw.toUpperCase() === "GRANDE") cup = raw;
console.log(cup);
`,
    { url: "https://cafe.example/" },
  )
  // the guard uppercases the input before comparing, but the goal needs the
  // RAW spelling: the canary survives re-cased, attribution is
  // case-insensitive, and the learned constant is tried in both spellings
  const r = await engine.exploreParams({ goal: `cup === "grande"` })
  assert.ok(r.examples.length >= 1)
  const ex = r.examples[0]
  assert.equal(ex.params.size, "grande")
  const via = ex.assignments[0].via
  assert.deepEqual(
    via.map((v) => v.op),
    ["probe", "eq"],
  )
  assert.equal(via.at(-1).learned, "GRANDE", "the journal reported the normalized constant")
  assert.equal(via.at(-1).folded, "grande", "…and the candidate is its case-folded spelling")
  assert.equal(r.explored, 3, "probe → GRANDE → grande — still zero guesses")
})

test("inputs consulted only inside unlocked branches join the search mid-flight", async () => {
  await engine.run(
    `const params = new URLSearchParams(location.search);
let unlocked = false;
if (params.get("mode") === "x") {
  const secret = localStorage.getItem("secret");
  if (secret === "42") unlocked = true;
}
console.log(unlocked);
`,
    { url: "https://vault.example/" },
  )
  // as recorded, localStorage.getItem("secret") NEVER ran — the key is
  // invisible to any static read registry. The mode=x candidate's own run
  // reveals it; the discovered input then probes with mode=x re-applied
  // as context, and its value is learned from that combined run's journal
  const r = await engine.exploreParams({ goal: `unlocked === true` })
  assert.ok(r.examples.length >= 1, "the two-input combination was found")
  const ex = r.examples[0]
  assert.deepEqual(
    ex.assignments.map((a) => [a.kind, a.key, a.value]),
    [
      ["param", "mode", "x"],
      ["storage", "secret", "42"],
    ],
  )
  const disc = r.inputs.find((x) => x.key === "secret")
  assert.equal(disc.discovered, true, "the input joined mid-search")
  assert.equal(disc.store, "localStorage")
  assert.match(disc.under, /mode=x/, "provenance: which run revealed it")
  // the chain on the discovered input: revealed → probed → learned
  assert.deepEqual(
    ex.assignments[1].via.map((v) => v.op),
    ["discovered", "probe", "eq"],
  )
  assert.equal(ex.assignments[1].via.at(-1).learned, "42")
  assert.ok(ex.firstTrue != null)
  engine.switchTo(ex.branch, ex.firstTrue)
  assert.equal(engine.consoleEval(`unlocked`).value.v, true)
  engine.switchTo(0)
})

test("suggestEdits proposes storage writes with values learned from the run", async () => {
  await engine.run(
    `const pref = localStorage.getItem("accent") || "plain";
if (pref === "fancy") {
  document.getElementById("box").className = pref;
}
console.log(pref);
`,
    { html: `<style>.fancy { color: gold; }</style><div id="box"></div>` },
  )
  const cands = engine.suggestEdits(engine.trace.length - 1, { limit: 12 })
  assert.ok(
    cands.includes(`localStorage.setItem("accent", "fancy")`),
    `the journal teaches "fancy" — the value the code compared the read against: ${JSON.stringify(cands)}`,
  )
  // and explore can verify one end-to-end: set the pref, re-run from the top
  const r = await engine.explore(0, {
    goal: `document.getElementById("box").className === "fancy"`,
    candidates: [`localStorage.setItem("accent", "fancy")`],
    depth: 1,
  })
  assert.equal(r.examples.length, 1)
  engine.switchTo(r.examples[0].branch)
  assert.match(engine.inspect().dom, /class="fancy"/)
  engine.switchTo(0)
})
