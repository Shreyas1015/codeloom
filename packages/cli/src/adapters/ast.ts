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

function className(cls: ts.ClassLikeDeclaration): string {
  return cls.name?.text ?? "<anonymous>";
}

/** `const name = { ... }` → "name", for an object literal directly assigned to a variable. */
function objectVarName(obj: ts.Node): string | undefined {
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.parent;
  return p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : undefined;
}

export function enclosingSymbol(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if ((ts.isMethodDeclaration(cur) || ts.isGetAccessor(cur) || ts.isSetAccessor(cur)) && ts.isClassLike(cur.parent)) {
      return `${className(cur.parent)}.${memberName(cur.name)}`;
    }
    if ((ts.isMethodDeclaration(cur) || ts.isGetAccessor(cur) || ts.isSetAccessor(cur)) && objectVarName(cur.parent)) {
      return `${objectVarName(cur.parent)}.${memberName(cur.name)}`;
    }
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent) {
      const p = cur.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isPropertyDeclaration(p) && ts.isClassLike(p.parent)) return `${className(p.parent)}.${memberName(p.name)}`;
      if (ts.isPropertyAssignment(p) && objectVarName(p.parent)) return `${objectVarName(p.parent)}.${memberName(p.name)}`;
      if (ts.isFunctionExpression(cur) && cur.name) return cur.name.text;
    }
    cur = cur.parent;
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

export function normalizePath(p: string): string {
  let s = p.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  s = s.split("?")[0]!.split("#")[0]!;
  s = s.replace(/\/{2,}/g, "/");
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Turn a URL expression into a route pattern. Undefined when it is only a variable (nothing literal). */
export function pathPattern(expr: ts.Expression): { path: string; resolved: boolean } | undefined {
  const parts: Part[] = [];
  if (!collect(expr, parts)) return undefined;
  if (!parts.some((p) => "text" in p)) return undefined;
  let out = "";
  let resolved = true;
  parts.forEach((p, i) => {
    if ("text" in p) {
      out += p.text;
      return;
    }
    if (i === 0 && BASE_RE.test(p.expr.getText())) return;
    const name = paramName(p.expr);
    if (name === undefined) {
      resolved = false;
      out += ":param";
    } else out += `:${name}`;
  });
  return { path: normalizePath(out), resolved };
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
