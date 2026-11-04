import ts from "typescript";
import {
  asyncThunkOf, className, commonJsAssignedName, constructorFieldOf, enclosingSymbol, functionLikeName, isModuleExports, lastName, lineOf,
  objectName, rtkEndpointOf, stringValue, walk,
} from "../adapters/ast.js";
import type { ParsedFile } from "../adapters/types.js";
import { httpCallShape, superagentReceivers } from "../adapters/http-calls.js";
import { pathPattern } from "../adapters/ast.js";
import { type ConfigArg, configArgsOf, configWrapperCandidate } from "./config-wrappers.js";
import type { HttpMethod } from "../store/schemas.js";
import { compare } from "../util.js";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "object-method";
  lines: [number, number];
  exported: boolean;
  /** True only when `name` really binds in the file's scope, so a bare `name()` call there can mean it:
   * function declarations, const/let/var-declared functions, named class declarations, and their
   * methods. False for CommonJS property names (`exports.x = function () {}`), a function expression's
   * own name outside a declaration (`module.exports = function main() {}`), and "default" names. */
  binding: boolean;
  /** The preferred export alias when it differs from `name` ("default" wins over a rename). */
  exportedAs?: string;
  /** Functions/classes: every name other files can import this symbol under ("default" for the default
   * export). Own `name` is included only when actually exported under it. Absent when not exported. */
  exportNames?: string[];
  /** v0.2a §4: the function is handed to a Redux Toolkit factory — a `createAsyncThunk` payload creator, or an RTK
   * Query endpoint's `query` function. Calling the name does not run it directly, so a hop to it is at best "param". */
  factory?: "createAsyncThunk" | "rtk-query";
}

export type ImportBinding =
  | { local: string; kind: "named"; imported: string; from: string }
  | { local: string; kind: "default"; from: string }
  | { local: string; kind: "namespace"; from: string };

export type ReExport =
  | { kind: "all"; from: string }
  | { kind: "named"; exported: string; imported: string; from: string };

export interface ClassField {
  className: string;
  field: string;
  typeName: string;
}

/** A name bound to one key of a hook's result (H10): in `const { handleSubmit, onDelete: remove } =
 * useCustomerForm()`, `remove` is `{ hook: "useCustomerForm", key: "onDelete" }`. v0.2a: `key` is a path —
 * nested destructuring joins keys with "." and array positions read "[i]" (`const [save] = useX()` -> "[0]",
 * `const { form: { submit } } = useX()` -> "form.submit"). */
export interface HookKey {
  hook: string;
  key: string;
}

export type Callee =
  | {
    kind: "ident"; name: string;
    /** Set when the nearest declaration of `name` in scope destructures it from a hook call (H10). */
    hook?: HookKey;
  }
  | {
    kind: "member"; object: string; prop: string;
    /** Set when the nearest declaration of `object` in scope is `const object = useX()` (H10): the hook's name. */
    hook?: string;
    /** Set with `hook` when `object` is itself one key of the hook's result (`const { form } = useX()`):
     * that key, so `form.submit` reads key "form.submit". */
    hookKey?: string;
    /** What the receiver is known to be from its nearest declaration in scope (H4): a type name from a
     * parameter/variable annotation (`q: Queue` -> "Queue", `ids: number[]` -> "Array", `s: string` ->
     * "String") or from its initializer (`[]` -> "Array", `{}` -> "Object", `new Map()` -> "Map", a string
     * literal -> "String"). Absent when unknown. The resolver never guesses onto a non-repo type. */
    recvType?: string;
    /** v0.2a §4: `object` is the first parameter of the named function `props` (a component's props object), so
     * `props.onX()` calls whatever the component is given as `onX` (connect's mapDispatchToProps, or a JSX prop). */
    props?: string;
  }
  | { kind: "new-member"; className: string; prop: string }
  | { kind: "this"; prop: string }
  | { kind: "this-field"; field: string; prop: string }
  | { kind: "other"; prop?: string; receiver?: string[] };

export interface CallSite {
  caller: string;
  line: number;
  callee: Callee;
  /** Absent for a real call. `"jsx-ref"`: not a call but a function handed to JSX (H3) — a JSX attribute
   * value that is a plain name / `this.x` / `obj.x` (`<form onSubmit={submitData}>`), or a component
   * tag (`<PostDetails />`). Resolved like a call, but at best "param" (it may never run).
   * `"fn-arg"`: not a call but a function handed over as a call argument (v0.2a) — `useMutation(saveCustomer)`,
   * `useQuery({ onSuccess: refresh })` — only when the outer callee is a local/imported function or a
   * hook-like `use*` name (never a member call like `ids.forEach(save)`). At best "param" too.
   * `"lifecycle"` (v0.2a §4): not a call but React running a class component's lifecycle method or `render`: the
   * caller is the class itself, the callee `this.<method>`. At best "param". */
  kind?: "jsx-ref" | "fn-arg" | "lifecycle";
  /** v0.2a §4: a jsx-ref that is a JSX attribute on a component tag (`<CustomerRow onRemove={this.remove} />`): the tag
   * name as written and the attribute, so the component's `this.props.onRemove()` can find what it is given. */
  jsxProp?: { tag: string; attr: string };
  /** Plain-identifier arguments that name a function/class declared in this file or an import binding —
   * a function handed over by reference, e.g. the `handleEmail` in `channel.consume("emails",
   * handleEmail)` — with their argument position. Absent when none. */
  refArgs?: Array<{ index: number; name: string }>;
  /** Arguments with literal URL text (`'/user'`, `` `/articles/${slug}` ``), as route patterns, so a call to an
   * HTTP wrapper (resolved later by the linker) can become an HTTP call. Absent when none. */
  urlArgs?: UrlArg[];
  /** `{ method, url }` config arguments, for a call to a config-object wrapper (config-wrappers.ts). Absent when none. */
  configArgs?: ConfigArg[];
}

export interface UrlArg {
  index: number;
  path: string;
  kind: "literal" | "template";
  resolved: boolean;
  raw: string;
  base?: string;
}

/**
 * A function whose body makes one HTTP call whose URL is its own parameter, alone or after a base
 * (`` `${BASE}${url}` `` / `BASE + url`): calls to it with a literal URL argument are HTTP calls (H2).
 */
export interface HttpWrapper {
  symbol: string;
  /** Index of the parameter carrying the URL. */
  param: number;
  method: HttpMethod;
  client: string;
  /** Source text of the base expression, when it is not a same-file string constant. */
  base?: string;
  /** The base's value when it is a top-level `const X = "<string>"` in the same file. */
  baseLiteral?: string;
  /** Config-object wrapper (config-wrappers.ts): `param` carries a `{ method, url }` config. */
  config?: true;
  methodFixed?: true;
  line?: number;
}

export interface FileCodeIndex {
  symbols: CodeSymbol[];
  imports: ImportBinding[];
  reExports: ReExport[];
  classFields: ClassField[];
  localNews: Array<{ caller: string; local: string; className: string }>;
  calls: CallSite[];
  /** CommonJS `module.exports = obj` / `export = obj` where `obj` is a local object literal: its name,
   * so `require("./x").m()` / a default import's `x.m()` resolve to `obj.m`. */
  defaultObject?: string;
  /** HTTP wrapper functions declared in this file (source order). Absent when none. */
  wrappers?: HttpWrapper[];
  /** Properties of a named object literal (`export default {…}` -> "default", `module.exports = {…}` ->
   * "exports", `const x = {…}` -> "x") that are a plain identifier: shorthand `{ Articles }` or
   * `{ Labels: Tags }`. Lets `agent.Articles.all()` follow the default object to `Articles.all` (H3b).
   * Source order. Absent when none. */
  objectRefs?: Array<{ object: string; prop: string; local: string }>;
  /** Handlers a hook (a function named `use[A-Z]…`) returns under a key, when every value it returns is an
   * object literal (H10). Sorted by hook, then key. Absent when none. */
  hookReturns?: HookReturn[];
  /** v0.2a §4: `export default connect(…)(Customer)` / `withRouter(Customer)` / `module.exports = memo(Customer)`: the
   * local component a higher-order-component default export wraps. The default import stands for it. */
  defaultWraps?: string;
  /** v0.2a §4: Redux `connect(mapState, mapDispatch)(Component)` in this file. `fn`: mapDispatch is a function of this
   * file (its returned keys are recorded in hookReturns under its name); `object`: an object literal of plain names. */
  reduxConnects?: ReduxConnect[];
  /** v0.2a §4: RTK Query endpoints declared in this file (`const api = createApi({ endpoints: (b) => ({ x: b.query(…) }) })`);
   * each endpoint's `query` function is the symbol `<api>.<endpoint>`. Source order. */
  rtkEndpoints?: Array<{ api: string; endpoint: string; kind: "query" | "mutation" }>;
  /** v0.2a §4: generated hooks destructured from an RTK Query api (`export const { useGetCustomerQuery } = api`). */
  rtkHooks?: Array<{ local: string; api: string; exported: boolean; /** the generated name, when renamed */ key?: string }>;
}

export interface ReduxConnect {
  component: string;
  dispatch: { kind: "fn"; name: string } | { kind: "object"; props: Array<{ key: string; name: string }> };
}

/** What hook `hook` returns under `key`: a function named in the hook's file (`{ handleSubmit }` /
 * `{ handleSubmit: submit }` where `submit` is a function declared in the hook, or not declared in the hook at
 * all), or an inline function (`{ handleSubmit: async () => {…} }`, `{ reset() {…} }`, `useCallback(() => …)`,
 * or a const the hook sets to `useCallback(…)`). An inline function has no symbol of its own (its calls belong
 * to the hook), so it stands for the hook, with the function's lines. */
export interface HookReturn {
  hook: string;
  key: string;
  target: { kind: "name"; name: string } | { kind: "inline"; lines: [number, number] };
}

export type RepoCodeIndex = Map<string, FileCodeIndex>;

function endLineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function typeRefName(type: ts.TypeNode | undefined): string | undefined {
  return type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? type.typeName.text : undefined;
}

function newExpressionClass(expr: ts.Expression | undefined): string | undefined {
  return expr && ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) ? expr.expression.text : undefined;
}

/** Max property levels followed through objects of objects (`agent.Articles.all()` is one). */
export const MAX_OBJECT_LEVELS = 2;

/** `a.b` / `a.b.c` (an identifier then 1..MAX_OBJECT_LEVELS plain property names) -> ["a", "b"(, "c")]. */
function identifierChain(expr: ts.Expression): string[] | undefined {
  const names: string[] = [];
  let cur: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(cur)) {
    names.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur) || names.length === 0 || names.length > MAX_OBJECT_LEVELS) return undefined;
  return [cur.text, ...names];
}

/** A type annotation as a type name: `T[]` / `Array<T>` / tuples -> "Array", keyword and literal types ->
 * "String" / "Number" / "Boolean", `Foo<…>` -> "Foo". Undefined for anything else (unions, qualified names). */
function typeNodeName(type: ts.TypeNode | undefined): string | undefined {
  if (!type) return undefined;
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return "Array";
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return typeNodeName(type.type);
  if (ts.isParenthesizedTypeNode(type)) return typeNodeName(type.type);
  if (type.kind === ts.SyntaxKind.StringKeyword) return "String";
  if (type.kind === ts.SyntaxKind.NumberKeyword) return "Number";
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return "Boolean";
  if (ts.isLiteralTypeNode(type)) {
    const lit = type.literal;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) return "String";
    if (ts.isNumericLiteral(lit)) return "Number";
    if (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword) return "Boolean";
    return undefined;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    return name === "ReadonlyArray" ? "Array" : name;
  }
  return undefined;
}

/** A variable initializer as a type name: array / object / string / number / boolean literals and `new X()`. */
function initializerTypeName(init: ts.Expression | undefined): string | undefined {
  let e = init;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) {
    if (ts.isAsExpression(e)) return typeNodeName(e.type) ?? initializerTypeName(e.expression);
    e = e.expression;
  }
  if (!e) return undefined;
  if (ts.isArrayLiteralExpression(e)) return "Array";
  if (ts.isObjectLiteralExpression(e)) return "Object";
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return "String";
  if (ts.isNumericLiteral(e)) return "Number";
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "Boolean";
  return newExpressionClass(e);
}

function declaredIn(statements: ts.NodeArray<ts.Statement>, name: string): ts.VariableDeclaration | undefined {
  for (const st of statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
  }
  return undefined;
}

/** The receiver type of identifier `id` from its nearest declaration in scope: a parameter of an enclosing
 * function, or a variable declared directly in an enclosing block / the file. The nearest declaration wins
 * (shadowing), and one without a usable type gives undefined. */
function receiverTypeOf(id: ts.Identifier): string | undefined {
  const name = id.text;
  for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) {
      const p = cur.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
      if (p) return typeNodeName(p.type) ?? initializerTypeName(p.initializer);
    }
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur)) {
      const d = declaredIn(cur.statements, name);
      if (d) return typeNodeName(d.type) ?? initializerTypeName(d.initializer);
    }
  }
  return undefined;
}

function classify(expr: ts.Expression): Callee {
  if (ts.isIdentifier(expr)) {
    const hook = hookKeyOf(expr);
    return hook ? { kind: "ident", name: expr.text, hook } : { kind: "ident", name: expr.text };
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const prop = expr.name.text;
    const obj = expr.expression;
    if (obj.kind === ts.SyntaxKind.ThisKeyword) return { kind: "this", prop };
    if (ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return { kind: "this-field", field: obj.name.text, prop };
    }
    const newClass = newExpressionClass(obj);
    if (newClass) return { kind: "new-member", className: newClass, prop };
    if (ts.isIdentifier(obj)) {
      const hook = wholeHookOf(obj);
      if (hook !== undefined) return { kind: "member", object: obj.text, prop, hook };
      const keyed = hookKeyOf(obj);
      if (keyed) return { kind: "member", object: obj.text, prop, hook: keyed.hook, hookKey: keyed.key };
      const recvType = receiverTypeOf(obj);
      const props = propsOwnerOf(obj);
      return {
        kind: "member", object: obj.text, prop,
        ...(recvType !== undefined ? { recvType } : {}), ...(props !== undefined ? { props } : {}),
      };
    }
    const receiver = identifierChain(obj);
    return receiver ? { kind: "other", prop, receiver } : { kind: "other", prop };
  }
  if (ts.isElementAccessExpression(expr)) {
    const prop = stringValue(expr.argumentExpression);
    return prop !== undefined ? { kind: "other", prop } : { kind: "other" };
  }
  return { kind: "other" };
}

/** A local name exported under `as` ("default" for default exports). */
interface ExportMark {
  local: string;
  as: string;
}

function addField(idx: FileCodeIndex, f: ClassField): void {
  if (!idx.classFields.some((c) => c.className === f.className && c.field === f.field)) idx.classFields.push(f);
}

/** The VariableStatement a declaration sits directly in (not one further out). */
function ownVariableStatement(decl: ts.VariableDeclaration): ts.VariableStatement | undefined {
  const list = decl.parent;
  return list && ts.isVariableDeclarationList(list) && list.parent && ts.isVariableStatement(list.parent) ? list.parent : undefined;
}

/** A function/class symbol exported under `names` (none = not exported here; export lists and
 * CommonJS assignments elsewhere in the file are added by applyExportMarks). */
function plainSymbol(
  name: string, kind: "function" | "class", lines: [number, number], names: string[], binding: boolean,
): CodeSymbol {
  const sym: CodeSymbol = { name, kind, lines, exported: false, binding };
  for (const n of names) addExportName(sym, n);
  return sym;
}

function addExportName(s: CodeSymbol, as: string): void {
  const names = (s.exportNames ??= []);
  if (!names.includes(as)) names.push(as);
  s.exported = true;
  s.exportedAs = names.includes("default") ? "default" : names.find((n) => n !== s.name);
}

/** Names a declaration with export modifiers is exported under: `export default` -> "default",
 * `export` -> its own name. */
function modifierExportNames(node: ts.Node, name: string): string[] {
  return isExported(node) ? [isDefaultExport(node) ? "default" : name] : [];
}

/** Symbol for a function-like node already named by functionLikeName (the adapters' naming rule). */
function functionSymbol(node: ts.Node, name: string): CodeSymbol {
  const own: [number, number] = [lineOf(node), endLineOf(node)];
  if (ts.isFunctionDeclaration(node)) {
    return plainSymbol(name, "function", own, modifierExportNames(node, name), node.name !== undefined);
  }
  const p = node.parent;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    if (ts.isClassLike(p)) return { name, kind: "method", lines: own, exported: false, binding: classBinds(p) };
    return { name, kind: "object-method", lines: own, exported: objectExported(p), binding: objectBinds(p) };
  }
  // Arrow function / function expression.
  if (ts.isVariableDeclaration(p)) {
    const stmt = ownVariableStatement(p);
    return plainSymbol(name, "function", [lineOf(p), endLineOf(p)], stmt && isExported(stmt) ? [name] : [], true);
  }
  if (ts.isPropertyDeclaration(p)) {
    return { name, kind: "method", lines: [lineOf(p), endLineOf(p)], exported: false, binding: classBinds(p.parent) };
  }
  if (ts.isPropertyAssignment(p) && objectName(p.parent) !== undefined) {
    return { name, kind: "object-method", lines: own, exported: objectExported(p.parent), binding: objectBinds(p.parent) };
  }
  // v0.2a §4: `this.handleX = () => {…}` in a constructor is a method of the class.
  const ctorField = constructorFieldOf(node);
  if (ctorField) return { name, kind: "method", lines: own, exported: false, binding: classBinds(ctorField.cls) };
  // v0.2a §4: `const fetchX = createAsyncThunk("x", payloadCreator)` binds `fetchX` like a const function.
  const thunk = asyncThunkOf(node);
  if (thunk) {
    const stmt = ownVariableStatement(thunk.decl);
    const sym = plainSymbol(name, "function", [lineOf(thunk.decl), endLineOf(thunk.decl)], stmt && isExported(stmt) ? [name] : [], true);
    return { ...sym, factory: "createAsyncThunk" };
  }
  // v0.2a §4: an RTK Query endpoint's `query` function ("<api>.<endpoint>"), reached through generated hooks only.
  if (rtkEndpointOf(node)) return { ...plainSymbol(name, "function", own, [], false), factory: "rtk-query" };
  // Below, `name` is a CommonJS property, "default", or a function expression's own name (visible only
  // inside that function): none of them bind in the file's scope.
  // `exports.x = function () {}` (exported as x) / `module.exports = function main() {}` (as default).
  const cjs = commonJsAssignedName(node);
  if (cjs !== undefined) return plainSymbol(name, "function", own, [cjs], false);
  // `export default () => {}` / `export = function () {}`.
  if (ts.isExportAssignment(p)) return plainSymbol(name, "function", own, ["default"], false);
  return plainSymbol(name, "function", own, [], false);
}

/** Does a class's name bind in the file scope? Only a named class declaration does. */
function classBinds(cls: ts.Node): boolean {
  return ts.isClassDeclaration(cls) && cls.name !== undefined;
}

/** Does an object literal's name bind in the file scope? Only `const x = {…}` (not exports/default). */
function objectBinds(obj: ts.Node): boolean {
  return !!obj.parent && ts.isVariableDeclaration(obj.parent) && ts.isIdentifier(obj.parent.name);
}

/** Are an object literal's methods importable? `module.exports = {…}` / `export default {…}` always;
 * `const x = {…}` when its own statement is `export const` (local export lists are applied later). */
function objectExported(obj: ts.Node): boolean {
  const name = objectName(obj);
  if (name === undefined) return false;
  const p = obj.parent;
  if (!ts.isVariableDeclaration(p)) return true;
  const stmt = ownVariableStatement(p);
  return !!stmt && isExported(stmt);
}

/** `this.x = new X()` assignments in a constructor body, not looking inside nested class-likes or
 * non-arrow functions (their `this` is a different object). Arrow functions share the constructor's `this`. */
function constructorThisNews(body: ts.Node, visit: (field: string, typeName: string) => void): void {
  body.forEachChild(function scan(n: ts.Node): void {
    if (ts.isClassLike(n) || (ts.isFunctionLike(n) && !ts.isArrowFunction(n))) return;
    if (
      ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const typeName = newExpressionClass(n.right);
      if (typeName) visit(n.left.name.text, typeName);
    }
    n.forEachChild(scan);
  });
}

/** Mark local symbols named in export lists / `export default X` / CommonJS exports. A function or
 * class `local` gains export name `as`; an
 * object `local` exports its `local.*` object-methods. */
function applyExportMarks(idx: FileCodeIndex, marks: ExportMark[]): void {
  for (const { local, as } of marks) {
    for (const s of idx.symbols) {
      if (s.name === local && (s.kind === "function" || s.kind === "class")) {
        addExportName(s, as);
      } else if (s.kind === "object-method" && s.name.startsWith(`${local}.`)) {
        s.exported = true;
      }
    }
  }
}


const WRAPPER_NAME_METHODS: Record<string, HttpMethod> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", del: "DELETE",
};

/** The nearest enclosing function-like node, when it is named (the one enclosingSymbol names). An
 * unnamed function in between (a callback) ends the search: its own parameters may shadow the outer ones. */
function enclosingFunction(node: ts.Node): { node: ts.SignatureDeclaration; name: string } | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    const name = functionLikeName(cur);
    if (ts.isFunctionLike(cur)) return name !== undefined ? { node: cur, name } : undefined;
    if (name !== undefined) return undefined;
  }
  return undefined;
}

/** Top-level `const X = "<string>"` declarations. */
function stringConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of stmt.declarationList.declarations) {
      const v = stringValue(d.initializer);
      if (ts.isIdentifier(d.name) && v !== undefined) out.set(d.name.text, v);
    }
  }
  return out;
}

/** A base expression a wrapper may put before its URL parameter: a name or a dotted name. */
function isBaseExpr(e: ts.Expression): boolean {
  return ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && isBaseExpr(e.expression));
}

/** Split a wrapper URL into (base, parameter name): `p`, `` `${p}` ``, `` `${BASE}${p}` ``, `BASE + p`. */
function wrapperUrl(e: ts.Expression): { base?: ts.Expression; param: string } | undefined {
  if (ts.isParenthesizedExpression(e)) return wrapperUrl(e.expression);
  if (ts.isIdentifier(e)) return { param: e.text };
  if (ts.isTemplateExpression(e) && e.head.text === "" && e.templateSpans.every((s) => s.literal.text === "")) {
    const exprs = e.templateSpans.map((s) => s.expression);
    const last = exprs[exprs.length - 1]!;
    if (!ts.isIdentifier(last)) return undefined;
    if (exprs.length === 1) return { param: last.text };
    if (exprs.length === 2 && isBaseExpr(exprs[0]!)) return { base: exprs[0]!, param: last.text };
    return undefined;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isIdentifier(e.right) && isBaseExpr(e.left)) {
    return { base: e.left, param: e.right.text };
  }
  return undefined;
}

/** If `call` is an HTTP call whose URL is a parameter of its enclosing function, that function as a wrapper. */
function wrapperCandidate(
  call: ts.CallExpression, superagent: Set<string>, consts: Map<string, string>,
): HttpWrapper | undefined {
  const shape = httpCallShape(call, superagent);
  if (!shape) return undefined;
  const url = wrapperUrl(shape.urlExpr);
  if (!url) return undefined;
  const fn = enclosingFunction(call);
  if (!fn) return undefined;
  const params = fn.node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined));
  const param = params.indexOf(url.param);
  if (param < 0) return undefined;
  const baseText = url.base?.getText();
  // The base must not itself be a parameter (then the URL is fully caller-controlled in two parts).
  if (baseText !== undefined && params.includes(baseText)) return undefined;
  const ownName = fn.name.slice(fn.name.lastIndexOf(".") + 1).toLowerCase();
  const method = shape.method ?? WRAPPER_NAME_METHODS[ownName];
  if (!method) return undefined;
  const literal = url.base && ts.isIdentifier(url.base) ? consts.get(url.base.text) : undefined;
  return {
    symbol: fn.name, param, method, client: shape.client,
    ...(baseText !== undefined && literal === undefined ? { base: baseText } : {}),
    ...(literal !== undefined ? { baseLiteral: literal } : {}),
  };
}

/** Is `a` a path-like URL argument: a plain literal starting with "/", or a template/concatenation whose
 * literal text contains "/"? */
function pathLikeArg(a: ts.Expression): boolean {
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text.startsWith("/");
  if (ts.isTemplateExpression(a)) return [a.head.text, ...a.templateSpans.map((s) => s.literal.text)].some((t) => t.includes("/"));
  if (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken) return a.getText().includes("/");
  return false;
}

/** Literal-URL arguments of a call, as route patterns. Module specifiers (`require(...)`, `import(...)`) never count. */
function urlArgsOf(call: ts.CallExpression): UrlArg[] {
  const out: UrlArg[] = [];
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return out;
  if (ts.isIdentifier(call.expression) && call.expression.text === "require") return out;
  call.arguments.forEach((a, index) => {
    if (!pathLikeArg(a)) return;
    const pattern = pathPattern(a);
    if (!pattern) return;
    const raw = a.getText();
    out.push({
      index, path: pattern.path, kind: pattern.kind, resolved: pattern.resolved, raw,
      ...(pattern.base !== undefined ? { base: pattern.base } : {}),
    });
  });
  return out;
}

/** A JSX attribute value or tag that names a function by reference: a plain name, `this.x` or `obj.x`
 * (dotted names one level deep). Anything else (literals, calls, inline arrows) is not a reference. */
function isJsxRefExpr(e: ts.Node): e is ts.Identifier | ts.PropertyAccessExpression {
  if (ts.isIdentifier(e)) return true;
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) &&
    (ts.isIdentifier(e.expression) || e.expression.kind === ts.SyntaxKind.ThisKeyword || isThisProps(e.expression));
}

/** `this.props` (v0.2a §4: `onRemove={this.props.onRemove}` hands a prop on). */
function isThisProps(e: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(e) && e.name.text === "props" && e.expression.kind === ts.SyntaxKind.ThisKeyword;
}

/** The component tag and attribute name of a JSX attribute on a component element (`<CustomerRow onRemove={…}>`). */
function jsxPropOf(attr: ts.JsxAttribute): { tag: string; attr: string } | undefined {
  const el = attr.parent?.parent;
  if (!el || (!ts.isJsxOpeningElement(el) && !ts.isJsxSelfClosingElement(el))) return undefined;
  const tag = el.tagName;
  if (!ts.isIdentifier(tag) || !/^[A-Z]/.test(tag.text) || !ts.isIdentifier(attr.name)) return undefined;
  return { tag: tag.text, attr: attr.name.text };
}

/** The expression a JSX node hands over by reference, if any: `onX={handler}` attribute values, and
 * component tags (`<PostDetails …>` / `<Layout.Footer …>`; lower-case intrinsic tags like `<div>` are
 * not functions). Expression children (`{handler}`) are never references. */
function jsxRefOf(node: ts.Node): ts.Identifier | ts.PropertyAccessExpression | undefined {
  if (ts.isJsxAttribute(node)) {
    const init = node.initializer;
    if (init && ts.isJsxExpression(init) && init.expression && isJsxRefExpr(init.expression)) return init.expression;
    return undefined;
  }
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const tag = node.tagName;
    if (ts.isIdentifier(tag)) return /^[A-Z]/.test(tag.text) ? tag : undefined;
    return isJsxRefExpr(tag) ? tag : undefined;
  }
  return undefined;
}

/** The outer callee of a call whose arguments may hand functions over: a plain name (kept later only when it
 * is a local/imported function or a `use*` hook) -> that name; `ns.useX(…)` -> "". Undefined otherwise
 * (member calls like `ids.forEach(save)` / `p.then(load)` are built-in or library methods). */
function fnArgCallee(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text === "require" ? undefined : e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && HOOK_NAME_RE.test(e.name.text)) return "";
  return undefined;
}

/** Functions a call hands over by reference: arguments that are a plain name / `obj.x` / `this.x`, and such
 * values of an object-literal argument's properties (`{ onSuccess: refresh }`, shorthand `{ refresh }`). */
function fnArgRefs(call: ts.CallExpression): Array<ts.Identifier | ts.PropertyAccessExpression> {
  const out: Array<ts.Identifier | ts.PropertyAccessExpression> = [];
  for (const a of call.arguments) {
    if (isJsxRefExpr(a)) out.push(a);
    else if (ts.isObjectLiteralExpression(a)) {
      for (const p of a.properties) {
        if (ts.isShorthandPropertyAssignment(p)) out.push(p.name);
        else if (ts.isPropertyAssignment(p) && isJsxRefExpr(p.initializer)) out.push(p.initializer);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Hook handlers (H10)
// ---------------------------------------------------------------------------------------------------

/** React's naming rule for hooks: `use` then an upper-case letter or digit. */
const HOOK_NAME_RE = /^use[A-Z0-9]/;

function unwrapExpr(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** `useX(…)` (a plain-identifier hook call) -> "useX"; `ns.useX(…)` -> "ns.useX" (v0.2a: the resolver follows
 * it only when `ns` is a namespace import). */
function hookCallName(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  const call = unwrapExpr(e);
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return HOOK_NAME_RE.test(callee.text) ? callee.text : undefined;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && HOOK_NAME_RE.test(callee.name.text)
    ? `${callee.expression.text}.${callee.name.text}` : undefined;
}

/** The identifier binding `name` inside a binding name (`x`, `{ a, b: x }`, `[x]`, nested patterns). */
function bindingIdent(name: ts.BindingName, text: string): ts.Identifier | undefined {
  if (ts.isIdentifier(name)) return name.text === text ? name : undefined;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const hit = bindingIdent(el.name, text);
    if (hit) return hit;
  }
  return undefined;
}

/** The identifier that declares `name` directly in a statement list: a variable (also inside a binding
 * pattern), a function or a class declaration. */
function declaredInStatements(statements: ts.NodeArray<ts.Statement>, name: string): ts.Identifier | undefined {
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const hit = bindingIdent(d.name, name);
        if (hit) return hit;
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) {
      return st.name;
    }
  }
  return undefined;
}

/** The identifier of the nearest declaration of `id`'s name in scope: a parameter of an enclosing function,
 * a `for`/`catch` variable, or a declaration directly in an enclosing block / the file. The search stops after
 * `stop` (inclusive). Undefined when there is none (a global, or declared outside `stop`). */
function nearestDeclaration(id: ts.Identifier, stop?: ts.Node): ts.Identifier | undefined {
  const name = id.text;
  for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
    let hit: ts.Identifier | undefined;
    if (ts.isFunctionLike(cur)) {
      for (const p of cur.parameters) hit ??= bindingIdent(p.name, name);
    } else if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur)) {
      hit = declaredInStatements(cur.statements, name);
    } else if ((ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur)) && cur.initializer && ts.isVariableDeclarationList(cur.initializer)) {
      for (const d of cur.initializer.declarations) hit ??= bindingIdent(d.name, name);
    } else if (ts.isCatchClause(cur) && cur.variableDeclaration) {
      hit = bindingIdent(cur.variableDeclaration.name, name);
    }
    if (hit) return hit;
    if (cur === stop) return undefined;
  }
  return undefined;
}

/** `name` destructured from a hook call by its nearest declaration (`const { handleSubmit, onDelete: remove }
 * = useCustomerForm()`): the hook and the key path. Nested patterns (`{ form: { submit } }`) and array
 * patterns (`[save]`) are followed up to MAX_HOOK_KEY_DEPTH levels; rest elements (`...rest`) and computed
 * keys are not. */
function hookKeyOf(id: ts.Identifier): HookKey | undefined {
  const decl = nearestDeclaration(id);
  let el: ts.Node | undefined = decl?.parent;
  if (!el || !ts.isBindingElement(el)) return undefined;
  const path: string[] = [];
  for (;;) {
    if (!ts.isBindingElement(el) || el.dotDotDotToken) return undefined;
    const pattern: ts.Node = el.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      const prop = el.propertyName;
      const key = !prop ? (ts.isIdentifier(el.name) ? el.name.text : undefined)
        : ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : undefined;
      if (key === undefined) return undefined;
      path.unshift(key);
    } else if (ts.isArrayBindingPattern(pattern)) {
      path.unshift(`[${pattern.elements.indexOf(el as ts.BindingElement)}]`);
    } else return undefined;
    if (path.length > MAX_HOOK_KEY_DEPTH) return undefined;
    const up = pattern.parent;
    if (ts.isVariableDeclaration(up)) {
      const hook = hookCallName(up.initializer);
      return hook === undefined ? undefined : { hook, key: path.join(".") };
    }
    el = up;
  }
}

/** v0.2a §4: the name of the function whose first parameter `id` is, by its nearest declaration (a component's
 * `props`: `function CustomerRow(props) { … props.onRemove() }`). Undefined for anything else. */
function propsOwnerOf(id: ts.Identifier): string | undefined {
  const decl = nearestDeclaration(id);
  const param = decl?.parent;
  if (!param || !ts.isParameter(param) || param.name !== decl) return undefined;
  const fn = param.parent;
  const name = ts.isFunctionLike(fn) && fn.parameters[0] === param ? functionLikeName(fn) : undefined;
  // React's rule: a component's name starts with an upper-case letter.
  return name !== undefined && /^[A-Z]/.test(name) && !name.includes(".") ? name : undefined;
}

/** `object` bound by its nearest declaration to a whole hook result (`const form = useCustomerForm()`). */
function wholeHookOf(id: ts.Identifier): string | undefined {
  const decl = nearestDeclaration(id);
  const d = decl?.parent;
  return d && ts.isVariableDeclaration(d) && d.name === decl ? hookCallName(d.initializer) : undefined;
}

/** `useCallback(<function>, …)` -> the function. */
function useCallbackFn(e: ts.Expression): ts.FunctionLikeDeclaration | undefined {
  const call = unwrapExpr(e);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "useCallback") return undefined;
  const fn = call.arguments[0] && unwrapExpr(call.arguments[0]);
  return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
}

function inlineTarget(node: ts.Node): HookReturn["target"] {
  return { kind: "inline", lines: [lineOf(node), endLineOf(node)] };
}

/** What a returned property value stands for, or undefined when it is not a function we can name. */
function hookValueTarget(value: ts.Expression, hookFn: ts.Node): HookReturn["target"] | undefined {
  const v = unwrapExpr(value);
  if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return inlineTarget(v);
  const cb = useCallbackFn(v);
  if (cb) return inlineTarget(cb);
  if (!ts.isIdentifier(v)) return undefined;
  const decl = nearestDeclaration(v, hookFn);
  // Not declared in the hook: a module-level function or an import (the resolver checks which).
  if (!decl) return { kind: "name", name: v.text };
  const p = decl.parent;
  if (ts.isFunctionDeclaration(p)) return { kind: "name", name: v.text };
  if (ts.isVariableDeclaration(p) && p.name === decl && p.initializer) {
    const init = unwrapExpr(p.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { kind: "name", name: v.text };
    const fn = useCallbackFn(init);
    if (fn) return inlineTarget(fn);
  }
  // State, a parameter, a destructured value, another hook's result: not followed.
  return undefined;
}

/** The expressions a function returns (an arrow's expression body, else every `return` not inside a nested
 * function or class). Bare `return;` gives no expression. */
function returnedExprs(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  body.forEachChild(function scan(n: ts.Node): void {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    n.forEachChild(scan);
  });
  return out;
}

/** Max key-path segments followed into a hook's result (`form.submit`, `[0].pay`). */
const MAX_HOOK_KEY_DEPTH = 3;

/** Keys hook `hook` returns as handlers. Every returned value must be an object literal (or null / undefined),
 * or every one an array literal (v0.2a: keys "[0]", "[1]", …); any other return, or a mix of the two, makes
 * every key unknown. Object/array literals nested in the result are followed (keys "form.submit", "[0].pay")
 * up to MAX_HOOK_KEY_DEPTH levels. A key given two different targets is dropped; so is one a later spread
 * (`...base`) may override, an array position after a spread, and any key under a key that is also a plain
 * value somewhere. */
function hookReturnsOf(fn: ts.FunctionLikeDeclaration, hook: string): HookReturn[] {
  const byKey = new Map<string, HookReturn["target"] | null>();
  const set = (key: string, target: HookReturn["target"] | undefined): void => {
    const prev = byKey.get(key);
    if (prev === null) return;
    if (!target || (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(target))) byKey.set(key, null);
    else byKey.set(key, target);
  };
  /** Keys whose value is a nested literal (never handlers themselves). */
  const containers = new Set<string>();
  const collect = (lit: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, prefix: string[]): void => {
    const visit = (seg: string, value: ts.Expression | undefined, target: () => HookReturn["target"] | undefined): void => {
      const path = [...prefix, seg];
      const key = path.join(".");
      const v = value && unwrapExpr(value);
      if (v && (ts.isObjectLiteralExpression(v) || ts.isArrayLiteralExpression(v))) {
        containers.add(key);
        if (path.length < MAX_HOOK_KEY_DEPTH) collect(v, path);
        return;
      }
      set(key, target());
    };
    if (ts.isArrayLiteralExpression(lit)) {
      for (let i = 0; i < lit.elements.length; i++) {
        const el = lit.elements[i]!;
        if (ts.isSpreadElement(el)) break; // later positions are unknown
        if (ts.isOmittedExpression(el)) continue;
        visit(`[${i}]`, el, () => hookValueTarget(el, fn));
      }
      return;
    }
    const props = lit.properties;
    for (let i = 0; i < props.length; i++) {
      const p = props[i]!;
      if (ts.isSpreadAssignment(p)) continue;
      const key = ts.isShorthandPropertyAssignment(p) ? p.name.text : memberName(p.name);
      if (key === undefined) continue;
      if (props.slice(i + 1).some((q) => ts.isSpreadAssignment(q))) {
        set([...prefix, key].join("."), undefined);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(p)) visit(key, undefined, () => hookValueTarget(p.name, fn));
      else if (ts.isPropertyAssignment(p)) visit(key, p.initializer, () => hookValueTarget(p.initializer, fn));
      else visit(key, undefined, () => (ts.isMethodDeclaration(p) ? inlineTarget(p) : undefined));
    }
  };
  let shape: "object" | "array" | undefined;
  for (const raw of returnedExprs(fn)) {
    const e = unwrapExpr(raw);
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined")) continue;
    const kind = ts.isObjectLiteralExpression(e) ? "object" : ts.isArrayLiteralExpression(e) ? "array" : undefined;
    if (!kind || (shape !== undefined && shape !== kind)) return [];
    shape = kind;
    collect(e as ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, []);
  }
  // A key under a key that is a plain value (or unknown) in some other return is not trusted.
  const underValue = (key: string): boolean => {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i++) if (byKey.has(parts.slice(0, i).join("."))) return true;
    return false;
  };
  return [...byKey].flatMap(([key, target]) => (target && !containers.has(key) && !underValue(key) ? [{ hook, key, target }] : []));
}

// ---------------------------------------------------------------------------------------------------
// Class components, Redux connect, RTK Query hooks (v0.2a §4)
// ---------------------------------------------------------------------------------------------------

/** Lifecycle methods React itself calls on a class component (and `render`). */
const LIFECYCLE_METHODS = new Set([
  "render", "componentDidMount", "componentDidUpdate", "componentWillUnmount", "shouldComponentUpdate",
  "getSnapshotBeforeUpdate", "componentDidCatch", "componentWillMount", "UNSAFE_componentWillMount",
  "componentWillReceiveProps", "UNSAFE_componentWillReceiveProps", "componentWillUpdate", "UNSAFE_componentWillUpdate",
]);

/** A class that extends `Component` / `PureComponent` (`React.Component` too), or that extends another class and
 * declares one of React's own `component*` lifecycle methods (`class Favorites extends Profile { componentWillMount() … }`). */
function isReactClassComponent(cls: ts.ClassLikeDeclaration): boolean {
  const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  if (!ext) return false;
  if (ext.types.some((t) => ["Component", "PureComponent"].includes(lastName(t.expression)))) return true;
  return cls.members.some((m) => {
    const name = ts.isMethodDeclaration(m) ? memberName(m.name) : undefined;
    return name !== undefined && LIFECYCLE_METHODS.has(name) && /^(UNSAFE_)?component[A-Z]/.test(name);
  });
}

/** Max higher-order-component calls unwrapped around a component (`connect(…)(withRouter(X))` is two). */
const MAX_HOC_DEPTH = 3;

/** The component a chain of single-argument HOC calls wraps: `X`, `hoc(X)`, `connect(a, b)(X)`, `React.memo(X)`. */
function hocInner(e: ts.Expression, depth = 0): string | undefined {
  const x = unwrapExpr(e);
  if (ts.isIdentifier(x)) return depth > 0 ? x.text : undefined;
  if (!ts.isCallExpression(x) || x.arguments.length !== 1 || depth >= MAX_HOC_DEPTH) return undefined;
  const callee = x.expression;
  const ok = ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
    || (ts.isCallExpression(callee) && (ts.isIdentifier(callee.expression) || ts.isPropertyAccessExpression(callee.expression)));
  return ok ? hocInner(x.arguments[0]!, depth + 1) : undefined;
}

/** `connect(mapState, mapDispatch)(Component)` (Redux): the component and what mapDispatch is. Undefined when
 * mapDispatch is absent / null / anything but a plain name or an object literal of plain names. */
function reduxConnectOf(node: ts.Node): ReduxConnect | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const inner = node.expression;
  if (!ts.isCallExpression(inner) || lastName(inner.expression) !== "connect") return undefined;
  const component = hocInner(node.arguments[0]!, 1) ?? (ts.isIdentifier(node.arguments[0]!) ? node.arguments[0]!.text : undefined);
  const md = inner.arguments[1] && unwrapExpr(inner.arguments[1]);
  if (component === undefined || !md) return undefined;
  if (ts.isIdentifier(md)) return { component, dispatch: { kind: "fn", name: md.text } };
  if (!ts.isObjectLiteralExpression(md)) return undefined;
  const props: Array<{ key: string; name: string }> = [];
  for (const p of md.properties) {
    if (ts.isShorthandPropertyAssignment(p)) props.push({ key: p.name.text, name: p.name.text });
    else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && memberName(p.name) !== undefined) {
      props.push({ key: memberName(p.name)!, name: p.initializer.text });
    }
  }
  return props.length > 0 ? { component, dispatch: { kind: "object", props } } : undefined;
}

/** RTK Query's generated hook names: `use<Endpoint>Query`, `useLazy<Endpoint>Query`, `use<Endpoint>QueryState`,
 * `use<Endpoint>Mutation`. */
export const RTK_HOOK_RE = /^use(Lazy)?([A-Z]\w*?)(Query|QueryState|Mutation)$/;

/** The endpoint and kind a generated hook name stands for (`useGetCustomerQuery` -> getCustomer, query). */
export function rtkHookEndpoint(hook: string): { endpoint: string; kind: "query" | "mutation" } | undefined {
  const m = RTK_HOOK_RE.exec(hook);
  if (!m) return undefined;
  if (m[1] && m[3] !== "Query") return undefined;
  const name = m[2]!;
  return { endpoint: name[0]!.toLowerCase() + name.slice(1), kind: m[3] === "Mutation" ? "mutation" : "query" };
}

export function buildFileCodeIndex(file: ParsedFile): FileCodeIndex {
  const idx: FileCodeIndex = { symbols: [], imports: [], reExports: [], classFields: [], localNews: [], calls: [] };
  if (!file.sf) return idx;
  const marks: ExportMark[] = [];
  let defaultCandidate: string | undefined;
  const superagent = superagentReceivers(file.sf);
  const consts = stringConsts(file.sf);
  /** symbol -> its wrapper candidate; null once a second HTTP call in the same symbol makes it ambiguous. */
  const wrappers = new Map<string, HttpWrapper | null>();
  /** fn-arg site -> its outer callee's name ("" for a `ns.useX(…)` hook call, which always qualifies). */
  const fnArgOuter = new Map<CallSite, string>();
  /** Function-like nodes of plain bound function symbols, by name (first one wins), for mapDispatchToProps. */
  const fnNodes = new Map<string, ts.FunctionLikeDeclaration>();
  /** `export default <hoc>(X)` / `module.exports = <hoc>(X)`: X, checked against the symbols after the walk. */
  let wrapCandidate: string | undefined;

  walk(file.sf, (node) => {
    const fnName = functionLikeName(node);
    if (fnName !== undefined) {
      const sym = functionSymbol(node, fnName);
      idx.symbols.push(sym);
      if (sym.kind === "function" && sym.binding && ts.isFunctionLike(node) && "body" in node && !fnNodes.has(fnName)) {
        fnNodes.set(fnName, node as ts.FunctionLikeDeclaration);
      }
      const rtk = sym.factory === "rtk-query" ? rtkEndpointOf(node) : undefined;
      if (rtk) (idx.rtkEndpoints ??= []).push({ api: rtk.api, endpoint: rtk.endpoint, kind: rtk.kind });
      if (HOOK_NAME_RE.test(fnName) && ts.isFunctionLike(node) && "body" in node) {
        const returns = hookReturnsOf(node as ts.FunctionLikeDeclaration, fnName);
        if (returns.length > 0) (idx.hookReturns ??= []).push(...returns);
      }
    }

    if (ts.isClassLike(node)) {
      const cls = className(node);
      const decl = ts.isClassDeclaration(node);
      // `module.exports = class Repo {}` (default) / `exports.Repo = class {}` / `export = class {}`.
      const cjs = decl ? undefined : ts.isExportAssignment(node.parent) ? "default" : commonJsAssignedName(node);
      const names = decl ? modifierExportNames(node, cls) : cjs !== undefined ? [cjs] : [];
      idx.symbols.push(plainSymbol(cls, "class", [lineOf(node), endLineOf(node)], names, classBinds(node)));
      for (const m of node.members) {
        if (ts.isPropertyDeclaration(m)) {
          const name = memberName(m.name);
          const typeName = typeRefName(m.type) ?? newExpressionClass(m.initializer);
          if (name && typeName) addField(idx, { className: cls, field: name, typeName });
        }
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            if (!ts.isIdentifier(p.name)) continue;
            const isParamProp = ts.canHaveModifiers(p) && (ts.getModifiers(p)?.length ?? 0) > 0;
            const typeName = typeRefName(p.type);
            if (isParamProp && typeName) addField(idx, { className: cls, field: p.name.text, typeName });
          }
          if (m.body) constructorThisNews(m.body, (field, typeName) => addField(idx, { className: cls, field, typeName }));
        }
      }
      // v0.2a §4: React runs a class component's lifecycle methods and render: one "lifecycle" site per method.
      if (isReactClassComponent(node)) {
        for (const m of node.members) {
          const name = ts.isMethodDeclaration(m) ? memberName(m.name) : undefined;
          if (name !== undefined && LIFECYCLE_METHODS.has(name) && !hasModifier(m, ts.SyntaxKind.StaticKeyword)) {
            idx.calls.push({ caller: cls, line: lineOf(m), kind: "lifecycle", callee: { kind: "this", prop: name } });
          }
        }
      }
    }

    // v0.2a §4: `export default connect(…)(X)` / `module.exports = withRouter(X)`.
    if (ts.isExportAssignment(node) && !node.isExportEquals) wrapCandidate ??= hocInner(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExports(node.left)) {
      wrapCandidate ??= hocInner(node.right);
    }
    // v0.2a §4: `connect(mapState, mapDispatch)(Component)`.
    const connect = reduxConnectOf(node);
    if (connect) (idx.reduxConnects ??= []).push(connect);
    // v0.2a §4: `export const { useGetCustomerQuery } = customersApi`.
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      const api = node.initializer.text;
      const stmt = ownVariableStatement(node);
      for (const el of node.name.elements) {
        if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
        const key = el.propertyName ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined) : el.name.text;
        if (key === undefined || !RTK_HOOK_RE.test(key)) continue;
        // Only the generated name itself (an alias keeps the generated name as `key`).
        (idx.rtkHooks ??= []).push({ local: el.name.text, api, exported: !!stmt && isExported(stmt), ...(key !== el.name.text ? { key } : {}) });
      }
    }

    // CommonJS: `module.exports = X`, `module.exports = { a, b: c }`, `exports.a = b`, `module.exports.a = b`.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = node;
      if (isModuleExports(left)) {
        if (ts.isIdentifier(right)) {
          marks.push({ local: right.text, as: "default" });
          defaultCandidate = right.text;
        }
        else if (ts.isObjectLiteralExpression(right)) {
          for (const p of right.properties) {
            if (ts.isShorthandPropertyAssignment(p)) marks.push({ local: p.name.text, as: p.name.text });
            else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) {
              const as = memberName(p.name);
              if (as) marks.push({ local: p.initializer.text, as });
            }
          }
        }
      } else if (
        ts.isPropertyAccessExpression(left) && ts.isIdentifier(right) &&
        ((ts.isIdentifier(left.expression) && left.expression.text === "exports") || isModuleExports(left.expression))
      ) {
        marks.push({ local: right.text, as: left.name.text });
      }
    }

    // `export { a, a as b }` (no module specifier) and `export default X`: applied after the walk,
    // so a declaration that comes later in the file is still found.
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        marks.push({ local: el.propertyName ? el.propertyName.text : el.name.text, as: el.name.text });
      }
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      marks.push({ local: node.expression.text, as: "default" });
      if (node.isExportEquals) defaultCandidate = node.expression.text;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) idx.imports.push({ local: clause.name.text, kind: "default", from });
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          idx.imports.push({ local: clause.namedBindings.name.text, kind: "namespace", from });
        } else {
          for (const el of clause.namedBindings.elements) {
            idx.imports.push({
              local: el.name.text, kind: "named",
              imported: el.propertyName ? el.propertyName.text : el.name.text, from,
            });
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require"
    ) {
      const from = stringValue(node.initializer.arguments[0]);
      if (from) {
        if (ts.isIdentifier(node.name)) {
          idx.imports.push({ local: node.name.text, kind: "namespace", from });
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isOmittedExpression(el) || !ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            idx.imports.push({ local: el.name.text, kind: "named", imported, from });
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      if (!node.exportClause) {
        idx.reExports.push({ kind: "all", from });
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          idx.reExports.push({
            kind: "named", exported: el.name.text,
            imported: el.propertyName ? el.propertyName.text : el.name.text, from,
          });
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const className = newExpressionClass(node.initializer);
      if (className) idx.localNews.push({ caller: enclosingSymbol(node), local: node.name.text, className });
    }

    if (ts.isObjectLiteralExpression(node)) {
      const object = objectName(node);
      if (object !== undefined) {
        for (const p of node.properties) {
          const ref = ts.isShorthandPropertyAssignment(p) ? { prop: p.name.text, local: p.name.text }
            : ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && memberName(p.name) !== undefined
              ? { prop: memberName(p.name)!, local: p.initializer.text } : undefined;
          if (ref) (idx.objectRefs ??= []).push({ object, ...ref });
        }
      }
    }

    const jsxRef = jsxRefOf(node);
    if (jsxRef) {
      const jsxProp = ts.isJsxAttribute(node) ? jsxPropOf(node) : undefined;
      idx.calls.push({ caller: enclosingSymbol(node), line: lineOf(node), kind: "jsx-ref", callee: classify(jsxRef), ...(jsxProp ? { jsxProp } : {}) });
    }

    if (ts.isCallExpression(node)) {
      const site: CallSite = { caller: enclosingSymbol(node), line: lineOf(node), callee: classify(node.expression) };
      const refArgs = node.arguments.flatMap((a, index) => (ts.isIdentifier(a) ? [{ index, name: a.text }] : []));
      if (refArgs.length > 0) site.refArgs = refArgs;
      const urlArgs = urlArgsOf(node);
      if (urlArgs.length > 0) site.urlArgs = urlArgs;
      const configArgs = configArgsOf(node);
      if (configArgs.length > 0) site.configArgs = configArgs;
      idx.calls.push(site);
      const outer = fnArgCallee(node.expression);
      if (outer !== undefined) {
        for (const arg of fnArgRefs(node)) {
          const fnArg: CallSite = { caller: site.caller, line: lineOf(arg), kind: "fn-arg", callee: classify(arg) };
          fnArgOuter.set(fnArg, outer);
          idx.calls.push(fnArg);
        }
      }
      const w = wrapperCandidate(node, superagent, consts) ?? configWrapperCandidate(node);
      if (w) wrappers.set(w.symbol, wrappers.has(w.symbol) ? null : w);
    }
  });

  applyExportMarks(idx, marks);
  const found = [...wrappers.values()].filter((w): w is HttpWrapper => w !== null);
  if (found.length > 0) idx.wrappers = found;
  // Keep only identifier arguments that can name a function: a local function/class or an import.
  const fnNames = new Set([
    ...idx.symbols.filter((s) => s.binding && (s.kind === "function" || s.kind === "class")).map((s) => s.name),
    ...idx.imports.filter((i) => i.kind !== "namespace").map((i) => i.local),
  ]);
  for (const site of idx.calls) {
    const kept = site.refArgs?.filter((a) => fnNames.has(a.name));
    if (kept && kept.length > 0) site.refArgs = kept;
    else delete site.refArgs;
  }
  // A plain-name JSX reference (`value={title}`) counts only when the name can be a function.
  // A name destructured from a hook's result can be a function too (H10).
  idx.calls = idx.calls.filter((c) => {
    if (c.kind === "fn-arg") {
      const outer = fnArgOuter.get(c)!;
      if (outer !== "" && !HOOK_NAME_RE.test(outer) && !fnNames.has(outer)) return false;
    } else if (c.kind !== "jsx-ref") return true;
    return c.callee.kind !== "ident" || c.callee.hook !== undefined || fnNames.has(c.callee.name);
  });
  // v0.2a §4: a HOC-wrapped default export stands for the local component it wraps.
  if (wrapCandidate !== undefined && !idx.symbols.some((s) => s.exportNames?.includes("default"))
    && idx.symbols.some((s) => s.name === wrapCandidate && s.binding && (s.kind === "class" || s.kind === "function"))) {
    idx.defaultWraps = wrapCandidate;
  }
  // v0.2a §4: the keys a connected component's mapDispatchToProps function returns (read like a hook's result).
  for (const c of idx.reduxConnects ?? []) {
    if (c.dispatch.kind !== "fn") continue;
    const name = c.dispatch.name;
    const fn = fnNodes.get(name);
    if (!fn || idx.hookReturns?.some((r) => r.hook === name)) continue;
    const returns = hookReturnsOf(fn, name);
    if (returns.length > 0) (idx.hookReturns ??= []).push(...returns);
  }
  idx.hookReturns?.sort((a, b) => compare(a.hook, b.hook) || compare(a.key, b.key));
  // Only an object literal (one carrying `<name>.*` object-methods) is a default *object*.
  const obj = defaultCandidate;
  if (obj !== undefined && idx.symbols.some((s) => s.kind === "object-method" && s.name.startsWith(`${obj}.`))) {
    idx.defaultObject = obj;
  }
  return idx;
}

export function symbolAt(idx: FileCodeIndex, line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const s of idx.symbols) {
    if (line < s.lines[0] || line > s.lines[1]) continue;
    // `<=`: on equal span the later (deeper, e.g. `A.m` on a one-line class) symbol wins.
    if (!best || s.lines[1] - s.lines[0] <= best.lines[1] - best.lines[0]) best = s;
  }
  return best;
}
