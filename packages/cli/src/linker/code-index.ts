import ts from "typescript";
import { enclosingSymbol, lineOf, stringValue, walk } from "../adapters/ast.js";
import type { ParsedFile } from "../adapters/types.js";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "object-method";
  lines: [number, number];
  exported: boolean;
  exportedAs?: string;
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
}

export interface FileCodeIndex {
  symbols: CodeSymbol[];
  imports: ImportBinding[];
  reExports: ReExport[];
  classFields: ClassField[];
  localNews: Array<{ caller: string; local: string; className: string }>;
  calls: CallSite[];
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

/** `const name = { ... }` -> "name", for an object literal directly assigned to a variable. */
function objectVarName(obj: ts.Node): string | undefined {
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.parent;
  return p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : undefined;
}

function enclosingVariableStatement(node: ts.Node): ts.VariableStatement | undefined {
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isVariableStatement(cur)) cur = cur.parent;
  return cur as ts.VariableStatement | undefined;
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

export function buildFileCodeIndex(file: ParsedFile): FileCodeIndex {
  const idx: FileCodeIndex = { symbols: [], imports: [], reExports: [], classFields: [], localNews: [], calls: [] };
  if (!file.sf) return idx;

  walk(file.sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      idx.symbols.push({
        name: node.name.text,
        kind: "function",
        lines: [lineOf(node), endLineOf(node)],
        exported: isExported(node),
        exportedAs: isDefaultExport(node) ? "default" : undefined,
      });
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const cls = node.name.text;
      idx.symbols.push({
        name: cls,
        kind: "class",
        lines: [lineOf(node), endLineOf(node)],
        exported: isExported(node),
        exportedAs: isDefaultExport(node) ? "default" : undefined,
      });
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
          const name = memberName(m.name);
          if (name) idx.symbols.push({ name: `${cls}.${name}`, kind: "method", lines: [lineOf(m), endLineOf(m)], exported: false });
        }
        if (ts.isPropertyDeclaration(m)) {
          const name = memberName(m.name);
          const typeName = typeRefName(m.type) ?? newExpressionClass(m.initializer);
          if (name && typeName) idx.classFields.push({ className: cls, field: name, typeName });
        }
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            if (!ts.isIdentifier(p.name)) continue;
            const isParamProp = ts.canHaveModifiers(p) && (ts.getModifiers(p)?.length ?? 0) > 0;
            const typeName = typeRefName(p.type);
            if (isParamProp && typeName) idx.classFields.push({ className: cls, field: p.name.text, typeName });
          }
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const objName = objectVarName(node);
      if (objName) {
        const stmt = enclosingVariableStatement(node);
        const exported = !!stmt && isExported(stmt);
        for (const p of node.properties) {
          if (ts.isMethodDeclaration(p)) {
            const name = memberName(p.name);
            if (name) idx.symbols.push({ name: `${objName}.${name}`, kind: "object-method", lines: [lineOf(p), endLineOf(p)], exported });
          } else if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
            const name = memberName(p.name);
            if (name) {
              idx.symbols.push({
                name: `${objName}.${name}`, kind: "object-method",
                lines: [lineOf(p.initializer), endLineOf(p.initializer)], exported,
              });
            }
          }
        }
      }
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

    if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
      const sym = idx.symbols.find((s) => s.name === (node.expression as ts.Identifier).text);
      if (sym) {
        sym.exported = true;
        sym.exportedAs = "default";
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const className = newExpressionClass(node.initializer);
      if (className) idx.localNews.push({ caller: enclosingSymbol(node), local: node.name.text, className });
    }

    if (ts.isCallExpression(node)) {
      idx.calls.push({ caller: enclosingSymbol(node), line: lineOf(node), callee: classify(node.expression) });
    }
  });

  return idx;
}

export function symbolAt(idx: FileCodeIndex, line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const s of idx.symbols) {
    if (line < s.lines[0] || line > s.lines[1]) continue;
    if (!best || s.lines[1] - s.lines[0] < best.lines[1] - best.lines[0]) best = s;
  }
  return best;
}
