import ts from "typescript";
import type { HttpCall, HttpMethod } from "../store/schemas.js";
import { enclosingSymbol, isRouterName, lastName, lineOf, pathPattern, prop, stringValue, walk } from "./ast.js";
import type { ParsedFile } from "./types.js";

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
const FETCH_FNS = new Set(["fetch", "$fetch", "ofetch", "useFetch"]);
const CLIENT_RE = /^(axios|ky|got|superagent)$|(api|client|http|request|instance|fetcher)$/i;

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
      path: pattern?.path ?? urlExpr.getText(),
      raw: urlExpr.getText(),
      resolved: pattern?.resolved ?? false,
      client,
      at: { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) },
      // Interim Task 1 value: a real literal/template/unknown distinction and `base` extraction land in
      // Task 2, which rewrites this function and `pathPattern`'s return type together.
      kind: pattern ? "literal" : "unknown",
    });
  });
  return out;
}
