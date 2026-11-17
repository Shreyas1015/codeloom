import ts from "typescript";
import type { HttpCall, HttpClient, HttpMethod } from "../store/schemas.js";
import {
  absoluteHost, collect, enclosingSymbol, isRouterName, lastName, lineOf, normalizePath, pathPattern, prop, rtkBaseUrl, rtkEndpointOf, stringValue, walk,
} from "./ast.js";
import type { Part } from "./ast.js";
import type { HttpCallDraft, HttpClientDraft, ParsedFile, ReExportDraft } from "./types.js";

const METHODS: Record<string, HttpMethod> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
/** `METHODS`/`SUPERAGENT_METHODS` keyed case-insensitively: generated clients (openapi-fetch and
 * similar) name their methods `client.GET(...)`/`client.POST(...)`, uppercase. */
function methodNamed(table: Record<string, HttpMethod>, name: string): HttpMethod | undefined {
  return table[name.toLowerCase()];
}
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
    if (
      ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && SUPERAGENT_MODULE_RE.test(stmt.moduleSpecifier.text) &&
      !stmt.importClause?.isTypeOnly
    ) {
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
 * when present but not a literal (a variable method), or when absent but a spread may supply it. */
export function configMethod(obj: ts.ObjectLiteralExpression | undefined, fallback: HttpMethod): HttpMethod | undefined {
  const m = obj && prop(obj, "method");
  if (!m) return obj?.properties.some(ts.isSpreadAssignment) ? undefined : fallback;
  const v = stringValue(m);
  return v === undefined ? undefined : methodOf(v) ?? fallback;
}

/** `process.env.X` / `import.meta.env.X`: an env var access. */
export function isEnvAccess(e: ts.Expression): e is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(e)) return false;
  const host = e.expression.getText();
  return host === "process.env" || host === "import.meta.env";
}

/** Top-level `const X = <env access>` (optionally `|| "<fallback>"` / `?? "<fallback>"`): X -> the env
 * access text, e.g. "import.meta.env.VITE_API_URL". */
export function envConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of stmt.declarationList.declarations) {
      let init = d.initializer;
      while (init && ts.isParenthesizedExpression(init)) init = init.expression;
      if (
        init && ts.isBinaryExpression(init) && stringValue(init.right) !== undefined &&
        (init.operatorToken.kind === ts.SyntaxKind.BarBarToken || init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) init = init.left;
      if (ts.isIdentifier(d.name) && init && isEnvAccess(init)) out.set(d.name.text, init.getText());
    }
  }
  return out;
}

/** What a file knows about its own HTTP clients: names bound to `axios.create(...)` & co, and module
 * consts initialised from an env var (so a `${API_URL}` base reads as the env var). */
export interface ClientScope {
  clients: Set<string>;
  envConsts: Map<string, string>;
}

export function clientScope(file: ParsedFile): ClientScope {
  if (!file.sf) return { clients: new Set(), envConsts: new Map() };
  return { clients: new Set(detectHttpClients(file).map((c) => c.name)), envConsts: envConsts(file.sf) };
}

/** True when `node` sits directly in `fn` (not inside a nested function). */
function directlyIn(node: ts.Node, fn: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur === fn) return true;
    if (ts.isFunctionLike(cur)) return false;
  }
  return false;
}

/** A config argument as an object literal: the literal itself, or a `const <name> = { … }` declared
 * earlier in the same function (one level, never through a nested function). Undefined otherwise. */
export function configObject(arg: ts.Expression, call: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(arg)) return arg;
  if (!ts.isIdentifier(arg)) return undefined;
  let fn: ts.Node | undefined = call.parent;
  while (fn && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  if (!fn) return undefined;
  const scope = fn;
  // Every same-named declaration in the function counts (a second one makes it ambiguous).
  const found: Array<ts.Expression | undefined> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === arg.text && directlyIn(n, scope)) {
      const isConst = ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0;
      found.push(isConst && n.getStart() < call.getStart() ? n.initializer : undefined);
    }
    if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  const [only] = found;
  return found.length === 1 && only && ts.isObjectLiteralExpression(only) ? only : undefined;
}

/** `client(config)` on a known client (axios itself or a local instance), or `client.request(<config const>)`:
 * `{ urlExpr }` when the config's url can be read, `{}` (unknown URL) when it cannot. Never guesses. */
function configCall(
  node: ts.CallExpression, scope: ClientScope,
): { method: HttpMethod | undefined; urlExpr?: ts.Expression; client: string } | undefined {
  const callee = node.expression;
  const [first] = node.arguments;
  if (!first) return undefined;
  let client: string;
  if (ts.isIdentifier(callee) && (callee.text === "axios" || scope.clients.has(callee.text))) client = callee.text;
  else if (
    ts.isPropertyAccessExpression(callee) && callee.name.text === "request" && ts.isIdentifier(first) &&
    ts.isIdentifier(callee.expression) && (scope.clients.has(callee.expression.text) || isClientReceiver(callee.expression.text, node))
  ) client = callee.expression.text;
  else return undefined;
  return { ...readConfig(first, node), client };
}

/** Method and url of a config argument; no `urlExpr` when the url cannot be read. */
function readConfig(arg: ts.Expression, call: ts.Node): { method: HttpMethod | undefined; urlExpr?: ts.Expression } {
  const obj = configObject(arg, call);
  const url = obj && prop(obj, "url");
  if (!url) return { method: "GET" };
  return { method: configMethod(obj, "GET"), urlExpr: url };
}

/** Recognise an HTTP client call (fetch, axios(config), client.request(config), client.get(url), superagent). */
export function httpCallShape(node: ts.CallExpression, superagent: Set<string>, scope?: ClientScope): HttpCallShape | undefined {
  const callee = node.expression;
  const [first, second] = node.arguments;
  if (!first) return undefined;
  if (ts.isIdentifier(callee) && FETCH_FNS.has(callee.text)) {
    // An init that is not an object literal (a forwarded variable) may carry any method: unknown.
    const method = !second ? "GET" : ts.isObjectLiteralExpression(second) ? configMethod(second, "GET") : undefined;
    return { method, urlExpr: first, client: callee.text, methodStyle: false };
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
  const method = methodNamed(isSuperagent ? SUPERAGENT_METHODS : METHODS, name);
  if (!method) return undefined;
  const localClient = ts.isIdentifier(callee.expression) && !!scope?.clients.has(receiver) && !isRouterName(node, receiver);
  if (!isSuperagent && !localClient && !isClientReceiver(receiver, node)) return undefined;
  return { method, urlExpr: first, client: receiver, methodStyle: true };
}

/** A route pattern for a URL expression whose leading base is a module const read from an env var reads
 * that env var as its base (`${API_URL}/x` with `const API_URL = import.meta.env.VITE_API_URL`). */
export function urlPattern(urlExpr: ts.Expression, env: Map<string, string>): ReturnType<typeof pathPattern> {
  const pattern = pathPattern(urlExpr);
  const envBase = pattern?.base !== undefined ? env.get(pattern.base) : undefined;
  return pattern && envBase !== undefined ? { ...pattern, base: envBase } : pattern;
}

type AnyShape = { method: HttpMethod | undefined; urlExpr?: ts.Expression; client: string; methodStyle?: boolean };

/** The HttpCall for a recognised shape, or undefined when a method-style URL does not look like one. */
function callOf(file: ParsedFile, node: ts.CallExpression, shape: AnyShape, env: Map<string, string>): HttpCall | undefined {
  const { urlExpr } = shape;
  if (shape.methodStyle && !(urlExpr && pathPattern(urlExpr) && looksLikeUrl(literalText(urlExpr)))) return undefined;
  // A variable method keeps the adapter's historical default (GET); wrapper inference treats it apart.
  const method = shape.method ?? "GET";
  const pattern = urlExpr && urlPattern(urlExpr, env);
  return {
    method,
    path: pattern?.path ?? "",
    raw: urlExpr?.getText() ?? node.arguments[0]!.getText(),
    resolved: pattern?.resolved ?? false,
    client: shape.client,
    at: { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) },
    kind: pattern?.kind ?? "unknown",
    ...(pattern?.base !== undefined ? { base: pattern.base } : {}),
  };
}

/** The URL a function returns: its expression body, or the single `return <expr>` of its block. */
function returnedExpr(fn: ts.Node): ts.Expression | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isMethodDeclaration(fn)) return undefined;
  const body = fn.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  const [only] = body.statements;
  return body.statements.length === 1 && only && ts.isReturnStatement(only) ? only.expression : undefined;
}

/** v0.2a §4: an RTK Query endpoint's `query` function as an HTTP call on its api (the api is an HttpClient named
 * after its variable, so fetchBaseQuery's baseUrl applies): `query: (id) => \`/customers/${id}\`` is a GET, and
 * `query: (b) => ({ url: "/customers", method: "POST", body: b })` takes `method` (GET when absent). Only for an api
 * whose baseQuery is `fetchBaseQuery(…)`; a query whose URL cannot be read is left out. */
function rtkQueryCall(file: ParsedFile, node: ts.Node, env: Map<string, string>): HttpCall | undefined {
  const ep = rtkEndpointOf(node);
  if (!ep || !rtkUsesFetchBaseQuery(ep.createApi)) return undefined;
  let e = returnedExpr(node);
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  if (!e) return undefined;
  let method: HttpMethod | undefined = "GET";
  let urlExpr: ts.Expression | undefined = e;
  if (ts.isObjectLiteralExpression(e)) {
    urlExpr = prop(e, "url");
    method = configMethod(e, "GET");
  }
  const pattern = urlExpr && urlPattern(urlExpr, env);
  if (!urlExpr || !pattern || !method) return undefined;
  return {
    method, path: pattern.path, raw: urlExpr.getText(), resolved: pattern.resolved, client: ep.api,
    at: { file: file.rel, line: lineOf(node), symbol: `${ep.api}.${ep.endpoint}` }, kind: pattern.kind,
    ...(pattern.base !== undefined ? { base: pattern.base } : {}),
  };
}

function rtkUsesFetchBaseQuery(createApi: ts.CallExpression): boolean {
  const opts = createApi.arguments[0];
  const bq = opts && ts.isObjectLiteralExpression(opts) ? prop(opts, "baseQuery") : undefined;
  return !!bq && ts.isCallExpression(bq) && lastName(bq.expression) === "fetchBaseQuery";
}

export function detectHttpCalls(file: ParsedFile): HttpCall[] {
  if (!file.sf) return [];
  const superagent = superagentReceivers(file.sf);
  const scope = clientScope(file);
  const out: HttpCall[] = [];
  walk(file.sf, (node) => {
    const rtk = rtkQueryCall(file, node, scope.envConsts);
    if (rtk) out.push(rtk);
    if (!ts.isCallExpression(node)) return;
    const shape = configCall(node, scope) ?? httpCallShape(node, superagent, scope);
    const call = shape && callOf(file, node, shape, scope.envConsts);
    if (call) out.push(call);
  });
  return out;
}

/** Import bindings (default and named, aliases kept) of repo modules that may export an HTTP client:
 * local name -> { from, imported name ("default" for a default import) }. Known HTTP libraries and
 * type-only imports are skipped. */
export function importedBindings(sf: ts.SourceFile): Map<string, { from: string; name: string }> {
  const out = new Map<string, { from: string; name: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const from = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly || KNOWN_HTTP_LIB_PACKAGES.has(from)) continue;
    if (clause.name) out.set(clause.name.text, { from, name: "default" });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (!el.isTypeOnly) out.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
      }
    }
  }
  return out;
}

/** Namespace imports of repo modules (`import * as net from "./net"`): local name -> module specifier.
 * Known HTTP libraries and type-only imports are skipped. */
function namespaceImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly || KNOWN_HTTP_LIB_PACKAGES.has(stmt.moduleSpecifier.text)) continue;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) out.set(clause.namedBindings.name.text, stmt.moduleSpecifier.text);
  }
  return out;
}

/** Re-exports a file makes (`export * from` / `export { a as b } from`), type-only ones skipped. */
export function detectReExports(file: ParsedFile): ReExportDraft[] {
  if (!file.sf) return [];
  const out: ReExportDraft[] = [];
  for (const stmt of file.sf.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const from = stmt.moduleSpecifier.text;
    if (!stmt.exportClause) out.push({ file: file.rel, kind: "all", from });
    else if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (!el.isTypeOnly) out.push({ file: file.rel, kind: "named", exported: el.name.text, imported: (el.propertyName ?? el.name).text, from });
      }
    }
  }
  return out;
}

/** True when `name` is re-declared (a parameter, a variable, a function) in a function or block around `node`. */
function shadowed(node: ts.Node, name: string): boolean {
  const declares = (n: ts.BindingName): boolean =>
    ts.isIdentifier(n) ? n.text === name : n.elements.some((e) => !ts.isOmittedExpression(e) && declares(e.name));
  for (let cur = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => declares(p.name))) return true;
    if (ts.isBlock(cur)) {
      for (const s of cur.statements) {
        if (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => declares(d.name))) return true;
        if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) return true;
      }
    }
  }
  return false;
}

/**
 * Calls on an imported binding that would be HTTP calls if the binding is an HTTP client instance:
 * `svc.get(url)` (and post/put/patch/delete), `svc.request(config)` and `svc(config)`. Each carries a
 * `clientImport` for `finalizeEndpoints` to check against the exporting file's clients. Calls that
 * `detectHttpCalls` already finds (e.g. a receiver named like a client) are not repeated.
 */
export function detectImportedClientCalls(file: ParsedFile): HttpCallDraft[] {
  if (!file.sf) return [];
  const imports = importedBindings(file.sf);
  const namespaces = namespaceImports(file.sf);
  if (imports.size === 0 && namespaces.size === 0) return [];
  const superagent = superagentReceivers(file.sf);
  const scope = clientScope(file);
  const env = scope.envConsts;
  const out: HttpCallDraft[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node) || !node.arguments[0]) return;
    const callee = node.expression;
    let local = ts.isIdentifier(callee) ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
    let imp = local !== undefined ? imports.get(local) : undefined;
    let shadowName = local;
    if (!imp) {
      // `net.backend.get(url)` / `net.backend(config)` / `net.backend.request(config)` on `import * as net` (v0.2a).
      const member = ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression) ? callee.expression
        : ts.isPropertyAccessExpression(callee) ? callee : undefined;
      const ns = member && ts.isIdentifier(member.expression) ? namespaces.get(member.expression.text) : undefined;
      if (member && ns !== undefined) {
        imp = { from: ns, name: member.name.text };
        shadowName = (member.expression as ts.Identifier).text;
        local = `${shadowName}.${member.name.text}`;
        // `net.backend(config)` calls the member itself; `net.backend.get(url)` calls a method on it.
        if (callee !== member && !(ts.isPropertyAccessExpression(callee) && callee.expression === member)) return;
      }
    }
    if (!imp || local === undefined || shadowName === undefined || shadowed(node, shadowName)) return;
    if (configCall(node, scope) ?? httpCallShape(node, superagent, scope)) return;
    const first = node.arguments[0];
    let shape: AnyShape | undefined;
    const configLike = ts.isObjectLiteralExpression(first) || ts.isIdentifier(first);
    const callsClient = ts.isIdentifier(callee) || (ts.isPropertyAccessExpression(callee) && local === `${callee.expression.getText()}.${callee.name.text}`);
    if (configLike && (callsClient || (ts.isPropertyAccessExpression(callee) && callee.name.text === "request"))) {
      shape = { ...readConfig(first, node), client: local };
    } else if (ts.isPropertyAccessExpression(callee) && methodNamed(METHODS, callee.name.text)) {
      shape = { method: methodNamed(METHODS, callee.name.text), urlExpr: first, client: local, methodStyle: true };
    }
    const call = shape && callOf(file, node, shape, env);
    if (call) out.push({ ...call, clientImport: imp });
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

// ---------------------------------------------------------------------------------------------------
// Client factories (Task 4 follow-up, spec §4): `function backendClient(backend) { const client =
// createClient({ baseUrl: sameOrigin(`/api/${backend}`) }); return client; }` then `const apiClient =
// backendClient('api')` — a generated client (openapi-fetch and similar) created behind a one-argument
// local factory, whose caller's own string literal is the only thing missing to know the client's base.
// Folding this (rather than teaching `proxies` to name a client export instead of a URL prefix) keeps the
// fix local to how clients are read, so every existing consumer of `HttpClient.baseLiteral` (route
// matching, `proxies`, `externalHost`, ...) benefits without its own special case. See docs/reference.md.
// ---------------------------------------------------------------------------------------------------

/** A local single-parameter factory whose body creates an HTTP client via that parameter: `parts` is the
 * client's baseUrl template with the parameter's own slot marked (`{ param: true }`), ready to fold once
 * a call site supplies a literal argument. `factory` names the inner client-creating call, the same text
 * `detectHttpClients` itself would use (a known library's name, or another call's own callee text). */
interface ClientFactory {
  paramName: string;
  parts: Array<{ text: string } | { param: true }>;
  factory: string;
}

/** Packages (beyond the HTTP libraries `KNOWN_HTTP_LIB_PACKAGES` already covers via
 * `collectKnownLibAliases`, member-call style) whose bare factory export, called directly
 * (`createClient(...)`), is trusted as HTTP-client creation — review fix: a bare call used to need only a
 * `baseUrl`/`baseURL`/`prefixUrl` option, which an unrelated helper (`buildLink({ baseUrl })`) could carry
 * too; now it also needs a real import from one of these. */
const BARE_FACTORY_PACKAGES = new Set(["openapi-fetch", "@hey-api/client-fetch", "@hey-api/client-axios"]);

/** Is `name` bound to a known HTTP library (any local alias `collectKnownLibAliases` found) or imported
 * from one of `BARE_FACTORY_PACKAGES`? The only two ways a bare call's own callee earns the "this creates
 * an HTTP client" signal. */
function isImportedBareFactory(name: string, aliases: Map<string, string>, imports: Map<string, { from: string; name: string }>): boolean {
  if (aliases.has(name)) return true;
  const imp = imports.get(name);
  return !!imp && BARE_FACTORY_PACKAGES.has(imp.from);
}

/** Every top-level `function NAME(...) {...}` and `const NAME = (...) => ...`/`function (...) {}` in
 * `sf`, in source order. Shared by the client-factory fold and its origin-wrapper check below. */
function topLevelFunctions(sf: ts.SourceFile): Array<{ name: string; fn: ts.FunctionLikeDeclaration }> {
  const out: Array<{ name: string; fn: ts.FunctionLikeDeclaration }> = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) out.push({ name: stmt.name.text, fn: stmt });
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          out.push({ name: d.name.text, fn: d.initializer });
        }
      }
    }
  }
  return out;
}

/** Every identifier `target` (an assignment's left side) would write to: itself, when it is a plain
 * identifier; everything named inside it, when it is a destructuring pattern (`[b] = [...]`,
 * `({ b, x: c, ...rest } = o)`, nested, defaulted, parenthesized) — review fix: `isMutated` must catch a
 * destructured reassignment of the parameter, not just a bare `name = ...`. A property/element-access
 * target (`obj.x = ...`) names nothing by itself and is ignored. */
function assignmentTargets(target: ts.Expression, out: Set<string>): void {
  if (ts.isParenthesizedExpression(target)) return assignmentTargets(target.expression, out);
  if (ts.isIdentifier(target)) {
    out.add(target.text);
    return;
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    assignmentTargets(target.left, out); // a default inside a pattern: `b = 1`
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    for (const el of target.elements) {
      if (ts.isOmittedExpression(el)) continue;
      assignmentTargets(ts.isSpreadElement(el) ? el.expression : el, out);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const p of target.properties) {
      if (ts.isShorthandPropertyAssignment(p)) out.add(p.name.text);
      else if (ts.isPropertyAssignment(p)) assignmentTargets(p.initializer, out);
      else if (ts.isSpreadAssignment(p)) assignmentTargets(p.expression, out);
    }
  }
}

/** True when `name` is the target of an assignment (`name = ...`, `name += ...`, a destructuring
 * `[name] = ...` / `({ name } = ...)`, ...) or `++`/`--` anywhere in `fn`'s body, including inside a
 * nested function (a closure over the parameter can still mutate it before the factory call returns) —
 * review fix: a reassigned/incremented parameter makes the factory's result depend on more than just the
 * call-site argument, so it must never be folded. */
function isMutated(fn: ts.FunctionLikeDeclaration, name: string): boolean {
  const body = fn.body;
  if (!body) return false;
  let mutated = false;
  const isAssignmentOp = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  const isIncDec = (k: ts.SyntaxKind) => k === ts.SyntaxKind.PlusPlusToken || k === ts.SyntaxKind.MinusMinusToken;
  const visit = (n: ts.Node): void => {
    if (mutated) return;
    if (ts.isBinaryExpression(n) && isAssignmentOp(n.operatorToken.kind)) {
      const targets = new Set<string>();
      assignmentTargets(n.left, targets);
      if (targets.has(name)) {
        mutated = true;
        return;
      }
    }
    if (
      (ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
      isIncDec(n.operator) && ts.isIdentifier(n.operand) && n.operand.text === name
    ) {
      mutated = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return mutated;
}

/** Every `ReturnStatement` anywhere in `fn`'s body — never inside a nested function-like node or class
 * (that is a different scope's own returns/control-flow) — found by walking the whole body, not just its
 * top-level statements (review fix, round 4: a guard clause, `if (cond) { return X; } ...more
 * statements... return Y;`, with no `else`, hid `return X` from every earlier version of this, which only
 * looked at a block's direct statements or a single top-level if/else). `undefined` — fail safe, never
 * fold — when the body contains a construct this does not model: `throw`, any loop, `try`, or `switch`,
 * since those change what "every return" even means (an uncaught throw skips every later return; a loop
 * can return zero or more times). An arrow's expression body has no `ReturnStatement` node at all;
 * callers handle that shape themselves. */
function allReturns(fn: ts.FunctionLikeDeclaration): ts.ReturnStatement[] | undefined {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return undefined;
  const out: ts.ReturnStatement[] = [];
  let unmodeled = false;
  const visit = (n: ts.Node): void => {
    if (unmodeled) return;
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (
      ts.isThrowStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isTryStatement(n) || ts.isSwitchStatement(n)
    ) {
      unmodeled = true;
      return;
    }
    if (ts.isReturnStatement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return unmodeled ? undefined : out;
}

/** The expression a function-like node returns: an arrow's expression body as-is, or — when its body has
 * exactly one `return` anywhere (`allReturns`; review fix, round 4: a factory with more than one
 * `return` path, e.g. an early `return otherClient;` guard clause, is never understood at all, not just
 * the first/last one found) and that return names a `const` declared earlier in the same block — that
 * const's own initializer (`const client = createClient(...); return client;`, one level only; review
 * fix, round 2: `const` only — `let client = make(); client = other(); return client;` must never be
 * chased, since the value `return`ed may not be what the first declaration bound at all). Anything else
 * (0 or 2+ returns anywhere in the body, an unmodeled construct, a `let`/`var` binding, ...) is not a
 * factory this understands. */
function factoryReturnExpr(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const body = fn.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  const returns = allReturns(fn);
  if (!returns || returns.length !== 1) return undefined;
  const ret = returns[0]!.expression;
  if (!ret) return undefined;
  if (!ts.isIdentifier(ret)) return ret;
  // A bare identifier: the function's own parameter, returned directly (`function sameOrigin(path) {
  // return path; }`), or a local `const` declared earlier in the block — one level only.
  if (fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === ret.text)) return ret;
  const decls = body.statements
    .filter((s): s is ts.VariableStatement => ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap((s) => s.declarationList.declarations)
    .filter((d) => ts.isIdentifier(d.name) && d.name.text === ret.text && d.initializer);
  return decls.length === 1 ? decls[0]!.initializer : undefined;
}

/** `expr` is exactly `location.origin`, `window.location.origin` or `globalThis.location.origin` — the
 * one real "same origin" reference an origin wrapper's prefix may be (review fix, round 1→2: *any*
 * prefix used to be accepted — literal text like `"/gateway"`, a free variable holding an absolute URL,
 * `+`-concat, … — so a wrapper that actually prepended a different host, or any fixed path segment, was
 * wrongly trusted as transparent). Checked structurally (not by source text), so whitespace/parens don't
 * matter. */
function isLocationOrigin(expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "origin") return false;
  const owner = expr.expression;
  if (ts.isIdentifier(owner)) return owner.text === "location";
  return (
    ts.isPropertyAccessExpression(owner) && owner.name.text === "location" && ts.isIdentifier(owner.expression) &&
    (owner.expression.text === "window" || owner.expression.text === "globalThis")
  );
}

/** Loopback hosts a "path-free origin" fallback branch may name outright (review fix, round 4: round 3
 * accepted *any* bare scheme+host literal, so a guard clause returning a real-looking third-party domain
 * with no path, e.g. `https://pay.example.com`, still folded — only a host that is obviously a local/dev
 * address, same convention as `linker/link.ts`'s own `LOOPBACK_HOSTS`, is trusted here). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
const PATH_FREE_ORIGIN_RE = /^https?:\/\/([^/]+)$/;

/** A "path-free" origin usable as a *non*-primary branch of a conditional origin check: a string literal
 * that is just a scheme and a known loopback host (a port is fine; a trailing `/`, a path, or any other
 * host is not), or a bare `process.env.X` / `import.meta.env.X` read with nothing else in the same
 * prefix (`isEnvAccess`). At least one branch of the conditional must still be the real
 * `location.origin`-family check (`isLocationOrigin`) — this is only ever the *fallback*. */
function isPathFreeOrigin(part: Part): boolean {
  if (!("text" in part)) return isEnvAccess(part.expr);
  const host = PATH_FREE_ORIGIN_RE.exec(part.text)?.[1];
  return !!host && LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ""));
}

/** Like `collect` (`adapters/ast.ts`), but a `ConditionalExpression` anywhere in `expr` — at the top
 * level, nested inside another conditional, or nested inside a template substitution — expands into
 * every branch, so the result is one `Part[]` sequence per possible runtime path through `expr`'s
 * conditionals (review fix, round 3: "nested conditionals follow the same rule"). `undefined` on the
 * same shapes `collect` itself cannot decompose. */
function collectBranches(expr: ts.Expression): Part[][] | undefined {
  if (ts.isParenthesizedExpression(expr)) return collectBranches(expr.expression);
  if (ts.isConditionalExpression(expr)) {
    const t = collectBranches(expr.whenTrue);
    const f = collectBranches(expr.whenFalse);
    return t && f ? [...t, ...f] : undefined;
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [[{ text: expr.text }]];
  const cross = (a: Part[][], b: Part[][]): Part[][] => a.flatMap((x) => b.map((y) => [...x, ...y]));
  if (ts.isTemplateExpression(expr)) {
    let acc: Part[][] = [expr.head.text ? [{ text: expr.head.text }] : []];
    for (const span of expr.templateSpans) {
      const branches = collectBranches(span.expression);
      if (!branches) return undefined;
      acc = cross(acc, branches);
      if (span.literal.text) acc = acc.map((p) => [...p, { text: span.literal.text }]);
    }
    return acc;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = collectBranches(expr.left);
    const r = collectBranches(expr.right);
    return l && r ? cross(l, r) : undefined;
  }
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isCallExpression(expr) || ts.isElementAccessExpression(expr)) {
    return [[{ expr }]];
  }
  return undefined;
}

type OriginLeafKind = "param" | "location-origin" | "path-free-origin" | "other";

/** `seq` (one `collectBranches` sequence) ends in exactly one occurrence of `paramName`, as the very
 * last part — a suffix, never reshaped or interleaved (review fix: `withVersion(path) =>
 * \`${path}/v2\`` is NOT an origin wrapper — it appends to the path). Everything before it, if
 * anything, is either exactly `location.origin`-family (`"location-origin"`) or a path-free origin
 * (`"path-free-origin"`, round 3) — never two or more prefix parts, a fixed path segment, `+`-concat of
 * unrelated text, or a free variable (`"other"`, always rejected). */
function classifyOriginLeaf(seq: Part[], paramName: string): OriginLeafKind {
  const isParam = (p: Part): boolean => !("text" in p) && ts.isIdentifier(p.expr) && p.expr.text === paramName;
  if (seq.filter(isParam).length !== 1) return "other";
  const last = seq.at(-1);
  if (!last || !isParam(last)) return "other";
  const prefix = seq.slice(0, -1);
  if (prefix.length === 0) return "param";
  if (prefix.length !== 1) return "other";
  const only = prefix[0]!;
  if (!("text" in only) && isLocationOrigin(only.expr)) return "location-origin";
  return isPathFreeOrigin(only) ? "path-free-origin" : "other";
}

/** `fn` merely returns its own single parameter, optionally with an origin prefixed before it — the
 * only shape `unwrapOneCall` trusts to see through a one-argument wrapper call around a factory's
 * baseUrl template:
 * - a single expression (no conditional, found via `allReturns`: exactly one `return` anywhere in the
 *   body — review fix, round 4): `(path) => path`, or exactly
 *   `location.origin`/`window.location.origin`/`globalThis.location.origin` + `path` — nothing else
 *   (round 2's rule, unchanged);
 * - 2+ returns anywhere in the body (a conditional expression, an if/else, or — review fix, round 4 — a
 *   guard clause with no `else` at all, `` if (cond) { return X; } ...; return Y; `` — the real-world
 *   SSR/test-fallback shape, `` `${typeof window === "undefined" ? "http://localhost" :
 *   window.location.origin}${path}` ``, as well as its statement-level equivalent): at least one branch
 *   must be the real origin check (exactly `location.origin`-family + `path`); every *other* branch must
 *   be `path` alone or a path-free origin (`isPathFreeOrigin`) + `path` — a literal with a path in it, a
 *   real-looking third-party host even with no path, a different host, or anything else, and the whole
 *   function is rejected (never folded as if it were transparent). Nested conditionals (anywhere
 *   `collectBranches` finds one) follow the same rule, since every branch is flattened into its own
 *   sequence before any of this is checked. `allReturns`' own fail-safe (no fold on a `throw`, loop,
 *   `try` or `switch` anywhere in the body) applies here too. */
function isOriginWrapper(fn: ts.FunctionLikeDeclaration): boolean {
  if (fn.parameters.length !== 1) return false;
  const param = fn.parameters[0]!.name;
  if (!ts.isIdentifier(param) || isMutated(fn, param.text)) return false;
  const body = fn.body;
  if (!body) return false;
  let rets: ts.Expression[];
  if (!ts.isBlock(body)) {
    rets = [body]; // an arrow's expression body: the one implicit return, no ReturnStatement node at all
  } else {
    const returns = allReturns(fn);
    if (!returns || returns.length === 0 || returns.some((r) => !r.expression)) return false;
    rets = returns.map((r) => r.expression!);
  }
  const sequences: Part[][] = [];
  for (const ret of rets) {
    const branches = collectBranches(ret);
    if (!branches) return false;
    sequences.push(...branches);
  }
  const kinds = sequences.map((seq) => classifyOriginLeaf(seq, param.text));
  if (kinds.some((k) => k === "other")) return false;
  if (kinds.length === 1) return kinds[0] !== "path-free-origin";
  return kinds.includes("location-origin");
}

/** Names of local origin-wrapper functions/arrows in `sf` (see `isOriginWrapper`) — the only calls
 * `unwrapOneCall` unwraps. */
function originWrapperNamesIn(sf: ts.SourceFile): Set<string> {
  return new Set(topLevelFunctions(sf).filter(({ fn }) => isOriginWrapper(fn)).map(({ name }) => name));
}

/** `expr` itself when it is already something `collect` can decompose (template/string/`+`-concat), or —
 * when it is instead a one-argument call to a known local origin wrapper (`originWrappers`, e.g.
 * `sameOrigin(\`/api/${x}\`)`) — that inner argument. One level only: the same convention `paramName`
 * (above) already uses for a URL's own leading base expression. Any other one-argument call
 * (`withVersion(...)`, not a recognised origin wrapper) is left as-is, so it falls through to `collect`'s
 * own opaque "{expr}" handling and the factory is correctly not folded. */
function unwrapOneCall(expr: ts.Expression, originWrappers: Set<string>): ts.Expression {
  if (ts.isCallExpression(expr) && expr.arguments.length === 1 && ts.isIdentifier(expr.expression) && originWrappers.has(expr.expression.text)) {
    const inner = expr.arguments[0]!;
    if (
      ts.isTemplateExpression(inner) || ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ||
      (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) return inner;
  }
  return expr;
}

/** The baseUrl/baseURL/prefixUrl option of a call that creates an HTTP client, and a label for it: the
 * usual `<receiver>.create(...)`/`.extend(...)` shape `detectHttpClients` itself matches (a known library,
 * or any receiver whose call has a base option), or a bare call (`createClient(...)`) whose object
 * argument has one of those options AND whose own callee is a known HTTP client import (review fix: see
 * `isImportedBareFactory` — a base option alone is no longer enough for a bare call). */
function clientFactoryCall(
  expr: ts.Expression, aliases: Map<string, string>, imports: Map<string, { from: string; name: string }>,
): { baseUrl: ts.Expression; factory: string } | undefined {
  if (!ts.isCallExpression(expr)) return undefined;
  const [opts] = expr.arguments;
  const obj = opts && ts.isObjectLiteralExpression(opts) ? opts : undefined;
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const receiver = resolveClientReceiver(expr.expression.expression, aliases);
    const factory = receiver && clientFactory(receiver.knownLib ?? receiver.name, expr.expression.name.text);
    if (!factory || (!receiver!.knownLib && !hasBaseOption(obj))) return undefined;
    const baseUrl = baseOption(obj);
    return baseUrl ? { baseUrl, factory } : undefined;
  }
  if (ts.isIdentifier(expr.expression) && hasBaseOption(obj) && isImportedBareFactory(expr.expression.text, aliases, imports)) {
    return { baseUrl: baseOption(obj)!, factory: expr.expression.text };
  }
  return undefined;
}

/** Every local single-parameter function/arrow in `sf` whose body creates an HTTP client through that
 * parameter (and never reassigns it — `isMutated`), keyed by the factory's own name; a factory whose
 * baseUrl has any dynamic piece other than its own parameter (another free variable, a second parameter,
 * a non-origin-wrapper call, ...) is left out — not foldable from a call site alone. */
function clientFactoriesIn(
  sf: ts.SourceFile, aliases: Map<string, string>, imports: Map<string, { from: string; name: string }>,
): Map<string, ClientFactory> {
  const originWrappers = originWrapperNamesIn(sf);
  const out = new Map<string, ClientFactory>();
  for (const { name, fn } of topLevelFunctions(sf)) {
    if (fn.parameters.length !== 1) continue;
    const param = fn.parameters[0]!.name;
    if (!ts.isIdentifier(param) || isMutated(fn, param.text)) continue;
    const ret = factoryReturnExpr(fn);
    const call = ret && clientFactoryCall(ret, aliases, imports);
    if (!call) continue;
    const parts: Part[] = [];
    if (!collect(unwrapOneCall(call.baseUrl, originWrappers), parts)) continue;
    const folded: ClientFactory["parts"] = [];
    let ok = true;
    for (const p of parts) {
      if ("text" in p) {
        folded.push(p);
        continue;
      }
      if (!ts.isIdentifier(p.expr) || p.expr.text !== param.text) {
        ok = false;
        break;
      }
      folded.push({ param: true });
    }
    if (ok) out.set(name, { paramName: param.text, parts: folded, factory: call.factory });
  }
  return out;
}

/** `const apiClient = backendClient('api')` (module scope, `backendClient` a factory found in the same
 * file, a literal argument): the client that call would create, with the literal folded into the
 * factory's own baseUrl template — `web/lib/api-client.ts`'s `backendClient('api')` becomes a client named
 * "apiClient" with `baseLiteral: "/api/api"`. A non-literal argument, or a name that is not a known
 * factory, yields nothing (unresolved, as before). */
function detectClientFactoryCalls(
  sf: ts.SourceFile, rel: string, aliases: Map<string, string>, imports: Map<string, { from: string; name: string }>,
): HttpClient[] {
  const factories = clientFactoriesIn(sf, aliases, imports);
  if (factories.size === 0) return [];
  const out: HttpClient[] = [];
  for (const stmt of sf.statements) {
    // review fix: the module-level binding must be `const` — `export let apiClient = f("api"); apiClient
    // = other();` would make this name mean something other than the folded factory call's own result.
    if (!ts.isVariableStatement(stmt) || (stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isCallExpression(d.initializer) || !ts.isIdentifier(d.initializer.expression)) continue;
      const fac = factories.get(d.initializer.expression.text);
      const [argNode] = d.initializer.arguments;
      const arg = argNode && stringValue(argNode);
      if (!fac || arg === undefined) continue;
      const literal = fac.parts.map((p) => ("text" in p ? p.text : arg)).join("");
      const baseHost = absoluteHost(literal);
      out.push({
        name: d.name.text, file: rel, line: lineOf(stmt), factory: fac.factory,
        baseLiteral: normalizePath(literal),
        ...(baseHost !== undefined ? { baseHost } : {}),
      });
    }
  }
  return out;
}

export function detectHttpClients(file: ParsedFile): HttpClient[] {
  if (!file.sf) return [];
  const aliases = collectKnownLibAliases(file.sf);
  const imports = importedBindings(file.sf);
  const env = envConsts(file.sf);
  const out: HttpClient[] = [];
  walk(file.sf, (node) => {
    // v0.2a §4: `const api = createApi({ baseQuery: fetchBaseQuery({ baseUrl }) , … })` is a client named `api`.
    if (ts.isCallExpression(node) && lastName(node.expression) === "createApi" && rtkUsesFetchBaseQuery(node)
      && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      const baseNode = rtkBaseUrl(node);
      const literal = baseNode && stringValue(baseNode);
      const baseHost = literal !== undefined ? absoluteHost(literal) : undefined;
      out.push({
        name: node.parent.name.text, file: file.rel, line: lineOf(node), factory: "rtk-query",
        ...(baseNode && literal === undefined ? { baseExpr: env.get(baseNode.getText()) ?? baseNode.getText() } : {}),
        ...(literal !== undefined ? { baseLiteral: normalizePath(literal) } : {}),
        ...(baseHost !== undefined ? { baseHost } : {}),
      });
      return;
    }
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
      ...(baseNode && literal === undefined ? { baseExpr: env.get(baseNode.getText()) ?? baseNode.getText() } : {}),
      ...(literal !== undefined ? { baseLiteral: normalizePath(literal) } : {}),
      ...(baseHost !== undefined ? { baseHost } : {}),
    });
  });
  out.push(...detectClientFactoryCalls(file.sf, file.rel, aliases, imports));
  return out;
}

/** Top-level names other files can import each local name under: `export const x`, `export { x as y }`,
 * `export default x` ("default"). */
function moduleExportNames(sf: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (local: string, exported: string) => out.set(local, [...(out.get(local) ?? []), exported]);
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d.name.text);
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) add((el.propertyName ?? el.name).text, el.name.text);
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
      add(stmt.expression.text, "default");
    }
  }
  return out;
}

/** detectHttpClients plus, for each top-level instance, the names it is exported under (for imported-call checks). */
export function detectHttpClientDrafts(file: ParsedFile): HttpClientDraft[] {
  const clients = detectHttpClients(file);
  if (!file.sf || clients.length === 0) return clients;
  const exports = moduleExportNames(file.sf);
  return clients.map((c) => {
    const names = exports.get(c.name);
    return names ? { ...c, exportNames: names } : c;
  });
}
