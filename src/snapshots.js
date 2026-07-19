// Copy-on-write snapshot store over a WebAssembly linear memory.
//
// A snapshot is a page table: an array of immutable Uint8Array pages plus a
// byte length. Consecutive snapshots share page objects for every page that
// did not change between them — only dirty pages are copied. WebAssembly has
// no hardware page-protection traps, so writes are detected by comparing the
// live memory against the previous snapshot's pages (software COW). Restoring
// works the same way in reverse: only pages that differ from the target
// snapshot are written back.

export const PAGE_SIZE = 4096
const WORDS_PER_PAGE = PAGE_SIZE / 4

function pagesEqual(mem, offset, page) {
  // Word-wise compare; both sides are PAGE_SIZE long except a final short page.
  if (page.length === PAGE_SIZE && (offset & 3) === 0) {
    const a = new Uint32Array(mem.buffer, mem.byteOffset + offset, WORDS_PER_PAGE)
    const b = new Uint32Array(page.buffer, page.byteOffset, WORDS_PER_PAGE)
    for (let i = 0; i < WORDS_PER_PAGE; i++) if (a[i] !== b[i]) return false
    return true
  }
  for (let i = 0; i < page.length; i++) if (mem[offset + i] !== page[i]) return false
  return true
}

export class SnapshotStore {
  constructor(pageSize = PAGE_SIZE) {
    if (pageSize !== PAGE_SIZE) throw new Error("page size is fixed at module level")
    this.snapshots = [] // { id, pages: Uint8Array[], byteLength, dirtyPages, newBytes, tag }
    this.uniquePages = new Set() // identity set of every distinct page object retained
    this.uniqueBytes = 0
    this.logicalBytes = 0 // sum of byteLength over snapshots (what naive full copies would cost)
    this.pageWriteHeat = new Map() // pageIndex -> number of checkpoints where it was dirty
    this._nextId = 0
  }

  get count() {
    return this.snapshots.length
  }

  /**
   * Take a snapshot of `mem` (a Uint8Array view over the whole linear memory).
   * Shares every page that is byte-identical to the same page of `base`
   * (default: the most recent snapshot).
   */
  take(mem, tag = null, base = this.snapshots[this.snapshots.length - 1] ?? null) {
    const byteLength = mem.byteLength
    const pageCount = Math.ceil(byteLength / PAGE_SIZE)
    const pages = new Array(pageCount)
    let dirtyPages = 0
    let newBytes = 0
    for (let p = 0; p < pageCount; p++) {
      const offset = p * PAGE_SIZE
      const len = Math.min(PAGE_SIZE, byteLength - offset)
      const basePage = base && p < base.pages.length && base.pages[p].length === len ? base.pages[p] : null
      if (basePage && pagesEqual(mem, offset, basePage)) {
        pages[p] = basePage // shared — copy-on-write in action
      } else {
        pages[p] = mem.slice(offset, offset + len)
        dirtyPages++
        newBytes += len
        this.pageWriteHeat.set(p, (this.pageWriteHeat.get(p) ?? 0) + 1)
        if (!this.uniquePages.has(pages[p])) {
          this.uniquePages.add(pages[p])
          this.uniqueBytes += len
        }
      }
    }
    const snap = { id: this._nextId++, pages, byteLength, dirtyPages, newBytes, tag }
    this.snapshots.push(snap)
    this.logicalBytes += byteLength
    return snap
  }

  /**
   * Write snapshot `snap` back into `mem`. Only pages that differ are written.
   * If the live memory is larger than the snapshot (it grew after the snapshot
   * was taken), the tail is zeroed so replays start from identical contents.
   * Returns the number of pages written.
   */
  restore(snap, mem) {
    if (mem.byteLength < snap.byteLength) {
      throw new Error("live memory is smaller than snapshot — WebAssembly memory cannot shrink")
    }
    let written = 0
    for (let p = 0; p < snap.pages.length; p++) {
      const page = snap.pages[p]
      const offset = p * PAGE_SIZE
      if (!pagesEqual(mem, offset, page)) {
        mem.set(page, offset)
        written++
      }
    }
    if (mem.byteLength > snap.byteLength) mem.fill(0, snap.byteLength)
    return written
  }

  /** Drop snapshots for which `predicate(snap, index)` is true. Recomputes stats. */
  prune(predicate) {
    const keep = []
    for (let i = 0; i < this.snapshots.length; i++) {
      if (!predicate(this.snapshots[i], i)) keep.push(this.snapshots[i])
    }
    this.snapshots = keep
    this._recomputeRetained()
  }

  /** Drop every snapshot after (not including) the one with the given id. */
  truncateAfter(id) {
    const idx = this.snapshots.findIndex((s) => s.id === id)
    if (idx >= 0 && idx < this.snapshots.length - 1) {
      this.snapshots.length = idx + 1
      this._recomputeRetained()
    }
  }

  clear() {
    this.snapshots = []
    this.uniquePages = new Set()
    this.uniqueBytes = 0
    this.logicalBytes = 0
    this.pageWriteHeat = new Map()
  }

  _recomputeRetained() {
    this.uniquePages = new Set()
    this.uniqueBytes = 0
    this.logicalBytes = 0
    for (const s of this.snapshots) {
      this.logicalBytes += s.byteLength
      for (const page of s.pages) {
        if (!this.uniquePages.has(page)) {
          this.uniquePages.add(page)
          this.uniqueBytes += page.length
        }
      }
    }
  }

  stats() {
    const naive = this.logicalBytes
    const actual = this.uniqueBytes
    return {
      snapshots: this.snapshots.length,
      uniquePages: this.uniquePages.size,
      retainedBytes: actual,
      naiveBytes: naive,
      savings: naive > 0 ? 1 - actual / naive : 0,
      lastByteLength: this.snapshots.length ? this.snapshots[this.snapshots.length - 1].byteLength : 0,
    }
  }
}
