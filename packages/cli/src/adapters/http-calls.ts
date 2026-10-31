import ts from "typescript";
import type { HttpCall, HttpClient, HttpMethod } from "../store/schemas.js";
import { enclosingSymbol, isRouterName, lastName, lineOf, normalizePath, pathPattern, prop, stringValue, walk } from "./ast.js";
import type { ParsedFile } from "./types.js";

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
const FETCH_FNS = new Set(["fetch", "$fetch", "ofetch", "useFetch"]);
const CLIENT_RE = /^(axios|ky|got|superagent)$|(api|client|http|request|instance|fetcher)$/i;
/** Bindings known to be HTTP client libraries; a bare `<lib>.create(...)` is always a real client. */
const KNOWN_HTTP_LIBS = new Set(["axios", "ky", "got", "ofetch", "redaxios", "wretch", "$fetch"]);

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

/** True when the factory call's first-argument object literal has a baseURL/baseUrl/prefixUrl property. */
function hasBaseOption(obj: ts.ObjectLiteralExpression | undefined): boolean {
  return !!obj && !!(prop(obj, "baseURL") ?? prop(obj, "baseUrl") ?? prop(obj, "prefixUrl"));
}

export function detectHttpClients(file: ParsedFile): HttpClient[] {
  if (!file.sf) return [];
  const out: HttpClient[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const receiver = node.expression.expression;
    if (!ts.isIdentifier(receiver)) return;
    const factory = clientFactory(receiver.text, node.expression.name.text);
    if (!factory) return;
    const decl = node.parent;
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return;
    const [opts] = node.arguments;
    const obj = opts && ts.isObjectLiteralExpression(opts) ? opts : undefined;
    if (!KNOWN_HTTP_LIBS.has(receiver.text) && !hasBaseOption(obj)) return;
    const baseNode = obj && (prop(obj, "baseURL") ?? prop(obj, "prefixUrl"));
    const literal = baseNode && stringValue(baseNode);
    out.push({
      name: decl.name.text,
      file: file.rel,
      line: lineOf(node),
      factory,
      ...(baseNode && literal === undefined ? { baseExpr: baseNode.getText() } : {}),
      ...(literal !== undefined ? { baseLiteral: normalizePath(literal) } : {}),
    });
  });
  return out;
}
