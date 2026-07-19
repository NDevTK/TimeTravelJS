// Source instrumentation for TimeTravelJS.
//
// User code is rewritten so that execution can be suspended between any two
// statements with all program state (including locals) living in the QuickJS
// heap — which is exactly what the COW memory snapshots capture.
//
// The trick: every instrumented function is compiled to a *pair*:
//
//   - a hidden generator function carrying the real (instrumented) body,
//     which yields a step marker `[0, line, col, endLine, endCol, depth]`
//     before every statement, and
//   - a plain "façade" function that runs the generator to completion
//     atomically (`__tt_drain`) when called normally.
//
// The generator is attached to the façade under a well-known symbol. Call
// sites inside instrumented code go through `yield* __tt_call(...)`, which
// delegates to the hidden generator when present (steppable) and falls back
// to a plain call otherwise. Anything we cannot confidently transform is left
// untouched ("raw") — raw calls into instrumented functions still work,
// they just execute atomically. Graceful degradation everywhere.
//
// Scope capture: at the top of every block that introduces bindings we emit
//   const __tt_scN = () => __tt_locals([["x", () => x], ...])
// and each step marker assigns `__tt_scope = __tt_scN` first, so the host can
// materialize the locals visible at the paused statement on demand.

import * as acorn from "../vendor/acorn.mjs"
import { generate } from "../vendor/astring.mjs"

const RESERVED_PREFIX = "__tt"

// ---------------------------------------------------------------------------
// tiny ESTree node builders
// ---------------------------------------------------------------------------
const id = (name) => ({ type: "Identifier", name })
const lit = (value) => ({ type: "Literal", value })
const arr = (elements) => ({ type: "ArrayExpression", elements })
const call = (callee, args) => ({ type: "CallExpression", callee, arguments: args, optional: false })
const member = (object, property, computed = false) => ({ type: "MemberExpression", object, property, computed, optional: false })
const assign = (left, right) => ({ type: "AssignmentExpression", operator: "=", left, right })
const seq = (expressions) => ({ type: "SequenceExpression", expressions })
const exprStmt = (expression) => ({ type: "ExpressionStatement", expression })
const yieldStar = (argument) => ({ type: "YieldExpression", delegate: true, argument })
const yieldOnce = (argument) => ({ type: "YieldExpression", delegate: false, argument })
const block = (body) => ({ type: "BlockStatement", body })
const ret = (argument) => ({ type: "ReturnStatement", argument })
const constDecl = (name, init) => ({
  type: "VariableDeclaration",
  kind: "const",
  declarations: [{ type: "VariableDeclarator", id: id(name), init }],
})
const varDecl = (names) => ({
  type: "VariableDeclaration",
  kind: "var",
  declarations: names.map((n) => ({ type: "VariableDeclarator", id: id(n), init: null })),
})
const voidZero = () => ({ type: "UnaryExpression", operator: "void", prefix: true, argument: lit(0) })
const arrow = (params, body) => ({
  type: "ArrowFunctionExpression",
  params,
  body,
  async: false,
  expression: body.type !== "BlockStatement",
})

// ---------------------------------------------------------------------------
// generic AST utilities
// ---------------------------------------------------------------------------
const SKIP_KEYS = new Set(["loc", "start", "end", "range", "regex"])

function isNode(v) {
  return v !== null && typeof v === "object" && typeof v.type === "string"
}

function eachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (isNode(v[i])) v[i] = fn(v[i], node, key)
    } else if (isNode(v)) {
      node[key] = fn(v, node, key)
    }
  }
  return node
}

/** Collect every name bound by a binding pattern. */
function patternNames(node, out) {
  if (!node) return out
  switch (node.type) {
    case "Identifier":
      out.push(node.name)
      break
    case "ObjectPattern":
      for (const p of node.properties) {
        if (p.type === "RestElement") patternNames(p.argument, out)
        else patternNames(p.value, out)
      }
      break
    case "ArrayPattern":
      for (const el of node.elements) if (el) patternNames(el, out)
      break
    case "AssignmentPattern":
      patternNames(node.left, out)
      break
    case "RestElement":
      patternNames(node.argument, out)
      break
  }
  return out
}

/** var-scoped names (var declarations + function declarations), not crossing function boundaries. */
function collectVarNames(body) {
  const names = []
  const walk = (node) => {
    if (!isNode(node)) return
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id) names.push(node.id.name)
        return // do not cross into nested functions
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassDeclaration":
      case "ClassExpression":
        return
      case "VariableDeclaration":
        if (node.kind === "var") for (const d of node.declarations) patternNames(d.id, names)
        break
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach(walk)
      else if (isNode(v)) walk(v)
    }
  }
  for (const stmt of body) walk(stmt)
  return names
}

/** Lexically-scoped names introduced directly by a statement list (let/const/class/function). */
function collectLexicalNames(body) {
  const names = []
  for (const stmt of body) {
    if (stmt.type === "VariableDeclaration" && stmt.kind !== "var") {
      for (const d of stmt.declarations) patternNames(d.id, names)
    } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
      names.push(stmt.id.name)
    } else if (stmt.type === "ClassDeclaration" && stmt.id) {
      names.push(stmt.id.name)
    }
  }
  return names
}

/** Does this subtree contain a node of one of the given types (crossing everything)? */
function containsNodeType(root, types) {
  let found = false
  const walk = (node) => {
    if (found || !isNode(node)) return
    if (types.has(node.type)) {
      if (node.type === "MetaProperty") {
        if (node.meta && node.meta.name === "new") found = true
      } else {
        found = true
      }
      if (found) return
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach(walk)
      else if (isNode(v)) walk(v)
    }
  }
  walk(root)
  return found
}

const SUPER_OR_PRIVATE = new Set(["Super", "PrivateIdentifier"])
const NEW_TARGET = new Set(["MetaProperty"])

// ---------------------------------------------------------------------------
// the transformer
// ---------------------------------------------------------------------------
class Instrumenter {
  constructor() {
    this.counter = 0
    this.warnings = []
    // per-function-context state (stack)
    this.fnCtx = []
    // lexical scope chain for locals capture: {names: string[], thunk: string|null}
    this.scopes = []
  }

  uid(base) {
    return `${RESERVED_PREFIX}_${base}${this.counter++}`
  }

  warn(msg, node) {
    const line = node && node.loc ? node.loc.start.line : null
    this.warnings.push(line ? `line ${line}: ${msg}` : msg)
  }

  // -- function context: tracks synthetic temps needed inside current function-like body
  pushFnCtx(kind) {
    this.fnCtx.push({ kind, temps: 0, tempDepth: 0, extraVars: [] })
  }
  popFnCtx() {
    return this.fnCtx.pop()
  }
  get curFn() {
    return this.fnCtx[this.fnCtx.length - 1]
  }
  /** borrow a member-call temp for the current nesting depth */
  withTemp(fn) {
    const c = this.curFn
    const idx = c.tempDepth++
    c.temps = Math.max(c.temps, c.tempDepth)
    const name = `${RESERVED_PREFIX}_t${idx}`
    try {
      return fn(name)
    } finally {
      c.tempDepth--
    }
  }

  // -- lexical scopes for the variables panel
  pushScope(names) {
    this.scopes.push({ names, thunk: null })
  }
  popScope() {
    this.scopes.pop()
  }
  get currentThunk() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].thunk) return this.scopes[i].thunk
    }
    return null
  }
  visibleNames() {
    // innermost binding wins; cap to keep generated code sane
    const seen = new Map()
    for (const scope of this.scopes) {
      for (const n of scope.names) seen.set(n, true)
    }
    const names = [...seen.keys()]
    return names.length > 64 ? names.slice(names.length - 64) : names
  }
  /** const __tt_scN = () => __tt_locals([["x", () => x], ...]) */
  makeThunkDecl(extraNames = [], includeThis = false) {
    const names = this.visibleNames()
    for (const n of extraNames) if (!names.includes(n)) names.push(n)
    const pairs = names
      .filter((n) => !n.startsWith(RESERVED_PREFIX))
      .map((n) => arr([lit(n), arrow([], id(n))]))
    if (includeThis) pairs.unshift(arr([lit("this"), arrow([], { type: "ThisExpression" })]))
    if (pairs.length === 0) return null
    const name = this.uid("sc")
    const decl = constDecl(name, arrow([], call(id(`${RESERVED_PREFIX}_locals`), [arr(pairs)])))
    return { name, decl }
  }

  // -------------------------------------------------------------------------
  // statements
  // -------------------------------------------------------------------------

  /** step marker: yield (__tt_scope = THUNK, __tt_line = L, [0, l, c, el, ec, __tt_depth]) */
  stepStmt(node) {
    const loc = node.loc
    const l = loc ? loc.start.line : 0
    const c = loc ? loc.start.column : 0
    const el = loc ? loc.end.line : l
    const ec = loc ? loc.end.column : c
    const thunk = this.currentThunk
    const marker = arr([lit(0), lit(l), lit(c), lit(el), lit(ec), id(`${RESERVED_PREFIX}_depth`)])
    return exprStmt(
      yieldOnce(
        seq([
          assign(id(`${RESERVED_PREFIX}_scope`), thunk ? id(thunk) : lit(null)),
          assign(id(`${RESERVED_PREFIX}_line`), lit(l)),
          marker,
        ]),
      ),
    )
  }

  /**
   * Transform a statement list. Options:
   *   steps      — inject step markers (only inside instrumented generators)
   *   scopeNames — bindings introduced by this list's own scope (emit thunk)
   *   forceThunk — emit a thunk even if the list introduces no new names
   *   includeThis— include `this` in the thunk (function bodies)
   */
  stmtList(body, { steps, newScope, forceThunk = false, includeThis = false }) {
    const lexical = collectLexicalNames(body)
    let pushed = false
    if (newScope) {
      this.pushScope([...newScope.names, ...lexical])
      pushed = true
    } else if (lexical.length) {
      this.pushScope(lexical)
      pushed = true
    }

    const out = []
    const marks = []
    let thunkInfo = null
    if (steps && (pushed || forceThunk)) {
      thunkInfo = this.makeThunkDecl([], includeThis)
      if (thunkInfo) {
        this.scopes[this.scopes.length - 1] = { ...this.scopes[this.scopes.length - 1], thunk: thunkInfo.name }
      }
    }

    // directive prologue must stay first
    let i = 0
    while (
      i < body.length &&
      body[i].type === "ExpressionStatement" &&
      body[i].expression.type === "Literal" &&
      typeof body[i].expression.value === "string" &&
      body[i].directive !== undefined
    ) {
      out.push(body[i])
      i++
    }
    if (thunkInfo) out.push(thunkInfo.decl)
    const markInsertAt = out.length

    for (; i < body.length; i++) {
      const stmt = body[i]
      this.emitStatement(stmt, out, marks, steps)
    }
    // marking statements run before the first step of the scope
    out.splice(markInsertAt, 0, ...marks)

    if (pushed) this.popScope()
    return out
  }

  emitStatement(stmt, out, marks, steps) {
    switch (stmt.type) {
      case "EmptyStatement":
        return
      case "FunctionDeclaration": {
        const res = this.functionDeclaration(stmt)
        if (res.pair) {
          out.push(res.genDecl, res.facade)
          marks.push(res.mark)
        } else {
          out.push(res.node)
        }
        return
      }
      case "ClassDeclaration": {
        if (steps) out.push(this.stepStmt(stmt))
        const res = this.classNode(stmt, steps)
        for (const pre of res.pre) out.push(pre)
        out.push(res.node)
        for (const post of res.post) out.push(post)
        return
      }
      default: {
        if (steps && stmt.type !== "DebuggerStatement") out.push(this.stepStmt(stmt))
        out.push(this.statement(stmt, steps))
        return
      }
    }
  }

  /** Transform a single (non-declaration) statement in place. */
  statement(stmt, steps) {
    const E = steps ? (n) => this.expr(n) : (n) => this.rawExpr(n)
    switch (stmt.type) {
      case "ExpressionStatement":
        stmt.expression = E(stmt.expression)
        return stmt
      case "VariableDeclaration":
        for (const d of stmt.declarations) {
          if (d.init) d.init = this.declInit(d, E)
          d.id = this.rawExpr(d.id) // patterns may contain defaults/computed keys
        }
        return stmt
      case "ReturnStatement":
      case "ThrowStatement":
        if (stmt.argument) stmt.argument = E(stmt.argument)
        return stmt
      case "IfStatement":
        stmt.test = E(stmt.test)
        stmt.consequent = this.nestedBody(stmt.consequent, steps)
        if (stmt.alternate) {
          stmt.alternate =
            stmt.alternate.type === "IfStatement"
              ? this.statement(stmt.alternate, steps)
              : this.nestedBody(stmt.alternate, steps)
        }
        return stmt
      case "WhileStatement":
        stmt.test = E(stmt.test)
        stmt.body = this.nestedBody(stmt.body, steps)
        return stmt
      case "DoWhileStatement":
        stmt.body = this.nestedBody(stmt.body, steps)
        stmt.test = E(stmt.test)
        return stmt
      case "ForStatement": {
        const loopNames = []
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") {
            if (stmt.init.kind !== "var") for (const d of stmt.init.declarations) patternNames(d.id, loopNames)
            for (const d of stmt.init.declarations) {
              if (d.init) d.init = this.declInit(d, E)
              d.id = this.rawExpr(d.id)
            }
          } else {
            stmt.init = E(stmt.init)
          }
        }
        if (loopNames.length) this.pushScope(loopNames)
        try {
          if (stmt.test) stmt.test = E(stmt.test)
          if (stmt.update) stmt.update = E(stmt.update)
          stmt.body = this.nestedBody(stmt.body, steps, loopNames.length > 0)
        } finally {
          if (loopNames.length) this.popScope()
        }
        return stmt
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const loopNames = []
        if (stmt.left.type === "VariableDeclaration") {
          if (stmt.left.kind !== "var") for (const d of stmt.left.declarations) patternNames(d.id, loopNames)
        } else {
          stmt.left = E(stmt.left)
        }
        stmt.right = E(stmt.right)
        if (loopNames.length) this.pushScope(loopNames)
        try {
          stmt.body = this.nestedBody(stmt.body, steps, loopNames.length > 0)
        } finally {
          if (loopNames.length) this.popScope()
        }
        return stmt
      }
      case "BlockStatement":
        stmt.body = this.stmtList(stmt.body, { steps })
        return stmt
      case "TryStatement":
        stmt.block.body = this.stmtList(stmt.block.body, { steps })
        if (stmt.handler) {
          const names = patternNames(stmt.handler.param, [])
          if (names.length) this.pushScope(names)
          try {
            stmt.handler.body.body = this.stmtList(stmt.handler.body.body, { steps, forceThunk: names.length > 0 })
          } finally {
            if (names.length) this.popScope()
          }
        }
        if (stmt.finalizer) stmt.finalizer.body = this.stmtList(stmt.finalizer.body, { steps })
        return stmt
      case "SwitchStatement":
        stmt.discriminant = E(stmt.discriminant)
        for (const cs of stmt.cases) {
          if (cs.test) cs.test = E(cs.test)
          cs.consequent = this.stmtList(cs.consequent, { steps })
        }
        return stmt
      case "LabeledStatement":
        stmt.body = this.statement(stmt.body, steps)
        return stmt
      case "WithStatement":
        this.warn("`with` blocks are executed without instrumentation", stmt)
        return stmt
      case "ClassDeclaration": {
        // only reachable via LabeledStatement — treat conservatively
        const res = this.classNode(stmt, steps)
        if (res.pre.length || res.post.length) return block([...res.pre, res.node, ...res.post])
        return res.node
      }
      case "FunctionDeclaration": {
        // labeled function declaration (sloppy) — keep raw
        this.rawFunctionBody(stmt)
        return stmt
      }
      default:
        return stmt
    }
  }

  /** Declarator init with function-name inference: const f = () => … names f. */
  declInit(declarator, E) {
    const init = declarator.init
    if (declarator.id.type === "Identifier") {
      if (init.type === "ArrowFunctionExpression") return this.arrowExpr(init, declarator.id.name)
      if (init.type === "FunctionExpression") return this.functionExpr(init, declarator.id.name)
    }
    return E(init)
  }

  /** Blockify + instrument a nested statement body (if/loop bodies). */
  nestedBody(node, steps, forceThunk = false) {
    if (node.type === "BlockStatement") {
      node.body = this.stmtList(node.body, { steps, forceThunk })
      return node
    }
    if (node.type === "EmptyStatement") return block([])
    // single statement — blockify so we can put a step in front
    const out = []
    const marks = []
    if (forceThunk && steps) {
      // wrap in an explicit scope block so the thunk const has a home
      const inner = this.stmtList([node], { steps, forceThunk: true })
      return block(inner)
    }
    this.emitStatement(node, out, marks, steps)
    out.splice(0, 0, ...marks)
    return block(out)
  }

  // -------------------------------------------------------------------------
  // expressions (instrumented context — yields allowed)
  // -------------------------------------------------------------------------
  expr(node) {
    switch (node.type) {
      case "CallExpression":
        return this.callExpr(node)
      case "NewExpression": {
        const callee = this.expr(node.callee)
        const args = node.arguments.map((a) =>
          a.type === "SpreadElement" ? ((a.argument = this.expr(a.argument)), a) : this.expr(a),
        )
        const loc = node.loc ? node.loc.start : { line: 0, column: 0 }
        return yieldStar(call(id(`${RESERVED_PREFIX}_new`), [callee, arr(args), lit(loc.line), lit(loc.column)]))
      }
      case "ChainExpression":
        node.expression = this.chainExpr(node.expression)
        return node
      case "FunctionExpression":
        return this.functionExpr(node, null)
      case "ArrowFunctionExpression":
        return this.arrowExpr(node, null)
      case "ClassExpression": {
        const res = this.classNode(node, true)
        if (res.pre.length === 0 && res.post.length === 0 && !res.markCall) return res.node
        return res.markCall
      }
      case "ObjectExpression":
        return this.objectExpr(node)
      case "TaggedTemplateExpression":
        // leave the call raw (drain-safe), still transform interpolations
        node.quasi.expressions = node.quasi.expressions.map((e) => this.expr(e))
        node.tag = this.expr(node.tag)
        return node
      case "VariableDeclaration":
        // for(let x = f();;) init handled elsewhere; defensive
        return this.statement(node, true)
      case "Property": {
        if (node.computed) node.key = this.expr(node.key)
        node.value = this.expr(node.value)
        return node
      }
      default:
        // name inference for `const f = (…) => …` / `let g = function () {}`
        if (node.type === "VariableDeclarator" && node.init && node.id.type === "Identifier") {
          const name = node.id.name
          if (node.init.type === "ArrowFunctionExpression") {
            node.init = this.arrowExpr(node.init, name)
            return node
          }
          if (node.init.type === "FunctionExpression") {
            node.init = this.functionExpr(node.init, name)
            return node
          }
        }
        return eachChild(node, (child) => this.expr(child))
    }
  }

  callExpr(node) {
    const loc = node.loc ? node.loc.start : { line: 0, column: 0 }
    const args = node.arguments.map((a) =>
      a.type === "SpreadElement" ? ((a.argument = this.expr(a.argument)), a) : this.expr(a),
    )
    const callHelper = id(`${RESERVED_PREFIX}_call`)
    const callee = node.callee

    if (callee.type === "Super") {
      // super() only occurs in raw constructors; defensive
      node.arguments = args
      return node
    }
    if (callee.type === "MemberExpression" && callee.object.type !== "Super") {
      return this.withTemp((tmp) => {
        const objExpr = this.expr(callee.object)
        const prop = callee.computed ? this.expr(callee.property) : callee.property
        return yieldStar(
          seq([
            assign(id(tmp), objExpr),
            call(callHelper, [id(tmp), member(id(tmp), prop, callee.computed), arr(args), lit(loc.line), lit(loc.column)]),
          ]),
        )
      })
    }
    if (callee.type === "MemberExpression") {
      // super.m(...) — raw (only valid in raw method bodies anyway)
      node.arguments = args
      return node
    }
    const calleeExpr = this.expr(callee)
    return yieldStar(call(callHelper, [voidZero(), calleeExpr, arr(args), lit(loc.line), lit(loc.column)]))
  }

  /** Inside a?.b?.(x) chains calls stay plain (drain-safe) but subexpressions are transformed. */
  chainExpr(node) {
    if (node.type === "CallExpression") {
      node.callee = this.chainExpr(node.callee)
      node.arguments = node.arguments.map((a) =>
        a.type === "SpreadElement" ? ((a.argument = this.expr(a.argument)), a) : this.expr(a),
      )
      return node
    }
    if (node.type === "MemberExpression") {
      if (node.object.type !== "Super") node.object = this.chainExpr(node.object)
      if (node.computed) node.property = this.expr(node.property)
      return node
    }
    return this.expr(node)
  }

  // -------------------------------------------------------------------------
  // raw context: no yields — but function definitions inside are still instrumented
  // -------------------------------------------------------------------------
  rawExpr(node) {
    switch (node.type) {
      case "FunctionExpression":
        return this.functionExpr(node, null)
      case "ArrowFunctionExpression":
        return this.arrowExpr(node, null)
      case "ClassExpression": {
        const res = this.classNode(node, false)
        return res.markCall || res.node
      }
      case "ObjectExpression":
        return this.objectExpr(node, true)
      default:
        if (node.type === "VariableDeclarator" && node.init && node.id.type === "Identifier") {
          const name = node.id.name
          if (node.init.type === "ArrowFunctionExpression") {
            node.init = this.arrowExpr(node.init, name)
            return node
          }
          if (node.init.type === "FunctionExpression") {
            node.init = this.functionExpr(node.init, name)
            return node
          }
        }
        return eachChild(node, (child) => this.rawExpr(child))
    }
  }

  /** Statement list in raw context: no steps/thunks, but nested declarations get instrumented. */
  rawStmtList(body) {
    const out = []
    const marks = []
    for (const stmt of body) this.emitStatement(stmt, out, marks, false)
    out.splice(0, 0, ...marks)
    return out
  }

  rawFunctionBody(fnNode) {
    // keep the function itself raw; still visit body to instrument nested definitions
    this.pushFnCtx("raw")
    if (fnNode.body.type === "BlockStatement") {
      fnNode.body.body = this.rawStmtList(fnNode.body.body)
    } else {
      fnNode.body = this.rawExpr(fnNode.body)
    }
    fnNode.params = fnNode.params.map((p) => this.rawExpr(p))
    const ctx = this.popFnCtx()
    const extra = [...rangeTempNames(ctx.temps), ...ctx.extraVars]
    if (extra.length > 0 && fnNode.body.type === "BlockStatement") {
      fnNode.body.body.unshift(varDecl(extra))
    }
    return fnNode
  }

  // -------------------------------------------------------------------------
  // functions
  // -------------------------------------------------------------------------

  canInstrumentFunction(node) {
    if (node.async || node.generator) return false
    if (containsNodeType(node.body, NEW_TARGET)) {
      this.warn("function uses new.target — executed without stepping", node)
      return false
    }
    return true
  }

  /** Build the hidden generator FunctionExpression from a function-ish node. */
  buildGenerator(node, { includeThis }) {
    this.pushFnCtx("gen")
    const paramNames = []
    for (const p of node.params) patternNames(p, paramNames)
    const params = node.params.map((p) => this.rawExpr(p)) // defaults stay raw (yield illegal there)

    let bodyStmts
    if (node.body.type === "BlockStatement") {
      const varNames = collectVarNames(node.body.body)
      bodyStmts = this.stmtList(node.body.body, {
        steps: true,
        newScope: { names: [...paramNames, ...varNames] },
        forceThunk: true,
        includeThis,
      })
    } else {
      // expression-bodied arrow: { step; return expr }
      this.pushScope(paramNames)
      const thunkInfo = this.makeThunkDecl([], includeThis)
      if (thunkInfo) this.scopes[this.scopes.length - 1].thunk = thunkInfo.name
      const stepS = this.stepStmt(node.body)
      const retS = ret(this.expr(node.body))
      this.popScope()
      bodyStmts = thunkInfo ? [thunkInfo.decl, stepS, retS] : [stepS, retS]
    }

    const ctx = this.popFnCtx()
    const extra = [...rangeTempNames(ctx.temps), ...ctx.extraVars]
    if (extra.length > 0) bodyStmts.unshift(varDecl(extra))

    return {
      type: "FunctionExpression",
      id: null,
      params,
      body: block(bodyStmts),
      generator: true,
      async: false,
    }
  }

  functionArity(node) {
    let n = 0
    for (const p of node.params) {
      if (p.type === "AssignmentPattern" || p.type === "RestElement") break
      n++
    }
    return n
  }

  /** function f(a) {…}  →  hidden generator decl + façade decl + mark statement */
  functionDeclaration(node) {
    if (!this.canInstrumentFunction(node)) {
      return { pair: false, node: this.rawFunctionBody(node) }
    }
    const fname = node.id.name
    const genName = this.uid(`g$${fname}$`)
    const gen = this.buildGenerator(node, { includeThis: true })
    const genDecl = {
      type: "FunctionDeclaration",
      id: id(genName),
      params: gen.params,
      body: gen.body,
      generator: true,
      async: false,
    }
    const facade = {
      type: "FunctionDeclaration",
      id: id(fname),
      params: [],
      body: block([ret(call(id(`${RESERVED_PREFIX}_drain`), [id(genName), { type: "ThisExpression" }, id("arguments")]))]),
      generator: false,
      async: false,
    }
    const mark = exprStmt(
      call(id(`${RESERVED_PREFIX}_setgen`), [id(fname), id(genName), lit(fname), lit(this.functionArity(node))]),
    )
    return { pair: true, genDecl, facade, mark }
  }

  /** function expressions → __tt_wrap(function* (…) {…}, name, arity) */
  functionExpr(node, inferredName) {
    if (!this.canInstrumentFunction(node)) return this.rawFunctionBody(node)
    const name = node.id ? node.id.name : inferredName
    const gen = this.buildGenerator(node, { includeThis: true })
    const wrapped = call(id(`${RESERVED_PREFIX}_wrap`), [
      gen,
      lit(name ?? ""),
      lit(this.functionArity(node)),
    ])
    if (node.id) {
      // named function expression: the name must be visible inside the body
      const inner = block([constDecl(node.id.name, wrapped), ret(id(node.id.name))])
      return call(arrow([], inner), [])
    }
    return wrapped
  }

  /** arrows → __tt_wrap((function* (…) {…}).bind(this), name, arity) — lexical this preserved */
  arrowExpr(node, inferredName) {
    if (node.async) return this.rawFunctionBody(node)
    if (containsNodeType(node.body, NEW_TARGET)) return this.rawFunctionBody(node)
    const gen = this.buildGenerator(node, { includeThis: false })
    const bound = call(member(gen, id("bind")), [{ type: "ThisExpression" }])
    return call(id(`${RESERVED_PREFIX}_wrap`), [bound, lit(inferredName ?? ""), lit(this.functionArity(node))])
  }

  // -------------------------------------------------------------------------
  // objects & classes
  // -------------------------------------------------------------------------
  objectExpr(node, raw = false) {
    const E = raw ? (n) => this.rawExpr(n) : (n) => this.expr(n)
    for (let i = 0; i < node.properties.length; i++) {
      const p = node.properties[i]
      if (p.type === "SpreadElement") {
        p.argument = E(p.argument)
        continue
      }
      if (p.computed) p.key = E(p.key)
      if (p.kind === "get" || p.kind === "set") {
        this.rawFunctionBody(p.value)
        continue
      }
      const v = p.value
      if (v && v.type === "FunctionExpression") {
        if (containsNodeType(v.body, SUPER_OR_PRIVATE)) {
          // methods using super/private names must keep their home object
          this.rawFunctionBody(v)
          continue
        }
        const nm = !p.computed && p.key.type === "Identifier" ? p.key.name : null
        p.value = this.functionExpr(v, nm)
        if (p.method) {
          p.method = false
          p.shorthand = false
        }
      } else if (v && v.type === "ArrowFunctionExpression") {
        const nm = !p.computed && p.key.type === "Identifier" ? p.key.name : null
        p.value = this.arrowExpr(v, nm)
      } else if (v) {
        p.value = E(v)
      }
    }
    return node
  }

  /**
   * Classes: constructors, accessors, generator/async methods, computed keys,
   * and anything touching super/private stays raw. Plain methods become
   * façades whose hidden generators are hoisted next to the class and attached
   * via __tt_markclass.
   */
  classNode(node, steps) {
    const E = steps ? (n) => this.expr(n) : (n) => this.rawExpr(n)
    if (node.superClass) node.superClass = E(node.superClass)

    const pre = []
    const post = []
    const methodPairs = []
    const staticPairs = []
    const preAssigns = []

    for (const el of node.body.body) {
      if (el.type === "PropertyDefinition") {
        if (el.value) el.value = this.rawExpr(el.value) // field initializers run in ctor context
        if (el.computed) el.key = E(el.key)
        continue
      }
      if (el.type === "StaticBlock") {
        el.body = this.rawStmtList(el.body)
        continue
      }
      if (el.type !== "MethodDefinition") continue
      if (el.computed) el.key = E(el.key)
      const fn = el.value
      const isPlainMethod =
        el.kind === "method" &&
        !el.computed &&
        el.key.type === "Identifier" &&
        !fn.async &&
        !fn.generator &&
        !containsNodeType(fn.body, SUPER_OR_PRIVATE) &&
        !containsNodeType(fn.body, NEW_TARGET)
      if (!isPlainMethod) {
        this.rawFunctionBody(fn)
        continue
      }
      const gname = this.uid(`mg`)
      this.curFn.extraVars.push(gname)
      const gen = this.buildGenerator(fn, { includeThis: true })
      preAssigns.push(assign(id(gname), gen))
      const facadeBody = block([
        ret(call(id(`${RESERVED_PREFIX}_drain`), [id(gname), { type: "ThisExpression" }, id("arguments")])),
      ])
      el.value = {
        type: "FunctionExpression",
        id: null,
        params: [],
        body: facadeBody,
        generator: false,
        async: false,
      }
      const pairList = el.static ? staticPairs : methodPairs
      pairList.push(arr([lit(el.key.name), id(gname), lit(this.functionArity(fn))]))
    }

    const needsMark = methodPairs.length > 0 || staticPairs.length > 0
    if (!needsMark) {
      return { pre, node, post, markCall: null }
    }

    if (node.type === "ClassDeclaration") {
      for (const a of preAssigns) pre.push(exprStmt(a))
      post.push(
        exprStmt(
          call(id(`${RESERVED_PREFIX}_markclass`), [id(node.id.name), arr(methodPairs), arr(staticPairs)]),
        ),
      )
      return { pre, node, post, markCall: null }
    }
    // class expression: (__tt_mgN = function*…, __tt_markclass(class {…}, […]))
    const markCall = seq([
      ...preAssigns,
      call(id(`${RESERVED_PREFIX}_markclass`), [node, arr(methodPairs), arr(staticPairs)]),
    ])
    return { pre, node, post, markCall }
  }

  // -------------------------------------------------------------------------
  // entry point
  // -------------------------------------------------------------------------
  program(ast) {
    this.pushFnCtx("program")
    const varNames = collectVarNames(ast.body)
    const body = this.stmtList(ast.body, {
      steps: true,
      newScope: { names: varNames },
      forceThunk: true,
      includeThis: false,
    })
    const ctx = this.popFnCtx()
    if (ctx.temps > 0 || ctx.extraVars.length > 0) {
      body.unshift(varDecl([...rangeTempNames(ctx.temps), ...ctx.extraVars]))
    }
    return body
  }
}

function rangeTempNames(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(`${RESERVED_PREFIX}_t${i}`)
  return out
}

/**
 * Instrument a user program.
 * Returns { code, warnings } where `code` is the body of the main generator —
 * the engine wraps it as `globalThis.__tt_gen1 = (function* () { … })()`.
 */
export function instrument(source) {
  if (source.includes(RESERVED_PREFIX)) {
    throw Object.assign(new Error(`identifiers containing "${RESERVED_PREFIX}" are reserved by the debugger`), {
      timeTravelUserError: true,
    })
  }
  let ast
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true })
  } catch (e) {
    throw Object.assign(new Error(`syntax error: ${e.message}`), {
      timeTravelUserError: true,
      loc: e.loc ?? null,
    })
  }
  const inst = new Instrumenter()
  const bodyStmts = inst.program(ast)
  const wrapped = {
    type: "Program",
    sourceType: "script",
    body: bodyStmts,
  }
  const code = generate(wrapped, { indent: "  " })
  return { code, warnings: inst.warnings }
}

/** Wrap instrumented body code into the full evaluatable payload. */
export function wrapProgram(bodyCode, genGlobalName = "__tt_gen1") {
  return `globalThis.${genGlobalName} = (function* () {\n${bodyCode}\n})();\n"ok"`
}
