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

function jsxRoutePath(node: ts.JsxOpeningLikeElement): string | undefined {
  if (node.tagName.getText() !== "Route") return undefined;
  for (const attr of node.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === "path" && attr.initializer && ts.isStringLiteral(attr.initializer)) {
      return attr.initializer.text;
    }
  }
  return undefined;
}

function objectRoutePath(node: ts.ObjectLiteralExpression): string | undefined {
  let path: string | undefined;
  let isRoute = false;
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const key = p.name.getText();
    if (key === "path" && ts.isPropertyAssignment(p)) path = stringValue(p.initializer);
    if (["element", "Component", "lazy", "children"].includes(key)) isRoute = true;
  }
  return isRoute ? path : undefined;
}

function joinRoute(parent: string, child: string): string {
  return child.startsWith("/") ? child : `${parent.replace(/\/$/, "")}/${child}`;
}

function reactRouterPages(file: ParsedFile): UiPage[] {
  const out: UiPage[] = [];
  walk(file.sf!, (node) => {
    let own: string | undefined;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) own = jsxRoutePath(node);
    else if (ts.isObjectLiteralExpression(node)) own = objectRoutePath(node);
    if (own === undefined) return;
    let full = own;
    let cur: ts.Node | undefined = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent;
    while (cur) {
      let ancestor: string | undefined;
      if (ts.isJsxElement(cur)) ancestor = jsxRoutePath(cur.openingElement);
      else if (ts.isObjectLiteralExpression(cur)) ancestor = objectRoutePath(cur);
      if (ancestor !== undefined) full = joinRoute(ancestor, full);
      cur = cur.parent;
    }
    out.push({ route: normalizePath(full), file: file.rel, line: lineOf(node), framework: "react-router" });
  });
  return out;
}
