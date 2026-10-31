import ts from "typescript";
import type { HttpCall, HttpClient, HttpMethod } from "../store/schemas.js";
import { enclosingSymbol, isRouterName, lastName, lineOf, normalizePath, pathPattern, prop, stringValue, walk } from "./ast.js";
import type { ParsedFile } from "./types.js";

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
const FETCH_FNS = new Set(["fetch", "$fetch", "ofetch", "useFetch"]);
const CLIENT_RE = /^(axios|ky|got|superagent)$|(api|client|http|request|instance|fetcher)$/i;
/** Bindings known to be HTTP client libraries; a bare `<lib>.create(...)` is always a real client. */
const KNOWN_HTTP_LIBS = new Set(["axios", "ky", "got", "ofetch", "redaxios", "wretch", "$fetch"]);
/** Package names of known HTTP client libraries, for resolving aliased imports/requires to their real library. */
const KNOWN_HTTP_LIB_PACKAGES = new Set(["axios", "ky", "got", "ofetch", "redaxios", "wretch"]);

function methodOf(value: string | undefined): HttpMethod | undefined {
  return value ? METHODS[value.toLowerCase()] : undefined;
}

function isClientReceiver(receiver: string, node: ts.Node): boolean {
  return !!receiver && receiver !== "this" && CLIENT_RE.test(receiver) && !isRouterName(node, receiver);
}

/** Concatenated literal text of a URL expression: string/template literal pieces and both sides of `+`, ignoring variables. */
function literalText(expr: ts.Expression): string {
  if (ts.isParenthesizedExpression(expr)) return literalText(expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    return expr.head.text + expr.templateSpans.map((s) => s.literal.text).join("");
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalText(expr.left) + literalText(expr.right);
  }
  return "";
}

/** A URL "looks like a URL" when its literal text has a path separator or an http(s) scheme. */
function looksLikeUrl(text: string): boolean {
  return /^\s*(https?:\/\/|\/)/.test(text) || text.includes("/");
}

export function detectHttpCalls(file: ParsedFile): HttpCall[] {
  if (!file.sf) return [];
  const out: HttpCall[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const [first, second] = node.arguments;
    let method: HttpMethod | undefined;
    let urlExpr: ts.Expression | undefined;
    let client = "";

    if (ts.isIdentifier(callee) && FETCH_FNS.has(callee.text) && first) {
      const init = second && ts.isObjectLiteralExpression(second) ? second : undefined;
      method = (init && methodOf(stringValue(prop(init, "method")))) ?? "GET";
      urlExpr = first;
      client = callee.text;
    } else if (ts.isIdentifier(callee) && callee.text === "axios" && first && ts.isObjectLiteralExpression(first)) {
      urlExpr = prop(first, "url");
      method = methodOf(stringValue(prop(first, "method"))) ?? "GET";
      client = "axios";
    } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "request" && first && ts.isObjectLiteralExpression(first)) {
      const receiver = lastName(callee.expression);
      if (isClientReceiver(receiver, node)) {
        urlExpr = prop(first, "url");
        method = methodOf(stringValue(prop(first, "method"))) ?? "GET";
        client = receiver;
      }
    } else if (ts.isPropertyAccessExpression(callee) && METHODS[callee.name.text] && first) {
      const receiver = lastName(callee.expression);
      if (isClientReceiver(receiver, node) && pathPattern(first) && looksLikeUrl(literalText(first))) {
        method = METHODS[callee.name.text];
        urlExpr = first;
        client = receiver;
      }
    }
    if (!method || !urlExpr) return;
    const pattern = pathPattern(urlExpr);
    out.push({
      method,
      path: pattern?.path ?? "",
      raw: urlExpr.getText(),
      resolved: pattern?.resolved ?? false,
      client,
      at: { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) },
      kind: pattern?.kind ?? "unknown",
      ...(pattern?.base !== undefined ? { base: pattern.base } : {}),
    });
  });
  return out;
}

/** "axios"/"create" -> "axios"; "ky"/"create"|"extend" -> "ky"; any other receiver's "create" -> its own name. */
function clientFactory(receiver: string, method: string): string | undefined {
  if (receiver === "axios" && method === "create") return "axios";
  if (receiver === "ky" && (method === "create" || method === "extend")) return "ky";
  if (method === "create") return receiver;
  return undefined;
}

/** The call's base-URL option, shared by the factory gate and the base capture: baseURL, else baseUrl, else prefixUrl. */
function baseOption(obj: ts.ObjectLiteralExpression | undefined): ts.Expression | undefined {
  return obj && (prop(obj, "baseURL") ?? prop(obj, "baseUrl") ?? prop(obj, "prefixUrl"));
}

/** True when the factory call's first-argument object literal has a baseURL/baseUrl/prefixUrl property. */
function hasBaseOption(obj: ts.ObjectLiteralExpression | undefined): boolean {
  return !!baseOption(obj);
}

/**
 * Local identifier -> real package name, for bindings of known HTTP libraries that aren't referenced by
 * their literal name: default imports (`import Axios from "axios"`), namespace imports
 * (`import * as Axios from "axios"`), and `const x = require("<lib>")`. Named imports (even aliased, e.g.
 * `import { create as makeKy } from "ky"`) are out of scope: the binding isn't the library itself.
 */
function collectKnownLibAliases(sf: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const lib = stmt.moduleSpecifier.text;
      if (!KNOWN_HTTP_LIB_PACKAGES.has(lib)) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) aliases.set(clause.name.text, lib);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        aliases.set(clause.namedBindings.name.text, lib);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          init.arguments[0] &&
          ts.isStringLiteral(init.arguments[0])
        ) {
          const lib = init.arguments[0].text;
          if (KNOWN_HTTP_LIB_PACKAGES.has(lib)) aliases.set(decl.name.text, lib);
        }
      }
    }
  }
  return aliases;
}

/** Resolves a `.create(...)`/`.extend(...)` receiver to its own name plus, when it's a known library (by literal
 * name, by an aliased import/require, or via `<knownLib>.default` CJS interop), that library's real package name. */
function resolveClientReceiver(
  expr: ts.Expression,
  aliases: Map<string, string>,
): { name: string; knownLib?: string } | undefined {
  if (ts.isIdentifier(expr)) {
    return { name: expr.text, knownLib: KNOWN_HTTP_LIBS.has(expr.text) ? expr.text : aliases.get(expr.text) };
  }
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "default" && ts.isIdentifier(expr.expression)) {
    const base = expr.expression.text;
    const knownLib = KNOWN_HTTP_LIBS.has(base) ? base : aliases.get(base);
    return knownLib ? { name: base, knownLib } : undefined;
  }
  return undefined;
}

const ABSOLUTE_HOST_RE = /^\s*[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i;

export function detectHttpClients(file: ParsedFile): HttpClient[] {
  if (!file.sf) return [];
  const aliases = collectKnownLibAliases(file.sf);
  const out: HttpClient[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const receiver = resolveClientReceiver(node.expression.expression, aliases);
    if (!receiver) return;
    const factory = clientFactory(receiver.knownLib ?? receiver.name, node.expression.name.text);
    if (!factory) return;
    const decl = node.parent;
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return;
    const [opts] = node.arguments;
    const obj = opts && ts.isObjectLiteralExpression(opts) ? opts : undefined;
    if (!receiver.knownLib && !hasBaseOption(obj)) return;
    const baseNode = baseOption(obj);
    const literal = baseNode && stringValue(baseNode);
    out.push({
      name: decl.name.text,
      file: file.rel,
      line: lineOf(node),
      factory,
      ...(baseNode && literal === undefined ? { baseExpr: baseNode.getText() } : {}),
      ...(literal !== undefined ? { baseLiteral: normalizePath(literal) } : {}),
      ...(literal !== undefined && ABSOLUTE_HOST_RE.test(literal) ? { baseHost: literal.match(ABSOLUTE_HOST_RE)![1]!.toLowerCase() } : {}),
    });
  });
  return out;
}
