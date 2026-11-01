import ts from "typescript";
import type { HttpCall, HttpClient, HttpMethod } from "../store/schemas.js";
import { absoluteHost, enclosingSymbol, isRouterName, lastName, lineOf, normalizePath, pathPattern, prop, stringValue, walk } from "./ast.js";
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

/** Module names that are superagent (or a promise wrapper around it), e.g. "superagent", "superagent-promise". */
const SUPERAGENT_MODULE_RE = /^superagent(?:$|[-/])/;
/** Receiver names that mean superagent once the file imports it (`superagent.del(...)`, `agent.get(...)`). */
const SUPERAGENT_RECEIVERS = new Set(["superagent", "agent", "request"]);
/** superagent's own method names: its DELETE is `del` (`delete` is an alias). */
const SUPERAGENT_METHODS: Record<string, HttpMethod> = { ...METHODS, del: "DELETE" };

/**
 * Receivers that are superagent in this file: only when the file imports or requires a superagent module
 * (dependency gate), then the import's own local names plus the conventional names above.
 */
export function superagentReceivers(sf: ts.SourceFile): Set<string> {
  const locals = new Set<string>();
  let imported = false;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && SUPERAGENT_MODULE_RE.test(stmt.moduleSpecifier.text)) {
      imported = true;
      const clause = stmt.importClause;
      if (clause?.name) locals.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) locals.add(clause.namedBindings.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" &&
          init.arguments[0] && ts.isStringLiteral(init.arguments[0]) && SUPERAGENT_MODULE_RE.test(init.arguments[0].text)
        ) {
          imported = true;
          if (ts.isIdentifier(decl.name)) locals.add(decl.name.text);
        }
      }
    }
  }
  if (!imported) return new Set();
  for (const n of SUPERAGENT_RECEIVERS) locals.add(n);
  return locals;
}

/** What an HTTP call looks like before any URL filtering: its method (undefined when the call passes a
 * non-literal method, e.g. `fetch(u, { method: m })`), URL expression and client name. */
export interface HttpCallShape {
  method: HttpMethod | undefined;
  urlExpr: ts.Expression;
  client: string;
  /** Method-style call (`client.get(url)`): the adapter only keeps these when the URL looks like one. */
  methodStyle: boolean;
}

/** Method from a config object's `method` property: its literal value, `fallback` when absent, undefined
 * when present but not a literal (a variable method). */
function configMethod(obj: ts.ObjectLiteralExpression | undefined, fallback: HttpMethod): HttpMethod | undefined {
  const m = obj && prop(obj, "method");
  if (!m) return fallback;
  const v = stringValue(m);
  return v === undefined ? undefined : methodOf(v) ?? fallback;
}

/** Recognise an HTTP client call (fetch, axios(config), client.request(config), client.get(url), superagent). */
export function httpCallShape(node: ts.CallExpression, superagent: Set<string>): HttpCallShape | undefined {
  const callee = node.expression;
  const [first, second] = node.arguments;
  if (!first) return undefined;
  if (ts.isIdentifier(callee) && FETCH_FNS.has(callee.text)) {
    const init = second && ts.isObjectLiteralExpression(second) ? second : undefined;
    return { method: configMethod(init, "GET"), urlExpr: first, client: callee.text, methodStyle: false };
  }
  if (ts.isIdentifier(callee) && callee.text === "axios" && ts.isObjectLiteralExpression(first)) {
    const url = prop(first, "url");
    return url ? { method: configMethod(first, "GET"), urlExpr: url, client: "axios", methodStyle: false } : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const receiver = lastName(callee.expression);
  const name = callee.name.text;
  if (name === "request" && ts.isObjectLiteralExpression(first)) {
    if (!isClientReceiver(receiver, node)) return undefined;
    const url = prop(first, "url");
    return url ? { method: configMethod(first, "GET"), urlExpr: url, client: receiver, methodStyle: false } : undefined;
  }
  const isSuperagent = ts.isIdentifier(callee.expression) && superagent.has(receiver) && !isRouterName(node, receiver);
  const method = isSuperagent ? SUPERAGENT_METHODS[name] : METHODS[name];
  if (!method) return undefined;
  if (!isSuperagent && !isClientReceiver(receiver, node)) return undefined;
  return { method, urlExpr: first, client: receiver, methodStyle: true };
}

export function detectHttpCalls(file: ParsedFile): HttpCall[] {
  if (!file.sf) return [];
  const superagent = superagentReceivers(file.sf);
  const out: HttpCall[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const shape = httpCallShape(node, superagent);
    if (!shape) return;
    const { urlExpr } = shape;
    if (shape.methodStyle && !(pathPattern(urlExpr) && looksLikeUrl(literalText(urlExpr)))) return;
    // A variable method keeps the adapter's historical default (GET); wrapper inference treats it apart.
    const method = shape.method ?? "GET";
    const pattern = pathPattern(urlExpr);
    out.push({
      method,
      path: pattern?.path ?? "",
      raw: urlExpr.getText(),
      resolved: pattern?.resolved ?? false,
      client: shape.client,
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
    const baseHost = literal !== undefined ? absoluteHost(literal) : undefined;
    out.push({
      name: decl.name.text,
      file: file.rel,
      line: lineOf(node),
      factory,
      ...(baseNode && literal === undefined ? { baseExpr: baseNode.getText() } : {}),
      ...(literal !== undefined ? { baseLiteral: normalizePath(literal) } : {}),
      ...(baseHost !== undefined ? { baseHost } : {}),
    });
  });
  return out;
}
