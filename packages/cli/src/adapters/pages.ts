import ts from "typescript";
import type { UiPage } from "../store/schemas.js";
import { fileRoute, lineOf, normalizePath, stringValue, walk } from "./ast.js";
import type { AdapterContext, ParsedFile } from "./types.js";

export function detectPages(file: ParsedFile, ctx: AdapterContext): UiPage[] {
  const out: UiPage[] = [];
  if (ctx.deps.has("next")) {
    const app = file.rel.match(/(?:^|\/)app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js)$/);
    if (app) out.push({ route: fileRoute(app[1] ? app[1].split("/") : []), file: file.rel, line: 1, framework: "next-app" });
    const pages = file.rel.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js)$/);
    if (pages && !/^(api\/|_app$|_document$|_error$)/.test(pages[1]!)) {
      const segs = pages[1]!.split("/");
      if (segs[segs.length - 1] === "index") segs.pop();
      out.push({ route: fileRoute(segs), file: file.rel, line: 1, framework: "next-pages" });
    }
  }
  if ((ctx.deps.has("react-router") || ctx.deps.has("react-router-dom")) && file.sf) {
    out.push(...reactRouterPages(file));
  }
  return out;
}

/** A route's own contribution: its path segment (undefined when it has none, e.g. a layout route),
 * and whether it's an index route (a page at its parent's path, adding no segment of its own). */
interface RouteInfo {
  path?: string;
  index: boolean;
}

function jsxRouteInfo(node: ts.JsxOpeningLikeElement): RouteInfo | undefined {
  if (node.tagName.getText() !== "Route") return undefined;
  let path: string | undefined;
  let index = false;
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText();
    if (name === "path" && attr.initializer && ts.isStringLiteral(attr.initializer)) path = attr.initializer.text;
    if (name === "index") index = true;
  }
  return { path, index };
}

const ROUTER_CALLS = new Set(["createBrowserRouter", "createHashRouter", "createMemoryRouter", "createStaticRouter", "useRoutes"]);

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function childrenArray(obj: ts.ObjectLiteralExpression): ts.ArrayLiteralExpression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === "children" && ts.isArrayLiteralExpression(p.initializer)) {
      return p.initializer;
    }
  }
  return undefined;
}

/** Object literals only count as routes when they live in a real route-config array: an array passed
 * to createBrowserRouter/useRoutes/etc, an array assigned to a `*routes`/`*Routes` variable, or
 * (recursively) a `children` array nested inside one of those. This keeps menu/breadcrumb configs
 * from being misread as pages. */
function routeArrays(sf: ts.SourceFile): Set<ts.ArrayLiteralExpression> {
  const queue: ts.ArrayLiteralExpression[] = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ROUTER_CALLS.has(calleeName(node.expression) ?? "")) {
      for (const arg of node.arguments) if (ts.isArrayLiteralExpression(arg)) queue.push(arg);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer) &&
      ts.isIdentifier(node.name) &&
      /routes$/i.test(node.name.text)
    ) {
      queue.push(node.initializer);
    }
  });
  const result = new Set<ts.ArrayLiteralExpression>();
  while (queue.length) {
    const arr = queue.pop()!;
    if (result.has(arr)) continue;
    result.add(arr);
    for (const el of arr.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      const children = childrenArray(el);
      if (children) queue.push(children);
    }
  }
  return result;
}

function objectRouteInfo(node: ts.ObjectLiteralExpression, routes: Set<ts.ArrayLiteralExpression>): RouteInfo | undefined {
  if (!node.parent || !ts.isArrayLiteralExpression(node.parent) || !routes.has(node.parent)) return undefined;
  let path: string | undefined;
  let index = false;
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name.getText();
    if (key === "path") path = stringValue(p.initializer);
    if (key === "index" && p.initializer.kind === ts.SyntaxKind.TrueKeyword) index = true;
  }
  return { path, index };
}

function joinRoute(parent: string, child: string): string {
  if (child === "") return parent;
  return child.startsWith("/") ? child : `${parent.replace(/\/$/, "")}/${child}`;
}

function reactRouterPages(file: ParsedFile): UiPage[] {
  const out: UiPage[] = [];
  const routes = routeArrays(file.sf!);
  walk(file.sf!, (node) => {
    let info: RouteInfo | undefined;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) info = jsxRouteInfo(node);
    else if (ts.isObjectLiteralExpression(node)) info = objectRouteInfo(node, routes);
    if (!info || (info.path === undefined && !info.index)) return;
    let full = info.index ? "" : info.path!;
    let cur: ts.Node | undefined = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent;
    while (cur) {
      let ancestor: string | undefined;
      if (ts.isJsxElement(cur)) ancestor = jsxRouteInfo(cur.openingElement)?.path;
      else if (ts.isObjectLiteralExpression(cur)) ancestor = objectRouteInfo(cur, routes)?.path;
      if (ancestor !== undefined) full = joinRoute(ancestor, full);
      cur = cur.parent;
    }
    out.push({ route: normalizePath(full), file: file.rel, line: lineOf(node), framework: "react-router" });
  });
  return out;
}
