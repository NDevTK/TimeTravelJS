(function () {
  'use strict';
  const G = globalThis;
  /* Debug-runtime self-hosted callback builtins: user callbacks run from
     bytecode, so the stackless interpreter can suspend inside them. Plain
     arrays with function callbacks take the JS path; anything exotic
     (thisArg, subclasses, proxies) delegates to the C originals. */
  (function () {
    const AP = Array.prototype;
    const plain = (a) => Array.isArray(a) && Object.getPrototypeOf(a) === AP;
    const origs = {};
    for (const n of ['sort', 'forEach', 'map', 'filter', 'some', 'every',
                     'find', 'findIndex', 'findLast', 'findLastIndex',
                     'reduce', 'reduceRight']) origs[n] = AP[n];
    const def = (name, fn) => {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      Object.defineProperty(fn, 'length', { value: origs[name].length, configurable: true });
      Object.defineProperty(AP, name, { value: fn, writable: true, configurable: true });
    };
    const bail = (name, self, args) => origs[name].apply(self, args);
    def('forEach', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('forEach', this, arguments);
      const n = this.length >>> 0;
      for (let i = 0; i < n; i++) if (i in this) cb(this[i], i, this);
    });
    def('map', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('map', this, arguments);
      const n = this.length >>> 0;
      const out = new Array(n);
      for (let i = 0; i < n; i++) if (i in this) out[i] = cb(this[i], i, this);
      return out;
    });
    def('filter', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('filter', this, arguments);
      const n = this.length >>> 0;
      const out = [];
      for (let i = 0; i < n; i++) if (i in this) { const v = this[i]; if (cb(v, i, this)) out[out.length] = v; }
      return out;
    });
    def('some', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('some', this, arguments);
      const n = this.length >>> 0;
      for (let i = 0; i < n; i++) if (i in this && cb(this[i], i, this)) return true;
      return false;
    });
    def('every', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('every', this, arguments);
      const n = this.length >>> 0;
      for (let i = 0; i < n; i++) if (i in this && !cb(this[i], i, this)) return false;
      return true;
    });
    def('find', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('find', this, arguments);
      const n = this.length >>> 0;
      for (let i = 0; i < n; i++) { const v = this[i]; if (cb(v, i, this)) return v; }
      return undefined;
    });
    def('findIndex', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('findIndex', this, arguments);
      const n = this.length >>> 0;
      for (let i = 0; i < n; i++) if (cb(this[i], i, this)) return i;
      return -1;
    });
    def('findLast', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('findLast', this, arguments);
      for (let i = (this.length >>> 0) - 1; i >= 0; i--) { const v = this[i]; if (cb(v, i, this)) return v; }
      return undefined;
    });
    def('findLastIndex', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) return bail('findLastIndex', this, arguments);
      for (let i = (this.length >>> 0) - 1; i >= 0; i--) if (cb(this[i], i, this)) return i;
      return -1;
    });
    def('reduce', function (cb, init) {
      if (!plain(this) || typeof cb !== 'function') return bail('reduce', this, arguments);
      const n = this.length >>> 0;
      let acc, i = 0, has = arguments.length >= 2;
      if (has) { acc = init; } else {
        for (; i < n; i++) if (i in this) { acc = this[i]; i++; has = true; break; }
        if (!has) throw new TypeError('reduce of empty array with no initial value');
      }
      for (; i < n; i++) if (i in this) acc = cb(acc, this[i], i, this);
      return acc;
    });
    def('reduceRight', function (cb, init) {
      if (!plain(this) || typeof cb !== 'function') return bail('reduceRight', this, arguments);
      let i = (this.length >>> 0) - 1, acc, has = arguments.length >= 2;
      if (has) { acc = init; } else {
        for (; i >= 0; i--) if (i in this) { acc = this[i]; i--; has = true; break; }
        if (!has) throw new TypeError('reduce of empty array with no initial value');
      }
      for (; i >= 0; i--) if (i in this) acc = cb(acc, this[i], i, this);
      return acc;
    });
    def('sort', function (cmp) {
      if (cmp !== undefined && typeof cmp !== 'function') throw new TypeError('not a function');
      if (!plain(this) || cmp === undefined) return bail('sort', this, arguments);
      const n = this.length >>> 0;
      const items = [];
      let undef = 0, holes = 0;
      for (let i = 0; i < n; i++) {
        if (!(i in this)) { holes++; continue; }
        const v = this[i];
        if (v === undefined) { undef++; continue; }
        items[items.length] = v;
      }
      /* stable merge sort; SortCompare: NaN → 0 */
      const m = items.length;
      const tmp = new Array(m);
      const sc = (x, y) => { const r = +cmp(x, y); return r === r ? r : 0; };
      for (let w = 1; w < m; w *= 2) {
        for (let lo = 0; lo < m - w; lo += 2 * w) {
          const mid = lo + w, hi = Math.min(lo + 2 * w, m);
          let i = lo, j = mid, k = lo;
          while (i < mid && j < hi) tmp[k++] = sc(items[i], items[j]) <= 0 ? items[i++] : items[j++];
          while (i < mid) tmp[k++] = items[i++];
          while (j < hi) tmp[k++] = items[j++];
          for (let t = lo; t < hi; t++) items[t] = tmp[t];
        }
      }
      let k = 0;
      for (; k < m; k++) this[k] = items[k];
      for (let u = 0; u < undef; u++) this[k++] = undefined;
      for (let h = 0; h < holes; h++) delete this[k++];
      return this;
    });
  })();
  /* More debug-runtime self-hosts: user callbacks and coercions run from
     bytecode so the stackless interpreter can suspend inside them. */
  (function () {
    const AP = Array.prototype;
    const SP = String.prototype;
    const plain = (a) => Array.isArray(a) && Object.getPrototypeOf(a) === AP;
    const origSort = AP.sort, origJoin = AP.join, origFlat = AP.flat,
          origFrom = Array.from, origReplace = SP.replace, origReplaceAll = SP.replaceAll,
          origStringify = JSON.stringify, origParse = JSON.parse;
    const OrigString = String;
    /* exact ToString: String(v) for non-symbols (the engine coerces the
       object argument in-loop, so user toString parks); symbols throw */
    const toStr = (v) => {
      if (typeof v === 'symbol') throw new TypeError('cannot convert symbol to string');
      return OrigString(v);
    };
    const dp = (o, n, fn, len) => {
      Object.defineProperty(fn, 'name', { value: n, configurable: true });
      Object.defineProperty(fn, 'length', { value: len, configurable: true });
      Object.defineProperty(o, n, { value: fn, writable: true, configurable: true });
    };
    /* default sort: SortCompare does ToString from bytecode */
    dp(AP, 'sort', function (cmp) {
      if (cmp !== undefined && typeof cmp !== 'function') throw new TypeError('not a function');
      if (!plain(this)) return origSort.apply(this, arguments);
      const sc = cmp !== undefined ? cmp : (x, y) => {
        const xs = toStr(x), ys = toStr(y);
        return xs < ys ? -1 : xs > ys ? 1 : 0;
      };
      const n = this.length >>> 0;
      const items = [];
      let undef = 0, holes = 0;
      for (let i = 0; i < n; i++) {
        if (!(i in this)) { holes++; continue; }
        const v = this[i];
        if (v === undefined) { undef++; continue; }
        items[items.length] = v;
      }
      const m = items.length, tmp = new Array(m);
      const c2 = (x, y) => { const r = +sc(x, y); return r === r ? r : 0; };
      for (let w = 1; w < m; w *= 2) {
        for (let lo = 0; lo < m - w; lo += 2 * w) {
          const mid = lo + w, hi = Math.min(lo + 2 * w, m);
          let i = lo, j = mid, k = lo;
          while (i < mid && j < hi) tmp[k++] = c2(items[i], items[j]) <= 0 ? items[i++] : items[j++];
          while (i < mid) tmp[k++] = items[i++];
          while (j < hi) tmp[k++] = items[j++];
          for (let t = lo; t < hi; t++) items[t] = tmp[t];
        }
      }
      let k = 0;
      for (; k < m; k++) this[k] = items[k];
      for (let u = 0; u < undef; u++) this[k++] = undefined;
      for (let h = 0; h < holes; h++) delete this[k++];
      return this;
    }, 1);
    dp(AP, 'join', function (sep) {
      if (!plain(this)) return origJoin.apply(this, arguments);
      const s = sep === undefined ? ',' : toStr(sep);
      const n = this.length >>> 0;
      let out = '';
      for (let i = 0; i < n; i++) {
        if (i > 0) out += s;
        const v = this[i];
        if (v !== undefined && v !== null) out += toStr(v);
      }
      return out;
    }, 1);
    dp(AP, 'toString', function () {
      const j = this.join;
      if (typeof j === 'function') return j.call(this);
      return Object.prototype.toString.call(this);
    }, 0);
    dp(AP, 'flatMap', function (cb, thisArg) {
      if (!plain(this) || typeof cb !== 'function' || thisArg !== undefined) {
        const mapped = AP.map.apply(this, arguments);
        return origFlat.call(mapped, 1);
      }
      const n = this.length >>> 0;
      const out = [];
      for (let i = 0; i < n; i++) {
        if (!(i in this)) continue;
        const v = cb(this[i], i, this);
        if (Array.isArray(v)) { for (let j = 0; j < v.length; j++) out[out.length] = v[j]; }
        else out[out.length] = v;
      }
      return out;
    }, 1);
    dp(Array, 'from', function (items, mapFn, thisArg) {
      if (mapFn !== undefined && typeof mapFn !== 'function') throw new TypeError('not a function');
      if (this !== Array || thisArg !== undefined) return origFrom.apply(this, arguments);
      const out = [];
      if (items === undefined || items === null) return origFrom.apply(this, arguments);
      const itf = items[Symbol.iterator];
      if (typeof itf === 'function') {
        let i = 0;
        for (const v of items) { out[out.length] = mapFn ? mapFn(v, i) : v; i++; }
        return out;
      }
      const n = Math.floor(Math.max(0, +items.length || 0));
      for (let i = 0; i < n; i++) { const v = items[i]; out[out.length] = mapFn ? mapFn(v, i) : v; }
      return out;
    }, 1);
    /* JSON.stringify with toJSON/replacer walked from bytecode */
    dp(JSON, 'stringify', function (value, replacer, space) {
      let repFn, repList = null;
      if (typeof replacer === 'function') repFn = replacer;
      else if (Array.isArray(replacer)) {
        repList = [];
        for (const k of replacer) {
          if (typeof k === 'string') repList[repList.length] = k;
          else if (typeof k === 'number') repList[repList.length] = '' + k;
          else if (k instanceof String || k instanceof Number) repList[repList.length] = '' + k;
        }
      }
      const walk = (holder, key) => {
        let v = holder[key];
        if (v !== null && (typeof v === 'object' || typeof v === 'bigint')) {
          const tj = v && v.toJSON;
          if (typeof tj === 'function') v = tj.call(v, key);
        }
        if (repFn) v = repFn.call(holder, key, v);
        if (v !== null && typeof v === 'object' && !(v instanceof Boolean) && !(v instanceof Number) && !(v instanceof String)) {
          if (Array.isArray(v)) {
            const out = new Array(v.length);
            for (let i = 0; i < v.length; i++) { const w = walk(v, i); out[i] = w === undefined ? null : w; }
            return out;
          }
          const out = {};
          const keys = repList !== null ? repList : Object.keys(v);
          for (const k of keys) {
            if (!(k in v) && repList !== null) continue;
            const w = walk(v, k);
            if (w !== undefined) out[k] = w;
          }
          return out;
        }
        return v;
      };
      const needWalk = repFn || repList !== null || (value !== null && typeof value === 'object') || typeof value === 'object';
      if (!needWalk) return origStringify(value, undefined, space);
      const root = { '': value };
      const cooked = walk(root, '');
      return origStringify(cooked, undefined, space);
    }, 3);
    dp(JSON, 'parse', function (text, reviver) {
      const v = origParse('' + text);
      if (typeof reviver !== 'function') return v;
      const walk = (holder, key) => {
        const val = holder[key];
        if (val !== null && typeof val === 'object') {
          if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) {
              const w = walk(val, i);
              if (w === undefined) delete val[i]; else val[i] = w;
            }
          } else {
            for (const k of Object.keys(val)) {
              const w = walk(val, k);
              if (w === undefined) delete val[k]; else val[k] = w;
            }
          }
        }
        return reviver.call(holder, '' + key, val);
      };
      return walk({ '': v }, '');
    }, 2);
    /* String replace with a function callback: drive matches from bytecode */
    const doReplace = (self, orig, pat, rep, all) => {
      if (typeof rep !== 'function') return orig.apply(self, [pat, rep]);
      const str = '' + self;
      if (typeof pat === 'string' || !(pat instanceof RegExp)) {
        const ps = '' + pat;
        let out = '', pos = 0;
        for (;;) {
          const at = str.indexOf(ps, pos);
          if (at < 0) break;
          out += str.slice(pos, at) + ('' + rep(ps, at, str));
          pos = at + (ps.length > 0 ? ps.length : 1);
          if (ps.length === 0) out += str.slice(at, pos - 0).slice(0, 1);
          if (!all) break;
        }
        return out + str.slice(pos);
      }
      const re = pat.global || !all ? pat : new RegExp(pat.source, pat.flags + 'g');
      const g = re.global;
      re.lastIndex = 0;
      let out = '', pos = 0, m;
      while ((m = re.exec(str)) !== null) {
        const args = m.slice();
        args[args.length] = m.index;
        args[args.length] = str;
        out += str.slice(pos, m.index) + ('' + rep.apply(undefined, args));
        pos = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
        if (!g) break;
      }
      return out + str.slice(pos);
    };
    dp(SP, 'replace', function (pat, rep) { return doReplace(this, origReplace, pat, rep, false); }, 2);
    dp(SP, 'replaceAll', function (pat, rep) {
      if (typeof rep === 'function' && pat instanceof RegExp && !pat.global)
        return origReplaceAll.apply(this, arguments); /* keep the TypeError */
      return doReplace(this, origReplaceAll, pat, rep, true);
    }, 2);
    /* Promise: run the user executor from bytecode (capability captured by
       a setup-code mini-executor via super) */
    const OrigPromise = G.Promise;
    class TTPromise extends OrigPromise {
      constructor(executor) {
        if (typeof executor !== 'function') { super(executor); return; }
        let cap;
        super((res, rej) => { cap = [res, rej]; });
        try { executor(cap[0], cap[1]); } catch (e) { cap[1](e); }
      }
    }
    Object.defineProperty(TTPromise, 'name', { value: 'Promise', configurable: true });
    G.Promise = TTPromise;
    /* combinators iterate user iterables from bytecode */
    const toArr = (it) => { const a = []; for (const v of it) a[a.length] = v; return a; };
    dp(TTPromise, 'all', function (it) { return OrigPromise.all.call(this, toArr(it)); }, 1);
    dp(TTPromise, 'allSettled', function (it) { return OrigPromise.allSettled.call(this, toArr(it)); }, 1);
    dp(TTPromise, 'race', function (it) { return OrigPromise.race.call(this, toArr(it)); }, 1);
    dp(TTPromise, 'any', function (it) { return OrigPromise.any.call(this, toArr(it)); }, 1);
  })();
  /* ---- postMessage: an external input channel -------------------------
     Messages queue in-machine and every handler sees every message
     exactly once — so a message posted at a fork anchor (before the
     program ran a single line) still reaches handlers registered later
     in the run. __msgProbe builds a recording payload: property reads
     return marked strings, so the comparison journal reveals which keys
     an object protocol consults and what it tests them against. */
  const msgs = [];
  const msgHandlers = [];
  const winEvents = new Set();
  function msgFlush() {
    for (const h of msgHandlers)
      while (h.seen < msgs.length) {
        const data = msgs[h.seen++];
        h.fn.call(G, { type: 'message', data: data, origin: G.location.origin, source: null, lastEventId: '', ports: [] });
      }
  }
  G.postMessage = function (data) { msgs.push(data); msgFlush(); };
  G.addEventListener = function (type, fn) {
    winEvents.add(String(type));
    if (String(type) === 'message' && typeof fn === 'function') { msgHandlers.push({ fn: fn, seen: 0 }); msgFlush(); }
  };
  G.removeEventListener = function (type, fn) {
    for (let i = 0; i < msgHandlers.length; i++)
      if (msgHandlers[i].fn === fn) { msgHandlers.splice(i, 1); return; }
  };
  let onmsg = null;
  Object.defineProperty(G, 'onmessage', {
    configurable: true,
    get: function () { return onmsg ? onmsg.fn : null; },
    set: function (fn) {
      if (onmsg) { const i = msgHandlers.indexOf(onmsg); if (i >= 0) msgHandlers.splice(i, 1); onmsg = null; }
      if (typeof fn === 'function') { winEvents.add('message'); onmsg = { fn: fn, seen: 0 }; msgHandlers.push(onmsg); msgFlush(); }
    },
  });
  G.__messageStats = function () {
    return { handlers: msgHandlers.length, posted: msgs.length, types: Array.from(winEvents) };
  };
  G.__msgProbe = function (m, over) {
    m = String(m);
    over = over && typeof over === 'object' ? over : {};
    return new Proxy({}, {
      get: function (t, k) {
        if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf' || k === 'toJSON') return function () { return m; };
        if (typeof k !== 'string') return undefined;
        if (Object.prototype.hasOwnProperty.call(over, k)) return over[k];
        return m + '.' + k;
      },
      has: function () { return true; },
    });
  };
  G.window = G;
  /* ---- DOM self-host over the __dom leaf primitives (Lexbor) ----------
     Everything here is bytecode: user event handlers, callbacks touching
     the DOM, style reads — all park like any other code. The C layer only
     walks/mutates the tree between steps. */
  const DOM = G.__dom;
  delete G.__dom;
  let DomNode = null;
  function buildDOM() {
    if (!DOM || !DOM.hasDoc()) return;
    const wraps = new Map();
    const listeners = new Map();
    const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    const parseStyle = (txt) => {
      const m = new Map();
      if (!txt) return m;
      for (const part of txt.split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
        if (k) m.set(k, v);
      }
      return m;
    };
    const styleText = (m) => Array.from(m).map((e) => e[0] + ': ' + e[1]).join('; ');
    function wrap(p) {
      if (!p) return null;
      let w = wraps.get(p);
      if (w) return w;
      const t = DOM.nodeType(p);
      w = t === 1 ? new Element(p) : t === 3 ? new Text(p)
        : t === 8 ? new Comment(p) : t === 9 ? new Document(p)
        : t === 10 ? new DocumentType(p) : new Node(p);
      wraps.set(p, w);
      return w;
    }
    class Node {
      constructor(p) { this.__p = p; }
      get nodeType() { return DOM.nodeType(this.__p); }
      get nodeName() { return DOM.nodeName(this.__p); }
      get parentNode() { return wrap(DOM.parent(this.__p)); }
      get parentElement() { const n = wrap(DOM.parent(this.__p)); return n && n.nodeType === 1 ? n : null; }
      get firstChild() { return wrap(DOM.firstChild(this.__p)); }
      get lastChild() { return wrap(DOM.lastChild(this.__p)); }
      get nextSibling() { return wrap(DOM.next(this.__p)); }
      get previousSibling() { return wrap(DOM.prev(this.__p)); }
      get childNodes() {
        const out = [];
        let c = DOM.firstChild(this.__p);
        while (c) { out.push(wrap(c)); c = DOM.next(c); }
        return out;
      }
      get textContent() { return DOM.textGet(this.__p); }
      set textContent(v) { DOM.textSet(this.__p, String(v)); }
      get ownerDocument() { return G.document; }
      get isConnected() {
        let n = this.__p;
        while (n) { if (DOM.nodeType(n) === 9) return true; n = DOM.parent(n); }
        return false;
      }
      appendChild(n) { DOM.append(this.__p, n.__p); return n; }
      insertBefore(n, ref) {
        if (ref == null) return this.appendChild(n);
        DOM.insertBefore(ref.__p, n.__p);
        return n;
      }
      removeChild(n) { DOM.remove(n.__p); return n; }
      replaceChild(n, old) { DOM.insertBefore(old.__p, n.__p); DOM.remove(old.__p); return old; }
      remove() { DOM.remove(this.__p); }
      cloneNode(deep) { return wrap(DOM.clone(this.__p, !!deep)); }
      contains(n) {
        let c = n && n.__p;
        while (c) { if (c === this.__p) return true; c = DOM.parent(c); }
        return false;
      }
      hasChildNodes() { return DOM.firstChild(this.__p) !== 0; }
      addEventListener(type, fn, opts) {
        if (typeof fn !== 'function') return;
        const cap = !!(opts === true || (opts && opts.capture));
        const once = !!(opts && opts.once);
        let per = listeners.get(this.__p);
        if (!per) { per = new Map(); listeners.set(this.__p, per); }
        let arr = per.get(String(type));
        if (!arr) { arr = []; per.set(String(type), arr); }
        for (const l of arr) if (l.fn === fn && l.cap === cap) return;
        arr.push({ fn: fn, cap: cap, once: once });
      }
      removeEventListener(type, fn, opts) {
        const cap = !!(opts === true || (opts && opts.capture));
        const per = listeners.get(this.__p);
        const arr = per && per.get(String(type));
        if (!arr) return;
        for (let i = 0; i < arr.length; i++)
          if (arr[i].fn === fn && arr[i].cap === cap) { arr.splice(i, 1); return; }
      }
      dispatchEvent(ev) {
        ev.__target = this;
        const path = [];
        let a = DOM.parent(this.__p);
        while (a) { path.push(wrap(a)); a = DOM.parent(a); }
        const fire = (node, phase) => {
          const per = listeners.get(node.__p);
          const arr = per && per.get(ev.type);
          if (!arr) return;
          for (const l of arr.slice()) {
            if (ev.__stopNow) return;
            if (phase === 1 && !l.cap) continue;
            if (phase === 3 && l.cap) continue;
            if (l.once) { const k = arr.indexOf(l); if (k >= 0) arr.splice(k, 1); }
            ev.__phase = phase; ev.__current = node;
            try { l.fn.call(node, ev); }
            catch (e) { console.error(e); }
          }
        };
        for (let i = path.length - 1; i >= 0; i--) { if (ev.__stop) break; fire(path[i], 1); }
        if (!ev.__stop) fire(this, 2);
        if (ev.bubbles) for (let i = 0; i < path.length; i++) { if (ev.__stop) break; fire(path[i], 3); }
        ev.__phase = 0; ev.__current = null;
        return !ev.defaultPrevented;
      }
    }
    class Element extends Node {
      get tagName() { return DOM.nodeName(this.__p); }
      get id() { return DOM.attrGet(this.__p, 'id') || ''; }
      set id(v) { DOM.attrSet(this.__p, 'id', String(v)); }
      get className() { return DOM.attrGet(this.__p, 'class') || ''; }
      set className(v) { DOM.attrSet(this.__p, 'class', String(v)); }
      get classList() {
        const el = this;
        return {
          get length() { return el.className.split(/\s+/).filter(Boolean).length; },
          contains(c) { return el.className.split(/\s+/).filter(Boolean).indexOf(String(c)) >= 0; },
          add(...cs) {
            const s = el.className.split(/\s+/).filter(Boolean);
            for (const c of cs) if (s.indexOf(String(c)) < 0) s.push(String(c));
            el.className = s.join(' ');
          },
          remove(...cs) {
            let s = el.className.split(/\s+/).filter(Boolean);
            for (const c of cs) s = s.filter((x) => x !== String(c));
            el.className = s.join(' ');
          },
          toggle(c, force) {
            const has = this.contains(c);
            const want = force === undefined ? !has : !!force;
            if (want && !has) this.add(c);
            else if (!want && has) this.remove(c);
            return want;
          },
          toString() { return el.className; },
        };
      }
      get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
      get firstElementChild() { return this.children[0] || null; }
      get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
      getAttribute(n) { return DOM.attrGet(this.__p, String(n)); }
      setAttribute(n, v) { DOM.attrSet(this.__p, String(n), String(v)); }
      removeAttribute(n) { DOM.attrDel(this.__p, String(n)); }
      hasAttribute(n) { return DOM.attrGet(this.__p, String(n)) !== null; }
      getAttributeNames() { return DOM.attrNames(this.__p); }
      get innerHTML() { return DOM.serialize(this.__p, 1); }
      set innerHTML(v) { DOM.innerSet(this.__p, String(v)); }
      get outerHTML() { return DOM.serialize(this.__p, 0); }
      querySelector(sel) { const r = DOM.qsa(this.__p, String(sel)); return r.length ? wrap(r[0]) : null; }
      querySelectorAll(sel) { return DOM.qsa(this.__p, String(sel)).map(wrap); }
      matches(sel) { return DOM.matches(this.__p, String(sel)); }
      closest(sel) {
        let n = this;
        while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; }
        return null;
      }
      getElementsByTagName(t) { return this.querySelectorAll(String(t)); }
      getElementsByClassName(c) {
        return this.querySelectorAll('.' + String(c).trim().split(/\s+/).join('.'));
      }
      get namespaceURI() {
        const k = DOM.ns(this.__p);
        return k === 'svg' ? 'http://www.w3.org/2000/svg'
          : k === 'math' ? 'http://www.w3.org/1998/Math/MathML'
          : 'http://www.w3.org/1999/xhtml';
      }
      get content() {
        return wrap(DOM.templateContent(this.__p));
      }
      get style() {
        let f = wrapsStyle.get(this.__p);
        if (f) return f;
        const el = this;
        f = new Proxy({}, {
          get(t, k) {
            if (k === 'cssText') return DOM.attrGet(el.__p, 'style') || '';
            if (k === 'setProperty') return (n, v) => {
              const m = parseStyle(DOM.attrGet(el.__p, 'style'));
              m.set(String(n), String(v));
              DOM.attrSet(el.__p, 'style', styleText(m));
            };
            if (k === 'getPropertyValue') return (n) => parseStyle(DOM.attrGet(el.__p, 'style')).get(String(n)) || '';
            if (k === 'removeProperty') return (n) => {
              const m = parseStyle(DOM.attrGet(el.__p, 'style'));
              const old = m.get(String(n)) || '';
              m.delete(String(n));
              DOM.attrSet(el.__p, 'style', styleText(m));
              return old;
            };
            if (typeof k !== 'string') return undefined;
            return parseStyle(DOM.attrGet(el.__p, 'style')).get(kebab(k)) || '';
          },
          set(t, k, v) {
            if (k === 'cssText') { DOM.attrSet(el.__p, 'style', String(v)); return true; }
            const m = parseStyle(DOM.attrGet(el.__p, 'style'));
            if (v === '' || v == null) m.delete(kebab(String(k)));
            else m.set(kebab(String(k)), String(v));
            DOM.attrSet(el.__p, 'style', styleText(m));
            return true;
          },
        });
        wrapsStyle.set(this.__p, f);
        return f;
      }
    }
    const wrapsStyle = new Map();
    class CharacterData extends Node {
      get data() { return DOM.dataGet(this.__p); }
      set data(v) { DOM.textSet(this.__p, String(v)); }
      get nodeValue() { return this.data; }
      set nodeValue(v) { this.data = v; }
      get length() { return this.data.length; }
    }
    class Text extends CharacterData {}
    class Comment extends CharacterData {}
    class DocumentType extends Node {
      get name() { return DOM.doctypeIds(this.__p)[0] || ''; }
      get publicId() { return DOM.doctypeIds(this.__p)[1] || ''; }
      get systemId() { return DOM.doctypeIds(this.__p)[2] || ''; }
    }
    class Document extends Node {
      get __eventTypes() {
        const s = new Set();
        for (const per of listeners.values())
          for (const kv of per) if (kv[1].length) s.add(kv[0]);
        return Array.from(s);
      }
      get doctype() {
        for (const c of this.childNodes) if (c.nodeType === 10) return c;
        return null;
      }
      get body() { return wrap(DOM.body()); }
      get head() { return wrap(DOM.head()); }
      get documentElement() { return wrap(DOM.docElement()); }
      createElement(n) { return wrap(DOM.createElement(String(n))); }
      createTextNode(s) { return wrap(DOM.createText(String(s))); }
      createComment(s) { return wrap(DOM.createComment(String(s))); }
      getElementById(id) { return wrap(DOM.byAttr(DOM.docElement(), 'id', String(id))); }
      querySelector(sel) { const r = DOM.qsa(this.__p, String(sel)); return r.length ? wrap(r[0]) : null; }
      querySelectorAll(sel) { return DOM.qsa(this.__p, String(sel)).map(wrap); }
      getElementsByTagName(t) { return this.querySelectorAll(String(t)); }
      getElementsByClassName(c) {
        return this.querySelectorAll('.' + String(c).trim().split(/\s+/).join('.'));
      }
      addStyleSheet(css) { DOM.addCss(String(css)); }
    }
    class Event {
      constructor(type, init) {
        init = init || {};
        this.type = String(type);
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.defaultPrevented = false;
        this.__stop = false; this.__stopNow = false;
        this.__phase = 0; this.__current = null; this.__target = null;
        this.timeStamp = Date.now();
        this.isTrusted = false;
      }
      get target() { return this.__target; }
      get currentTarget() { return this.__current; }
      get eventPhase() { return this.__phase; }
      stopPropagation() { this.__stop = true; }
      stopImmediatePropagation() { this.__stop = true; this.__stopNow = true; }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    }
    class CustomEvent extends Event {
      constructor(type, init) {
        super(type, init);
        this.detail = init && init.detail !== undefined ? init.detail : null;
      }
    }
    DomNode = Node;
    G.Node = Node; G.Element = Element; G.Text = Text; G.Comment = Comment;
    G.DocumentType = DocumentType;
    G.CharacterData = CharacterData; G.Document = Document;
    G.Event = Event; G.CustomEvent = CustomEvent;
    G.document = wrap(DOM.doc());
    G.getComputedStyle = (el) => {
      const out = {};
      const flat = DOM.computed(el.__p);
      const rules = [];
      for (let i = 0; i + 1 < flat.length; i += 2) rules.push([flat[i], flat[i + 1]]);
      rules.sort((a, b) => a[0] - b[0]); /* stable: doc order breaks ties */
      const importants = new Map();
      for (const [, txt] of rules) {
        for (const [k, v] of parseStyle(txt)) {
          if (/\s!important$/.test(v)) importants.set(k, v.replace(/\s*!important$/, ''));
          else out[k] = v;
        }
      }
      for (const [k, v] of parseStyle(DOM.attrGet(el.__p, 'style'))) out[k] = v;
      for (const [k, v] of importants) out[k] = v;
      Object.defineProperty(out, 'getPropertyValue', {
        value: (n) => out[String(n)] || '', enumerable: false,
      });
      return out;
    };
  }
  return { buildDOM: buildDOM };
})()
