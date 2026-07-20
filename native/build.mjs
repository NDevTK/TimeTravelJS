// Build the patched QuickJS + wrapper to WebAssembly.
//
//   node native/build.mjs [--debug]      → dist/quickjs-tt.wasm
//
// Pipeline:
//   1. clang (wasm32-wasi) compiles the QuickJS fork (host interface included) + tt-dom.c
//   2. Binaryen runs the Asyncify pass (suspendable import env.tt_host_step),
//      optimizes, and exports the shadow __stack_pointer global
//   3. native/barrier.mjs instruments every store with the dirty-page write
//      barrier (marks g_tt_dirty[(addr)>>10]) — after Asyncify, so the spill
//      stores are tracked too
//
// --debug keeps the name section for readable wasm stack traces.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { instrumentWriteBarrier } from "./barrier.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const qjs = join(root, "vendor/quickjs")
const out = join(root, "dist")
mkdirSync(out, { recursive: true })
const debug = process.argv.includes("--debug")

const CLANG = process.env.CLANG ?? "clang"
const rawWasm = join(out, "quickjs-tt.raw.wasm")
const finalWasm = join(out, "quickjs-tt.wasm")

const sources = ["quickjs.c", "cutils.c", "libregexp.c", "libunicode.c", "dtoa.c"].map((f) => join(qjs, f))
sources.push(join(root, "native/tt-dom.c"))

// Lexbor: the DOM/CSS engine shares this linear memory, so the document
// time-travels through the ordinary COW snapshots
import { readdirSync } from "node:fs"
const lexborRoot = join(root, "vendor/lexbor")
const lexborWalk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) lexborWalk(p)
    else if (name.name.endsWith(".c")) sources.push(p)
  }
}
for (const mod of ["core", "dom", "html", "css", "selectors", "style", "tag", "ns"])
  lexborWalk(join(lexborRoot, "lexbor", mod))
lexborWalk(join(lexborRoot, "lexbor/ports/posix"))

const args = [
  "--target=wasm32-wasi",
  "--sysroot=/usr",
  "-nostdinc",
  "-isystem", join(root, "native/shims"),
  "-isystem", "/usr/include/wasm32-wasi",
  "-isystem", "/usr/lib/llvm-18/lib/clang/18/include",
  "-O2",
  debug ? "-g" : "-g0",
  "-DCONFIG_VERSION=\"2026-06-04\"",
  "-D__wasi__",
  "-mexec-model=reactor",
  "-fno-strict-aliasing",
  "-Wl,--export=malloc",
  "-Wl,--export=free",
  "-Wl,-z,stack-size=1048576",
  // start small: the base snapshot and audits scale with footprint
  "-Wl,--initial-memory=6291456",
  "-Wl,--max-memory=536870912",
  "-Wl,--export-table",
  "-I", qjs,
  "-I", lexborRoot,
  "-DLEXBOR_STATIC",
  ...sources,
  "-lm",
  "-o", rawWasm,
]

console.log("· compiling QuickJS + wrapper → wasm32-wasi")
execFileSync(CLANG, args, { stdio: "inherit" })
console.log(`  ${(statSync(rawWasm).size / 1048576).toFixed(2)} MB raw`)

// --- discover the dirty map address (link-time layout, stable across passes)
const rawBytes = readFileSync(rawWasm)
const rawModule = await WebAssembly.compile(rawBytes)
const stubImports = {}
for (const imp of WebAssembly.Module.imports(rawModule)) {
  stubImports[imp.module] ??= {}
  stubImports[imp.module][imp.name] = imp.kind === "function" ? () => 0 : undefined
}
const rawInstance = await WebAssembly.instantiate(rawModule, stubImports)
const mapAddr = rawInstance.exports.tt_dirty_map()
const mapSize = rawInstance.exports.tt_dirty_map_size()
console.log(`· dirty map at ${mapAddr} (${mapSize / 1024} KB)`)

// No Asyncify: the stackless interpreter suspends by returning — the only
// transform left is optimization ahead of the write-barrier pass.
console.log("· Binaryen: optimize")
const binaryen = (await import("binaryen")).default
binaryen.setDebugInfo(debug)
const module_ = binaryen.readBinary(rawBytes)
binaryen.setOptimizeLevel(2)
binaryen.setShrinkLevel(0)
module_.optimize()
if (!module_.validate()) throw new Error("binaryen validation failed")
const asyncified = module_.emitBinary()
module_.dispose()
console.log(`  ${(asyncified.length / 1048576).toFixed(2)} MB optimized`)

console.log("· write-barrier pass (every store marks its 1 KB page)")
const final = instrumentWriteBarrier(asyncified, mapAddr)
if (!(await WebAssembly.validate(final))) throw new Error("barrier output failed validation")
writeFileSync(finalWasm, final)
console.log(`  ${(final.length / 1048576).toFixed(2)} MB → ${finalWasm}${debug ? " (debug names kept)" : ""}`)
