import ts from "typescript";

export const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

export function parseSource(file: string, content: string): ts.SourceFile {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file)
      ? ts.ScriptKind.JSX
      : /\.(ts|mts|cts)$/.test(file)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
}

/** Calls that create a router/server (express(), express.Router(), Router(), fastify(), Fastify()). */
export const ROUTER_FACTORY_RE = /^(express|express\.Router|Router|fastify|Fastify)$/;

/** Factories that create a whole app/server rather than a mountable sub-router. */
export const APP_FACTORY_RE = /^(express|fastify|Fastify)$/;

/** Methods that return the router itself, so `Router().use(a).get(...)` is still that router. */
const ROUTER_CHAIN_METHODS = new Set(["use", "get", "post", "put", "patch", "delete", "del", "all", "options", "head"]);

/** Strips `.use(...)` / `.get(...)`-style self-returning calls off `expr`: `Router().use(a).use(b)` -> `Router()`,
 * `router.use(a)` -> `router`. Anything else is returned unchanged. */
export function unwrapRouterChain(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    ROUTER_CHAIN_METHODS.has(cur.expression.name.text) &&
    !ROUTER_FACTORY_RE.test(cur.expression.getText())
  ) {
    cur = cur.expression.expression;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  }
  return cur;
}

/** The router-factory call at the root of `expr` (`Router()` in `Router().use(a)`), if there is one. */
export function routerFactoryRoot(expr: ts.Expression | undefined): ts.CallExpression | undefined {
  if (!expr) return undefined;
  const root = unwrapRouterChain(expr);
  return ts.isCallExpression(root) && ROUTER_FACTORY_RE.test(root.expression.getText()) ? root : undefined;
}

function isRouterFactoryCall(expr: ts.Expression | undefined): boolean {
  return routerFactoryRoot(expr) !== undefined;
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

/** Does this binding name (plain identifier, or an object/array pattern, possibly nested/renamed) bind `name`? */
function bindingBinds(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindingBinds(el.name, target));
}

/** A declaration of `name` directly inside this block/source file's own statements (not nested functions). */
type DeclMatch = { destructured: false; decl: ts.VariableDeclaration } | { destructured: true };

function findVarDecl(statements: ts.NodeArray<ts.Statement>, name: string): DeclMatch | undefined {
  for (const stmt of statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        if (decl.name.text === name) return { destructured: false, decl };
      } else if (bindingBinds(decl.name, name)) {
        // Destructured out of some call's result; such a binding is never a router-factory call here.
        return { destructured: true };
      }
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
export function isRouterName(node: ts.Node, name: string): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    const params = functionParams(cur);
    if (params?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return false;
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      const match = findVarDecl(cur.statements, name);
      if (match) return match.destructured ? false : isRouterFactoryCall(match.decl.initializer);
    }
    cur = cur.parent;
  }
  return false;
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

export function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function memberName(name: ts.Node | undefined): string {
  if (!name) return "<member>";
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return name.getText();
}

export function className(cls: ts.ClassLikeDeclaration): string {
  return cls.name?.text ?? "<anonymous>";
}

/** Is `expr` the expression `module.exports`? */
export function isModuleExports(expr: ts.Node): boolean {
  return ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) &&
    expr.expression.text === "module" && expr.name.text === "exports";
}

/** The name an object literal's methods are keyed on: `const name = { ... }` -> "name",
 * `module.exports = { ... }` / `export = { ... }` -> "exports", `export default { ... }` -> "default". */
export function objectName(obj: ts.Node): string | undefined {
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.parent;
  if (!p) return undefined;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isBinaryExpression(p) && p.right === obj && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExports(p.left)) {
    return "exports";
  }
  if (ts.isExportAssignment(p)) return p.isExportEquals ? "exports" : "default";
  return undefined;
}

/** What a CommonJS assignment target exports: `exports.x` / `module.exports.x` -> "x",
 * `module.exports` -> "default"; undefined for any other expression. */
export function commonJsExportName(left: ts.Node): string | undefined {
  if (isModuleExports(left)) return "default";
  if (
    ts.isPropertyAccessExpression(left) &&
    ((ts.isIdentifier(left.expression) && left.expression.text === "exports") || isModuleExports(left.expression))
  ) {
    return left.name.text;
  }
  return undefined;
}

/** For a function/class expression that is the right side of `x = <expr>`: the CommonJS export name
 * of `x` (see commonJsExportName), else undefined. */
export function commonJsAssignedName(expr: ts.Node): string | undefined {
  const p = expr.parent;
  if (!p || !ts.isBinaryExpression(p) || p.right !== expr || p.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  return commonJsExportName(p.left);
}

function isMethodLike(n: ts.Node): n is ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);
}

/** The symbol name of a function-like node, or undefined when it has none of its own (anonymous
 * callbacks etc.). The single naming rule shared by enclosingSymbol and the linker's code index. */
export function functionLikeName(cur: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(cur)) {
    // `export default function () {}` has no name of its own: it is the module's "default".
    return cur.name?.text ?? (ts.getModifiers(cur)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : undefined);
  }
  if (isMethodLike(cur)) {
    if (ts.isClassLike(cur.parent)) return `${className(cur.parent)}.${memberName(cur.name)}`;
    const obj = objectName(cur.parent);
    if (obj) return `${obj}.${memberName(cur.name)}`;
  }
  if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent) {
    const p = cur.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyDeclaration(p) && ts.isClassLike(p.parent)) return `${className(p.parent)}.${memberName(p.name)}`;
    if (ts.isPropertyAssignment(p)) {
      const obj = objectName(p.parent);
      if (obj) return `${obj}.${memberName(p.name)}`;
    }
    // `exports.x = function () {}` / `module.exports.x = () => {}` -> "x" (the property, like a const's
    // variable name); `module.exports = function main() {}` -> "main", anonymous -> "default".
    const cjs = commonJsAssignedName(cur);
    if (cjs !== undefined) return cjs === "default" && ts.isFunctionExpression(cur) && cur.name ? cur.name.text : cjs;
    // `export default () => {}` / `export = function () {}`.
    if (ts.isExportAssignment(p)) return ts.isFunctionExpression(cur) && cur.name ? cur.name.text : "default";
    // v0.2a §4: `this.handleX = (…) => {…}` in a class constructor -> "Class.handleX".
    const ctorField = constructorFieldOf(cur);
    if (ctorField) return `${className(ctorField.cls)}.${ctorField.field}`;
    // v0.2a §4: `const fetchX = createAsyncThunk("x", async (…) => {…})` -> "fetchX".
    const thunk = asyncThunkOf(cur);
    if (thunk) return thunk.name;
    if (ts.isFunctionExpression(cur) && cur.name) return cur.name.text;
  }
  const rtk = rtkEndpointOf(cur);
  if (rtk) return `${rtk.api}.${rtk.endpoint}`;
  return undefined;
}

/** `this.<field> = <fn>` as a statement directly in a class constructor's body: the class and the field. */
export function constructorFieldOf(fn: ts.Node): { cls: ts.ClassLikeDeclaration; field: string } | undefined {
  const p = fn.parent;
  if (!p || !ts.isBinaryExpression(p) || p.right !== fn || p.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  if (!ts.isPropertyAccessExpression(p.left) || p.left.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  const stmt = p.parent;
  const block = stmt?.parent;
  const ctor = block?.parent;
  if (!stmt || !ts.isExpressionStatement(stmt) || !block || !ts.isBlock(block) || !ctor || !ts.isConstructorDeclaration(ctor)) return undefined;
  return ts.isClassLike(ctor.parent) ? { cls: ctor.parent, field: p.left.name.text } : undefined;
}

/** `createAsyncThunk(type, <fn>)` (Redux Toolkit) assigned to `const <name>`: the variable declaration and name. */
export function asyncThunkOf(fn: ts.Node): { decl: ts.VariableDeclaration; name: string } | undefined {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[1] !== fn || lastName(call.expression) !== "createAsyncThunk") return undefined;
  const decl = call.parent;
  return decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? { decl, name: decl.name.text } : undefined;
}

export interface RtkEndpoint {
  /** The variable the `createApi(…)` result is assigned to. */
  api: string;
  endpoint: string;
  kind: "query" | "mutation";
  createApi: ts.CallExpression;
}

/** The object an arrow/function returns: its expression body, or the single `return <expr>` of its block. */
function returnedObject(fn: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isMethodDeclaration(fn)) return undefined;
  let e: ts.Node | undefined = fn.body;
  if (e && ts.isBlock(e)) {
    const rets = e.statements.filter(ts.isReturnStatement);
    e = e.statements.length === 1 && rets.length === 1 ? rets[0]!.expression : undefined;
  }
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  return e && ts.isObjectLiteralExpression(e) ? e : undefined;
}

/** A property of an object literal (assignment or method) named `key`. */
function objectMember(obj: ts.Node, key: string): ts.Node | undefined {
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  return obj.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && memberName(p.name) === key);
}

/** RTK Query (v0.2a §4): `fn` is the `query` function of endpoint `x` in
 * `const api = createApi({ …, endpoints: (b) => ({ x: b.query({ query: (id) => … }) }) })` (or `b.mutation`, or a
 * `query(id) {…}` method). The builder must be the `endpoints` function's own first parameter. */
export function rtkEndpointOf(fn: ts.Node): RtkEndpoint | undefined {
  let prop: ts.Node;
  if (ts.isMethodDeclaration(fn)) prop = fn;
  else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent && ts.isPropertyAssignment(fn.parent)) prop = fn.parent;
  else return undefined;
  if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) return undefined;
  if (memberName(prop.name) !== "query") return undefined;
  const def = prop.parent.parent;
  if (!def || !ts.isCallExpression(def) || def.arguments[0] !== prop.parent || !ts.isPropertyAccessExpression(def.expression)) return undefined;
  const kind = def.expression.name.text;
  if (kind !== "query" && kind !== "mutation") return undefined;
  const builder = def.expression.expression;
  const endpointProp = def.parent;
  if (!endpointProp || !ts.isPropertyAssignment(endpointProp) || endpointProp.initializer !== def) return undefined;
  const endpoint = memberName(endpointProp.name);
  // Up from the endpoints object to the function returning it.
  let up: ts.Node | undefined = endpointProp.parent.parent;
  while (up && (ts.isParenthesizedExpression(up) || ts.isReturnStatement(up) || ts.isBlock(up))) up = up.parent;
  if (!up || returnedObject(up) !== endpointProp.parent) return undefined;
  const endpointsFn = up as ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
  const param = endpointsFn.parameters[0];
  if (!param || !ts.isIdentifier(param.name) || !ts.isIdentifier(builder) || builder.text !== param.name.text) return undefined;
  const endpointsProp = ts.isMethodDeclaration(endpointsFn) ? endpointsFn : endpointsFn.parent;
  if (!endpointsProp || (!ts.isPropertyAssignment(endpointsProp) && !ts.isMethodDeclaration(endpointsProp))) return undefined;
  if (memberName(endpointsProp.name) !== "endpoints") return undefined;
  const createApi = endpointsProp.parent.parent;
  if (!createApi || !ts.isCallExpression(createApi) || createApi.arguments[0] !== endpointsProp.parent || lastName(createApi.expression) !== "createApi") {
    return undefined;
  }
  const decl = createApi.parent;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return undefined;
  return { api: decl.name.text, endpoint, kind, createApi };
}

/** RTK Query: the `baseQuery: fetchBaseQuery({ baseUrl })` option of a `createApi({…})` call, as the expression. */
export function rtkBaseUrl(createApi: ts.CallExpression): ts.Expression | undefined {
  const opts = createApi.arguments[0];
  const bq = opts && objectMember(opts, "baseQuery");
  const init = bq && ts.isPropertyAssignment(bq) ? bq.initializer : undefined;
  if (!init || !ts.isCallExpression(init) || lastName(init.expression) !== "fetchBaseQuery") return undefined;
  const arg = init.arguments[0];
  const url = arg && objectMember(arg, "baseUrl");
  return url && ts.isPropertyAssignment(url) ? url.initializer : undefined;
}

export function enclosingSymbol(node: ts.Node): string {
  for (let cur = node.parent; cur; cur = cur.parent) {
    const name = functionLikeName(cur);
    if (name !== undefined) return name;
  }
  return "<module>";
}

export function stringValue(expr: ts.Node | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return undefined;
}

export function prop(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, "") === key) return p.initializer;
  }
  return undefined;
}

export function rootName(expr: ts.Expression): string {
  let cur: ts.Expression = expr;
  let afterThis = "";
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      if (cur.expression.kind === ts.SyntaxKind.ThisKeyword) afterThis = cur.name.text;
      cur = cur.expression;
    } else if (ts.isCallExpression(cur) || ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else break;
  }
  if (cur.kind === ts.SyntaxKind.ThisKeyword) return afterThis;
  return ts.isIdentifier(cur) ? cur.text : "";
}

export function lastName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  return "";
}

const BASE_RE = /(url|uri|api|base|host|origin|endpoint|server|domain|env)/i;
type Part = { text: string } | { expr: ts.Expression };

function collect(expr: ts.Expression, parts: Part[]): boolean {
  if (ts.isParenthesizedExpression(expr)) return collect(expr.expression, parts);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    parts.push({ text: expr.text });
    return true;
  }
  if (ts.isTemplateExpression(expr)) {
    if (expr.head.text) parts.push({ text: expr.head.text });
    for (const span of expr.templateSpans) {
      parts.push({ expr: span.expression });
      if (span.literal.text) parts.push({ text: span.literal.text });
    }
    return true;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return collect(expr.left, parts) && collect(expr.right, parts);
  }
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isCallExpression(expr) || ts.isElementAccessExpression(expr)) {
    parts.push({ expr });
    return true;
  }
  return false;
}

function paramName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isCallExpression(expr) && expr.arguments[0]) return paramName(expr.arguments[0]);
  return undefined;
}

const ABSOLUTE_HOST_RE = /^\s*[`'"]?[a-z][a-z0-9+.-]*:\/\/([^/'"`?#\s]+)/i;

/** Host (lowercased, port kept) of an absolute URL at the start of `text` — an optional leading quote
 * or backtick is allowed, so this works equally on raw source text (`call.raw`) and an already-unquoted
 * string value (a client's literal baseURL). Shared by http-calls.ts and the UI linker. */
export function absoluteHost(text: string): string | undefined {
  return text.match(ABSOLUTE_HOST_RE)?.[1]?.toLowerCase();
}

export function normalizePath(p: string): string {
  let s = p.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  s = s.split("?")[0]!.split("#")[0]!;
  s = s.replace(/\/{2,}/g, "/");
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Turn a URL expression into a route pattern. Undefined when it is only a variable (nothing literal).
 * A leading non-literal expression is treated as a stripped `base` when its own text matches BASE_RE
 * (looks like a url/host/env var) or when it is immediately followed by literal text starting with "/"
 * (a dynamic prefix is almost never how a real path parameter starts). `kind` is "literal" when every
 * remaining part (after stripping the base) is literal text, "template" when any part remains dynamic. */
export function pathPattern(
  expr: ts.Expression,
): { path: string; resolved: boolean; kind: "literal" | "template"; base?: string } | undefined {
  const parts: Part[] = [];
  if (!collect(expr, parts)) return undefined;
  if (!parts.some((p) => "text" in p)) return undefined;

  let base: string | undefined;
  let rest = parts;
  const [first, second] = parts;
  if (first && !("text" in first)) {
    const text = first.expr.getText();
    const followedBySlash = !!second && "text" in second && second.text.startsWith("/");
    if (BASE_RE.test(text) || followedBySlash) {
      base = text;
      rest = parts.slice(1);
    }
  }

  let out = "";
  let resolved = true;
  let hasExpr = false;
  for (const p of rest) {
    if ("text" in p) {
      out += p.text;
      continue;
    }
    hasExpr = true;
    const name = paramName(p.expr);
    if (name === undefined) {
      resolved = false;
      out += ":param";
    } else out += `:${name}`;
  }
  return {
    path: normalizePath(out),
    resolved,
    kind: hasExpr ? "template" : "literal",
    ...(base !== undefined ? { base } : {}),
  };
}

export function fileRoute(segments: string[]): string {
  const out = segments
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"))
    .map((s) => {
      const rest = s.match(/^\[\[?\.\.\.(.+?)\]\]?$/);
      if (rest) return `:${rest[1]}*`;
      const dyn = s.match(/^\[(.+)\]$/);
      if (dyn) return `:${dyn[1]}`;
      return s;
    });
  return normalizePath(out.join("/"));
}

export function pascal(s: string): string {
  return s
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

export function snakePlural(className: string): string {
  const snake = className.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (/[^aeiou]y$/.test(snake)) return `${snake.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(snake)) return `${snake}es`;
  return `${snake}s`;
}
