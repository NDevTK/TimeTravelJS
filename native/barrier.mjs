// Write-barrier instrumentation pass over a WebAssembly binary.
//
// Rewrites every memory store so it also marks the touched 1 KB page(s) in a
// byte map inside linear memory (`g_tt_dirty` in the quickjs.c host section):
//
//     g_tt_dirty[(addr + offset) >> 10] = 1        (and the end page, when
//     g_tt_dirty[(addr + offset + size-1) >> 10] = 1    the access can straddle)
//
// The injected marking stores are emitted raw (not themselves instrumented),
// so the map region never marks itself and stays out of recorded history.
// Bulk operations (memory.copy / memory.fill / memory.init) mark their whole
// destination range with an inline loop.
//
// This runs on Binaryen's output (after the Asyncify pass), so the asyncify
// spill stores are instrumented too — the spill buffer is part of every
// snapshot. WebAssembly branches are structural (relative depths, not byte
// offsets), so inserting instructions requires no relocation beyond
// re-encoding body/section sizes.
//
// Note on trapping stores: the page mark executes before the store itself,
// so an out-of-bounds store may scribble one byte before trapping. A trap
// ends the recording session anyway; recorded history is unaffected.

// ---------------------------------------------------------------------------
// LEB helpers
// ---------------------------------------------------------------------------
class Reader {
  constructor(bytes) {
    this.b = bytes
    this.p = 0
  }
  u8() {
    return this.b[this.p++]
  }
  u32() {
    let r = 0
    let s = 0
    for (;;) {
      const byte = this.b[this.p++]
      r |= (byte & 0x7f) << s
      if (!(byte & 0x80)) return r >>> 0
      s += 7
    }
  }
  s33() {
    // signed LEB (used for block types); value unused, just skip correctly
    let s = 0
    for (;;) {
      const byte = this.b[this.p++]
      s += 7
      if (!(byte & 0x80)) return
    }
  }
  s64skip() {
    for (;;) {
      const byte = this.b[this.p++]
      if (!(byte & 0x80)) return
    }
  }
  bytes(n) {
    const r = this.b.subarray(this.p, this.p + n)
    this.p += n
    return r
  }
}

function uleb(n) {
  const out = []
  n = n >>> 0
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n !== 0) byte |= 0x80
    out.push(byte)
  } while (n !== 0)
  return out
}

function sleb(n) {
  // signed LEB128 for i32.const immediates (n may be up to 2^31-1)
  const out = []
  for (;;) {
    const byte = n & 0x7f
    n >>= 7
    if ((n === 0 && !(byte & 0x40)) || (n === -1 && byte & 0x40)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

// ---------------------------------------------------------------------------
// opcode tables
// ---------------------------------------------------------------------------
const STORES = {
  0x36: { size: 4, valLocal: "v32" }, // i32.store
  0x37: { size: 8, valLocal: "v64" }, // i64.store
  0x38: { size: 4, valLocal: "vf32" }, // f32.store
  0x39: { size: 8, valLocal: "vf64" }, // f64.store
  0x3a: { size: 1, valLocal: "v32" }, // i32.store8
  0x3b: { size: 2, valLocal: "v32" }, // i32.store16
  0x3c: { size: 1, valLocal: "v64" }, // i64.store8
  0x3d: { size: 2, valLocal: "v64" }, // i64.store16
  0x3e: { size: 4, valLocal: "v64" }, // i64.store32
}

const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f])

// ---------------------------------------------------------------------------
// instruction walking
// ---------------------------------------------------------------------------
/**
 * Skip one instruction's immediates (opcode already consumed).
 * Returns false for `end` at depth handling by the caller.
 */
function skipImmediates(r, opcode) {
  switch (opcode) {
    case 0x02:
    case 0x03:
    case 0x04: {
      const t = r.b[r.p]
      if (t === 0x40 || VALTYPES.has(t)) r.p++
      else r.s33()
      return
    }
    case 0x0c:
    case 0x0d:
      r.u32()
      return
    case 0x0e: {
      const n = r.u32()
      for (let i = 0; i <= n; i++) r.u32()
      return
    }
    case 0x10:
      r.u32()
      return
    case 0x11:
      r.u32()
      r.u32()
      return
    case 0x1c: {
      const n = r.u32()
      r.p += n
      return
    }
    case 0x20:
    case 0x21:
    case 0x22:
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26:
      r.u32()
      return
    case 0x3f:
    case 0x40:
      r.u32() // memory index (0x00)
      return
    case 0x41:
      r.s64skip()
      return
    case 0x42:
      r.s64skip()
      return
    case 0x43:
      r.p += 4
      return
    case 0x44:
      r.p += 8
      return
    case 0xd0:
      r.p += 1
      return
    case 0xd2:
      r.u32()
      return
    default:
      if (opcode >= 0x28 && opcode <= 0x3e) {
        r.u32() // align
        r.u32() // offset
        return
      }
      if ((opcode >= 0x00 && opcode <= 0x01) || opcode === 0x05 || opcode === 0x0b || opcode === 0x0f || opcode === 0x1a || opcode === 0x1b || (opcode >= 0x45 && opcode <= 0xc4) || opcode === 0xd1) {
        return // no immediates
      }
      throw new Error(`barrier: unhandled opcode 0x${opcode.toString(16)}`)
  }
}

/** 0xFC-prefixed: returns {sub} after skipping immediates. */
function skipFCImmediates(r) {
  const sub = r.u32()
  switch (sub) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
      return sub // trunc_sat — no immediates
    case 8:
      r.u32()
      r.u32()
      return sub // memory.init: dataidx, memidx
    case 9:
      r.u32()
      return sub // data.drop
    case 10:
      r.u32()
      r.u32()
      return sub // memory.copy: two mem indices
    case 11:
      r.u32()
      return sub // memory.fill
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
    case 17:
      r.u32()
      if (sub === 12 || sub === 14) r.u32()
      return sub // table ops
    default:
      throw new Error(`barrier: unhandled 0xFC sub-opcode ${sub}`)
  }
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------
export function instrumentWriteBarrier(wasmBytes, mapAddr) {
  const bytes = new Uint8Array(wasmBytes)
  if (bytes[0] !== 0 || bytes[1] !== 0x61) throw new Error("not a wasm binary")

  // --- locate sections; collect function type info for local indexing
  const r = new Reader(bytes)
  r.p = 8
  const sections = [] // {id, headStart, start, end}
  while (r.p < bytes.length) {
    const headStart = r.p
    const id = r.u8()
    const size = r.u32()
    const payloadStart = r.p
    sections.push({ id, headStart, start: payloadStart, end: payloadStart + size })
    r.p = payloadStart + size
  }

  const typeParamCounts = []
  const funcTypeIdx = []
  let importedFuncs = 0
  let codeSection = null

  for (const sec of sections) {
    const sr = new Reader(bytes)
    sr.p = sec.start
    if (sec.id === 1) {
      const n = sr.u32()
      for (let i = 0; i < n; i++) {
        const form = sr.u8()
        if (form !== 0x60) throw new Error("barrier: unsupported type form")
        const params = sr.u32()
        sr.p += params
        const results = sr.u32()
        sr.p += results
        typeParamCounts.push(params)
      }
    } else if (sec.id === 2) {
      const n = sr.u32()
      for (let i = 0; i < n; i++) {
        const modLen = sr.u32()
        sr.p += modLen
        const nameLen = sr.u32()
        sr.p += nameLen
        const kind = sr.u8()
        if (kind === 0) {
          sr.u32() // type index
          importedFuncs++
        } else if (kind === 1) {
          sr.p += 1 // reftype
          const flags = sr.u8()
          sr.u32()
          if (flags & 1) sr.u32()
        } else if (kind === 2) {
          const flags = sr.u8()
          sr.u32()
          if (flags & 1) sr.u32()
        } else if (kind === 3) {
          sr.p += 2 // valtype + mutability
        } else {
          throw new Error("barrier: unknown import kind")
        }
      }
    } else if (sec.id === 3) {
      const n = sr.u32()
      for (let i = 0; i < n; i++) funcTypeIdx.push(sr.u32())
    } else if (sec.id === 10) {
      codeSection = sec
    }
  }
  if (!codeSection) throw new Error("barrier: no code section")

  // --- rewrite the code section
  const cr = new Reader(bytes)
  cr.p = codeSection.start
  const funcCount = cr.u32()
  const newBodies = []

  const MAP = mapAddr >>> 0

  for (let f = 0; f < funcCount; f++) {
    const bodySize = cr.u32()
    const bodyEnd = cr.p + bodySize

    // parse local decls
    const declCount = cr.u32()
    const decls = []
    let localCount = 0
    for (let i = 0; i < declCount; i++) {
      const count = cr.u32()
      const type = cr.u8()
      decls.push([count, type])
      localCount += count
    }
    const params = typeParamCounts[funcTypeIdx[f]]
    const base = params + localCount
    const L = {
      p: base, // i32: pointer
      q: base + 1, // i32: length / scratch
      rr: base + 2, // i32: range cursor
      ss: base + 3, // i32: range end
      v32: base + 4, // i32: store value
      v64: base + 5, // i64: store value
      vf32: base + 6, // f32: store value
      vf64: base + 7, // f64: store value
    }

    const out = []
    const emit = (...xs) => {
      for (const x of xs) {
        if (Array.isArray(x)) out.push(...x)
        else out.push(x)
      }
    }
    // new local decls: existing + [5×i32, 1×i64, 1×f32, 1×f64]
    emit(uleb(declCount + 4))
    for (const [count, type] of decls) emit(uleb(count), type)
    emit(uleb(5), 0x7f, uleb(1), 0x7e, uleb(1), 0x7d, uleb(1), 0x7c)

    // helper: emit "mark page of ($p + k)" — [] -> []
    const emitMark = (k) => {
      emit(0x41, sleb(MAP)) // i32.const MAP
      emit(0x20, uleb(L.p)) // local.get $p
      if (k !== 0) emit(0x41, sleb(k), 0x6a) // i32.const k ; i32.add
      emit(0x41, sleb(10), 0x76) // i32.const 10 ; i32.shr_u
      emit(0x6a) // i32.add
      emit(0x41, sleb(1)) // i32.const 1
      emit(0x3a, 0x00, 0x00) // i32.store8 align=0 offset=0
    }
    // helper: mark range [$p, $p+$q) with an inline loop (skipped when $q==0)
    const emitMarkRange = () => {
      emit(0x20, uleb(L.q), 0x04, 0x40) // local.get $q ; if (empty)
      //   rr = MAP + (p >> 10)
      emit(0x41, sleb(MAP), 0x20, uleb(L.p), 0x41, sleb(10), 0x76, 0x6a, 0x21, uleb(L.rr))
      //   ss = MAP + ((p + q - 1) >> 10)
      emit(0x41, sleb(MAP), 0x20, uleb(L.p), 0x20, uleb(L.q), 0x6a, 0x41, sleb(1), 0x6b, 0x41, sleb(10), 0x76, 0x6a, 0x21, uleb(L.ss))
      emit(0x03, 0x40) // loop (empty)
      emit(0x20, uleb(L.rr), 0x41, sleb(1), 0x3a, 0x00, 0x00) // map[rr] = 1
      emit(0x20, uleb(L.rr), 0x20, uleb(L.ss), 0x49) // rr < ss (i32.lt_u)
      emit(0x04, 0x40) // if
      emit(0x20, uleb(L.rr), 0x41, sleb(1), 0x6a, 0x21, uleb(L.rr)) // rr++
      emit(0x0c, uleb(1)) // br 1 → the loop
      emit(0x0b) // end if
      emit(0x0b) // end loop
      emit(0x0b) // end outer if
    }

    // walk instructions, copying + instrumenting
    let last = cr.p
    const flush = (to) => {
      for (let i = last; i < to; i++) out.push(bytes[i])
      last = to
    }
    while (cr.p < bodyEnd) {
      const opStart = cr.p
      const opcode = cr.u8()
      if (STORES[opcode]) {
        const align = cr.u32()
        const offset = cr.u32()
        if (offset > 0x7fffffff) throw new Error("barrier: store offset too large")
        const { size, valLocal } = STORES[opcode]
        flush(opStart) // copy everything before this store
        // stack: [ptr, value]
        emit(0x21, uleb(L[valLocal])) // local.set $v
        emit(0x21, uleb(L.p)) // local.set $p
        emitMark(offset)
        if (size > 1) emitMark(offset + size - 1)
        emit(0x20, uleb(L.p)) // local.get $p
        emit(0x20, uleb(L[valLocal])) // local.get $v
        emit(opcode, uleb(align), uleb(offset)) // original store
        last = cr.p
      } else if (opcode === 0xfc) {
        const beforeImm = cr.p
        const sub = skipFCImmediates(cr)
        if (sub === 10 || sub === 11 || sub === 8) {
          // memory.copy [d,s,n] / memory.fill [d,v,n] / memory.init [d,s,n]
          flush(opStart)
          emit(0x21, uleb(L.q)) // n
          emit(0x21, uleb(L.v32)) // src / val (i32 in all three)
          emit(0x21, uleb(L.p)) // dest
          emitMarkRange()
          emit(0x20, uleb(L.p), 0x20, uleb(L.v32), 0x20, uleb(L.q))
          emit(0xfc)
          for (let i = beforeImm; i < cr.p; i++) out.push(bytes[i])
          last = cr.p
        }
        // other 0xFC ops: leave for flush
        void beforeImm
      } else {
        skipImmediates(cr, opcode)
      }
    }
    flush(bodyEnd)
    newBodies.push(Uint8Array.from(out))
  }

  // --- assemble: all sections verbatim except code
  const chunks = [bytes.subarray(0, 8)]
  for (const sec of sections) {
    if (sec.id !== 10) {
      chunks.push(bytes.subarray(sec.headStart, sec.end))
      continue
    }
    const payload = []
    payload.push(...uleb(funcCount))
    for (const body of newBodies) {
      payload.push(...uleb(body.length))
      for (const byte of body) payload.push(byte)
    }
    chunks.push(Uint8Array.from([10, ...uleb(payload.length)]))
    chunks.push(Uint8Array.from(payload))
  }
  let total = 0
  for (const c of chunks) total += c.length
  const outBin = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    outBin.set(c, off)
    off += c.length
  }
  return outBin
}
