import ts from "typescript";
import {
  className, commonJsAssignedName, enclosingSymbol, functionLikeName, isModuleExports, lineOf, objectName, stringValue, walk,
} from "../adapters/ast.js";
import type { ParsedFile } from "../adapters/types.js";
import { httpCallShape, superagentReceivers } from "../adapters/http-calls.js";
import { pathPattern } from "../adapters/ast.js";
import type { HttpMethod } from "../store/schemas.js";

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

export type Callee =
  | { kind: "ident"; name: string }
  | { kind: "member"; object: string; prop: string }
  | { kind: "new-member"; className: string; prop: string }
  | { kind: "this"; prop: string }
  | { kind: "this-field"; field: string; prop: string }
  | { kind: "other"; prop?: string };

export interface CallSite {
  caller: string;
  line: number;
  callee: Callee;
  /** Absent for a real call. `"jsx-ref"`: not a call but a function handed to JSX (H3) — a JSX attribute
   * value that is a plain name / `this.x` / `obj.x` (`<form onSubmit={submitData}>`), or a component
   * tag (`<PostDetails />`). Resolved like a call, but at best "param" (it may never run). */
  kind?: "jsx-ref";
  /** Plain-identifier arguments that name a function/class declared in this file or an import binding —
   * a function handed over by reference, e.g. the `handleEmail` in `channel.consume("emails",
   * handleEmail)` — with their argument position. Absent when none. */
  refArgs?: Array<{ index: number; name: string }>;
  /** Arguments with literal URL text (`'/user'`, `` `/articles/${slug}` ``), as route patterns, so a call to an
   * HTTP wrapper (resolved later by the linker) can become an HTTP call. Absent when none. */
  urlArgs?: UrlArg[];
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

function classify(expr: ts.Expression): Callee {
  if (ts.isIdentifier(expr)) return { kind: "ident", name: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    const prop = expr.name.text;
    const obj = expr.expression;
    if (obj.kind === ts.SyntaxKind.ThisKeyword) return { kind: "this", prop };
    if (ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return { kind: "this-field", field: obj.name.text, prop };
    }
    const newClass = newExpressionClass(obj);
    if (newClass) return { kind: "new-member", className: newClass, prop };
    if (ts.isIdentifier(obj)) return { kind: "member", object: obj.text, prop };
    return { kind: "other", prop };
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
    (ts.isIdentifier(e.expression) || e.expression.kind === ts.SyntaxKind.ThisKeyword);
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

export function buildFileCodeIndex(file: ParsedFile): FileCodeIndex {
  const idx: FileCodeIndex = { symbols: [], imports: [], reExports: [], classFields: [], localNews: [], calls: [] };
  if (!file.sf) return idx;
  const marks: ExportMark[] = [];
  let defaultCandidate: string | undefined;
  const superagent = superagentReceivers(file.sf);
  const consts = stringConsts(file.sf);
  /** symbol -> its wrapper candidate; null once a second HTTP call in the same symbol makes it ambiguous. */
  const wrappers = new Map<string, HttpWrapper | null>();

  walk(file.sf, (node) => {
    const fnName = functionLikeName(node);
    if (fnName !== undefined) idx.symbols.push(functionSymbol(node, fnName));

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

    const jsxRef = jsxRefOf(node);
    if (jsxRef) idx.calls.push({ caller: enclosingSymbol(node), line: lineOf(node), kind: "jsx-ref", callee: classify(jsxRef) });

    if (ts.isCallExpression(node)) {
      const site: CallSite = { caller: enclosingSymbol(node), line: lineOf(node), callee: classify(node.expression) };
      const refArgs = node.arguments.flatMap((a, index) => (ts.isIdentifier(a) ? [{ index, name: a.text }] : []));
      if (refArgs.length > 0) site.refArgs = refArgs;
      const urlArgs = urlArgsOf(node);
      if (urlArgs.length > 0) site.urlArgs = urlArgs;
      idx.calls.push(site);
      const w = wrapperCandidate(node, superagent, consts);
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
  idx.calls = idx.calls.filter((c) => c.kind !== "jsx-ref" || c.callee.kind !== "ident" || fnNames.has(c.callee.name));
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
