// Build the patched QuickJS + wrapper to WebAssembly with an Asyncify pass.
//
//   node native/build.mjs            → dist/quickjs-tt.wasm
//
// Toolchain: clang (wasm32-wasi target) + wasi-libc + compiler-rt, then
// Binaryen's Asyncify pass (via the binaryen npm package) marking the single
// suspendable import env.tt_host_step.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const qjs = join(root, "vendor/quickjs")
const out = join(root, "dist")
mkdirSync(out, { recursive: true })

const CLANG = process.env.CLANG ?? "clang"
const rawWasm = join(out, "quickjs-tt.raw.wasm")
const finalWasm = join(out, "quickjs-tt.wasm")

const sources = ["quickjs.c", "cutils.c", "libregexp.c", "libunicode.c", "dtoa.c"].map((f) => join(qjs, f))
sources.push(join(root, "native/tt-wrap.c"))

const args = [
  "--target=wasm32-wasi",
  "--sysroot=/usr",
  "-nostdinc",
  "-isystem", join(root, "native/shims"),
  "-isystem", "/usr/include/wasm32-wasi",
  "-isystem", "/usr/lib/llvm-18/lib/clang/18/include",
  "-O2",
  "-g",
  "-DCONFIG_VERSION=\"2026-06-04\"",
  "-D__wasi__",
  "-mexec-model=reactor",
  "-fno-strict-aliasing",
  "-Wl,--export=malloc",
  "-Wl,--export=free",
  "-Wl,-z,stack-size=1048576",
  // start small: per-step COW capture compares live memory, so footprint is speed
  "-Wl,--initial-memory=6291456",
  "-Wl,--max-memory=536870912",
  "-Wl,--export-table",
  "-I", qjs,
  ...sources,
  "-lm",
  "-o", rawWasm,
]

console.log("· compiling QuickJS + wrapper → wasm32-wasi")
execFileSync(CLANG, args, { stdio: "inherit" })
console.log(`  ${(statSync(rawWasm).size / 1048576).toFixed(2)} MB raw`)

console.log("· running Binaryen Asyncify pass (suspendable import: env.tt_host_step)")
const binaryen = (await import("binaryen")).default
binaryen.setDebugInfo(true) // keep the name section for readable stack traces
const module_ = binaryen.readBinary(readFileSync(rawWasm))
binaryen.setOptimizeLevel(2)
binaryen.setShrinkLevel(0)
binaryen.setPassArgument("asyncify-imports", "env.tt_host_step")
module_.runPasses(["asyncify"])
module_.optimize()
// The shadow stack pointer is a wasm global — invisible to linear-memory
// snapshots, but a rewind only works from the same SP the unwind left
// behind. Export it so the engine can save/restore it per suspension.
module_.addGlobalExport("__stack_pointer", "__stack_pointer")
if (!module_.validate()) throw new Error("binaryen validation failed")
const bytes = module_.emitBinary()
module_.dispose()
writeFileSync(finalWasm, bytes)
console.log(`  ${(bytes.length / 1048576).toFixed(2)} MB asyncified → ${finalWasm}`)
