import ts from "typescript";
import type { HttpCall, HttpClient, HttpMethod } from "../store/schemas.js";
import { absoluteHost, enclosingSymbol, isRouterName, lastName, lineOf, normalizePath, pathPattern, prop, stringValue, walk } from "./ast.js";
import type { HttpCallDraft, HttpClientDraft, ParsedFile, ReExportDraft } from "./types.js";

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
  const method = isSuperagent ? SUPERAGENT_METHODS[name] : METHODS[name];
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

export function detectHttpCalls(file: ParsedFile): HttpCall[] {
  if (!file.sf) return [];
  const superagent = superagentReceivers(file.sf);
  const scope = clientScope(file);
  const out: HttpCall[] = [];
  walk(file.sf, (node) => {
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
    } else if (ts.isPropertyAccessExpression(callee) && METHODS[callee.name.text]) {
      shape = { method: METHODS[callee.name.text], urlExpr: first, client: local, methodStyle: true };
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

export function detectHttpClients(file: ParsedFile): HttpClient[] {
  if (!file.sf) return [];
  const aliases = collectKnownLibAliases(file.sf);
  const env = envConsts(file.sf);
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
      ...(baseNode && literal === undefined ? { baseExpr: env.get(baseNode.getText()) ?? baseNode.getText() } : {}),
      ...(literal !== undefined ? { baseLiteral: normalizePath(literal) } : {}),
      ...(baseHost !== undefined ? { baseHost } : {}),
    });
  });
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
