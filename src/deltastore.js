// Per-step copy-on-write history of the VM's linear memory.
//
// Every executed step gets a delta: the set of pages whose bytes changed
// since the previous step, stored as immutable page objects deduplicated by
// content (a loop that flips a refcount back and forth re-uses the same page
// object). The history is a persistent structure sharing everything
// unchanged — copy-on-write in the literal sense: a page is copied exactly
// when a write made it differ.
//
// Navigation applies deltas backward (old refs) or forward (new refs) and
// never re-executes anything.
//
// Pages are Uint32Array(256) (1 KB) — word-typed so the capture hot loop
// compares without allocating views.

export const PAGE_SIZE = 1024
const WORDS = PAGE_SIZE / 4

export class DeltaStore {
  constructor() {
    this.deltas = [] // deltas[i]: state i-1 → state i; deltas[0] = base image
    this.liveTable = [] // Uint32Array page refs for the CURRENT position
    this.liveLen = 0
    this.pool = new Map() // hash -> page[] (content-deduplicated pages)
    this.poolBytes = 0
    this.poolPages = 0
    this.logicalBytes = 0 // what full per-step snapshots would have cost
    this.pageHeat = new Map() // page index -> times dirtied
  }

  get count() {
    return this.deltas.length
  }

  _intern(u32, base) {
    let h = 0x811c9dc5
    for (let i = 0; i < WORDS; i++) {
      h ^= u32[base + i]
      h = Math.imul(h, 0x01000193)
    }
    h >>>= 0
    let bucket = this.pool.get(h)
    if (bucket) {
      outer: for (const page of bucket) {
        for (let i = 0; i < WORDS; i++) if (page[i] !== u32[base + i]) continue outer
        return page
      }
    } else {
      bucket = []
      this.pool.set(h, bucket)
    }
    const page = u32.slice(base, base + WORDS)
    bucket.push(page)
    this.poolBytes += PAGE_SIZE
    this.poolPages += 1
    return page
  }

  /**
   * Capture the differences between `mem` (Uint8Array over the whole linear
   * memory) and the live table as the next delta. Returns the new position.
   */
  capture(mem, tag = 0) {
    const len = mem.byteLength
    const pageCount = Math.ceil(len / PAGE_SIZE)
    const u32 = new Uint32Array(mem.buffer, 0, (len >> 2))
    const changes = []
    const table = this.liveTable
    for (let p = 0; p < pageCount; p++) {
      const base = p * WORDS
      const prev = p < table.length ? table[p] : null
      if (prev) {
        let equal = true
        for (let i = 0; i < WORDS; i++) {
          if (prev[i] !== u32[base + i]) {
            equal = false
            break
          }
        }
        if (equal) continue
      }
      const page = this._intern(u32, base)
      changes.push([p, prev ?? null, page])
      table[p] = page
      this.pageHeat.set(p, (this.pageHeat.get(p) ?? 0) + 1)
    }
    const delta = { changes, oldLen: this.liveLen, newLen: len, tag }
    this.liveLen = len
    this.deltas.push(delta)
    this.logicalBytes += len
    return this.deltas.length - 1
  }

  _writePage(mem, p, page) {
    mem.set(new Uint8Array(page.buffer, page.byteOffset, PAGE_SIZE), p * PAGE_SIZE)
  }

  /** Apply state transition i-1 → i onto mem (and the live table). */
  applyForward(i, mem) {
    const d = this.deltas[i]
    for (const [p, , page] of d.changes) {
      this._writePage(mem, p, page)
      this.liveTable[p] = page
    }
    this.liveLen = d.newLen
  }

  /** Apply state transition i → i-1 onto mem (and the live table). */
  applyBackward(i, mem) {
    const d = this.deltas[i]
    for (const [p, oldPage] of d.changes) {
      if (oldPage) {
        this._writePage(mem, p, oldPage)
        this.liveTable[p] = oldPage
      } else {
        // page did not exist before this delta (base image or memory growth)
        mem.fill(0, p * PAGE_SIZE, (p + 1) * PAGE_SIZE)
        this.liveTable[p] = null
      }
    }
    if (d.oldLen < d.newLen) {
      mem.fill(0, d.oldLen, Math.min(d.newLen, mem.byteLength))
      this.liveTable.length = Math.ceil(d.oldLen / PAGE_SIZE)
    }
    this.liveLen = d.oldLen
  }

  /**
   * Write the live table's state back into a memory whose contents drifted
   * (after a transactional inspection ran on it). Compare-and-write per
   * page: untouched pages cost only the comparison.
   */
  heal(mem) {
    const u32 = new Uint32Array(mem.buffer, 0, mem.byteLength >> 2)
    let written = 0
    for (let p = 0; p < this.liveTable.length; p++) {
      const page = this.liveTable[p]
      if (!page) continue
      const base = p * WORDS
      let equal = true
      for (let i = 0; i < WORDS; i++) {
        if (page[i] !== u32[base + i]) {
          equal = false
          break
        }
      }
      if (!equal) {
        this._writePage(mem, p, page)
        written++
      }
    }
    if (mem.byteLength > this.liveLen) mem.fill(0, this.liveLen)
    return written
  }

  clear() {
    this.deltas = []
    this.liveTable = []
    this.liveLen = 0
    this.pool = new Map()
    this.poolBytes = 0
    this.poolPages = 0
    this.logicalBytes = 0
    this.pageHeat = new Map()
  }

  stats() {
    return {
      snapshots: this.deltas.length,
      uniquePages: this.poolPages,
      retainedBytes: this.poolBytes,
      naiveBytes: this.logicalBytes,
      savings: this.logicalBytes > 0 ? 1 - this.poolBytes / this.logicalBytes : 0,
      lastByteLength: this.liveLen,
    }
  }

  /** dirty page count per delta — feeds the timeline/memory visualizations */
  dirtyCounts() {
    return this.deltas.map((d) => d.changes.length)
  }
}
