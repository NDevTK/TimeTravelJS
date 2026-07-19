// Run html5lib-tests tree-construction fixtures through the ENGINE: each
// input is parsed by the embedded Lexbor via engine.run({ html }), the
// tree is dumped in html5lib format by a JS program running INSIDE the
// debugger (stepping enabled), and compared against the expected dump.
// Proves the embedded parser + the self-hosted DOM view of it.
//
//   node tools/html5lib-run.mjs <html5lib-tests>/tree-construction [file...]
//
// Fragment tests (#document-fragment), script-dependent expectations
// (#script-on), and foreign-content/template files are reported as
// skipped: the debugger exposes whole-document parsing without a
// scripting flag, and the dumper does not model namespace prefixes or
// template content subtrees.
import { readFileSync, readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { TimeTravelEngine } from "../src/engine.js"

const [, , dir, ...only] = process.argv
if (!dir) {
  console.error("usage: node tools/html5lib-run.mjs <tree-construction-dir> [file.dat...]")
  process.exit(2)
}

const SKIP_FILES = new Set()

const parseDat = (text) => {
  const tests = []
  let cur = null, section = null
  for (const line of text.split("\n")) {
    if (line === "#data") {
      if (cur) tests.push(cur)
      cur = { data: [], document: [], flags: new Set() }
      section = "data"
    } else if (line === "#errors" || line === "#new-errors") section = "errors"
    else if (line === "#document") section = "document"
    else if (line === "#document-fragment") { section = "fragment"; cur.flags.add("fragment") }
    else if (line === "#script-on") { section = "scripton"; cur.flags.add("script-on") }
    else if (line === "#script-off") section = "document" // same expectations for us
    else if (section === "data") cur.data.push(line)
    else if (section === "document") cur.document.push(line)
  }
  if (cur) tests.push(cur)
  for (const t of tests) {
    // #data lines join with \n; the final blank separator line is not data
    t.input = t.data.join("\n")
    while (t.document.length && t.document[t.document.length - 1] === "") t.document.pop()
    t.expected = t.document.join("\n")
  }
  return tests
}

const DUMPER = `
const out = [];
const attrName = (a) => {
  const i = a.indexOf(":");
  if (i > 0) {
    const p = a.slice(0, i);
    if (p === "xlink" || p === "xml" || p === "xmlns") return p + " " + a.slice(i + 1);
  }
  return a;
};
const walk = (n, depth) => {
  const pad = "| " + "  ".repeat(depth);
  const t = n.nodeType;
  if (t === 1) {
    const ns = n.namespaceURI;
    const prefix = ns.endsWith("/svg") ? "svg " : ns.indexOf("Math") >= 0 ? "math " : "";
    const tag = prefix ? n.tagName : n.tagName.toLowerCase();
    out.push(pad + "<" + prefix + tag + ">");
    const aname = prefix ? attrName : (a) => a; /* namespaced dumps only on foreign elements */
    const names = n.getAttributeNames().slice();
    names.sort((a, b) => (aname(a) < aname(b) ? -1 : aname(a) > aname(b) ? 1 : 0));
    for (const a of names)
      out.push("| " + "  ".repeat(depth + 1) + aname(a) + "=\\"" + n.getAttribute(a) + "\\"");
    if (!prefix && n.tagName === "TEMPLATE") {
      out.push("| " + "  ".repeat(depth + 1) + "content");
      const c = n.content;
      if (c) for (const k of c.childNodes) walk(k, depth + 2);
      return;
    }
    for (const c of n.childNodes) walk(c, depth + 1);
  } else if (t === 3) {
    out.push(pad + '"' + n.textContent + '"');
  } else if (t === 7) {
    const d = n.data || "";
    out.push(pad + "<!-- ?" + n.nodeName + (d ? " " + d : "") + "? -->");
  } else if (t === 8) {
    out.push(pad + "<!-- " + n.data + " -->");
  } else if (t === 10) {
    const name = n.name, pub = n.publicId, sys = n.systemId;
    if (pub || sys) out.push(pad + "<!DOCTYPE " + name + ' "' + pub + '" "' + sys + '">');
    else out.push(pad + "<!DOCTYPE " + name + ">");
  }
};
for (const c of document.childNodes) walk(c, 0);
/* chunked: the console serializer caps long strings */
for (const l of out) {
  if (l.length <= 100) { console.log("L", l); continue; }
  console.log("L", l.slice(0, 100));
  for (let i = 100; i < l.length; i += 100) console.log("C", l.slice(i, i + 100));
}
`

const bytes = readFileSync(new URL("../dist/quickjs-tt.wasm", import.meta.url))
const engine = await TimeTravelEngine.create(bytes)

const files = (only.length ? only : readdirSync(dir).filter((f) => f.endsWith(".dat")).sort())
let pass = 0, fail = 0, skip = 0
const failures = []
for (const f of files) {
  if (SKIP_FILES.has(basename(f))) { skip++; continue }
  const tests = parseDat(readFileSync(join(dir, f), "utf8"))
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i]
    if (t.flags.has("fragment") || t.flags.has("script-on")) { skip++; continue }
    let got
    try {
      const summary = await engine.run(DUMPER, { html: t.input, maxSteps: 100000 })
      if (summary.error) throw new Error(JSON.stringify(summary.error))
      const lines = []
      for (const e of engine.consoleEntries) {
        const kind = e.parts[0]?.v
        const chunk = String(e.parts[1]?.v ?? "")
        if (kind === "L") lines.push(chunk)
        else if (lines.length) lines[lines.length - 1] += chunk
      }
      got = lines.join("\n")
    } catch (e) {
      got = "ENGINE ERROR: " + e
    }
    if (got === t.expected) pass++
    else {
      fail++
      if (failures.length < 8)
        failures.push({ file: basename(f), i, input: t.input, expected: t.expected, got })
    }
  }
}

console.log(`html5lib tree-construction via the engine: ${pass} pass, ${fail} fail, ${skip} skipped`)
for (const x of failures) {
  console.log(`\n--- ${x.file} #${x.i}\ninput:    ${JSON.stringify(x.input.slice(0, 120))}`)
  console.log(`expected:\n${x.expected}\ngot:\n${x.got}`)
}
process.exit(fail ? 1 : 0)
