// Loader + driver for the TimeTravelJS QuickJS build (dist/quickjs-tt.wasm).
//
// One suspension mechanism, one contract: the stackless interpreter keeps
// every frame in a linear-memory arena, so suspending IS returning from the
// entry export and resuming is a fresh call into tt_resume. A parked
// machine has no live wasm activation at all — its complete state is linear
// memory, restorable from any snapshot by construction.
//
// No handles, no wrappers: strings cross the boundary as UTF-8 bytes, and
// every JSValue the wrapper holds lives inside the VM image itself.

const td = new TextDecoder()
const te = new TextEncoder()

export const STEP_CONTINUE = 0
export const STEP_ABORT = 1

export class QuickJSVM {
  /**
   * @param wasmBytes  BufferSource with dist/quickjs-tt.wasm
   * @param hooks {
   *   onOut(kind, text) — out-of-band channel (console/inspection/results);
   *   onInterrupt() → bool — watchdog for stretches between steps.
   * }
   */
  static async instantiate(wasmBytes, hooks) {
    const vm = new QuickJSVM(hooks)
    const imports = {
      env: {
        tt_host_out: (kind, ptr, len) => hooks.onOut(kind, vm.readString(ptr, len)),
        tt_host_arg: (dst, cap) => vm._hostArg(dst, cap),
        tt_host_interrupt: () => (hooks.onInterrupt?.() ? 1 : 0),
      },
      wasi_snapshot_preview1: vm._wasiImports(),
    }
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports)
    vm.exports = instance.exports
    vm.memory = instance.exports.memory
    vm.dirtyMapPtr = vm.exports.tt_dirty_map()
    vm.dirtyMapSize = vm.exports.tt_dirty_map_size()
    const rc = vm.exports.tt_init()
    if (rc !== 0) throw new Error(`tt_init failed: ${rc}`)
    if (hooks.setupSrc) {
      // Interim: the shrinking JS substrate (src/vm/tt-setup.js) — being
      // ported block-by-block to native C inside the engine itself.
      const bytes = te.encode(hooks.setupSrc)
      const ptr = vm.exports.tt_alloc(bytes.length)
      new Uint8Array(vm.memory.buffer, ptr, bytes.length).set(bytes)
      const rc2 = vm.exports.tt_load_setup(0, ptr, bytes.length)
      vm.exports.tt_free(ptr)
      if (rc2 !== 0) throw new Error(`tt_load_setup failed: ${rc2}`)
    }
    return vm
  }

  /** page count covering the current memory size */
  get pageCount() {
    return this.memory.buffer.byteLength >> 10
  }

  /**
   * Collect the pages the write barrier marked since the last clear, and
   * clear the map. O(map bytes scanned + dirty pages).
   */
  readAndClearDirtyPages() {
    const pageCount = this.pageCount
    const words = pageCount >> 2
    const u32 = new Uint32Array(this.memory.buffer, this.dirtyMapPtr, words + 1)
    const u8 = new Uint8Array(this.memory.buffer, this.dirtyMapPtr, pageCount)
    const pages = []
    for (let w = 0; w <= words; w++) {
      if (u32[w] === 0) continue
      const b0 = w << 2
      for (let i = 0; i < 4; i++) {
        const p = b0 + i
        if (p < pageCount && u8[p]) {
          pages.push(p)
          u8[p] = 0
        }
      }
      u32[w] = 0
    }
    return pages
  }

  clearDirtyMap() {
    new Uint8Array(this.memory.buffer, this.dirtyMapPtr, this.pageCount).fill(0)
  }

  /** Mark pages for a JS-side write into VM memory (bypasses the barrier). */
  markRange(ptr, len) {
    if (len <= 0 || this.dirtyMapPtr === undefined) return
    const u8 = new Uint8Array(this.memory.buffer, this.dirtyMapPtr, this.dirtyMapSize)
    const first = ptr >> 10
    const last = (ptr + len - 1) >> 10
    for (let p = first; p <= last && p < this.dirtyMapSize; p++) u8[p] = 1
  }

  /** pages fully covered by the dirty map itself — excluded from history */
  mapExclusion() {
    return [this.dirtyMapPtr >> 10, ((this.dirtyMapPtr + this.dirtyMapSize - 1) >> 10) + 1]
  }

  constructor(hooks) {
    this.hooks = hooks
    this.suspended = false
    this.stagedArg = null // Uint8Array staged for tt_eval_parked / tt_eval_idle
  }

  mem() {
    return new Uint8Array(this.memory.buffer)
  }

  readString(ptr, len) {
    return td.decode(new Uint8Array(this.memory.buffer, ptr, len))
  }

  // ---- imports ------------------------------------------------------------
  _hostArg(dst, cap) {
    if (!this.stagedArg) return 0
    const n = Math.min(this.stagedArg.length, cap)
    new Uint8Array(this.memory.buffer, dst, n).set(this.stagedArg.subarray(0, n))
    this.markRange(dst, n)
    this.stagedArg = null
    return n
  }

  // ---- entry driving ------------------------------------------------------
  /** Invoke an entry export; returns { suspended, park: 'r' } or { done }. */
  drive(name, ...args) {
    if (this.suspended) throw new Error("VM already suspended")
    this.exports[name](...args)
    return this._postEntry()
  }

  /** Let the parked VM run again — a plain call into tt_resume. */
  resume(command) {
    if (!this.suspended) throw new Error("VM not suspended")
    this.suspended = false
    this.exports.tt_resume(command === STEP_ABORT ? 1 : 0)
    return this._postEntry()
  }

  _postEntry() {
    if (this.exports.tt_parked()) {
      this.suspended = true
      return { suspended: true, park: "r" }
    }
    return { done: true }
  }

  /**
   * Adopt a suspension restored from a snapshot: after the engine rewrites
   * linear memory with a state captured while parked, the machine is
   * resumable by construction — this just re-arms the driver's bookkeeping.
   */
  adoptSuspension() {
    this.suspended = true
  }

  /** Forget the current suspension (its memory is being navigated away). */
  abandonSuspension() {
    this.suspended = false
  }

  /** Reset driver bookkeeping after a failed transaction. */
  normalize() {
    this.suspended = false
    this.stagedArg = null
  }

  // ---- helpers ------------------------------------------------------------
  /** Copy a JS string into VM memory; caller frees via tt_free. */
  writeString(s) {
    const bytes = te.encode(s)
    const ptr = this.exports.tt_alloc(bytes.length + 1)
    const view = new Uint8Array(this.memory.buffer, ptr, bytes.length + 1)
    view.set(bytes)
    view[bytes.length] = 0
    return { ptr, len: bytes.length }
  }

  // ---- wasi shims (deterministic) ----------------------------------------
  _wasiImports() {
    const vm = this
    let randState = 0x1badb002
    return {
      fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
        // QuickJS core writes nothing in normal operation; capture anything
        // (e.g. internal printf debugging) into the out channel.
        const dv = new DataView(vm.memory.buffer)
        let written = 0
        let text = ""
        for (let i = 0; i < iovsLen; i++) {
          const base = dv.getUint32(iovs + i * 8, true)
          const len = dv.getUint32(iovs + i * 8 + 4, true)
          if (len > 0) text += vm.readString(base, len)
          written += len
        }
        if (text.trim()) vm.hooks.onOut(6, JSON.stringify({ fd, text }))
        dv.setUint32(nwrittenPtr, written, true)
        vm.markRange(nwrittenPtr, 4)
        return 0
      },
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: (fd, ptr) => {
        new Uint8Array(vm.memory.buffer, ptr, 24).fill(0)
        vm.markRange(ptr, 24)
        return 0
      },
      clock_time_get: (id, precision, outPtr) => {
        // deterministic: derived from the VM's own virtual clock
        const vt = vm.exports.tt_vtime ? vm.exports.tt_vtime() : 0
        new DataView(vm.memory.buffer).setBigUint64(outPtr, BigInt(Math.floor(vt)) * 1000000n, true)
        vm.markRange(outPtr, 8)
        return 0
      },
      random_get: (ptr, len) => {
        const view = new Uint8Array(vm.memory.buffer, ptr, len)
        for (let i = 0; i < len; i++) {
          randState = (randState * 1664525 + 1013904223) >>> 0
          view[i] = randState & 0xff
        }
        vm.markRange(ptr, len)
        return 0
      },
      environ_sizes_get: (countPtr, sizePtr) => {
        const dv = new DataView(vm.memory.buffer)
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
        vm.markRange(countPtr, 4)
        vm.markRange(sizePtr, 4)
        return 0
      },
      environ_get: () => 0,
      args_sizes_get: (countPtr, sizePtr) => {
        const dv = new DataView(vm.memory.buffer)
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
        vm.markRange(countPtr, 4)
        vm.markRange(sizePtr, 4)
        return 0
      },
      args_get: () => 0,
      proc_exit: (code) => {
        throw new Error(`wasm proc_exit(${code})`)
      },
      sched_yield: () => 0,
      poll_oneoff: () => 52, // ENOSYS
      fd_read: () => 52,
      path_open: () => 52,
      fd_prestat_get: () => 8, // EBADF — no preopened dirs
      fd_prestat_dir_name: () => 52,
    }
  }
}
