import { test } from "node:test"
import assert from "node:assert/strict"
import { DeltaStore, PAGE_SIZE } from "../src/deltastore.js"

const makeMem = (pages) => new Uint8Array(pages * PAGE_SIZE)

test("per-step deltas share unchanged pages and dedupe by content", () => {
  const store = new DeltaStore()
  const mem = makeMem(8)
  for (let p = 0; p < 8; p++) mem.fill(p + 1, p * PAGE_SIZE, (p + 1) * PAGE_SIZE)
  store.capture(mem) // base image: 8 distinct dirty pages
  assert.equal(store.deltas[0].changes.length, 8)

  mem[3 * PAGE_SIZE + 5] = 42
  store.capture(mem)
  assert.equal(store.deltas[1].changes.length, 1)

  // flip the page back — content-dedup must reuse the original page object
  mem[3 * PAGE_SIZE + 5] = 4
  store.capture(mem)
  const stats = store.stats()
  assert.equal(store.deltas[2].changes.length, 1)
  assert.equal(stats.uniquePages, 9, "reverted page content must not be stored twice")
  assert.equal(store.deltas[2].changes[0][2], store.deltas[0].changes[3][2], "identical content shares the page object")
  assert.ok(stats.savings > 0.5)
})

test("navigation applies deltas backward and forward exactly", () => {
  const store = new DeltaStore()
  const mem = makeMem(4)
  const states = []
  for (let step = 0; step < 6; step++) {
    mem[step * 16] = step + 1
    mem[2 * PAGE_SIZE + step] = 100 + step
    store.capture(mem)
    states.push(mem.slice())
  }
  // walk backward to 2
  for (let i = 5; i > 2; i--) store.applyBackward(i, mem)
  assert.deepEqual(mem, states[2])
  // forward to 4
  for (let i = 3; i <= 4; i++) store.applyForward(i, mem)
  assert.deepEqual(mem, states[4])
  // all the way to 0 and back to 5
  for (let i = 4; i > 0; i--) store.applyBackward(i, mem)
  assert.deepEqual(mem, states[0])
  for (let i = 1; i <= 5; i++) store.applyForward(i, mem)
  assert.deepEqual(mem, states[5])
})

test("memory growth between steps restores with a zeroed tail going back", () => {
  const store = new DeltaStore()
  let mem = makeMem(2)
  mem.fill(3)
  store.capture(mem)
  const small = mem.slice()
  // grow
  const grown = makeMem(4)
  grown.set(mem)
  grown.fill(9, 2 * PAGE_SIZE)
  mem = grown
  store.capture(mem)
  store.applyBackward(1, mem)
  assert.deepEqual(mem.subarray(0, 2 * PAGE_SIZE), small)
  assert.equal(mem[3 * PAGE_SIZE], 0, "grown tail zeroed for the older state")
  store.applyForward(1, mem)
  assert.equal(mem[3 * PAGE_SIZE], 9)
})

test("heal repairs drifted memory back to the live table", () => {
  const store = new DeltaStore()
  const mem = makeMem(4)
  mem.fill(5)
  store.capture(mem)
  const pristine = mem.slice()
  // a transaction scribbles over memory
  mem.fill(200, 100, 5000)
  const written = store.heal(mem)
  assert.ok(written >= 1)
  assert.deepEqual(mem, pristine)
})
