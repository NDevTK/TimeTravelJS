import { test } from "node:test"
import assert from "node:assert/strict"
import { SnapshotStore, PAGE_SIZE } from "../src/snapshots.js"

function makeMem(pages) {
  return new Uint8Array(pages * PAGE_SIZE)
}

test("COW snapshots share unchanged pages", () => {
  const store = new SnapshotStore()
  const mem = makeMem(8)
  mem.fill(7)
  const s1 = store.take(mem)
  assert.equal(s1.dirtyPages, 8) // first snapshot copies everything

  mem[3 * PAGE_SIZE + 100] = 42 // dirty exactly one page
  const s2 = store.take(mem)
  assert.equal(s2.dirtyPages, 1)
  assert.equal(s2.pages[0], s1.pages[0]) // shared page object (identity)
  assert.notEqual(s2.pages[3], s1.pages[3]) // copied page
  const stats = store.stats()
  assert.equal(stats.uniquePages, 9) // 8 + 1 rewritten
  assert.equal(stats.naiveBytes, 2 * 8 * PAGE_SIZE)
  assert.equal(stats.retainedBytes, 9 * PAGE_SIZE)
  assert.ok(stats.savings > 0.4)
})

test("restore writes only differing pages and rewinds contents", () => {
  const store = new SnapshotStore()
  const mem = makeMem(4)
  mem.fill(1)
  const snap = store.take(mem)

  mem.fill(9, 0, PAGE_SIZE) // change page 0
  mem[2 * PAGE_SIZE] = 5 // change page 2
  const written = store.restore(snap, mem)
  assert.equal(written, 2)
  assert.equal(mem[0], 1)
  assert.equal(mem[2 * PAGE_SIZE], 1)
})

test("restore zeroes the tail when memory grew after the snapshot", () => {
  const store = new SnapshotStore()
  const memSmall = makeMem(2)
  memSmall.fill(3)
  const snap = store.take(memSmall)

  const memBig = makeMem(4)
  memBig.fill(8)
  store.restore(snap, memBig)
  assert.equal(memBig[0], 3)
  assert.equal(memBig[2 * PAGE_SIZE], 0) // grown tail zeroed for determinism
  assert.equal(memBig[4 * PAGE_SIZE - 1], 0)
})

test("restore refuses when live memory is smaller than the snapshot", () => {
  const store = new SnapshotStore()
  const mem = makeMem(4)
  const snap = store.take(mem)
  assert.throws(() => store.restore(snap, makeMem(2)), /cannot shrink/)
})

test("short final page is handled", () => {
  const store = new SnapshotStore()
  const mem = new Uint8Array(PAGE_SIZE + 100)
  mem.fill(4)
  const snap = store.take(mem)
  assert.equal(snap.pages.length, 2)
  assert.equal(snap.pages[1].length, 100)
  mem[PAGE_SIZE + 50] = 99
  const snap2 = store.take(mem)
  assert.equal(snap2.dirtyPages, 1)
  store.restore(snap, mem)
  assert.equal(mem[PAGE_SIZE + 50], 4)
})

test("prune drops snapshots and recomputes retained stats", () => {
  const store = new SnapshotStore()
  const mem = makeMem(4)
  for (let i = 0; i < 6; i++) {
    mem[i * 16] = i + 1
    store.take(mem, i)
  }
  assert.equal(store.count, 6)
  const before = store.stats().retainedBytes
  store.prune((snap) => snap.tag % 2 === 1)
  assert.equal(store.count, 3)
  assert.ok(store.stats().retainedBytes <= before)
  // remaining snapshots still restore correctly
  const target = store.snapshots[1]
  store.restore(target, mem)
  assert.equal(mem[0], 1)
})
