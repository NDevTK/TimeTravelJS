// Loader + driver for the TimeTravelJS QuickJS build (dist/quickjs-tt.wasm).
//
// This module owns the Asyncify protocol: the wasm's env.tt_host_step import
// is the single suspendable point. When the driver decides to suspend, the
// entire wasm call stack spills into a fixed buffer inside linear memory
// (tt_asyncify_area, in the data segment), the entry export returns, and the
// VM is a frozen machine whose complete state — heap, stack spill, virtual
// clock — is bytes. Resuming rewinds into whatever suspension the current
// memory contents describe, which is exactly what makes restored snapshots
// come back to life.
//
// No handles, no wrappers: strings cross the boundary as UTF-8 bytes, and
// every JSValue the wrapper holds lives inside the VM image itself.

const td = new TextDecoder()
const te = new TextEncoder()

export const STEP_CONTINUE = 0
export const STEP_ABORT = 1
export const STEP_INSPECT = 2
export const STEP_EVAL = 3
export const STEP_INSPECT_ABORT = 4
export const STEP_EVAL_ABORT = 5

const ASYNCIFY_NORMAL = 0
const ASYNCIFY_REWINDING = 2

export class QuickJSVM {
  /**
   * @param wasmBytes  BufferSource with dist/quickjs-tt.wasm
   * @param hooks {
   *   onStep(line, col, depth) → STEP_* | "suspend"  — called on every source
   *     line the interpreter crosses (and on loop iterations);
   *   onOut(kind, text) — out-of-band channel (console/inspection/results);
   *   onInterrupt() → bool — watchdog for stretches between steps.
   * }
   */
  static async instantiate(wasmBytes, hooks) {
    const vm = new QuickJSVM(hooks)
    const imports = {
      env: {
        tt_host_step: (line, col, depth) => vm._hostStep(line, col, depth),
        tt_host_out: (kind, ptr, len) => hooks.onOut(kind, vm.readString(ptr, len)),
        tt_host_arg: (dst, cap) => vm._hostArg(dst, cap),
        tt_host_interrupt: () => (hooks.onInterrupt?.() ? 1 : 0),
      },
      wasi_snapshot_preview1: vm._wasiImports(),
    }
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports)
    vm.exports = instance.exports
    vm.memory = instance.exports.memory
    vm._initAsyncifyArea()
    const rc = vm.exports.tt_init()
    if (rc !== 0) throw new Error(`tt_init failed: ${rc}`)
    return vm
  }

  constructor(hooks) {
    this.hooks = hooks
    this.suspended = false
    this.entry = null // { name, args } of the export invocation that is suspended
    this.pendingCommand = STEP_CONTINUE
    this.stagedArg = null // Uint8Array staged for TT_CMD_EVAL
    this._suspendRequested = false
  }

  mem() {
    return new Uint8Array(this.memory.buffer)
  }

  readString(ptr, len) {
    return td.decode(new Uint8Array(this.memory.buffer, ptr, len))
  }

  _initAsyncifyArea() {
    const ptr = this.exports.tt_asyncify_area()
    const size = this.exports.tt_asyncify_area_size()
    const dv = new DataView(this.memory.buffer)
    dv.setUint32(ptr, ptr + 8, true) // current write position
    dv.setUint32(ptr + 4, ptr + size, true) // end of buffer
    this.asyncifyPtr = ptr
  }

  // ---- imports ------------------------------------------------------------
  _hostStep(line, col, depth) {
    if (this.exports.asyncify_get_state() === ASYNCIFY_REWINDING) {
      // arriving back inside the suspension we just resumed
      this.exports.asyncify_stop_rewind()
      const cmd = this.pendingCommand
      this.pendingCommand = STEP_CONTINUE
      return cmd
    }
    const decision = this.hooks.onStep(line, col, depth)
    if (decision === "suspend") {
      this._suspendRequested = true
      this.exports.asyncify_start_unwind(this.asyncifyPtr)
      return STEP_CONTINUE // ignored during unwind
    }
    return decision
  }

  _hostArg(dst, cap) {
    if (!this.stagedArg) return 0
    const n = Math.min(this.stagedArg.length, cap)
    new Uint8Array(this.memory.buffer, dst, n).set(this.stagedArg.subarray(0, n))
    this.stagedArg = null
    return n
  }

  // ---- entry driving ------------------------------------------------------
  /** Invoke an entry export; returns { suspended } or { done }. */
  drive(name, ...args) {
    if (this.suspended) throw new Error("VM already suspended")
    this.entry = { name, args }
    this.exports[name](...args)
    return this._postEntry()
  }

  /**
   * Deliver a command into the paused step hook and let the VM run again:
   * rewinds into whatever suspension the CURRENT MEMORY CONTENTS describe.
   * The re-entered hook returns `command` to the wrapper's command loop.
   */
  resume(command) {
    if (!this.suspended) throw new Error("VM not suspended")
    this.pendingCommand = command
    this.suspended = false
    this.exports.asyncify_start_rewind(this.asyncifyPtr)
    this.exports[this.entry.name](...this.entry.args)
    return this._postEntry()
  }

  _postEntry() {
    if (this._suspendRequested) {
      this._suspendRequested = false
      this.exports.asyncify_stop_unwind()
      this.suspended = true
      return { suspended: true }
    }
    this.entry = null
    return { done: true }
  }

  /**
   * Adopt a suspension restored from a snapshot: after the engine rewrites
   * linear memory with a state that was captured while suspended inside
   * `entry`, this re-arms the driver to resume it.
   */
  adoptSuspension(entry) {
    this.suspended = true
    this.entry = entry
    this._suspendRequested = false
  }

  /** Forget the current suspension (its memory is being navigated away). */
  abandonSuspension() {
    this.suspended = false
    this.entry = null
    this._suspendRequested = false
  }

  /**
   * After a wasm trap mid-rewind the asyncify state global is stuck and the
   * spill cursor in memory is half-consumed. Reset the state machine; the
   * engine's page heal restores the cursor.
   */
  normalize() {
    if (this.exports.asyncify_get_state() !== ASYNCIFY_NORMAL) {
      this.exports.asyncify_stop_rewind()
    }
    this.suspended = false
    this.entry = null
    this._suspendRequested = false
    this.pendingCommand = STEP_CONTINUE
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
        return 0
      },
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: (fd, ptr) => {
        new Uint8Array(vm.memory.buffer, ptr, 24).fill(0)
        return 0
      },
      clock_time_get: (id, precision, outPtr) => {
        // deterministic: derived from the VM's own virtual clock
        const vt = vm.exports.tt_vtime ? vm.exports.tt_vtime() : 0
        new DataView(vm.memory.buffer).setBigUint64(outPtr, BigInt(Math.floor(vt)) * 1000000n, true)
        return 0
      },
      random_get: (ptr, len) => {
        const view = new Uint8Array(vm.memory.buffer, ptr, len)
        for (let i = 0; i < len; i++) {
          randState = (randState * 1664525 + 1013904223) >>> 0
          view[i] = randState & 0xff
        }
        return 0
      },
      environ_sizes_get: (countPtr, sizePtr) => {
        const dv = new DataView(vm.memory.buffer)
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
        return 0
      },
      environ_get: () => 0,
      args_sizes_get: (countPtr, sizePtr) => {
        const dv = new DataView(vm.memory.buffer)
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
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
