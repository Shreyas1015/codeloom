import ts from "typescript";
import type { HttpCall, HttpMethod } from "../store/schemas.js";
import { enclosingSymbol, lastName, lineOf, pathPattern, prop, stringValue, walk } from "./ast.js";
import type { ParsedFile } from "./types.js";

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
const FETCH_FNS = new Set(["fetch", "$fetch", "ofetch", "useFetch"]);
const CLIENT_RE = /^(axios|ky|got|superagent)$|(api|client|http|request|instance|fetcher)$/i;

function methodOf(value: string | undefined): HttpMethod | undefined {
  return value ? METHODS[value.toLowerCase()] : undefined;
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
    } else if (ts.isPropertyAccessExpression(callee) && METHODS[callee.name.text] && first) {
      const receiver = lastName(callee.expression);
      if (receiver && receiver !== "this" && CLIENT_RE.test(receiver)) {
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
