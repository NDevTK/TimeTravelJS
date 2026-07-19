// Source code of the support runtime evaluated INSIDE the QuickJS VM before
// any user code. Everything lives on globalThis under the reserved __tt_
// prefix. No backticks or ${ } here — this string is also evaluated in a bare
// `node:vm` context by the unit tests, mirroring the QuickJS setup exactly.
//
// Host functions the engine injects separately (before this runs):
//   __tt_hostout(jsonString)  — console output sink
//
// Determinism notes: Date, Math.random and timers are virtualized so that
// replaying from a snapshot re-executes identically. The virtual clock
// (__tt_vt) advances one millisecond per step and lives in the VM heap, so
// snapshots capture it automatically.

export const VM_RUNTIME_SOURCE = String.raw`
(function () {
  "use strict";
  var G = globalThis;
  var SYM = Symbol("__tt.gen");
  G.__tt_symbol = SYM;
  G.__tt_depth = 0;
  G.__tt_scope = null;
  G.__tt_line = 0;
  G.__tt_stack = [];
  G.__tt_vt = 0;
  G.__tt_timers = [];
  var timerSeq = 1;

  // ---- core call machinery ------------------------------------------------
  G.__tt_drain = function (genFn, thisArg, args) {
    var it = genFn.apply(thisArg, args);
    var r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  };

  G.__tt_wrap = function (genFn, name, arity) {
    var f = function () {
      return G.__tt_drain(genFn, this, arguments);
    };
    try {
      f[SYM] = genFn;
      genFn[SYM] = genFn;
      if (name) Object.defineProperty(f, "name", { value: name, configurable: true });
      if (arity !== undefined) Object.defineProperty(f, "length", { value: arity, configurable: true });
    } catch (e) {}
    return f;
  };

  G.__tt_setgen = function (f, genFn, name, arity) {
    try {
      f[SYM] = genFn;
      genFn[SYM] = genFn;
      if (arity !== undefined) Object.defineProperty(f, "length", { value: arity, configurable: true });
    } catch (e) {}
    return f;
  };

  G.__tt_markclass = function (C, methods, statics) {
    var i, pair, fn;
    if (methods) {
      for (i = 0; i < methods.length; i++) {
        pair = methods[i];
        try {
          fn = C.prototype[pair[0]];
          if (typeof fn === "function") {
            fn[SYM] = pair[1];
            pair[1][SYM] = pair[1];
            if (pair[2] !== undefined) Object.defineProperty(fn, "length", { value: pair[2], configurable: true });
          }
        } catch (e) {}
      }
    }
    if (statics) {
      for (i = 0; i < statics.length; i++) {
        pair = statics[i];
        try {
          fn = C[pair[0]];
          if (typeof fn === "function") {
            fn[SYM] = pair[1];
            pair[1][SYM] = pair[1];
          }
        } catch (e) {}
      }
    }
    return C;
  };

  var fpCall = Function.prototype.call;
  var fpApply = Function.prototype.apply;

  G.__tt_call = function* (thisArg, fn, args, l, c) {
    if (typeof fn !== "function") {
      throw new TypeError(String(fn) + " is not a function");
    }
    var gen = fn[SYM];
    // keep f.call(...) / f.apply(...) on instrumented functions steppable
    if (gen === undefined && typeof thisArg === "function" && thisArg[SYM]) {
      if (fn === fpCall) {
        gen = thisArg[SYM];
        thisArg = args[0];
        args = Array.prototype.slice.call(args, 1);
      } else if (fn === fpApply) {
        gen = thisArg[SYM];
        var applyArgs = args[1];
        thisArg = args[0];
        args = applyArgs == null ? [] : Array.prototype.slice.call(applyArgs);
      }
    }
    if (gen !== undefined) {
      G.__tt_stack.push({ n: fn.name || "(anonymous)", l: l | 0, c: c | 0 });
      G.__tt_depth++;
      try {
        return yield* gen.apply(thisArg, args);
      } finally {
        G.__tt_depth--;
        G.__tt_stack.pop();
      }
    }
    return Reflect.apply(fn, thisArg, args);
  };

  G.__tt_new = function* (C, args, l, c) {
    if (typeof C !== "function") {
      throw new TypeError(String(C) + " is not a constructor");
    }
    var gen = C[SYM];
    if (gen !== undefined) {
      var obj = Object.create(C.prototype && typeof C.prototype === "object" ? C.prototype : Object.prototype);
      G.__tt_stack.push({ n: "new " + (C.name || "(anonymous)"), l: l | 0, c: c | 0 });
      G.__tt_depth++;
      var ret;
      try {
        ret = yield* gen.apply(obj, args);
      } finally {
        G.__tt_depth--;
        G.__tt_stack.pop();
      }
      return ret !== null && (typeof ret === "object" || typeof ret === "function") ? ret : obj;
    }
    return Reflect.construct(C, args);
  };

  // ---- locals capture -----------------------------------------------------
  var TDZ = { __tt_isTdz: true };
  G.__tt_locals = function (pairs) {
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var name = pairs[i][0];
      try {
        out.push([name, pairs[i][1]()]);
      } catch (e) {
        out.push([name, TDZ]);
      }
    }
    return out;
  };

  // ---- value serialization (getter-safe: never invokes user getters) ------
  function serialize(v, depth, seenStack) {
    var t = typeof v;
    if (v === null) return { t: "null" };
    if (t === "undefined") return { t: "undef" };
    if (t === "number") {
      if (v !== v) return { t: "nan" };
      if (v === Infinity) return { t: "num", v: "Infinity", special: true };
      if (v === -Infinity) return { t: "num", v: "-Infinity", special: true };
      return { t: "num", v: v };
    }
    if (t === "boolean") return { t: "bool", v: v };
    if (t === "bigint") return { t: "bigint", v: String(v) };
    if (t === "string") {
      if (v.length > 200) return { t: "str", v: v.slice(0, 200), trunc: v.length };
      return { t: "str", v: v };
    }
    if (t === "symbol") return { t: "sym", v: String(v) };
    if (t === "function") {
      return { t: "fn", name: v.name || "", stepper: v[SYM] !== undefined };
    }
    if (v === TDZ) return { t: "tdz" };
    // object
    if (seenStack.indexOf(v) >= 0) return { t: "ref" };
    if (depth <= 0) return { t: "more", cls: className(v) };
    seenStack.push(v);
    try {
      if (Array.isArray(v)) {
        var items = [];
        var n = v.length;
        var lim = Math.min(n, 40);
        for (var i = 0; i < lim; i++) {
          items.push(i in v ? serialize(v[i], depth - 1, seenStack) : { t: "hole" });
        }
        return { t: "arr", n: n, items: items, more: n > lim };
      }
      if (v instanceof Date) return { t: "date", v: isNaN(v.getTime()) ? "Invalid Date" : v.toISOString() };
      if (v instanceof RegExp) return { t: "regexp", v: String(v) };
      if (v instanceof Error) return { t: "error", name: v.name, msg: String(v.message) };
      if (typeof Map === "function" && v instanceof Map) {
        var ments = [];
        var mi = 0;
        for (var entry of v) {
          if (mi++ >= 20) break;
          ments.push([serialize(entry[0], depth - 1, seenStack), serialize(entry[1], depth - 1, seenStack)]);
        }
        return { t: "map", n: v.size, entries: ments, more: v.size > 20 };
      }
      if (typeof Set === "function" && v instanceof Set) {
        var sents = [];
        var si = 0;
        for (var sv of v) {
          if (si++ >= 20) break;
          sents.push(serialize(sv, depth - 1, seenStack));
        }
        return { t: "set", n: v.size, items: sents, more: v.size > 20 };
      }
      if (ArrayBuffer.isView && ArrayBuffer.isView(v)) {
        var ta = [];
        var tn = v.length === undefined ? 0 : v.length;
        var tl = Math.min(tn, 20);
        for (var ti = 0; ti < tl; ti++) ta.push(v[ti]);
        return { t: "typed", cls: className(v), n: tn, items: ta, more: tn > tl };
      }
      var props = [];
      var keys = Object.keys(v);
      var klim = Math.min(keys.length, 40);
      for (var k = 0; k < klim; k++) {
        var key = keys[k];
        var desc = Object.getOwnPropertyDescriptor(v, key);
        if (desc && desc.get) props.push([key, { t: "getter" }]);
        else if (desc) props.push([key, serialize(desc.value, depth - 1, seenStack)]);
      }
      return { t: "obj", cls: className(v), props: props, more: keys.length > klim };
    } finally {
      seenStack.pop();
    }
  }
  function className(v) {
    try {
      var p = Object.getPrototypeOf(v);
      if (p === null) return "Object";
      var ctor = p.constructor;
      var n = ctor && ctor.name;
      return n && n !== "Object" ? n : "";
    } catch (e) {
      return "";
    }
  }
  G.__tt_ser = function (v, depth) {
    return serialize(v, depth === undefined ? 4 : depth, []);
  };

  // ---- inspection entry point (called by the host while paused) -----------
  G.__tt_inspect = function () {
    var locals = null;
    try {
      if (G.__tt_scope) {
        var pairs = G.__tt_scope();
        locals = [];
        for (var i = 0; i < pairs.length; i++) {
          if (pairs[i][0] === "this" && (pairs[i][1] === G || pairs[i][1] === undefined)) continue;
          locals.push([pairs[i][0], serialize(pairs[i][1], 4, [])]);
        }
      }
    } catch (e) {
      locals = null;
    }
    var stack = [];
    for (var s = 0; s < G.__tt_stack.length; s++) {
      stack.push({ n: G.__tt_stack[s].n, l: G.__tt_stack[s].l, c: G.__tt_stack[s].c });
    }
    var globals = [];
    var base = G.__tt_gbase;
    if (base) {
      var names = Object.getOwnPropertyNames(G);
      for (var g = 0; g < names.length; g++) {
        var nm = names[g];
        if (nm.indexOf("__tt") === 0) continue;
        if (base[nm]) continue;
        try {
          globals.push([nm, serialize(G[nm], 3, [])]);
        } catch (e) {}
      }
    }
    return JSON.stringify({ locals: locals, stack: stack, globals: globals });
  };

  // ---- debug-console evaluation at the paused position --------------------
  // Direct eval inside a sloppy function using a with-block makes the locals
  // captured by the current scope thunk readable from console expressions.
  // Writes go to the throwaway scope object — navigation discards them anyway.
  G.__tt_evalAt = function (src) {
    var scopeObj = {};
    try {
      if (G.__tt_scope) {
        var pairs = G.__tt_scope();
        for (var i = 0; i < pairs.length; i++) {
          var name = pairs[i][0];
          var value = pairs[i][1];
          if (name === "this") continue;
          if (value === TDZ) continue;
          scopeObj[name] = value;
        }
      }
    } catch (e) {}
    var fn = new Function(
      "__tt_scopeobj",
      "__tt_src",
      "with (__tt_scopeobj) { return eval(__tt_src); }"
    );
    return fn(scopeObj, src);
  };

  // ---- console ------------------------------------------------------------
  function consoleOut(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(serialize(args[i], 3, []));
    try {
      G.__tt_hostout(JSON.stringify({ level: level, parts: parts }));
    } catch (e) {}
  }
  G.console = {
    log: function () { consoleOut("log", arguments); },
    info: function () { consoleOut("info", arguments); },
    warn: function () { consoleOut("warn", arguments); },
    error: function () { consoleOut("error", arguments); },
    debug: function () { consoleOut("debug", arguments); },
    trace: function () { consoleOut("log", arguments); },
    assert: function (cond) {
      if (!cond) consoleOut("error", ["Assertion failed"].concat(Array.prototype.slice.call(arguments, 1)));
    },
  };

  // ---- deterministic time & randomness ------------------------------------
  var VBASE = 1700000000000; // fixed epoch: virtual time zero
  var RealDate = Date;
  var TTDate = function Date(a, b, c, d, e, f, g) {
    if (!(this instanceof TTDate)) return new RealDate(VBASE + G.__tt_vt).toString();
    switch (arguments.length) {
      case 0: return new RealDate(VBASE + G.__tt_vt);
      case 1: return new RealDate(a);
      case 2: return new RealDate(a, b);
      case 3: return new RealDate(a, b, c);
      case 4: return new RealDate(a, b, c, d);
      case 5: return new RealDate(a, b, c, d, e);
      case 6: return new RealDate(a, b, c, d, e, f);
      default: return new RealDate(a, b, c, d, e, f, g);
    }
  };
  TTDate.prototype = RealDate.prototype;
  TTDate.now = function () { return VBASE + G.__tt_vt; };
  TTDate.parse = RealDate.parse;
  TTDate.UTC = RealDate.UTC;
  G.Date = TTDate;

  var rngState = 0x2f6e2b1 >>> 0;
  Math.random = function () {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  if (typeof G.performance !== "object" || G.performance === null) G.performance = {};
  G.performance.now = function () { return G.__tt_vt; };

  // ---- virtual timers -----------------------------------------------------
  G.setTimeout = function (fn, ms) {
    if (typeof fn !== "function") return 0;
    var id = timerSeq++;
    var extra = Array.prototype.slice.call(arguments, 2);
    G.__tt_timers.push({ id: id, fn: fn, at: G.__tt_vt + (ms > 0 ? Math.floor(ms) : 0), seq: id, args: extra, l: G.__tt_line });
    return id;
  };
  G.clearTimeout = function (id) {
    for (var i = 0; i < G.__tt_timers.length; i++) {
      if (G.__tt_timers[i].id === id) {
        G.__tt_timers.splice(i, 1);
        return;
      }
    }
  };
  G.setInterval = function () {
    throw new Error("setInterval is not supported by TimeTravelJS (use setTimeout)");
  };
  G.clearInterval = G.clearTimeout;
  G.queueMicrotask = function (fn) { Promise.resolve().then(fn); };

  // Timer pump: driven by the engine after the main program finishes.
  // Yields a [1, line, at] marker before each callback so the engine can run
  // pending promise jobs at deterministic points (identical during replay).
  G.__tt_pump = function* () {
    for (;;) {
      var best = -1;
      for (var i = 0; i < G.__tt_timers.length; i++) {
        if (best < 0) best = i;
        else {
          var a = G.__tt_timers[i], b = G.__tt_timers[best];
          if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) best = i;
        }
      }
      if (best < 0) return;
      var t = G.__tt_timers.splice(best, 1)[0];
      if (t.at > G.__tt_vt) G.__tt_vt = t.at;
      yield [1, t.l | 0, t.at];
      yield* G.__tt_call(void 0, t.fn, t.args, t.l | 0, 0);
    }
  };

  // Advance the active program generator. The host calls this instead of
  // holding handles to the generators themselves: generator references then
  // live ONLY in VM globals, so every memory snapshot is self-consistent and
  // the host never owns a reference that a restore could strand.
  G.__tt_poke = function (phase2) {
    var g = phase2 ? G.__tt_gen2 : G.__tt_gen1;
    return g.next();
  };

  // Baseline globals for the "Globals" panel diff — captured after all
  // patching above, before user code runs.
  var gbase = Object.create(null);
  var baseNames = Object.getOwnPropertyNames(G);
  for (var bi = 0; bi < baseNames.length; bi++) gbase[baseNames[bi]] = true;
  G.__tt_gbase = gbase;
})();
`
