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

function isRouterFactoryCall(expr: ts.Expression | undefined): boolean {
  return !!expr && ts.isCallExpression(expr) && ROUTER_INIT_RE.test(expr.expression.getText());
}

/** Parameters of a function-like node, or undefined when `node` isn't one. */
function functionParams(node: ts.Node): ts.NodeArray<ts.ParameterDeclaration> | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    return node.parameters;
  }
  return undefined;
}

/** A variable declaration named `name` directly inside this block/source file's own statements (not nested functions). */
function findVarDecl(statements: ts.NodeArray<ts.Statement>, name: string): ts.VariableDeclaration | undefined {
  for (const stmt of statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
    }
  }
  return undefined;
}

/**
 * Is `name`, as referenced at `node`, a router/server rather than an HTTP client? Walks up through
 * enclosing blocks/functions/the source file to find the *nearest* declaration (variable or
 * parameter) with that name, and judges only that declaration — not any same-named variable
 * elsewhere in the file. No type checker; purely name- and shape-based.
 */
function isRouterName(node: ts.Node, name: string): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    const params = functionParams(cur);
    if (params?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return false;
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      const decl = findVarDecl(cur.statements, name);
      if (decl) return isRouterFactoryCall(decl.initializer);
    }
    cur = cur.parent;
  }
  return false;
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
    });
  });
  return out;
}
