import ts from "typescript";
import { baseWords } from "../linker/hints.js";
import type { Route, RouteForward } from "../store/schemas.js";
import { absoluteHost, enclosingSymbol, lineOf, normalizePath } from "./ast.js";
import { httpCallShape } from "./http-calls.js";
import type { ParsedFile } from "./types.js";

// 0.6 §2: where a Next.js catch-all API route (`app/api/billing/[...path]/route.ts`) forwards its requests. Its
// handler often does not fetch itself: it is made by a shared factory in another file (`serviceRoute("billing")`),
// which hands the service name and the path on to a helper that builds the URL from a base and calls `fetch`.
// This follows the handler through those functions — across at most MAX_IMPORT_HOPS imports, with each
// function's parameters bound to what its call site passes — to an HTTP call whose URL carries the route's
// catch-all path. Only string literals, env var reads, object literals, closures and the catch-all path are
// tracked; anything else is unknown, and a forward whose base is unknown is recorded without one (never guessed).

export const MAX_IMPORT_HOPS = 3;
/** Nested function calls followed from the handler (a factory, a helper, the URL builder, ...). */
const MAX_DEPTH = 8;
/** Expressions evaluated for one route: a bound on work, whatever the code looks like. */
const MAX_STEPS = 20_000;

export type FileLoader = (rel: string) => ParsedFile | undefined;
export type ImportResolver = (fromRel: string, specifier: string) => string | null;

type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
type Lazy = () => Val;

/** What an expression is known to be. `base`: a named base (`process.env.X`, `env.X`); `rest`: the route's
 * catch-all path (or a string made from it); `cat`: a string concatenation. */
type Val =
  | { k: "str"; s: string }
  | { k: "base"; text: string }
  | { k: "rest" }
  | { k: "cat"; parts: Val[] }
  | { k: "obj"; props: Map<string, Lazy> }
  | { k: "fn"; fn: FnNode; scope: Scope }
  | { k: "module"; mod: Mod }
  | { k: "null" }
  | { k: "unknown" };

interface Mod { file: ParsedFile; sf: ts.SourceFile; hops: number }
/** A function's parameters and locals (`fn`), or a module's top-level names (no `fn`); `parent`: the scope the
 * function was written in. */
interface Scope { mod: Mod; fn?: FnNode; vars: Map<string, Lazy>; parent?: Scope }

const UNKNOWN: Val = { k: "unknown" };
const NULL: Val = { k: "null" };
const REST: Val = { k: "rest" };

/** Methods that keep a value made of the catch-all path what it is (`path.map(encodeURIComponent).join("/")`). */
const REST_KEEP = new Set(["map", "join", "filter", "slice", "concat", "toString", "flat", "flatMap"]);
/** Methods that keep a base a base (`base.replace(/\/+$/, "")`). */
const STR_KEEP = new Set(["replace", "replaceAll", "trim", "trimEnd", "trimStart", "toString"]);
const PASS_FNS = new Set(["String", "encodeURI", "encodeURIComponent"]);
const FETCH_FNS = new Set(["fetch", "$fetch", "ofetch"]);
const GLOBALS = new Set(["globalThis", "window", "self", "global"]);
const NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const SPLAT_RE = /\/:([^/]+)\*$/;

function lazy(f: () => Val): Lazy {
  let v: Val | undefined;
  let busy = false;
  return () => {
    if (v) return v;
    if (busy) return UNKNOWN; // a value that needs itself
    busy = true;
    try {
      v = f();
    } finally {
      busy = false;
    }
    return v;
  };
}

const known = (v: Val): Lazy => () => v;

function objOf(entries: Record<string, Val>): Val {
  return { k: "obj", props: new Map(Object.entries(entries).map(([key, v]) => [key, known(v)])) };
}

function skipOuter(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)
      || ts.isTypeAssertionExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else return e;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isFn(n: ts.Node): n is FnNode {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

/** A concatenation's leaves, adjacent literal text merged. */
function flatten(v: Val): Val[] {
  const out: Val[] = [];
  const add = (x: Val) => {
    if (x.k === "cat") for (const p of x.parts) add(p);
    else if (x.k === "str" && x.s === "") return;
    else if (x.k === "str" && out[out.length - 1]?.k === "str") out[out.length - 1] = { k: "str", s: (out[out.length - 1] as { s: string }).s + x.s };
    else out.push(x);
  };
  add(v);
  return out;
}

function same(a: Val, b: Val): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "str": return a.s === (b as typeof a).s;
    case "base": return a.text === (b as typeof a).text;
    case "rest": case "null": return true;
    case "cat": {
      const x = flatten(a);
      const y = flatten(b);
      return x.length === y.length && x.every((p, i) => same(p, y[i]!));
    }
    case "fn": return a.fn === (b as typeof a).fn;
    case "obj": return a === b;
    case "module": return a.mod.file.rel === (b as typeof a).mod.file.rel;
    case "unknown": return false;
  }
}

const hasRest = (v: Val) => flatten(v).some((p) => p.k === "rest");

interface Found { v: Val; node: ts.CallExpression }

class Evaluator {
  private steps = 0;
  private depth = 0;
  private readonly scopes = new Map<string, Scope | null>();

  constructor(private readonly load: FileLoader, private readonly resolve: ImportResolver) {}

  moduleScope(rel: string, hops: number): Scope | undefined {
    if (hops > MAX_IMPORT_HOPS) return undefined;
    const key = `${rel}\0${hops}`;
    const cached = this.scopes.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const file = this.load(rel);
    const scope = file?.sf ? { mod: { file, sf: file.sf, hops }, vars: new Map<string, Lazy>() } : null;
    this.scopes.set(key, scope);
    return scope ?? undefined;
  }

  // ---- names --------------------------------------------------------------------------------------------------

  lookup(name: string, scope: Scope): Val {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const hit = s.vars.get(name);
      if (hit) return hit();
      const found = s.fn ? this.localBinding(s, name) : this.moduleBinding(s, name);
      if (found) {
        s.vars.set(name, found);
        return found();
      }
    }
    return UNKNOWN; // a global
  }

  /** A const or function declared in the function's own body (not in a nested function); two of them: unknown. */
  private localBinding(s: Scope, name: string): Lazy | undefined {
    const body = s.fn!.body;
    if (!body || !ts.isBlock(body)) return undefined;
    const found: Lazy[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) found.push(known({ k: "fn", fn: n, scope: s }));
      if (ts.isVariableDeclaration(n)) found.push(...this.declBindings(n, name, s));
      if (isFn(n) || ts.isClassLike(n)) return;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    if (found.length === 0) return undefined;
    return found.length === 1 ? found[0] : known(UNKNOWN);
  }

  /** What `name` binds in a `const` declaration (`const x = …`, `const { x } = …`, `const { y: x } = …`). */
  private declBindings(d: ts.VariableDeclaration, name: string, s: Scope): Lazy[] {
    const isConst = ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
    if (ts.isIdentifier(d.name)) {
      if (d.name.text !== name) return [];
      const init = d.initializer;
      return [isConst && init ? lazy(() => this.eval(init, s)) : known(UNKNOWN)];
    }
    if (!ts.isObjectBindingPattern(d.name)) return d.name.elements.some((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) && e.name.text === name) ? [known(UNKNOWN)] : [];
    const out: Lazy[] = [];
    for (const el of d.name.elements) {
      if (!ts.isIdentifier(el.name) || el.name.text !== name) continue;
      const key = el.propertyName ? propName(el.propertyName) : el.name.text;
      const init = d.initializer;
      out.push(isConst && init && key !== undefined && !el.dotDotDotToken ? lazy(() => this.member(this.eval(init, s), key)) : known(UNKNOWN));
    }
    return out;
  }

  private moduleBinding(s: Scope, name: string): Lazy | undefined {
    const found: Lazy[] = [];
    for (const st of s.mod.sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause && !st.importClause.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const clause = st.importClause;
        if (clause.name?.text === name) found.push(lazy(() => this.importValue(s.mod, spec, "default")));
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) found.push(lazy(() => this.importValue(s.mod, spec, "*")));
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly || el.name.text !== name) continue;
            const imported = el.propertyName ? propName(el.propertyName) ?? name : name;
            found.push(lazy(() => this.importValue(s.mod, spec, imported)));
          }
        }
      }
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) found.push(known({ k: "fn", fn: st, scope: s }));
      if (ts.isClassDeclaration(st) && st.name?.text === name) found.push(known(UNKNOWN));
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) found.push(...this.declBindings(d, name, s));
    }
    if (found.length === 0) return undefined;
    return found.length === 1 ? found[0] : known(UNKNOWN);
  }

  private importValue(mod: Mod, spec: string, imported: string): Val {
    const rel = this.resolve(mod.file.rel, spec);
    const target = rel === null ? undefined : this.moduleScope(rel, mod.hops + 1);
    if (!target) return UNKNOWN;
    return imported === "*" ? { k: "module", mod: target.mod } : this.exportValue(target, imported, 0) ?? UNKNOWN;
  }

  /** What module `scope` exports as `name`; undefined when it exports no such name. */
  exportValue(scope: Scope, name: string, reExports: number): Val | undefined {
    const stars: string[] = [];
    for (const st of scope.mod.sf.statements) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(st) && exported && (isDefault ? name === "default" : st.name?.text === name)) {
        return { k: "fn", fn: st, scope };
      }
      if (ts.isVariableStatement(st) && exported && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) {
        return this.lookup(name, scope);
      }
      if (ts.isExportAssignment(st) && !st.isExportEquals && name === "default") return this.eval(st.expression, scope);
      if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
        const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
        if (!st.exportClause) {
          if (spec !== undefined) stars.push(spec);
          continue;
        }
        if (!ts.isNamedExports(st.exportClause)) continue;
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly || el.name.text !== name) continue;
          const local = el.propertyName ? propName(el.propertyName) ?? name : name;
          return spec !== undefined ? this.importValue(scope.mod, spec, local) : this.lookup(local, scope);
        }
      }
    }
    if (reExports >= MAX_IMPORT_HOPS) return undefined;
    for (const spec of stars) {
      const rel = this.resolve(scope.mod.file.rel, spec);
      const target = rel === null ? undefined : this.moduleScope(rel, scope.mod.hops + 1);
      const v = target && this.exportValue(target, name, reExports + 1);
      if (v) return v;
    }
    return undefined;
  }

  // ---- values -------------------------------------------------------------------------------------------------

  eval(expr: ts.Expression, s: Scope): Val {
    if (++this.steps > MAX_STEPS) return UNKNOWN;
    const e = skipOuter(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { k: "str", s: e.text };
    if (ts.isTemplateExpression(e)) {
      const parts: Val[] = [{ k: "str", s: e.head.text }];
      for (const span of e.templateSpans) parts.push(this.eval(span.expression, s), { k: "str", s: span.literal.text });
      return { k: "cat", parts };
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return { k: "cat", parts: [this.eval(e.left, s), this.eval(e.right, s)] };
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        // `process.env.X ?? "http://localhost:4000"`: the env var is the base.
        const left = this.eval(e.left, s);
        return left.k === "unknown" || left.k === "null" ? UNKNOWN : left;
      }
      return UNKNOWN;
    }
    if (ts.isConditionalExpression(e)) {
      const a = this.eval(e.whenTrue, s);
      return same(a, this.eval(e.whenFalse, s)) ? a : UNKNOWN;
    }
    if (ts.isIdentifier(e)) return e.text === "undefined" ? NULL : this.lookup(e.text, s);
    if (e.kind === ts.SyntaxKind.NullKeyword) return NULL;
    if (ts.isPropertyAccessExpression(e)) {
      const host = e.expression.getText();
      if (host === "process.env" || host === "import.meta.env") return { k: "base", text: `${host}.${e.name.text}` };
      return this.member(this.eval(e.expression, s), e.name.text, e.expression);
    }
    if (ts.isElementAccessExpression(e)) {
      const key = this.eval(e.argumentExpression, s);
      if (key.k !== "str") return UNKNOWN;
      const host = e.expression.getText();
      if (host === "process.env" || host === "import.meta.env") return { k: "base", text: `${host}.${key.s}` };
      return this.member(this.eval(e.expression, s), key.s, e.expression);
    }
    if (ts.isCallExpression(e)) return this.call(e, s);
    if (ts.isNewExpression(e)) {
      const cls = ts.isIdentifier(e.expression) ? e.expression.text : "";
      const [url, base] = e.arguments ?? [];
      if ((cls !== "URL" && cls !== "Request") || !url) return UNKNOWN;
      // `new URL(path, base)` resolves the path against the base.
      return cls === "URL" && base ? { k: "cat", parts: [this.eval(base, s), this.eval(url, s)] } : this.eval(url, s);
    }
    if (ts.isObjectLiteralExpression(e)) {
      const props = new Map<string, Lazy>();
      for (const p of e.properties) {
        const key = p.name ? propName(p.name as ts.PropertyName) : undefined;
        if (key === undefined) continue;
        if (ts.isPropertyAssignment(p)) props.set(key, lazy(() => this.eval(p.initializer, s)));
        else if (ts.isShorthandPropertyAssignment(p)) props.set(key, lazy(() => this.lookup(key, s)));
        else if (ts.isMethodDeclaration(p)) props.set(key, known({ k: "fn", fn: p, scope: s }));
      }
      return { k: "obj", props };
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { k: "fn", fn: e, scope: s };
    return UNKNOWN;
  }

  /** `v[key]`. On a value codeloom cannot read, a key that can name a service (`env.BILLING_API_URL`,
   * `config.billing`) is read as a named base, the way the linker reads a call's base (linker/hints.ts). */
  member(v: Val, key: string, objExpr?: ts.Expression): Val {
    switch (v.k) {
      case "obj": return v.props.get(key)?.() ?? UNKNOWN;
      case "module": {
        const scope = this.moduleScope(v.mod.file.rel, v.mod.hops);
        return (scope && this.exportValue(scope, key, 0)) ?? UNKNOWN;
      }
      case "unknown":
      case "base": {
        if (!/^[A-Za-z_$][\w$-]*$/.test(key) || baseWords({ kind: "name", text: key }).length === 0) return UNKNOWN;
        const obj = objExpr?.getText();
        return { k: "base", text: obj !== undefined && NAME_RE.test(obj) && obj !== "this" ? `${obj}.${key}` : key };
      }
      default: return UNKNOWN;
    }
  }

  private call(c: ts.CallExpression, s: Scope): Val {
    const callee = skipOuter(c.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const recv = this.eval(callee.expression, s);
      if (recv.k === "rest" && REST_KEEP.has(m)) return REST;
      if ((recv.k === "base" || recv.k === "cat") && STR_KEEP.has(m)) return recv;
      const f = this.member(recv, m, callee.expression);
      return f.k === "fn" ? this.invoke(f, c.arguments, s) : UNKNOWN;
    }
    if (ts.isIdentifier(callee) && PASS_FNS.has(callee.text)) {
      const arg = c.arguments[0];
      const v = arg ? this.eval(arg, s) : UNKNOWN;
      return v.k === "rest" || v.k === "base" || v.k === "str" || v.k === "cat" ? v : UNKNOWN;
    }
    const f = this.eval(callee, s);
    return f.k === "fn" ? this.invoke(f, c.arguments, s) : UNKNOWN;
  }

  private args(list: readonly ts.Expression[], s: Scope): Lazy[] {
    return list.map((a) => (ts.isSpreadElement(a) ? known(UNKNOWN) : lazy(() => this.eval(a, s))));
  }

  /** A new scope for `f` with its parameters bound to `args` (a destructured parameter reads its keys). */
  bind(f: Extract<Val, { k: "fn" }>, args: Lazy[]): Scope {
    const scope: Scope = { mod: f.scope.mod, fn: f.fn, vars: new Map(), parent: f.scope };
    f.fn.parameters.forEach((p, i) => {
      const arg = args[i];
      const init = p.initializer;
      const value: Lazy = p.dotDotDotToken ? known(UNKNOWN) : arg ?? (init ? lazy(() => this.eval(init, scope)) : known(NULL));
      if (ts.isIdentifier(p.name)) scope.vars.set(p.name.text, value);
      else if (ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const key = el.propertyName ? propName(el.propertyName) : el.name.text;
          scope.vars.set(el.name.text, key === undefined || el.dotDotDotToken ? known(UNKNOWN) : lazy(() => this.member(value(), key)));
        }
      } else for (const el of p.name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) scope.vars.set(el.name.text, known(UNKNOWN));
    });
    return scope;
  }

  private invoke(f: Extract<Val, { k: "fn" }>, args: readonly ts.Expression[], s: Scope): Val {
    if (this.depth >= MAX_DEPTH) return UNKNOWN;
    this.depth++;
    try {
      return this.returned(f.fn, this.bind(f, this.args(args, s)));
    } finally {
      this.depth--;
    }
  }

  /** What a function returns: its expression body, or the one value all its non-null `return`s give. */
  private returned(fn: FnNode, scope: Scope): Val {
    const body = fn.body;
    if (!body) return UNKNOWN;
    if (!ts.isBlock(body)) return this.eval(body, scope);
    const values: Val[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) values.push(n.expression ? this.eval(n.expression, scope) : NULL);
      if (isFn(n) || ts.isClassLike(n)) return;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    const real = values.filter((v) => v.k !== "null");
    return real.length > 0 && real.every((v) => same(v, real[0]!)) ? real[0]! : UNKNOWN;
  }

  // ---- forwarding ---------------------------------------------------------------------------------------------

  /** HTTP calls reached from `f` (called with `args`) whose URL carries the catch-all path. */
  forwards(f: Extract<Val, { k: "fn" }>, args: Lazy[], depth: number): Found[] {
    if (depth > MAX_DEPTH || this.steps > MAX_STEPS) return [];
    const scope = this.bind(f, args);
    const body = f.fn.body;
    if (!body) return [];
    const out: Found[] = [];
    const visit = (n: ts.Node): void => {
      if (n !== body && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))) {
        // An inline callback (`.then((r) => fetch(...))`) runs in this scope.
        out.push(...this.forwards({ k: "fn", fn: n, scope }, [], depth + 1));
        return;
      }
      if (n !== body && (isFn(n) || ts.isClassLike(n))) return;
      if (ts.isCallExpression(n)) this.atCall(n, scope, depth, out);
      ts.forEachChild(n, visit);
    };
    visit(body);
    return out;
  }

  private atCall(c: ts.CallExpression, s: Scope, depth: number, out: Found[]): void {
    const url = httpUrlArg(c);
    if (url) {
      const v = this.eval(url, s);
      if (hasRest(v)) {
        out.push({ v, node: c });
        return;
      }
    }
    const callee = skipOuter(c.expression);
    let f: Val = UNKNOWN;
    if (ts.isPropertyAccessExpression(callee)) f = this.member(this.eval(callee.expression, s), callee.name.text, callee.expression);
    else if (ts.isIdentifier(callee)) f = this.lookup(callee.text, s);
    if (f.k === "fn") out.push(...this.forwards(f, this.args(c.arguments, s), depth + 1));
  }
}

/** The URL argument of an HTTP call: `fetch(url)`, `globalThis.fetch(url)`, `axios.get(url)`, `axios({ url })`, ... */
function httpUrlArg(c: ts.CallExpression): ts.Expression | undefined {
  const callee = skipOuter(c.expression);
  if (ts.isIdentifier(callee) && FETCH_FNS.has(callee.text)) return c.arguments[0];
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch" && ts.isIdentifier(callee.expression)
    && GLOBALS.has(callee.expression.text)) return c.arguments[0];
  return httpCallShape(c, new Set())?.urlExpr;
}

/** A forwarding call's URL as a RouteForward: the base before the path (when it is a named base or a literal
 * origin), and the forwarded path with the catch-all as `:<name>*` (when every part of it can be read). */
function render(found: Found, restName: string): RouteForward {
  const parts = flatten(found.v);
  const at = { file: found.node.getSourceFile().fileName, line: lineOf(found.node), symbol: enclosingSymbol(found.node) };
  const raw = parts.map((p) => (p.k === "str" ? p.s : p.k === "base" ? `\${${p.text}}` : p.k === "rest" ? `\${${restName}}` : "${…}")).join("");
  const head = parts[0];
  let base: string | undefined;
  let tail = parts;
  if (head?.k === "base") {
    base = head.text;
    tail = parts.slice(1);
  } else if (!(head?.k === "str" && absoluteHost(head.s) !== undefined)) {
    return { at, raw }; // no base codeloom can read
  }
  if (!tail.every((p) => p.k === "str" || p.k === "rest")) return { at, raw, ...(base !== undefined ? { base } : {}) };
  const path = normalizePath(tail.map((p) => (p.k === "str" ? p.s : `:${restName}*`)).join(""));
  return { at, raw, ...(base !== undefined ? { base } : {}), path };
}

/** Where a Next.js catch-all API route forwards, or undefined when it is no catch-all or forwards nothing
 * codeloom can see (`[...nextauth]` handing everything to a library). Several different forwards: one with no
 * base (a question, never a pick). */
export function proxyForward(route: Route, load: FileLoader, resolve: ImportResolver): RouteForward | undefined {
  const splat = route.framework === "next-api" ? SPLAT_RE.exec(route.path) : null;
  if (!splat) return undefined;
  const restName = splat[1]!;
  const ev = new Evaluator(load, resolve);
  const scope = ev.moduleScope(route.handlerFile ?? route.at.file, 0);
  if (!scope) return undefined;
  const handler = route.handler === "default" ? ev.exportValue(scope, "default", 0) : ev.lookup(route.handler, scope);
  if (handler?.k !== "fn") return undefined;
  const rest = objOf({ [restName]: REST });
  const pagesRouter = route.handler === "default";
  const args = pagesRouter ? [objOf({ query: rest }), UNKNOWN] : [UNKNOWN, objOf({ params: rest })];
  const found = ev.forwards(handler, args.map(known), 0);
  if (found.length === 0) return undefined;
  const all = found.map((f) => render(f, restName));
  const distinct = new Map(all.map((f) => [JSON.stringify({ raw: f.raw, base: f.base, path: f.path }), f]));
  if (distinct.size === 1) return all[0];
  return { at: all[0]!.at, raw: all[0]!.raw };
}

/** Every catch-all route of a repo with where it forwards (others unchanged). */
export function withForwards(routes: Route[], load: FileLoader, resolve: ImportResolver): Route[] {
  return routes.map((r) => {
    const forwards = proxyForward(r, load, resolve);
    return forwards ? { ...r, forwards } : r;
  });
}
