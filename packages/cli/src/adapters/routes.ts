import ts from "typescript";
import type { HttpMethod, Route } from "../store/schemas.js";
import type { RouterDef } from "../store/schemas.js";
import { compare } from "../util.js";
import {
  APP_FACTORY_RE, enclosingSymbol, fileRoute, isRouterName, lineOf, normalizePath, pascal, pathPattern, prop, routerFactoryRoot,
  stringValue, unwrapRouterChain, walk,
} from "./ast.js";
import { type AdapterContext, packageRelative, type MountDraft, type ParsedFile, type RouteDraft } from "./types.js";

const ROUTE_METHODS: Record<string, HttpMethod> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", del: "DELETE", any: "ANY", all: "ANY",
};
const ROUTER_NAMES = ["router", "route", "routes", "Route", "app", "server", "fastify", "r"];
const BACKEND_DEPS = ["@adonisjs/core", "express", "fastify", "@nestjs/core", "next"];
type Framework = Route["framework"];

function isBackendModule(spec: string): boolean {
  return (
    spec === "express" ||
    spec === "fastify" ||
    spec.startsWith("@adonisjs/") ||
    spec.startsWith("@ioc:Adonis/") ||
    spec.startsWith("@nestjs/")
  );
}

/** True when the file itself imports/requires a backend framework module, proving ROUTER_NAMES's
 * generic names (e.g. "router", "app") refer to a real router here rather than an unrelated object. */
function hasBackendImport(sf: ts.SourceFile): boolean {
  let found = false;
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (isBackendModule(n.moduleSpecifier.text)) found = true;
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      if (isBackendModule(n.moduleReference.expression.text)) found = true;
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "require" &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      if (isBackendModule(n.arguments[0].text)) found = true;
    }
  });
  return found;
}

export function adonisStringHandler(s: string): string {
  const last = s.split("/").pop()!;
  const dot = last.lastIndexOf(".");
  const file = dot >= 0 ? last.slice(0, dot) : last;
  const method = dot >= 0 ? last.slice(dot + 1) : "handle";
  const cls = /_/.test(file) || /^[a-z]/.test(file) ? pascal(file) : file;
  return `${cls}.${method}`;
}

function frameworkOf(ctx: AdapterContext): Framework {
  if (ctx.deps.has("@adonisjs/core")) return "adonis";
  if (ctx.deps.has("fastify")) return "fastify";
  return "express";
}

type HandlerInfo = Pick<RouteDraft, "handler" | "inline" | "handlerFile" | "handlerLines" | "handlerImport">;
type HandlerLoc = Pick<RouteDraft, "handlerFile" | "handlerImport">;

function linesOf(node: ts.Node): [number, number] {
  const sf = node.getSourceFile();
  return [lineOf(node), sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1];
}

/** `() => import("x")` (Adonis lazy controller) → "x". */
function lazyImportSpec(expr: ts.Expression): string | undefined {
  if (!ts.isArrowFunction(expr) && !ts.isFunctionExpression(expr)) return undefined;
  let body: ts.Node = expr.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword) return stringValue(body.arguments[0]);
  return undefined;
}

/** Where the top-level binding `name` comes from: an import specifier, or this file. */
function locateName(sf: ts.SourceFile, name: string): HandlerLoc {
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      const b = c?.namedBindings;
      const named = b && ts.isNamedImports(b) && b.elements.some((el) => el.name.text === name);
      const ns = b && ts.isNamespaceImport(b) && b.name.text === name;
      if (c?.name?.text === name || named || ns) return { handlerImport: st.moduleSpecifier.text };
    }
    if (ts.isImportEqualsDeclaration(st) && st.name.text === name && ts.isExternalModuleReference(st.moduleReference)) {
      const spec = stringValue(st.moduleReference.expression);
      return spec ? { handlerImport: spec } : {};
    }
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return { handlerFile: sf.fileName };
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const lazy = lazyImportSpec(d.initializer);
        if (lazy) return { handlerImport: lazy };
        const init = d.initializer;
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require") {
          const spec = stringValue(init.arguments[0]);
          return spec ? { handlerImport: spec } : {};
        }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init)) return { handlerFile: sf.fileName };
        return {};
      }
    }
  }
  return {};
}

/** Leftmost identifier of `a.b.c` (undefined for `this.x` and other shapes). */
function rootIdentifier(expr: ts.Expression): string | undefined {
  let cur = expr;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

/** `"#controllers/users_controller.index"` → `"#controllers/users_controller"`; no path → undefined. */
function stringHandlerSpec(s: string): string | undefined {
  const slash = s.lastIndexOf("/");
  if (slash < 0) return undefined;
  const dot = s.indexOf(".", slash);
  return dot >= 0 ? s.slice(0, dot) : s;
}

function handlerOf(h: ts.Expression | undefined, label: string, sf: ts.SourceFile): HandlerInfo {
  if (!h) return { handler: label, inline: true };
  if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) {
    return { handler: label, inline: true, handlerFile: sf.fileName, handlerLines: linesOf(h) };
  }
  if (ts.isArrayLiteralExpression(h)) {
    const [cls, method] = h.elements;
    const name = cls ? (ts.isIdentifier(cls) ? cls.text : cls.getText()) : "<unknown>";
    const loc = cls && ts.isIdentifier(cls) ? locateName(sf, cls.text) : {};
    return { handler: `${name}.${stringValue(method) ?? "handle"}`, inline: false, ...loc };
  }
  const s = stringValue(h);
  if (s !== undefined) {
    const spec = stringHandlerSpec(s);
    return { handler: adonisStringHandler(s), inline: false, ...(spec ? { handlerImport: spec } : {}) };
  }
  if (ts.isCallExpression(h)) return handlerOf(h.arguments[h.arguments.length - 1], label, sf);
  const root = rootIdentifier(h);
  return { handler: h.getText(), inline: false, ...(root ? locateName(sf, root) : {}) };
}

function groupPrefix(node: ts.Node): string {
  const prefixes: string[] = [];
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isCallExpression(cur.parent) &&
      ts.isPropertyAccessExpression(cur.parent.expression) &&
      cur.parent.expression.name.text === "group"
    ) {
      let chain: ts.Node = cur.parent;
      while (ts.isPropertyAccessExpression(chain.parent) && ts.isCallExpression(chain.parent.parent)) {
        const call = chain.parent.parent;
        if (chain.parent.name.text === "prefix") {
          const s = stringValue(call.arguments[0]);
          if (s) prefixes.unshift(s);
        }
        chain = call;
      }
    }
    cur = cur.parent;
  }
  return prefixes.join("/");
}

/** Is `name` a router where it is used at `node`? Either its nearest declaration is a router-factory
 * call (scope-aware), or it is a generic router name in a file that imports a backend framework. */
type IsRouter = (node: ts.Node, name: string) => boolean;

/** The outermost call of the method chain `expr` sits in: from `Router()` in `Router().use(a).use(b)`,
 * climbs to the whole expression. */
function chainTop(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  for (;;) {
    let up: ts.Node = cur.parent;
    while (ts.isParenthesizedExpression(up)) up = up.parent;
    if (ts.isPropertyAccessExpression(up) && ts.isCallExpression(up.parent) && up.parent.expression === up) cur = up.parent;
    else return cur;
  }
}

/** `module.exports = <expr>` -> "default"; `exports.x = <expr>` / `module.exports.x = <expr>` -> "x". */
function commonJsExportName(target: ts.Expression): string | undefined {
  const text = target.getText();
  if (text === "module.exports") return "default";
  if (ts.isPropertyAccessExpression(target)) {
    const base = target.expression.getText();
    if (base === "exports" || base === "module.exports") return target.name.text;
  }
  return undefined;
}

/** Name of the router a factory-rooted chain creates: the variable it is assigned to, or "default" when
 * it is the default export (`export default Router()...` / `module.exports = Router()...`). */
function chainBindingName(top: ts.Expression): string | undefined {
  let n: ts.Node = top;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isExportAssignment(p) && p.expression === n) return "default";
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n && commonJsExportName(p.left) === "default") {
    return "default";
  }
  return undefined;
}

/** The router a call receiver denotes: a router identifier (`router`), or a self-returning chain on one
 * (`router.use(a)`, `Router().use(a)` -> the variable/default export the chain is bound to). */
function receiverRouter(recv: ts.Expression, isRouter: IsRouter): string | undefined {
  const root = unwrapRouterChain(recv);
  if (ts.isIdentifier(root)) return isRouter(root, root.text) ? root.text : undefined;
  if (routerFactoryRoot(root)) return chainBindingName(chainTop(recv));
  return undefined;
}

/** Where top-level binding `name` is imported from, and under which exported name ("default" for a default
 * import, `import x = require()` or `const x = require()`; undefined export for a namespace import). */
function importBinding(sf: ts.SourceFile, name: string): { spec: string; export?: string } | undefined {
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      const spec = st.moduleSpecifier.text;
      if (c?.name?.text === name) return { spec, export: "default" };
      const b = c?.namedBindings;
      if (b && ts.isNamespaceImport(b) && b.name.text === name) return { spec };
      if (b && ts.isNamedImports(b)) {
        const el = b.elements.find((e) => e.name.text === name);
        if (el) return { spec, export: (el.propertyName ?? el.name).text };
      }
    }
    if (ts.isImportEqualsDeclaration(st) && st.name.text === name && ts.isExternalModuleReference(st.moduleReference)) {
      const spec = stringValue(st.moduleReference.expression);
      return spec ? { spec, export: "default" } : undefined;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const spec = requireSpec(d.initializer);
        return spec ? { spec, export: "default" } : undefined;
      }
    }
  }
  return undefined;
}

/** `require("x")` -> "x". */
function requireSpec(expr: ts.Expression): string | undefined {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "require") return stringValue(expr.arguments[0]);
  return undefined;
}

function routerCall(node: ts.CallExpression, isRouter: IsRouter, file: ParsedFile, framework: Framework): RouteDraft | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const name = node.expression.name.text;
  const recv = node.expression.expression;
  const at = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };

  if (name === "route" && ts.isIdentifier(recv) && isRouter(node, recv.text) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const o = node.arguments[0];
    const m = stringValue(prop(o, "method"));
    const url = prop(o, "url") ?? prop(o, "path");
    const p = url && pathPattern(url);
    if (!m || !p) return undefined;
    const method = ROUTE_METHODS[m.toLowerCase()] ?? "ANY";
    return {
      method, path: p.path, ...handlerOf(prop(o, "handler"), `${method} ${p.path}`, file.sf!),
      framework: "fastify", router: recv.text, at,
    };
  }

  const method = ROUTE_METHODS[name];
  if (!method) return undefined;
  let path: string | undefined;
  let router: string | undefined;
  if (ts.isIdentifier(recv) && isRouter(node, recv.text)) {
    if (node.arguments.length < 2) return undefined;
    path = pathPattern(node.arguments[0]!)?.path;
    router = recv.text;
  } else if (ts.isCallExpression(recv) && receiverRouter(recv, isRouter) !== undefined) {
    // A route on a self-returning chain: `Router().use(a).get("/x", h)` / `router.use(a).get("/x", h)`.
    if (node.arguments.length < 2) return undefined;
    path = pathPattern(node.arguments[0]!)?.path;
    router = receiverRouter(recv, isRouter);
  } else if (
    ts.isCallExpression(recv) &&
    ts.isPropertyAccessExpression(recv.expression) &&
    recv.expression.name.text === "route" &&
    ts.isIdentifier(recv.expression.expression) &&
    isRouter(node, recv.expression.expression.text)
  ) {
    const s = stringValue(recv.arguments[0]);
    path = s === undefined ? undefined : normalizePath(s);
    router = recv.expression.expression.text;
  } else return undefined;
  if (path === undefined) return undefined;
  const full = normalizePath(`${groupPrefix(node)}/${path}`);
  return {
    method,
    path: full,
    ...handlerOf(node.arguments[node.arguments.length - 1], `${method} ${full}`, file.sf!),
    framework,
    // The receiver is only a meaningful "router" for express/fastify (schema: "express/fastify");
    // Adonis's router/Route identifiers pass isRouter via the generic-name fallback too, but Adonis
    // has no app.use()-style mount step for Route.router to feed, so it stays undefined there.
    router: framework === "adonis" ? undefined : router,
    at,
  };
}

function decoratorCall(node: ts.Node, names: string[]): { name: string; arg?: ts.Expression } | undefined {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  for (const d of decorators) {
    if (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && names.includes(d.expression.expression.text)) {
      return { name: d.expression.expression.text, arg: d.expression.arguments[0] };
    }
  }
  return undefined;
}

function nestRoutes(cls: ts.ClassDeclaration, file: ParsedFile): Route[] {
  const controller = decoratorCall(cls, ["Controller"]);
  if (!controller) return [];
  let base = "";
  if (controller.arg) {
    base = stringValue(controller.arg) ?? (ts.isObjectLiteralExpression(controller.arg) ? (stringValue(prop(controller.arg, "path")) ?? "") : "");
  }
  const clsName = cls.name?.text ?? "<anonymous>";
  const out: Route[] = [];
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const d = decoratorCall(member, ["Get", "Post", "Put", "Patch", "Delete", "All"]);
    if (!d) continue;
    const method: HttpMethod = d.name === "All" ? "ANY" : (d.name.toUpperCase() as HttpMethod);
    const handler = `${clsName}.${member.name.getText()}`;
    out.push({
      method,
      path: normalizePath(`${base}/${d.arg ? (stringValue(d.arg) ?? "") : ""}`),
      handler,
      inline: false,
      framework: "nest",
      at: { file: file.rel, line: lineOf(member), symbol: handler },
      handlerFile: file.rel,
      handlerLines: linesOf(member),
    });
  }
  return out;
}

function nextApiRoutes(file: ParsedFile, ctx: AdapterContext): Route[] | undefined {
  const inPkg = packageRelative(file.rel, ctx);
  if (inPkg === undefined) return undefined;
  const app = inPkg.match(/^(?:src\/)?app\/(?:(.*)\/)?route\.(?:ts|js)$/);
  if (app && file.sf) {
    const path = fileRoute(app[1] ? app[1].split("/") : []);
    const out: Route[] = [];
    for (const st of file.sf.statements) {
      const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      const names: string[] = [];
      if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
      for (const n of names) {
        if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(n)) {
          out.push({ method: n as HttpMethod, path, handler: n, inline: false, framework: "next-api", at: { file: file.rel, line: lineOf(st), symbol: n }, handlerFile: file.rel });
        }
      }
    }
    return out;
  }
  const pages = inPkg.match(/^(?:src\/)?pages\/api\/(.+)\.(?:ts|js)$/);
  if (pages) {
    const segs = pages[1]!.split("/");
    if (segs[segs.length - 1] === "index") segs.pop();
    const path = fileRoute(["api", ...segs]);
    const methods = file.sf ? pagesApiMethods(file.sf) : [];
    const list: HttpMethod[] = methods.length ? methods : ["ANY"];
    return list.map((method) => ({
      method, path, handler: "default", inline: false, framework: "next-api",
      at: { file: file.rel, line: 1, symbol: "default" }, handlerFile: file.rel,
    }));
  }
  return undefined;
}

const PAGES_API_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isFunctionLike(n: ts.Node): n is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n)
  );
}

/** Every name a parameter list binds into its function's scope, including names introduced by
 * destructuring (`{ method }`, `{ method: m }`, `[a, b]`). */
function boundParamNames(params: readonly ts.ParameterDeclaration[]): Set<string> {
  const names = new Set<string>();
  const collect = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      collect(el.name);
    }
  };
  for (const p of params) collect(p.name);
  return names;
}

/** Like `walk`, but does not descend into a nested function/method/arrow whose own parameters
 * rebind one of `shadowNames` (e.g. the request param name, or its destructured `method` alias) —
 * such a nested scope's `req`/`method` refers to its own parameter, not the outer request. */
function walkScoped(node: ts.Node, shadowNames: ReadonlySet<string>, visit: (n: ts.Node) => void): void {
  visit(node);
  if (isFunctionLike(node) && shadowNames.size > 0) {
    const bound = boundParamNames(node.parameters);
    for (const name of bound) {
      if (shadowNames.has(name)) return;
    }
  }
  node.forEachChild((child) => walkScoped(child, shadowNames, visit));
}

/** The default-exported handler of a pages-router API file: a function declaration, or the
 * arrow/function expression that `export default` points to (directly, or via a local binding). */
function defaultExportHandler(sf: ts.SourceFile): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  const localFunction = (name: string): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined => {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (
            ts.isIdentifier(d.name) && d.name.text === name && d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          ) {
            return d.initializer;
          }
        }
      }
    }
    return undefined;
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      return st;
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const expr = st.expression;
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
      if (ts.isIdentifier(expr)) {
        const local = localFunction(expr.text);
        if (local) return local;
      }
    }
  }
  return undefined;
}

/** HTTP methods a pages-router default-export handler checks for, from `req.method === "X"` /
 * `!==` guards, `switch (req.method)` cases, and a destructured `const { method } = req` alias.
 * Sorted/deduped; empty when the handler never checks the method (caller falls back to "ANY"). */
function pagesApiMethods(sf: ts.SourceFile): HttpMethod[] {
  const fn = defaultExportHandler(sf);
  if (!fn || !fn.body) return [];
  const reqParam = fn.parameters[0];
  const reqName = reqParam && ts.isIdentifier(reqParam.name) ? reqParam.name.text : undefined;

  const aliases = new Set<string>();
  if (reqName) {
    walkScoped(fn.body, new Set([reqName]), (n) => {
      if (!ts.isVariableDeclaration(n) || !ts.isObjectBindingPattern(n.name)) return;
      if (!n.initializer || !ts.isIdentifier(n.initializer) || n.initializer.text !== reqName) return;
      for (const el of n.name.elements) {
        if (ts.isOmittedExpression(el)) continue;
        const propName = el.propertyName ?? el.name;
        if (ts.isIdentifier(propName) && propName.text === "method" && ts.isIdentifier(el.name)) aliases.add(el.name.text);
      }
    });
  }

  const isMethodRef = (expr: ts.Expression): boolean => {
    if (reqName && ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === reqName && expr.name.text === "method") {
      return true;
    }
    return ts.isIdentifier(expr) && aliases.has(expr.text);
  };

  const methods = new Set<HttpMethod>();
  const add = (s: string) => {
    const m = s.toUpperCase();
    if (PAGES_API_METHODS.has(m)) methods.add(m as HttpMethod);
  };

  const shadowNames = new Set(reqName ? [reqName, ...aliases] : aliases);
  walkScoped(fn.body, shadowNames, (n) => {
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const left = stringValue(n.left);
      const right = stringValue(n.right);
      if (left !== undefined && isMethodRef(n.right)) add(left);
      else if (right !== undefined && isMethodRef(n.left)) add(right);
    }
    if (ts.isSwitchStatement(n) && isMethodRef(n.expression)) {
      for (const clause of n.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const v = stringValue(clause.expression);
        if (v !== undefined) add(v);
      }
    }
  });

  return [...methods].sort(compare);
}

export function detectRoutes(file: ParsedFile, ctx: AdapterContext): RouteDraft[] {
  if (!BACKEND_DEPS.some((d) => ctx.deps.has(d))) return [];
  if (ctx.deps.has("next")) {
    const next = nextApiRoutes(file, ctx);
    if (next) return next;
  }
  if (!file.sf) return [];
  const generic = new Set<string>(hasBackendImport(file.sf) ? ROUTER_NAMES : []);
  const isRouter: IsRouter = (node, name) => generic.has(name) || isRouterName(node, name);
  const framework = frameworkOf(ctx);
  const out: RouteDraft[] = [];
  walk(file.sf, (node) => {
    if (ts.isCallExpression(node)) {
      const route = routerCall(node, isRouter, file, framework);
      if (route) out.push(route);
    }
    if (ts.isClassDeclaration(node) && ctx.deps.has("@nestjs/core")) out.push(...nestRoutes(node, file));
  });
  return out;
}

/** `<router>.use(prefix?, ...middleware, target)` as a mount, or undefined when it is not one. The receiver
 * is a router (factory-made, generic name in a backend file, a self-returning chain on one) or a binding
 * imported from another file (the linker checks that file really exports a router there). The prefix is
 * a string literal first argument, or "" for a single-argument `use(target)`; the target is an identifier
 * or an inline `require("x")`. */
function useMount(node: ts.CallExpression, recv: ts.Expression, isRouter: IsRouter, sf: ts.SourceFile): Omit<MountDraft, "at"> | undefined {
  const local = receiverRouter(recv, isRouter);
  const onImp = ts.isIdentifier(recv) && !isRouterName(node, recv.text) ? importBinding(sf, recv.text) : undefined;
  const on = local ?? (onImp && ts.isIdentifier(recv) ? recv.text : undefined);
  if (on === undefined) return undefined;
  let prefix: string | undefined;
  if (node.arguments.length === 1) prefix = "";
  else if (node.arguments.length >= 2) prefix = stringValue(node.arguments[0]);
  if (prefix === undefined) return undefined;
  const targetArg = node.arguments[node.arguments.length - 1]!;
  let target: MountDraft["target"];
  let targetImport: string | undefined;
  if (ts.isIdentifier(targetArg)) {
    target = { name: targetArg.text };
    const imp = importBinding(sf, targetArg.text);
    if (imp) {
      targetImport = imp.spec;
      if (imp.export !== undefined) target.export = imp.export;
    } else {
      const loc = locateName(sf, targetArg.text);
      if (loc.handlerImport) targetImport = loc.handlerImport;
    }
  } else {
    const spec = requireSpec(targetArg);
    if (spec === undefined) return undefined;
    target = { export: "default" };
    targetImport = spec;
  }
  return {
    prefix: prefix === "" ? "" : normalizePath(prefix), kind: "express-use", on, target,
    ...(targetImport ? { targetImport } : {}),
    ...(onImp ? { onImport: onImp.spec, ...(onImp.export !== undefined ? { onExport: onImp.export } : {}) } : {}),
  };
}

/** Routers this file exports, plus every app/server it creates with express()/fastify(). */
export function detectRouters(file: ParsedFile, ctx: AdapterContext): RouterDef[] {
  if (!BACKEND_DEPS.some((d) => ctx.deps.has(d))) return [];
  if (!file.sf) return [];
  const sf = file.sf;
  const generic = new Set<string>(hasBackendImport(sf) ? ROUTER_NAMES : []);
  const isRouter: IsRouter = (node, name) => generic.has(name) || isRouterName(node, name);
  const defs = new Map<string, { exports: Set<string>; app: boolean }>();
  const def = (name: string) => {
    let d = defs.get(name);
    if (!d) defs.set(name, (d = { exports: new Set(), app: false }));
    return d;
  };
  /** `expr` exported as `as`: a router identifier, or a factory-rooted chain (bound to `anonName`). */
  const exportExpr = (expr: ts.Expression, as: string, anonName: string) => {
    const root = unwrapRouterChain(expr);
    if (ts.isIdentifier(root) && root === expr) {
      if (isRouter(root, root.text)) def(root.text).exports.add(as);
    } else if (routerFactoryRoot(expr)) {
      def(anonName).exports.add(as);
    }
  };

  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const root = routerFactoryRoot(n.initializer);
      if (root && APP_FACTORY_RE.test(root.expression.getText())) def(n.name.text).app = true;
    }
    if (ts.isExportAssignment(n)) {
      const root = routerFactoryRoot(n.expression);
      if (root && APP_FACTORY_RE.test(root.expression.getText())) def("default").app = true;
    }
  });

  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isRouter(d.name, d.name.text)) def(d.name.text).exports.add(d.name.text);
      }
    } else if (ts.isExportAssignment(st)) {
      exportExpr(st.expression, "default", "default");
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (isRouter(st, local)) def(local).exports.add(el.name.text);
      }
    } else if (
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const as = commonJsExportName(st.expression.left);
      if (as !== undefined) exportExpr(st.expression.right, as, as === "default" ? "default" : as);
    }
  }

  return [...defs.entries()]
    .filter(([, d]) => d.app || d.exports.size > 0)
    .map(([name, d]): RouterDef => ({
      name, file: file.rel, exports: [...d.exports].sort(compare), ...(d.app ? { app: true } : {}), packageRoot: ctx.packageRoot,
    }))
    .sort((a, b) => compare(a.name, b.name));
}

export function detectMounts(file: ParsedFile, ctx: AdapterContext): MountDraft[] {
  if (!BACKEND_DEPS.some((d) => ctx.deps.has(d))) return [];
  if (!file.sf) return [];
  const generic = new Set<string>(hasBackendImport(file.sf) ? ROUTER_NAMES : []);
  const isRouter: IsRouter = (node, name) => generic.has(name) || isRouterName(node, name);
  // Ordered by the position of the `.use`/`.register` name, so a chain `Router().use(a).use(b)` (whose
  // outer call is walked first) lists a before b.
  const found: Array<{ pos: number; mount: MountDraft }> = [];
  const add = (node: ts.CallExpression, mount: MountDraft) =>
    found.push({ pos: ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getStart() : node.getStart(), mount });
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    const recv = node.expression.expression;
    const at = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };

    if (method === "use") {
      const mount = useMount(node, recv, isRouter, file.sf!);
      if (mount) add(node, { ...mount, at: { ...at, line: lineOf(node.expression.name) } });
      return;
    }

    if (method === "register" && ts.isIdentifier(recv) && isRouter(node, recv.text) && node.arguments.length >= 2) {
      const [pluginArg, optsArg] = node.arguments;
      if (!pluginArg || !ts.isIdentifier(pluginArg)) return;
      const opts = optsArg && ts.isObjectLiteralExpression(optsArg) ? optsArg : undefined;
      const prefix = opts && stringValue(prop(opts, "prefix"));
      if (prefix === undefined) return;
      const loc = locateName(file.sf!, pluginArg.text);
      add(node, {
        prefix: normalizePath(prefix), kind: "fastify-register", on: recv.text, target: { name: pluginArg.text },
        ...(loc.handlerImport ? { targetImport: loc.handlerImport } : {}),
        at,
      });
      return;
    }

    if (method === "setGlobalPrefix" && ctx.deps.has("@nestjs/core")) {
      const prefix = stringValue(node.arguments[0]);
      if (prefix === undefined) return;
      add(node, { prefix: normalizePath(prefix), kind: "nest-global", on: "", target: {}, at });
    }
  });
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.mount);
}
