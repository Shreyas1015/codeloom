import ts from "typescript";
import { className, enclosingSymbol, functionLikeName, lineOf, stringValue } from "./ast.js";
import { importedBindings, isMutated } from "./http-calls.js";
import {
  AMQP_METHOD_ARGC, hasAmqpDependency, hasDefaultModifier, hasExportModifier, isAmqpMethod, isAmqpReceiver, isLikelyRepoImport,
  memberKeyText, unwrapAsConst,
} from "./queues.js";
import type { AdapterContext, ParsedFile, QueueWrapperMethod } from "./types.js";

// ---------------------------------------------------------------------------------------------------
// v0.6 queues fix (spec §3). Real backends often reach amqplib only through classes: a base publisher or
// consumer keeps the exchange / routing key / queue in fields set by its constructor, each subclass passes
// them through `super(...)` or overrides a field, and callers do `new OrderPublisher(...).publish()`; or a
// shared singleton (`MessageBus.getInstance()`) is handed the names, sometimes inside a message object.
//
// A file alone cannot settle that (the base, the subclass, the names and the caller are usually in
// different files), so each file is summarised here — its classes, its functions, every amqplib call and
// every call that might lead to one, with each name argument kept as a small symbolic value (`QV`) — and
// `queue-solve.ts` settles every summary together in `finalizeEndpoints`. A value that cannot be read is
// `null` and is never guessed.
// ---------------------------------------------------------------------------------------------------

/** A name defined in `file` (`from` unset) or imported into it (`from` = the module specifier, `name` = the
 * name the module exports it under, "default" for a default import). */
export interface QRef {
  file: string;
  name: string;
  from?: string;
}

/** A symbolic value, as written at one place in the code. `param`/`self` are the enclosing function's own
 * parameter / `this`: open until a caller supplies them. Everything else is closed. */
export type QV =
  | { k: "lit"; v: string }
  /** An imported binding (a const, a member of an exported const object / enum / class statics, or an exported instance). */
  | { k: "imp"; ref: QRef; member?: string }
  | { k: "param"; i: number }
  | { k: "self" }
  | { k: "prop"; of: QV; p: string }
  /** `TABLE[key]` / `TABLE[key].p` on a const object literal (local or imported). */
  | { k: "lookup"; t: QRef; key: QV; p?: string }
  /** `a || b`, `a ?? b`: `b` null when it cannot be read. */
  | { k: "or"; a: QV; b: QV | null }
  | { k: "tpl"; parts: Array<string | QV> }
  /** The reply of `channel.assertQueue(name)`: its `.queue` is `name`. */
  | { k: "aq"; name: QV }
  /** An instance of class `cls`: `new cls(...args)` (args null when unknown), or `cls.<via>()` (a static
   * factory, valid only when it returns an instance of `cls`), then `chain` (fluent calls returning `this`). */
  | { k: "obj"; cls: QRef; args: Array<QV | null> | null; via?: string; chain?: Array<{ m: string; args: Array<QV | null> }> }
  /** What a factory function returns (`getMessageBus()`). */
  | { k: "ret"; fn: QRef };

/** The handler argument of a `consume` call. */
export type QHandler =
  | { k: "param"; i: number }
  /** An inline callback; `calls` are the `this.X(...)` methods it calls (a base consume loop handing over). */
  | { k: "inline"; calls: string[] }
  | { k: "method"; m: string };

export interface QAmqp {
  m: QueueWrapperMethod;
  line: number;
  /** The call's own enclosing symbol, when it is not the function's (a named callback inside it). */
  sym?: string;
  slots: Array<QV | null>;
  h?: QHandler;
}

export type QCallee =
  | { k: "fn"; ref: QRef }
  | { k: "this"; m: string }
  | { k: "super"; m: string }
  /** `Name.m(...)`: `Name` a class (a static call) or an instance (local or imported). */
  | { k: "name"; ref: QRef; m: string }
  /** `<value>.m(...)` on an object value; `t` the receiver's declared class (a typed parameter). */
  | { k: "on"; recv: QV; m: string; t?: QRef };

export interface QCall {
  c: QCallee;
  line: number;
  sym?: string;
  args: Array<QV | null>;
}

export interface QFn {
  key: string;
  symbol: string;
  line: number;
  cls?: string;
  isStatic?: boolean;
  defaults: Array<QV | null>;
  amqp: QAmqp[];
  calls: QCall[];
  /** A factory's return value (top-level functions only), when every return gives the same instance. */
  returns?: QV;
}

export interface QClass {
  name: string;
  line: number;
  abstract?: boolean;
  ext?: QRef;
  /** The constructor: its parameter defaults, the `super(...)` arguments, and in source order every field it
   * sets (`this.f = v`, a parameter property) and every `this.m(...)` call it makes (a setter: `this.onQueue(X)`). */
  ctor?: { defaults: Array<QV | null>; steps: Array<{ f: string; v: QV | null } | { m: string; args: Array<QV | null> }>; superArgs?: Array<QV | null> };
  /** Instance field initialisers. */
  fields: Record<string, QV | null>;
  /** Fields declared with a class type (`private publisher: OrderPublisher`). */
  fieldTypes: Record<string, QRef>;
  /** Fields assigned an `assertQueue` reply or an instance outside the constructor. */
  later: Record<string, QV>;
  /** Methods that return `this`: the fields each sets (a builder: `.onQueue("x")`). */
  fluent: Record<string, Array<{ f: string; v: QV | null }>>;
  /** Other methods that set fields (`setQueue(q) { this.queue = q }`): the fields each sets. */
  sets: Record<string, Array<{ f: string; v: QV | null }>>;
  /** Static methods returning an instance of the class (`getInstance`). */
  singletons: string[];
  /** Its own instance methods (for the method a base class's consume loop hands each message to). */
  methods: string[];
}

export interface QFlowFile {
  file: string;
  lits: Record<string, string>;
  /** Const object literals, string enums and class statics: name -> key -> value (or a row of values). */
  tables: Record<string, Record<string, string | Record<string, string>>>;
  /** Top-level `const x = <instance>`. */
  instances: Record<string, QV>;
  /** Exported name -> local name. */
  exports: Record<string, string>;
  defaultValue?: QV;
  classes: Record<string, QClass>;
  fns: Record<string, QFn>;
}

// ---- module scope ---------------------------------------------------------------------------------

interface Mod {
  file: string;
  sf: ts.SourceFile;
  deps: Set<string>;
  imports: Map<string, { from: string; name: string }>;
  lits: Map<string, string>;
  tables: Map<string, Record<string, string | Record<string, string>>>;
  classes: Set<string>;
  fns: Set<string>;
  instanceInits: Map<string, ts.Expression>;
}

/** The function a value is read in: its parameters become `param(i)`, `this` becomes `self`. */
interface Fx {
  mod: Mod;
  fn?: ts.FunctionLikeDeclaration;
  cls?: ts.ClassLikeDeclaration;
  depth: number;
}

const MAX_DEPTH = 8;

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isAwaitExpression(cur)
      || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function rowOf(init: ts.Expression): Record<string, string | Record<string, string>> | undefined {
  const obj = unwrapAsConst(init);
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const row: Record<string, string | Record<string, string>> = {};
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = memberKeyText(p.name);
    if (key === undefined) continue;
    const v = stringValue(p.initializer);
    if (v !== undefined) {
      row[key] = v;
      continue;
    }
    const inner = unwrapAsConst(p.initializer);
    if (!ts.isObjectLiteralExpression(inner)) continue;
    const sub: Record<string, string> = {};
    for (const q of inner.properties) {
      const k2 = ts.isPropertyAssignment(q) ? memberKeyText(q.name) : undefined;
      const v2 = k2 !== undefined && ts.isPropertyAssignment(q) ? stringValue(q.initializer) : undefined;
      if (k2 !== undefined && v2 !== undefined) sub[k2] = v2;
    }
    if (Object.keys(sub).length > 0) row[key] = sub;
  }
  return Object.keys(row).length > 0 ? row : undefined;
}

function moduleScope(file: ParsedFile, sf: ts.SourceFile, ctx: AdapterContext): Mod {
  const mod: Mod = {
    file: file.rel, sf, deps: ctx.deps, imports: importedBindings(sf), lits: new Map(), tables: new Map(), classes: new Set(),
    fns: new Set(), instanceInits: new Map(),
  };
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = d.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          mod.fns.add(d.name.text);
          continue;
        }
        if (!isConst) continue;
        const s = stringValue(init);
        if (s !== undefined) mod.lits.set(d.name.text, s);
        const row = rowOf(init);
        if (row) mod.tables.set(d.name.text, row);
        else if (s === undefined) mod.instanceInits.set(d.name.text, init);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      mod.fns.add(stmt.name.text);
    } else if (ts.isEnumDeclaration(stmt)) {
      const row: Record<string, string> = {};
      for (const m of stmt.members) {
        const key = memberKeyText(m.name);
        const v = m.initializer && stringValue(m.initializer);
        if (key !== undefined && v !== undefined) row[key] = v;
      }
      if (Object.keys(row).length > 0) mod.tables.set(stmt.name.text, row);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      mod.classes.add(stmt.name.text);
      const row: Record<string, string> = {};
      for (const m of stmt.members) {
        if (!ts.isPropertyDeclaration(m) || !ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) continue;
        const key = memberKeyText(m.name);
        const v = m.initializer && stringValue(m.initializer);
        if (key !== undefined && v !== undefined) row[key] = v;
      }
      if (Object.keys(row).length > 0) mod.tables.set(stmt.name.text, row);
    }
  }
  return mod;
}

// ---- reading a value ------------------------------------------------------------------------------

type Decl =
  | { kind: "param"; index: number }
  | { kind: "var"; decl: ts.VariableDeclaration; element?: string }
  | { kind: "opaque" };

function declares(name: ts.BindingName, id: string): boolean {
  return ts.isIdentifier(name) ? name.text === id : name.elements.some((e) => !ts.isOmittedExpression(e) && declares(e.name, id));
}

function varIn(list: ts.VariableDeclarationList, id: string): Decl | undefined {
  for (const d of list.declarations) {
    if (ts.isIdentifier(d.name)) {
      if (d.name.text === id) return { kind: "var", decl: d };
    } else if (declares(d.name, id)) {
      // `const { queue } = message` -> message.queue; anything else in a pattern is not read.
      if (ts.isObjectBindingPattern(d.name)) {
        for (const el of d.name.elements) {
          if (ts.isIdentifier(el.name) && el.name.text === id && !el.dotDotDotToken && !el.initializer) {
            const key = el.propertyName ? memberKeyText(el.propertyName) : id;
            if (key !== undefined) return { kind: "var", decl: d, element: key };
          }
        }
      }
      return { kind: "opaque" };
    }
  }
  return undefined;
}

/** The nearest declaration of `id` between its use and the summarised function (inclusive); undefined when
 * it is declared further out (module level). */
function findDecl(id: ts.Identifier, fx: Fx): Decl | undefined {
  const name = id.text;
  for (let cur: ts.Node | undefined = id.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
    if (ts.isFunctionLike(cur)) {
      const i = cur.parameters.findIndex((p) => declares(p.name, name));
      if (i >= 0) return cur === fx.fn && ts.isIdentifier(cur.parameters[i]!.name) ? { kind: "param", index: i } : { kind: "opaque" };
    }
    if (ts.isBlock(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur) || ts.isModuleBlock(cur)) {
      for (const s of cur.statements) {
        if (ts.isVariableStatement(s)) {
          const d = varIn(s.declarationList, name);
          if (d) return d;
        }
        if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) return { kind: "opaque" };
      }
    }
    if ((ts.isForOfStatement(cur) || ts.isForInStatement(cur) || ts.isForStatement(cur)) && cur.initializer && ts.isVariableDeclarationList(cur.initializer)) {
      if (cur.initializer.declarations.some((d) => declares(d.name, name))) return { kind: "opaque" };
    }
    if (ts.isCatchClause(cur) && cur.variableDeclaration && declares(cur.variableDeclaration.name, name)) return { kind: "opaque" };
    if (cur === fx.fn || ts.isClassLike(cur)) break;
  }
  return undefined;
}

const deeper = (fx: Fx): Fx => ({ ...fx, depth: fx.depth + 1 });

function classRef(name: string, mod: Mod): QRef | undefined {
  if (mod.classes.has(name)) return { file: mod.file, name };
  const imp = mod.imports.get(name);
  return imp && isLikelyRepoImport(imp.from, mod.deps) ? { file: mod.file, from: imp.from, name: imp.name } : undefined;
}

function fnRef(name: string, mod: Mod): QRef | undefined {
  if (mod.fns.has(name)) return { file: mod.file, name };
  const imp = mod.imports.get(name);
  return imp && isLikelyRepoImport(imp.from, mod.deps) ? { file: mod.file, from: imp.from, name: imp.name } : undefined;
}

function tableRef(name: string, mod: Mod): QRef | undefined {
  if (mod.tables.has(name)) return { file: mod.file, name };
  const imp = mod.imports.get(name);
  return imp && isLikelyRepoImport(imp.from, mod.deps) ? { file: mod.file, from: imp.from, name: imp.name } : undefined;
}

/** A module-level instance, read once per name (`const bus = MessageBus.getInstance()`). */
function moduleInstance(name: string, mod: Mod, depth: number): QV | null {
  const init = mod.instanceInits.get(name);
  if (!init || depth > MAX_DEPTH) return null;
  const v = toQV(init, { mod, depth: depth + 1 });
  return v && (v.k === "obj" || v.k === "ret") ? v : null;
}

function isChannelExpr(e: ts.Expression, fx: Fx): boolean {
  return !!fx.fn && isAmqpReceiver(fx.fn, fx.cls, e);
}

function identQV(id: ts.Identifier, fx: Fx): QV | null {
  const d = findDecl(id, fx);
  if (d?.kind === "param") return fx.fn && isMutated(fx.fn, id.text) ? null : { k: "param", i: d.index };
  if (d?.kind === "opaque") return null;
  if (d?.kind === "var") {
    const list = d.decl.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    if (!d.decl.initializer || (!isConst && fx.fn && isMutated(fx.fn, id.text))) return null;
    const v = toQV(d.decl.initializer, deeper(fx));
    return v && d.element !== undefined ? mkProp(v, d.element) : v;
  }
  const mod = fx.mod;
  const lit = mod.lits.get(id.text);
  if (lit !== undefined) return { k: "lit", v: lit };
  if (mod.instanceInits.has(id.text)) return moduleInstance(id.text, mod, fx.depth);
  const imp = mod.imports.get(id.text);
  return imp && isLikelyRepoImport(imp.from, mod.deps) ? { k: "imp", ref: { file: mod.file, from: imp.from, name: imp.name } } : null;
}

/** `of.p`, folded where the extraction alone can: an imported binding's member, a lookup row's field. */
function mkProp(of: QV, p: string): QV {
  if (of.k === "imp" && of.member === undefined) return { ...of, member: p };
  if (of.k === "lookup" && of.p === undefined) return { ...of, p };
  if (of.k === "aq" && p === "queue") return of.name;
  return { k: "prop", of, p };
}

function argsQV(args: readonly ts.Expression[], fx: Fx): Array<QV | null> {
  return args.map((a) => (ts.isSpreadElement(a) ? null : toQV(a, deeper(fx))));
}

export function toQV(e0: ts.Expression, fx: Fx): QV | null {
  if (fx.depth > MAX_DEPTH) return null;
  const e = unwrap(e0);
  const s = stringValue(e);
  if (s !== undefined) return { k: "lit", v: s };
  if (ts.isTemplateExpression(e)) {
    const parts: Array<string | QV> = [e.head.text];
    for (const span of e.templateSpans) {
      const v = toQV(span.expression, deeper(fx));
      if (!v) return null;
      parts.push(v, span.literal.text);
    }
    return { k: "tpl", parts: parts.filter((p) => p !== "") };
  }
  if (e.kind === ts.SyntaxKind.ThisKeyword) return fx.cls ? { k: "self" } : null;
  if (ts.isIdentifier(e)) return identQV(e, fx);
  if (ts.isPropertyAccessExpression(e)) {
    const p = e.name.text;
    const base = unwrap(e.expression);
    if (ts.isIdentifier(base) && !findDecl(base, fx)) {
      const table = fx.mod.tables.get(base.text);
      if (table) {
        const row = table[p];
        return typeof row === "string" ? { k: "lit", v: row } : null;
      }
    }
    const of = toQV(base, deeper(fx));
    return of ? mkProp(of, p) : null;
  }
  if (ts.isElementAccessExpression(e)) {
    const base = unwrap(e.expression);
    if (!ts.isIdentifier(base) || findDecl(base, fx)) return null;
    const t = tableRef(base.text, fx.mod);
    const key = t ? toQV(e.argumentExpression, deeper(fx)) : null;
    return t && key ? { k: "lookup", t, key } : null;
  }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    const a = toQV(e.left, deeper(fx));
    return a ? { k: "or", a, b: toQV(e.right, deeper(fx)) } : null;
  }
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) {
    const cls = findDecl(e.expression, fx) ? undefined : classRef(e.expression.text, fx.mod);
    return cls ? { k: "obj", cls, args: argsQV(e.arguments ?? [], fx) } : null;
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const recv = unwrap(callee.expression);
      if (m === "assertQueue" && isChannelExpr(callee.expression, fx)) {
        const name = e.arguments[0] ? toQV(e.arguments[0], deeper(fx)) : null;
        return name ? { k: "aq", name } : null;
      }
      if (ts.isIdentifier(recv) && !findDecl(recv, fx) && !fx.mod.instanceInits.has(recv.text)) {
        const cls = classRef(recv.text, fx.mod);
        if (cls) return { k: "obj", cls, args: null, via: m };
      }
      const of = toQV(recv, deeper(fx));
      if (of?.k === "obj") return { ...of, chain: [...(of.chain ?? []), { m, args: argsQV(e.arguments, fx) }] };
      return null;
    }
    if (ts.isIdentifier(callee) && !findDecl(callee, fx)) {
      const fn = fnRef(callee.text, fx.mod);
      if (fn) return { k: "ret", fn };
    }
    return null;
  }
  return null;
}

// ---- functions ------------------------------------------------------------------------------------

function typeRefOf(type: ts.TypeNode | undefined, mod: Mod): QRef | undefined {
  if (!type) return undefined;
  if (ts.isUnionTypeNode(type)) {
    const refs = type.types.map((t) => typeRefOf(t, mod)).filter((r): r is QRef => r !== undefined);
    return refs.length === 1 ? refs[0] : undefined;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return classRef(type.typeName.text, mod);
  return undefined;
}

function handlerOf(arg: ts.Expression | undefined, fx: Fx): QHandler | undefined {
  if (!arg) return undefined;
  const e = unwrap(arg);
  if (ts.isIdentifier(e)) {
    const d = findDecl(e, fx);
    return d?.kind === "param" && !(fx.fn && isMutated(fx.fn, e.text)) ? { k: "param", i: d.index } : undefined;
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    const calls = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        calls.add(n.expression.name.text);
      }
      n.forEachChild(visit);
    };
    if (e.body) visit(e.body);
    return { k: "inline", calls: [...calls].sort() };
  }
  // `this.handle` / `this.handle.bind(this)`
  let ref: ts.Expression = e;
  if (ts.isCallExpression(ref) && ts.isPropertyAccessExpression(ref.expression) && ref.expression.name.text === "bind") ref = ref.expression.expression;
  if (ts.isPropertyAccessExpression(ref) && ref.expression.kind === ts.SyntaxKind.ThisKeyword) return { k: "method", m: ref.name.text };
  return undefined;
}

function calleeOf(call: ts.CallExpression, fx: Fx): QCallee | undefined {
  const callee = unwrap(call.expression);
  const mod = fx.mod;
  if (ts.isIdentifier(callee)) {
    if (findDecl(callee, fx)) return undefined;
    const ref = fnRef(callee.text, mod);
    return ref ? { k: "fn", ref } : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const m = callee.name.text;
  const recv = unwrap(callee.expression);
  if (recv.kind === ts.SyntaxKind.SuperKeyword) return { k: "super", m };
  if (recv.kind === ts.SyntaxKind.ThisKeyword) return fx.cls ? { k: "this", m } : undefined;
  if (ts.isIdentifier(recv)) {
    const d = findDecl(recv, fx);
    if (!d) {
      if (mod.classes.has(recv.text)) return { k: "name", ref: { file: mod.file, name: recv.text }, m };
      if (mod.instanceInits.has(recv.text)) {
        const v = moduleInstance(recv.text, mod, fx.depth);
        return v ? { k: "on", recv: v, m } : undefined;
      }
      const imp = mod.imports.get(recv.text);
      return imp && isLikelyRepoImport(imp.from, mod.deps) ? { k: "name", ref: { file: mod.file, from: imp.from, name: imp.name }, m } : undefined;
    }
    if (d.kind === "param" && fx.fn) {
      const t = typeRefOf(fx.fn.parameters[d.index]!.type, mod);
      return t ? { k: "on", recv: { k: "param", i: d.index }, m, t } : undefined;
    }
  }
  const v = toQV(recv, fx);
  if (!v || v.k === "lit" || v.k === "tpl" || v.k === "or" || v.k === "param" || v.k === "lookup" || v.k === "aq") return undefined;
  return { k: "on", recv: v, m };
}

/** Every amqplib call and every call that might lead to one in `fn`'s body, nested callbacks included (they
 * close over the function's parameters and `this`). */
function summariseFn(key: string, fn: ts.FunctionLikeDeclaration, mod: Mod, cls: ts.ClassLikeDeclaration | undefined): QFn {
  const fx: Fx = { mod, fn, ...(cls ? { cls } : {}), depth: 0 };
  const amqp: QAmqp[] = [];
  const calls: QCall[] = [];
  const own = functionLikeName(fn) ?? key;
  const symOf = (n: ts.Node): { sym?: string } => {
    const s = enclosingSymbol(n);
    return s !== own ? { sym: s } : {};
  };
  const visit = (n: ts.Node): void => {
    if (n !== fn && (ts.isClassLike(n))) return;
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const m = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (m !== undefined && isAmqpMethod(m) && isAmqpReceiver(fn, cls, (callee as ts.PropertyAccessExpression).expression)) {
        const slots = Array.from({ length: AMQP_METHOD_ARGC[m] }, (_, i) => (n.arguments[i] ? toQV(n.arguments[i]!, fx) : null));
        const h = m === "consume" ? handlerOf(n.arguments[1], fx) : undefined;
        amqp.push({ m, line: lineOf(n), ...symOf(n), slots, ...(h ? { h } : {}) });
      } else {
        const c = calleeOf(n, fx);
        if (c) calls.push({ c, line: lineOf(n), ...symOf(n), args: argsQV(n.arguments, fx) });
      }
    }
    n.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  const defaults = fn.parameters.map((p) => (p.initializer ? toQV(p.initializer, { mod, depth: 0 }) : null));
  const isStatic = !!ts.getModifiers(fn)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
  const out: QFn = {
    key, symbol: own, line: lineOf(fn), defaults, amqp, calls,
    ...(cls ? { cls: className(cls) } : {}), ...(isStatic ? { isStatic } : {}),
  };
  if (!cls && fn.body) {
    const rets = returnsOf(fn).map((r) => toQV(r, { mod, depth: 0 }));
    const first = rets[0];
    if (first && (first.k === "obj" || first.k === "ret" || first.k === "imp") && rets.every((r) => JSON.stringify(r) === JSON.stringify(first))) {
      out.returns = first;
    }
  }
  return out;
}

/** The returned expressions of `fn` (an expression-bodied arrow's body counts), not of nested functions. */
function returnsOf(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn.body && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    n.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** Every `this.<f> = <expr>` directly in `fn`'s own body (not in nested functions). */
function thisAssigns(fn: ts.FunctionLikeDeclaration): Array<{ f: string; e: ts.Expression }> {
  const out: Array<{ f: string; e: ts.Expression }> = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn.body && ts.isFunctionLike(n)) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)
      && n.left.expression.kind === ts.SyntaxKind.ThisKeyword) out.push({ f: n.left.name.text, e: n.right });
    n.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

function summariseClass(cls: ts.ClassDeclaration, mod: Mod): QClass {
  const name = cls.name!.text;
  const out: QClass = { name, line: lineOf(cls), fields: {}, fieldTypes: {}, later: {}, fluent: {}, sets: {}, singletons: [], methods: [] };
  if (ts.getModifiers(cls)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) out.abstract = true;
  const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  if (ext && ts.isIdentifier(ext)) {
    const ref = classRef(ext.text, mod);
    if (ref) out.ext = ref;
  }
  for (const member of cls.members) {
    const isStatic = ts.canHaveModifiers(member) && !!ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    if (ts.isConstructorDeclaration(member)) {
      const fx: Fx = { mod, fn: member, cls, depth: 0 };
      const steps: NonNullable<QClass["ctor"]>["steps"] = [];
      member.parameters.forEach((p, i) => {
        if (ts.getModifiers(p)?.some((m) => m.kind === ts.SyntaxKind.PublicKeyword || m.kind === ts.SyntaxKind.PrivateKeyword
          || m.kind === ts.SyntaxKind.ProtectedKeyword || m.kind === ts.SyntaxKind.ReadonlyKeyword) && ts.isIdentifier(p.name)) {
          steps.push({ f: p.name.text, v: { k: "param", i } });
          const t = typeRefOf(p.type, mod);
          if (t) out.fieldTypes[p.name.text] = t;
        }
      });
      const collectSteps = (n: ts.Node): void => {
        if (n !== member.body && ts.isFunctionLike(n)) return;
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)
          && n.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
          steps.push({ f: n.left.name.text, v: toQV(n.right, fx) });
        } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          steps.push({ m: n.expression.name.text, args: argsQV(n.arguments, fx) });
        }
        n.forEachChild(collectSteps);
      };
      if (member.body) collectSteps(member.body);
      let superArgs: Array<QV | null> | undefined;
      const findSuper = (n: ts.Node): void => {
        if (superArgs || (n !== member.body && ts.isFunctionLike(n))) return;
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) superArgs = argsQV(n.arguments, fx);
        n.forEachChild(findSuper);
      };
      if (member.body) findSuper(member.body);
      const defaults = member.parameters.map((p) => (p.initializer ? toQV(p.initializer, { mod, depth: 0 }) : null));
      out.ctor = { defaults, steps, ...(superArgs ? { superArgs } : {}) };
    } else if (ts.isPropertyDeclaration(member) && !isStatic) {
      const f = memberKeyText(member.name);
      if (f === undefined) continue;
      const t = typeRefOf(member.type, mod);
      if (t) out.fieldTypes[f] = t;
      const init = member.initializer;
      if (init && !ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) out.fields[f] = toQV(init, { mod, cls, depth: 0 });
    } else if (ts.isMethodDeclaration(member)) {
      const m = memberKeyText(member.name);
      if (m === undefined) continue;
      if (!isStatic) out.methods.push(m);
      if (!member.body) continue;
      const fx: Fx = { mod, fn: member, cls, depth: 0 };
      if (isStatic) {
        const rt = member.type && typeRefOf(member.type, mod);
        const rets = returnsOf(member).map(unwrap);
        const own = (r: ts.Expression) => (ts.isNewExpression(r) && ts.isIdentifier(r.expression) && r.expression.text === name)
          || (ts.isPropertyAccessExpression(r) && ((ts.isIdentifier(r.expression) && r.expression.text === name) || r.expression.kind === ts.SyntaxKind.ThisKeyword));
        if ((rt && rt.from === undefined && rt.name === name) || (rets.length > 0 && rets.every(own))) out.singletons.push(m);
        continue;
      }
      const rets = returnsOf(member).map(unwrap);
      const assigns = thisAssigns(member);
      if (rets.length > 0 && rets.every((r) => r.kind === ts.SyntaxKind.ThisKeyword)) {
        out.fluent[m] = assigns.map(({ f, e }) => ({ f, v: toQV(e, fx) }));
      } else if (assigns.length > 0 && assigns.length <= 8) {
        out.sets[m] = assigns.map(({ f, e }) => ({ f, v: toQV(e, fx) }));
      }
      for (const { f, e } of assigns) {
        const v = toQV(e, fx);
        if (v && (v.k === "aq" || v.k === "obj") && !JSON.stringify(v).includes('"k":"param"')) {
          if (!(f in out.later)) out.later[f] = v;
        }
      }
    }
  }
  return out;
}

/** The summary of one file; undefined when it has nothing queue-related to say (or no amqplib dependency). */
export function extractQueueFlow(file: ParsedFile, ctx: AdapterContext): QFlowFile | undefined {
  if (!file.sf || !hasAmqpDependency(ctx)) return undefined;
  const sf = file.sf;
  const mod = moduleScope(file, sf, ctx);
  const out: QFlowFile = { file: file.rel, lits: {}, tables: {}, instances: {}, exports: {}, classes: {}, fns: {} };
  for (const [k, v] of mod.lits) out.lits[k] = v;
  for (const [k, v] of mod.tables) out.tables[k] = v;
  for (const name of mod.instanceInits.keys()) {
    const v = moduleInstance(name, mod, 0);
    if (v) out.instances[name] = v;
  }
  const keep = (f: QFn) => {
    if (f.amqp.length > 0 || f.calls.length > 0 || f.returns) out.fns[f.key] = f;
  };
  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);
    const isDefault = exported && hasDefaultModifier(stmt);
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      keep(summariseFn(stmt.name.text, stmt, mod, undefined));
      if (exported) out.exports[isDefault ? "default" : stmt.name.text] = stmt.name.text;
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          keep(summariseFn(d.name.text, d.initializer, mod, undefined));
        }
        if (exported) out.exports[d.name.text] = d.name.text;
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      out.classes[stmt.name.text] = summariseClass(stmt, mod);
      for (const member of stmt.members) {
        const m = memberKeyText(member.name as ts.PropertyName | undefined);
        if (m === undefined) continue;
        if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member)) && member.body) {
          keep(summariseFn(`${stmt.name.text}.${m}`, member, mod, stmt));
        } else if (ts.isPropertyDeclaration(member) && member.initializer
          && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
          keep(summariseFn(`${stmt.name.text}.${m}`, member.initializer, mod, stmt));
        }
      }
      if (exported) out.exports[isDefault ? "default" : stmt.name.text] = stmt.name.text;
    } else if (ts.isEnumDeclaration(stmt) && exported) {
      out.exports[stmt.name.text] = stmt.name.text;
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const e = unwrap(stmt.expression);
      if (ts.isIdentifier(e)) out.exports.default = e.text;
      else {
        const v = toQV(e, { mod, depth: 0 });
        if (v && (v.k === "obj" || v.k === "ret")) out.defaultValue = v;
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) if (!el.isTypeOnly) out.exports[el.name.text] = (el.propertyName ?? el.name).text;
    }
  }
  const empty = Object.keys(out.fns).length === 0 && Object.keys(out.classes).length === 0 && Object.keys(out.lits).length === 0
    && Object.keys(out.tables).length === 0 && Object.keys(out.instances).length === 0 && !out.defaultValue;
  return empty ? undefined : out;
}
