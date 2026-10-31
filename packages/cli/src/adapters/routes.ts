import ts from "typescript";
import type { HttpMethod, Route } from "../store/schemas.js";
import { enclosingSymbol, fileRoute, isRouterName, lineOf, normalizePath, pascal, pathPattern, prop, stringValue, walk } from "./ast.js";
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
    return [{ method: "ANY", path: fileRoute(["api", ...segs]), handler: "default", inline: false, framework: "next-api", at: { file: file.rel, line: 1, symbol: "default" }, handlerFile: file.rel }];
  }
  return undefined;
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

export function detectMounts(file: ParsedFile, ctx: AdapterContext): MountDraft[] {
  if (!BACKEND_DEPS.some((d) => ctx.deps.has(d))) return [];
  if (!file.sf) return [];
  const generic = new Set<string>(hasBackendImport(file.sf) ? ROUTER_NAMES : []);
  const isRouter: IsRouter = (node, name) => generic.has(name) || isRouterName(node, name);
  const out: MountDraft[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    const recv = node.expression.expression;
    const at = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };

    if (method === "use" && ts.isIdentifier(recv) && isRouter(node, recv.text) && node.arguments.length >= 2) {
      const prefix = stringValue(node.arguments[0]);
      if (prefix === undefined) return;
      const targetArg = node.arguments[node.arguments.length - 1]!;
      if (!ts.isIdentifier(targetArg)) return;
      const loc = locateName(file.sf!, targetArg.text);
      out.push({
        prefix: normalizePath(prefix), kind: "express-use", on: recv.text, target: { name: targetArg.text },
        ...(loc.handlerImport ? { targetImport: loc.handlerImport } : {}),
        at,
      });
      return;
    }

    if (method === "register" && ts.isIdentifier(recv) && isRouter(node, recv.text) && node.arguments.length >= 2) {
      const [pluginArg, optsArg] = node.arguments;
      if (!pluginArg || !ts.isIdentifier(pluginArg)) return;
      const opts = optsArg && ts.isObjectLiteralExpression(optsArg) ? optsArg : undefined;
      const prefix = opts && stringValue(prop(opts, "prefix"));
      if (prefix === undefined) return;
      const loc = locateName(file.sf!, pluginArg.text);
      out.push({
        prefix: normalizePath(prefix), kind: "fastify-register", on: recv.text, target: { name: pluginArg.text },
        ...(loc.handlerImport ? { targetImport: loc.handlerImport } : {}),
        at,
      });
      return;
    }

    if (method === "setGlobalPrefix" && ctx.deps.has("@nestjs/core")) {
      const prefix = stringValue(node.arguments[0]);
      if (prefix === undefined) return;
      out.push({ prefix: normalizePath(prefix), kind: "nest-global", on: "", target: {}, at });
    }
  });
  return out;
}
