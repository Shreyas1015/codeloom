import ts from "typescript";
import type { HttpMethod, Route } from "../store/schemas.js";
import { enclosingSymbol, fileRoute, lineOf, normalizePath, pascal, pathPattern, prop, stringValue, walk } from "./ast.js";
import { type AdapterContext, packageRelative, type ParsedFile } from "./types.js";

const ROUTE_METHODS: Record<string, HttpMethod> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", del: "DELETE", any: "ANY", all: "ANY",
};
const ROUTER_NAMES = ["router", "route", "routes", "Route", "app", "server", "fastify", "r"];
const ROUTER_FACTORIES = /^(express|express\.Router|Router|fastify|Fastify)$/;
const BACKEND_DEPS = ["@adonisjs/core", "express", "fastify", "@nestjs/core", "next"];
type Framework = Route["framework"];

function isBackendModule(spec: string): boolean {
  return (
    spec === "express" ||
    spec === "fastify" ||
    spec === "koa" ||
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

function handlerOf(h: ts.Expression | undefined, label: string): { handler: string; inline: boolean } {
  if (!h || ts.isArrowFunction(h) || ts.isFunctionExpression(h)) return { handler: label, inline: true };
  if (ts.isArrayLiteralExpression(h)) {
    const [cls, method] = h.elements;
    const name = cls ? (ts.isIdentifier(cls) ? cls.text : cls.getText()) : "<unknown>";
    return { handler: `${name}.${stringValue(method) ?? "handle"}`, inline: false };
  }
  const s = stringValue(h);
  if (s !== undefined) return { handler: adonisStringHandler(s), inline: false };
  if (ts.isCallExpression(h)) return handlerOf(h.arguments[h.arguments.length - 1], label);
  return { handler: h.getText(), inline: false };
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

function routerCall(node: ts.CallExpression, routers: Set<string>, file: ParsedFile, framework: Framework): Route | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const name = node.expression.name.text;
  const recv = node.expression.expression;
  const at = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };

  if (name === "route" && ts.isIdentifier(recv) && routers.has(recv.text) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const o = node.arguments[0];
    const m = stringValue(prop(o, "method"));
    const url = prop(o, "url") ?? prop(o, "path");
    const p = url && pathPattern(url);
    if (!m || !p) return undefined;
    const method = ROUTE_METHODS[m.toLowerCase()] ?? "ANY";
    return { method, path: p.path, ...handlerOf(prop(o, "handler"), `${method} ${p.path}`), framework: "fastify", at };
  }

  const method = ROUTE_METHODS[name];
  if (!method) return undefined;
  let path: string | undefined;
  if (ts.isIdentifier(recv) && routers.has(recv.text)) {
    if (node.arguments.length < 2) return undefined;
    path = pathPattern(node.arguments[0]!)?.path;
  } else if (
    ts.isCallExpression(recv) &&
    ts.isPropertyAccessExpression(recv.expression) &&
    recv.expression.name.text === "route" &&
    ts.isIdentifier(recv.expression.expression) &&
    routers.has(recv.expression.expression.text)
  ) {
    const s = stringValue(recv.arguments[0]);
    path = s === undefined ? undefined : normalizePath(s);
  } else return undefined;
  if (path === undefined) return undefined;
  const full = normalizePath(`${groupPrefix(node)}/${path}`);
  return {
    method,
    path: full,
    ...handlerOf(node.arguments[node.arguments.length - 1], `${method} ${full}`),
    framework,
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
          out.push({ method: n as HttpMethod, path, handler: n, inline: false, framework: "next-api", at: { file: file.rel, line: lineOf(st), symbol: n } });
        }
      }
    }
    return out;
  }
  const pages = inPkg.match(/^(?:src\/)?pages\/api\/(.+)\.(?:ts|js)$/);
  if (pages) {
    const segs = pages[1]!.split("/");
    if (segs[segs.length - 1] === "index") segs.pop();
    return [{ method: "ANY", path: fileRoute(["api", ...segs]), handler: "default", inline: false, framework: "next-api", at: { file: file.rel, line: 1, symbol: "default" } }];
  }
  return undefined;
}

export function detectRoutes(file: ParsedFile, ctx: AdapterContext): Route[] {
  if (!BACKEND_DEPS.some((d) => ctx.deps.has(d))) return [];
  if (ctx.deps.has("next")) {
    const next = nextApiRoutes(file, ctx);
    if (next) return next;
  }
  if (!file.sf) return [];
  const routers = new Set<string>(hasBackendImport(file.sf) ? ROUTER_NAMES : []);
  walk(file.sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ROUTER_FACTORIES.test(n.initializer.expression.getText())) {
      routers.add(n.name.text);
    }
  });
  const framework = frameworkOf(ctx);
  const out: Route[] = [];
  walk(file.sf, (node) => {
    if (ts.isCallExpression(node)) {
      const route = routerCall(node, routers, file, framework);
      if (route) out.push(route);
    }
    if (ts.isClassDeclaration(node) && ctx.deps.has("@nestjs/core")) out.push(...nestRoutes(node, file));
  });
  return out;
}
