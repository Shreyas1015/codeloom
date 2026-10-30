import ts from "typescript";
import type { HttpCall, HttpMethod } from "../store/schemas.js";
import { enclosingSymbol, lastName, lineOf, pathPattern, prop, stringValue, walk } from "./ast.js";
import type { ParsedFile } from "./types.js";

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
const FETCH_FNS = new Set(["fetch", "$fetch", "ofetch", "useFetch"]);
const CLIENT_RE = /^(axios|ky|got|superagent)$|(api|client|http|request|instance|fetcher)$/i;
/** Identifiers initialized with one of these are routers/servers, not HTTP clients. */
const ROUTER_INIT_RE = /^(express|express\.Router|Router|fastify|Fastify)$/;

function methodOf(value: string | undefined): HttpMethod | undefined {
  return value ? METHODS[value.toLowerCase()] : undefined;
}

/** Variables in this file created as `const x = express.Router()` / `express()` / `fastify()`, etc. */
function routerNamesIn(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ROUTER_INIT_RE.test(node.initializer.expression.getText())
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function isClientReceiver(receiver: string, routerNames: Set<string>): boolean {
  return !!receiver && receiver !== "this" && CLIENT_RE.test(receiver) && !routerNames.has(receiver);
}

/** The first literal text in a URL expression (string, template head, or `a + b`), ignoring pure variables. */
function firstLiteralText(expr: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(expr)) return firstLiteralText(expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) return expr.head.text;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return firstLiteralText(expr.left) ?? firstLiteralText(expr.right);
  }
  return undefined;
}

function looksLikeUrl(text: string): boolean {
  return text.startsWith("/") || text.startsWith("http://") || text.startsWith("https://");
}

export function detectHttpCalls(file: ParsedFile): HttpCall[] {
  if (!file.sf) return [];
  const out: HttpCall[] = [];
  const routerNames = routerNamesIn(file.sf);
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
      if (isClientReceiver(receiver, routerNames)) {
        urlExpr = prop(first, "url");
        method = methodOf(stringValue(prop(first, "method"))) ?? "GET";
        client = receiver;
      }
    } else if (ts.isPropertyAccessExpression(callee) && METHODS[callee.name.text] && first) {
      const receiver = lastName(callee.expression);
      const literal = firstLiteralText(first);
      if (isClientReceiver(receiver, routerNames) && literal !== undefined && looksLikeUrl(literal)) {
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
    });
  });
  return out;
}
