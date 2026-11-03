import ts from "typescript";
import { functionLikeName, lineOf, prop, stringValue } from "../adapters/ast.js";
import { clientScope, configObject, importedBindings, urlPattern } from "../adapters/http-calls.js";
import type { HttpMethod } from "../store/schemas.js";

/**
 * Config-object HTTP wrappers (hardening H2): a function that forwards a `{ method, url, … }` object to an
 * HTTP client — `httpClient({ method, url, data }) { return client({ method, url, data }) }` or
 * `request(config) { return client(config) }` — and the `{ method, url }` arguments its callers pass.
 * Kept apart from code-index.ts, which only stores what these return.
 */

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
/** Parameter name or type text that reads as a request config. */
const CONFIG_LIKE_RE = /config|cfg|opts|options|request|req\b|settings/i;

/** An object-literal argument (or a same-function `const config = {…}`) that carries a `url`. */
export interface ConfigArg {
  index: number;
  /** Literal `method`; absent when the config has no method (the wrapper's default applies). */
  method?: HttpMethod;
  /** The config's method is present but not a literal: the call's method is unknown. */
  methodUnknown?: true;
  /** The url as a route pattern; absent when it has no literal text. */
  url?: { path: string; kind: "literal" | "template"; resolved: boolean; raw: string; base?: string };
}

/** Per-source-file facts, computed once: module env consts, local client instances, import bindings. */
interface FileFacts {
  env: Map<string, string>;
  clients: Set<string>;
  imports: Set<string>;
}
const factsCache = new WeakMap<ts.SourceFile, FileFacts>();

function factsOf(sf: ts.SourceFile): FileFacts {
  let facts = factsCache.get(sf);
  if (!facts) {
    const scope = clientScope({ rel: sf.fileName, content: sf.text, sf });
    facts = { env: scope.envConsts, clients: scope.clients, imports: new Set(importedBindings(sf).keys()) };
    factsCache.set(sf, facts);
  }
  return facts;
}

/** Config arguments of a call: each object-literal argument (or one-level `const` config) with a `url`. */
export function configArgsOf(call: ts.CallExpression): ConfigArg[] {
  const out: ConfigArg[] = [];
  call.arguments.forEach((a, index) => {
    if (!ts.isObjectLiteralExpression(a) && !ts.isIdentifier(a)) return;
    const obj = configObject(a, call);
    const urlExpr = obj && prop(obj, "url");
    if (!obj || !urlExpr) return;
    const arg: ConfigArg = { index };
    const m = prop(obj, "method");
    const mv = m && stringValue(m);
    if (m && (mv === undefined || !METHODS[mv.toLowerCase()])) arg.methodUnknown = true;
    else if (mv !== undefined) arg.method = METHODS[mv.toLowerCase()];
    else if (obj.properties.some(ts.isSpreadAssignment)) arg.methodUnknown = true;
    const pattern = urlPattern(urlExpr, factsOf(call.getSourceFile()).env);
    if (pattern) {
      arg.url = {
        path: pattern.path, kind: pattern.kind, resolved: pattern.resolved, raw: urlExpr.getText(),
        ...(pattern.base !== undefined ? { base: pattern.base } : {}),
      };
    }
    out.push(arg);
  });
  return out;
}

/** The nearest enclosing function, when it is named; an unnamed function in between ends the search. */
function enclosingNamedFunction(node: ts.Node): { node: ts.SignatureDeclaration; name: string } | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    const name = functionLikeName(cur);
    if (ts.isFunctionLike(cur)) return name !== undefined ? { node: cur, name } : undefined;
    if (name !== undefined) return undefined;
  }
  return undefined;
}

/** Which parameter a url expression reads: `P.url` (P a plain parameter) or `url` destructured from a
 * parameter (`{ method, url, data }`). */
function urlParamIndex(e: ts.Expression, params: readonly ts.ParameterDeclaration[]): number {
  if (ts.isPropertyAccessExpression(e) && e.name.text === "url" && ts.isIdentifier(e.expression)) {
    const name = e.expression.text;
    return params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
  }
  if (ts.isIdentifier(e)) {
    return params.findIndex((p) => ts.isObjectBindingPattern(p.name) && p.name.elements.some((el) =>
      ts.isIdentifier(el.name) && el.name.text === e.text && !el.dotDotDotToken &&
      (el.propertyName === undefined || (ts.isIdentifier(el.propertyName) && el.propertyName.text === "url"))));
  }
  return -1;
}

/** Split a wrapper's inner url into (base, the parameter-carried url): `u`, `` `${BASE}${u}` ``, `BASE + u`. */
function splitBase(e: ts.Expression): { base?: ts.Expression; url: ts.Expression } {
  if (ts.isTemplateExpression(e) && e.head.text === "" && e.templateSpans.length === 2 && e.templateSpans.every((s) => s.literal.text === "")) {
    return { base: e.templateSpans[0]!.expression, url: e.templateSpans[1]!.expression };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return { base: e.left, url: e.right };
  return { url: e };
}

/** What code-index stores for a config wrapper (merged into its HttpWrapper). */
export interface ConfigWrapper {
  symbol: string;
  param: number;
  /** The inner config's literal method when it fixes one, else "GET" (the caller's config decides). */
  method: HttpMethod;
  client: string;
  base?: string;
  config: true;
  /** True when `method` is fixed by the wrapper itself. */
  methodFixed?: true;
  /** Line of the inner client call; the linker only trusts the wrapper when the adapter found an HTTP
   * call there (i.e. the callee really is an HTTP client). */
  line: number;
}

/**
 * `call` as the inner call of a config wrapper: `X(cfg)` / `X.request(cfg)` where X is axios, a local
 * client instance or an imported binding, and `cfg` forwards a parameter's config — the parameter itself,
 * `{ ...P }`, or an object whose `url` is `P.url` or a `url` destructured from a parameter.
 */
export function configWrapperCandidate(call: ts.CallExpression): ConfigWrapper | undefined {
  const callee = call.expression;
  const target = ts.isIdentifier(callee) ? callee
    : ts.isPropertyAccessExpression(callee) && callee.name.text === "request" && ts.isIdentifier(callee.expression) ? callee.expression
      : undefined;
  const [first] = call.arguments;
  if (!target || !first || call.arguments.length !== 1) return undefined;
  const facts = factsOf(call.getSourceFile());
  if (target.text !== "axios" && !facts.clients.has(target.text) && !facts.imports.has(target.text)) return undefined;
  const fn = enclosingNamedFunction(call);
  if (!fn) return undefined;
  const params = fn.node.parameters;
  // A whole parameter forwarded as the config must look like one (`config`, `opts: RequestOptions`, …):
  // `useCustomer(id) { return getCustomer(id) }` forwards an id, not a config.
  const plainParam = (e: ts.Expression) => ts.isIdentifier(e)
    ? params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === e.text && CONFIG_LIKE_RE.test(`${p.name.text} ${p.type?.getText() ?? ""}`))
    : -1;

  let param = plainParam(first);
  let base: ts.Expression | undefined;
  let methodFixed: HttpMethod | undefined;
  if (param < 0 && ts.isObjectLiteralExpression(first)) {
    const urlNode = first.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "url");
    const urlExpr = urlNode && ts.isShorthandPropertyAssignment(urlNode) ? urlNode.name
      : urlNode && ts.isPropertyAssignment(urlNode) ? urlNode.initializer : undefined;
    if (urlExpr) {
      const split = splitBase(urlExpr);
      param = urlParamIndex(split.url, params);
      base = split.base;
    } else {
      const spread = first.properties.find(ts.isSpreadAssignment);
      if (spread) param = plainParam(spread.expression);
    }
    const m = prop(first, "method");
    const mv = m && stringValue(m);
    if (mv !== undefined) methodFixed = METHODS[mv.toLowerCase()];
  }
  if (param < 0) return undefined;
  const baseText = base?.getText();
  if (base && !(ts.isIdentifier(base) || ts.isPropertyAccessExpression(base))) return undefined;
  const envBase = baseText !== undefined ? facts.env.get(baseText) ?? baseText : undefined;
  return {
    symbol: fn.name, param, method: methodFixed ?? "GET", client: target.text, config: true, line: lineOf(call),
    ...(methodFixed ? { methodFixed: true as const } : {}),
    ...(envBase !== undefined ? { base: envBase } : {}),
  };
}
