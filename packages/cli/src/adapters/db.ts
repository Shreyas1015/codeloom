import ts from "typescript";
import type { DbOp, ModelDef, TableDef } from "../store/schemas.js";
import { commonJsExportName, enclosingSymbol, lastName, lineOf, prop, rootName, snakePlural, stringValue, walk } from "./ast.js";
import type { AdapterContext, DbAccessDraft, EndpointsPart, ParsedFile } from "./types.js";

type DbPart = Pick<EndpointsPart, "dbAccess" | "tables" | "models">;

const DB_DEPS = ["@adonisjs/lucid", "knex", "mongoose", "@prisma/client", "drizzle-orm", "typeorm", "@nestjs/typeorm", "pg", "mysql2", "better-sqlite3", "postgres", "sqlite3"];
const QB_ROOTS = /^(db|knex|trx|database|Database|connection|query|qb|sql|tx)$/;
const DRIZZLE_ROOTS = /^(db|tx|trx|database|client|conn|connection)$/;
const SQL_CALL_RE = /^(query|execute|raw|unsafe|prepare|exec|queryRaw|executeRaw|\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe|rawQuery)$/;
/** Query-builder join methods; their first argument is a table (`.join("invoices as i", ...)`). */
const QB_JOIN_RE = /^(join|innerJoin|leftJoin|leftOuterJoin|rightJoin|rightOuterJoin|fullOuterJoin|crossJoin|joinRaw)$/;
const SQL_TAG_RE = /^(sql|raw|\$queryRaw|\$executeRaw)$/;
const MODEL_STATIC: Record<string, DbOp> = {
  create: "insert", createMany: "insert", firstOrCreate: "insert", fetchOrCreateMany: "insert",
  updateOrCreate: "update", updateOrCreateMany: "update",
  find: "read", findOrFail: "read", findBy: "read", findByOrFail: "read", findMany: "read", findManyBy: "read",
  first: "read", firstOrFail: "read", all: "read", query: "read", truncate: "delete",
};
const PRISMA_OPS: Record<string, DbOp> = {
  findMany: "read", findUnique: "read", findUniqueOrThrow: "read", findFirst: "read", findFirstOrThrow: "read",
  count: "read", aggregate: "read", groupBy: "read",
  create: "insert", createMany: "insert", createManyAndReturn: "insert",
  update: "update", updateMany: "update", upsert: "update", delete: "delete", deleteMany: "delete",
};
const REPO_OPS: Record<string, DbOp> = {
  find: "read", findOne: "read", findOneBy: "read", findBy: "read", findOneOrFail: "read", count: "read",
  findAndCount: "read", exist: "read", exists: "read", preload: "read",
  save: "insert", insert: "insert", create: "insert", update: "update", upsert: "update", merge: "update",
  delete: "delete", remove: "delete", softDelete: "delete",
};
const MONGOOSE_OPS: Record<string, DbOp> = {
  find: "read", findOne: "read", findById: "read", countDocuments: "read", estimatedDocumentCount: "read",
  exists: "read", aggregate: "read", distinct: "read", where: "read",
  create: "insert", insertMany: "insert",
  updateOne: "update", updateMany: "update", replaceOne: "update", findByIdAndUpdate: "update",
  findOneAndUpdate: "update", findOneAndReplace: "update", bulkWrite: "update",
  deleteOne: "delete", deleteMany: "delete", findByIdAndDelete: "delete", findOneAndDelete: "delete",
  findByIdAndRemove: "delete", findOneAndRemove: "delete",
};
/** A relative import of a model file: a `models/` folder, or a `*.model` / `*-model` file. */
const MONGOOSE_MODEL_SPEC = /^\.{1,2}\/(.*\/)?(models?\/|[^/]*[.-]model(\.[cm]?[jt]s)?$)/i;
/** Type-reference names that TypeORM injects as a repository field. */
const REPO_TYPE_RE = /^(Repository|MongoRepository|TreeRepository)$/;
const PARAM_PROP_MODS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword,
]);

/** The table named by a query-builder table argument: the part before ` as ` (any case), trimmed and
 * unquoted (`"customers as c"` -> `customers`). Undefined when what is left is not a table name. */
export function qbTable(arg: string): string | undefined {
  const name = arg.trim().split(/\s+as\s+/i)[0]!.trim().replace(/["`[\]]/g, "");
  return /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/.test(name) ? name : undefined;
}

/** Index just past the ")" matching the "(" at `open` (quotes skipped); text.length when unbalanced. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

/** One CTE head at `from`: `name [(cols)] AS [[NOT] MATERIALIZED] (`. */
const CTE_HEAD = /\s*("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*(?:\([^)]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(/iy;

/** Every name declared by a `WITH [RECURSIVE] a AS (…), b(x, y) AS (…), …` list anywhere in the text
 * (a leading one, or one inside a sub-select or after INSERT INTO): CTEs, not tables. Each body is
 * skipped by matching its parentheses, so a comma inside a body never starts a new name. */
function cteNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const w of text.matchAll(/\bwith(?:\s+recursive)?\b/gi)) {
    let at = w.index + w[0].length;
    for (;;) {
      CTE_HEAD.lastIndex = at;
      const m = CTE_HEAD.exec(text);
      if (!m) break;
      names.add(m[1]!.replace(/["`]/g, "").toLowerCase());
      at = closeParen(text, CTE_HEAD.lastIndex - 1);
      const comma = /\s*,/y;
      comma.lastIndex = at;
      if (!comma.exec(text)) break;
      at = comma.lastIndex;
    }
  }
  return names;
}

/** The SQL with every `-- line` and `/* block *\/` comment blanked out (each comment character becomes a
 * space, newlines are kept, so indexes and line numbers do not move). Comment markers inside a quoted
 * string or identifier (`'--'`, `"a/*b"`) are text, not comments, and stay. */
export function stripSqlComments(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      out += ch;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "-" && text[i + 1] === "-") {
      let end = text.indexOf("\n", i);
      if (end === -1) end = text.length;
      out += " ".repeat(end - i);
      i = end - 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      let end = text.indexOf("*/", i + 2);
      end = end === -1 ? text.length : end + 2;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end - 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Blank the contents of single-quoted string literals (`''` is an escaped quote inside one), so words in
 * a value (`note = 'paid from bank'`) never read as SQL. Double-quoted and backtick identifiers are kept. */
function blankSqlStrings(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "`") {
      let end = text.indexOf(ch, i + 1);
      if (end === -1) end = text.length - 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      out += "'" + text.slice(i + 1, j).replace(/[^\n]/g, " ") + (j < text.length ? "'" : "");
      i = j;
    } else {
      out += ch;
    }
  }
  return out;
}

export function sqlTables(text: string): Array<{ table: string; op: DbOp }> {
  text = blankSqlStrings(stripSqlComments(text));
  if (!/^\s*(select|insert|update|delete|with)\b/i.test(text)) return [];
  const out: Array<{ table: string; op: DbOp }> = [];
  const seen = new Set<string>();
  const ctes = cteNames(text);
  const add = (raw: string, op: DbOp) => {
    const name = raw.replace(/["`[\]]/g, "").split(".").pop()!.toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/.test(name) || ctes.has(name) || seen.has(`${op}:${name}`)) return;
    seen.add(`${op}:${name}`);
    out.push({ table: name, op });
  };
  const ident = `([\\w."\`\\[\\]]+)`;
  for (const m of text.matchAll(new RegExp(`insert\\s+into\\s+${ident}`, "gi"))) add(m[1]!, "insert");
  for (const m of text.matchAll(new RegExp(`(?:^|;)\\s*update\\s+${ident}\\s+set`, "gi"))) add(m[1]!, "update");
  for (const m of text.matchAll(new RegExp(`delete\\s+from\\s+(?:only\\s+)?${ident}`, "gi"))) add(m[1]!, "delete");
  const inCall = functionCallMask(text);
  // An identifier followed by "(" after FROM / JOIN is a table-valued function (`FROM unnest(arr)`,
  // `JOIN generate_series(1, 3)`), not a table.
  for (const m of text.matchAll(new RegExp(`(?<!delete\\s+|\\bdistinct\\s+)\\b(?:from|join)\\s+(?:(?:lateral|only)\\s+)?(?!(?:lateral|only)\\b)${ident}(?!\\s*\\(|[\\w."\`\\[\\]])`, "gi"))) {
    if (!inCall(m.index)) add(m[1]!, "read");
  }
  return out;
}

/** Words that may stand right before a "(" that is not a function call: `IN (`, `EXISTS (`, `JOIN (`,
 * `AS (` (a CTE), `VALUES (`, `AND (` … */
const NON_CALL_WORDS = new Set([
  "all", "and", "any", "as", "between", "by", "case", "else", "except", "exists", "from", "having", "in", "intersect",
  "into", "is", "join", "lateral", "like", "materialized", "not", "on", "or", "recursive", "returning", "select", "set",
  "some", "then", "union", "using", "values", "when", "where", "with",
]);

/** "call" when the "(" at `i` opens a function call's arguments (`EXTRACT(`, `trim (`): an identifier that
 * is not a SQL keyword stands right before it and no sub-select starts inside it. Anything else (a
 * sub-select, a grouping, an IN list) is "other". */
function parenKind(text: string, i: number): "call" | "other" {
  if (/^\s*(select|with)\b/i.test(text.slice(i + 1, i + 40))) return "other";
  const word = text.slice(Math.max(0, i - 64), i).match(/([A-Za-z_][\w$]*)\s*$/);
  return word && !NON_CALL_WORDS.has(word[1]!.toLowerCase()) ? "call" : "other";
}

/** A test for "the text at this index sits directly inside a function call's parentheses", where
 * `FROM` is an argument keyword (`EXTRACT(year FROM d)`, `TRIM(BOTH ' ' FROM s)`), not a table
 * reference. A sub-select's own top level is not inside a call, even when the sub-select is an argument
 * (`COALESCE((SELECT … FROM t), 0)`). Parentheses inside quotes are ignored. */
function functionCallMask(text: string): (index: number) => boolean {
  const inCall = new Uint8Array(text.length);
  const stack: Array<"call" | "other"> = [];
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      stack.push(parenKind(text, i));
    } else if (ch === ")") {
      stack.pop();
    }
    inCall[i] = stack[stack.length - 1] === "call" ? 1 : 0;
  }
  return (index) => inCall[index] === 1;
}

function opFromChain(call: ts.CallExpression): DbOp {
  let cur: ts.Node = call;
  while (ts.isPropertyAccessExpression(cur.parent) && ts.isCallExpression(cur.parent.parent)) {
    const name = cur.parent.name.text;
    if (/^(insert|insertMany|createMany|multiInsert)$/.test(name)) return "insert";
    if (/^(update|increment|decrement|merge)$/.test(name)) return "update";
    if (/^(delete|del|truncate)$/.test(name)) return "delete";
    cur = cur.parent.parent;
  }
  return "read";
}

function isLucidModelSpecifier(spec: string): boolean {
  return spec.startsWith("#models/") || spec.startsWith("App/Models/") || /\/models\//.test(spec);
}

/** How a local name was imported from a real Lucid models path (not any path with "model" in it). */
interface ModelImport {
  /** The exported name for a named import (`{ Customer as C }` -> `Customer`); the local name for a default import. */
  model: string;
  /** The specifier of a default import, whose class name only the imported file knows. */
  defaultFrom?: string;
}

function lucidModelImports(sf: ts.SourceFile): Map<string, ModelImport> {
  const names = new Map<string, ModelImport>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isLucidModelSpecifier(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (clause?.name && /^[A-Z]/.test(clause.name.text)) {
      names.set(clause.name.text, { model: clause.name.text, defaultFrom: st.moduleSpecifier.text });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (/^[A-Z]/.test(el.name.text) && /^[A-Z]/.test(imported)) names.set(el.name.text, { model: imported });
      }
    }
  }
  return names;
}

function classTableName(node: ts.Node, arg: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(arg) || arg.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isClassLike(cur)) cur = cur.parent;
  if (!cur || !ts.isClassLike(cur)) return undefined;
  for (const m of cur.members) {
    if (ts.isPropertyDeclaration(m) && m.name.getText() === arg.name.text) return stringValue(m.initializer);
  }
  return undefined;
}

/** The entity `E` of an `@InjectRepository(E)` decorator among `decorators`, if any. */
function injectRepositoryEntity(decorators: readonly ts.Decorator[] | undefined): string | undefined {
  for (const d of decorators ?? []) {
    if (ts.isCallExpression(d.expression) && d.expression.expression.getText() === "InjectRepository") {
      const arg = d.expression.arguments[0];
      if (arg) return arg.getText();
    }
  }
  return undefined;
}

/** The entity `E` a field (constructor-property parameter or class property) injects as a TypeORM
 * repository: from a `Repository<E>` / `MongoRepository<E>` / `TreeRepository<E>` type annotation,
 * else from an `@InjectRepository(E)` decorator on an untyped field. Type wins when both are present. */
function repoFieldEntity(type: ts.TypeNode | undefined, decorators: readonly ts.Decorator[] | undefined): string | undefined {
  if (type && ts.isTypeReferenceNode(type) && REPO_TYPE_RE.test(type.typeName.getText())) {
    const arg = type.typeArguments?.[0];
    if (arg) return arg.getText();
  }
  return injectRepositoryEntity(decorators);
}

/** Every field of `cls` (constructor-property parameter, or class property) that injects a TypeORM
 * repository, mapped to the entity it is a repository of. Adapters see one file at a time, so this
 * only sees fields whose type/decorator is written in this same file's class. */
function repoFields(cls: ts.ClassLikeDeclaration): Map<string, string> {
  const map = new Map<string, string>();
  const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m));
  for (const p of ctor?.parameters ?? []) {
    if (!ts.isIdentifier(p.name)) continue;
    const mods = ts.canHaveModifiers(p) ? ts.getModifiers(p) : undefined;
    if (!(mods ?? []).some((m) => PARAM_PROP_MODS.has(m.kind))) continue; // not a parameter property
    const decorators = ts.canHaveDecorators(p) ? ts.getDecorators(p) : undefined;
    const entity = repoFieldEntity(p.type, decorators);
    if (entity) map.set(p.name.text, entity);
  }
  for (const m of cls.members) {
    if (!ts.isPropertyDeclaration(m) || !ts.isIdentifier(m.name)) continue;
    const decorators = ts.canHaveDecorators(m) ? ts.getDecorators(m) : undefined;
    const entity = repoFieldEntity(m.type, decorators);
    if (entity) map.set(m.name.text, entity);
  }
  return map;
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) if (ts.isClassLike(cur)) return cur;
  return undefined;
}

function modelClass(cls: ts.ClassDeclaration, rel: string): ModelDef | undefined {
  const name = cls.name?.text;
  if (!name) return undefined;
  const heritage = (cls.heritageClauses ?? []).map((h) => h.getText()).join(" ");
  if (/\bBaseModel\b/.test(heritage)) {
    let table = snakePlural(name);
    for (const m of cls.members) {
      const isStatic = ts.canHaveModifiers(m) && (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
      if (ts.isPropertyDeclaration(m) && isStatic && m.name.getText() === "table") table = stringValue(m.initializer) ?? table;
    }
    return { model: name, table, file: rel, source: "lucid" };
  }
  const decorators = ts.canHaveDecorators(cls) ? (ts.getDecorators(cls) ?? []) : [];
  for (const d of decorators) {
    if (ts.isCallExpression(d.expression) && d.expression.expression.getText() === "Entity") {
      const arg = d.expression.arguments[0];
      const fromObj = arg && ts.isObjectLiteralExpression(arg) ? stringValue(prop(arg, "name")) : undefined;
      const table = stringValue(arg) ?? fromObj ?? name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      return { model: name, table, file: rel, source: "typeorm" };
    }
  }
  return undefined;
}

/** Mongoose's pluralisation rules (first match wins), applied to the lowercased model name. */
const MONGOOSE_PLURAL: Array<[RegExp, string]> = [
  [/human$/, "humans"], [/(m)an$/, "$1en"], [/(pe)rson$/, "$1ople"], [/(child)$/, "$1ren"], [/^(ox)$/, "$1en"],
  [/(ax|test)is$/, "$1es"], [/(octop|vir)us$/, "$1i"], [/(alias|status)$/, "$1es"], [/(bu)s$/, "$1ses"],
  [/(buffal|tomat|potat)o$/, "$1oes"], [/([ti])um$/, "$1a"], [/sis$/, "ses"], [/(?:([^f])fe|([lr])f)$/, "$1$2ves"],
  [/(hive)$/, "$1s"], [/([^aeiouy]|qu)y$/, "$1ies"], [/(x|ch|ss|sh)$/, "$1es"], [/(matr|vert|ind)ix|ex$/, "$1ices"],
  [/([ml])ouse$/, "$1ice"], [/(kn|w|l)ife$/, "$1ives"], [/(quiz)$/, "$1zes"], [/s$/, "s"], [/([^a-z])$/, "$1"], [/$/, "s"],
];
const MONGOOSE_UNCOUNTABLE = new Set([
  "advice", "energy", "excretion", "digestion", "cooperation", "health", "justice", "labour", "machinery", "equipment",
  "information", "pollution", "sewage", "paper", "money", "species", "series", "rain", "rice", "fish", "sheep", "moose",
  "deer", "news", "expertise", "status", "media",
]);

/** The collection mongoose gives a model when nothing names one: the model name lowercased and pluralised. */
export function mongooseCollection(model: string): string {
  const name = model.toLowerCase();
  if (MONGOOSE_UNCOUNTABLE.has(name)) return name;
  const rule = MONGOOSE_PLURAL.find(([re]) => re.test(name));
  return rule ? name.replace(rule[0], rule[1]) : name;
}

/** `require("<spec>")` -> "<spec>"; undefined for anything else. */
function requireSpec(e: ts.Expression | undefined): string | undefined {
  return e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "require" ? stringValue(e.arguments[0]) : undefined;
}

/** Local names bound to the mongoose module: its default/namespace import or CommonJS require (`mongoose`),
 * and named imports / destructured requires of `model` / `Schema` under their local names. */
function mongooseImports(sf: ts.SourceFile): { root: Set<string>; model: Set<string>; schema: Set<string> } {
  const out = { root: new Set<string>(), model: new Set<string>(), schema: new Set<string>() };
  const named = (imported: string, local: string) => {
    if (imported === "model") out.model.add(local);
    if (imported === "Schema") out.schema.add(local);
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (requireSpec(d.initializer) !== "mongoose") continue;
        if (ts.isIdentifier(d.name)) out.root.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            named(imported, el.name.text);
          }
        }
      }
      continue;
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "mongoose") continue;
    const clause = st.importClause;
    if (clause?.name) out.root.add(clause.name.text);
    const nb = clause?.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.root.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) named((el.propertyName ?? el.name).text, el.name.text);
    }
  }
  return out;
}

/** The variable a model call is assigned to, through `mongoose.models.X || model(…)`, parentheses and
 * casts (`const Customer = …`). Undefined when it is not assigned to a plain name. */
function assignedName(node: ts.Node): string | undefined {
  let cur = node.parent;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)
    || ts.isConditionalExpression(cur) || ts.isTypeAssertionExpression(cur)
    || (ts.isBinaryExpression(cur) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(cur.operatorToken.kind)))) {
    cur = cur.parent;
  }
  if (cur && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
  // CommonJS `exports.Customer = model(…)` -> "Customer" (`module.exports = model(…)` keeps the model's own name).
  const cjs = cur && ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken ? commonJsExportName(cur.left) : undefined;
  return cjs !== undefined && cjs !== "default" ? cjs : undefined;
}

/** Mongoose models declared in this file: each `model(Name, schema[, collection])` call (via the
 * mongoose import or a named `model` import), keyed by the local name it is assigned to (else Name).
 * The collection is the literal 3rd argument, else the schema's literal `collection` option, else
 * mongoose's rule on a literal Name; `table` is undefined when none of those can be read, so no table
 * is ever invented from a variable or class name. */
function mongooseModels(sf: ts.SourceFile): Map<string, { table?: string; node: ts.Node }> {
  const imp = mongooseImports(sf);
  const models = new Map<string, { table?: string; node: ts.Node }>();
  if (imp.root.size === 0 && imp.model.size === 0) return models;
  const isSchemaNew = (e: ts.Expression): e is ts.NewExpression => ts.isNewExpression(e)
    && ((ts.isIdentifier(e.expression) && imp.schema.has(e.expression.text))
      || (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "Schema" && imp.root.has(rootName(e.expression))));
  const schemaCollection = new Map<string, string | null>();
  const optionOf = (e: ts.NewExpression): string | null => {
    const opts = e.arguments?.[1];
    if (!opts) return null;
    if (!ts.isObjectLiteralExpression(opts)) return "?";
    const c = prop(opts, "collection");
    return c === undefined ? null : (stringValue(c) ?? "?");
  };
  /** Names bound to `mongoose.createConnection(…)` (optionally awaited). */
  const connections = new Set<string>();
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isSchemaNew(node.initializer)) {
      schemaCollection.set(node.name.text, optionOf(node.initializer));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === "createConnection"
        && ts.isIdentifier(init.expression.expression) && imp.root.has(init.expression.expression.text)) connections.add(node.name.text);
    }
  });
  /** `<receiver>.model(…)`: on mongoose itself, on `mongoose.connection`, on a `createConnection` result, or on
   * any receiver when the schema argument is a mongoose Schema of this file (v0.2a: `connection.model(…)`). */
  const modelReceiver = (recv: ts.Expression, schemaArg: ts.Expression | undefined): boolean => {
    if (ts.isIdentifier(recv) && (imp.root.has(recv.text) || connections.has(recv.text))) return true;
    if (ts.isPropertyAccessExpression(recv) && recv.name.text === "connection" && ts.isIdentifier(recv.expression) && imp.root.has(recv.expression.text)) {
      return true;
    }
    return !!schemaArg && ((ts.isIdentifier(schemaArg) && schemaCollection.has(schemaArg.text)) || isSchemaNew(schemaArg));
  };
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length < 2) return;
    const e = node.expression;
    const isModel = (ts.isIdentifier(e) && imp.model.has(e.text))
      || (ts.isPropertyAccessExpression(e) && e.name.text === "model" && modelReceiver(e.expression, node.arguments[1]));
    if (!isModel) return;
    const [nameArg, schemaArg, collArg] = node.arguments;
    const name = stringValue(nameArg);
    const local = assignedName(node) ?? name;
    if (!local) return;
    let option: string | null | undefined;
    if (schemaArg && ts.isIdentifier(schemaArg)) option = schemaCollection.get(schemaArg.text);
    else if (schemaArg && isSchemaNew(schemaArg)) option = optionOf(schemaArg);
    let table: string | undefined;
    if (collArg) table = stringValue(collArg);
    else if (option === "?") table = undefined;
    else if (typeof option === "string") table = option;
    else if (name !== undefined) table = mongooseCollection(name);
    models.set(local, table === undefined ? { node } : { table, node });
  });
  return models;
}

/** Imports of a relative model file (`../models/customer`, `./invoice.model`), as lucidModelImports
 * reads them: the default import resolves through the imported file's own model. */
function mongooseModelImports(sf: ts.SourceFile): Map<string, ModelImport> {
  const names = new Map<string, ModelImport>();
  for (const st of sf.statements) {
    // CommonJS: `const Customer = require("../models/customer")` / `const { Invoice } = require("../models/invoice")`.
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const spec = requireSpec(d.initializer);
        if (spec === undefined || !MONGOOSE_MODEL_SPEC.test(spec)) continue;
        if (ts.isIdentifier(d.name) && /^[A-Z]/.test(d.name.text)) names.set(d.name.text, { model: d.name.text, defaultFrom: spec });
        else if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            if (/^[A-Z]/.test(el.name.text) && /^[A-Z]/.test(imported)) names.set(el.name.text, { model: imported });
          }
        }
      }
      continue;
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !MONGOOSE_MODEL_SPEC.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (clause?.name && /^[A-Z]/.test(clause.name.text)) {
      names.set(clause.name.text, { model: clause.name.text, defaultFrom: st.moduleSpecifier.text });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (/^[A-Z]/.test(el.name.text) && /^[A-Z]/.test(imported)) names.set(el.name.text, { model: imported });
      }
    }
  }
  return names;
}

/** `new X(…)` -> "X". */
function newClassName(e: ts.Expression | undefined): string | undefined {
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  return e && ts.isNewExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : undefined;
}

/** The class a `.save()` receiver was made with: `new X(…)` itself, or a name whose nearest declaration is
 * `const name = new X(…)` (a `let`/`var`, a parameter or any other declaration in between gives undefined). */
function newDocModel(recv: ts.Expression): string | undefined {
  const direct = newClassName(recv);
  if (direct !== undefined || !ts.isIdentifier(recv)) return direct;
  const name = recv.text;
  const binds = (n: ts.BindingName): boolean =>
    ts.isIdentifier(n) ? n.text === name : n.elements.some((el) => !ts.isOmittedExpression(el) && binds(el.name));
  for (let cur: ts.Node | undefined = recv.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => binds(p.name))) return undefined;
    if (!ts.isBlock(cur) && !ts.isSourceFile(cur)) continue;
    for (const st of cur.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!binds(d.name)) continue;
        const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        return isConst && ts.isIdentifier(d.name) ? newClassName(d.initializer) : undefined;
      }
    }
  }
  return undefined;
}

function prismaSchema(file: ParsedFile): DbPart {
  const tables: TableDef[] = [];
  const models: ModelDef[] = [];
  for (const m of file.content.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = m[2]!.match(/@@map\(\s*"([^"]+)"\s*\)/);
    const table = mapped ? mapped[1]! : m[1]!;
    const line = file.content.slice(0, m.index).split("\n").length;
    tables.push({ name: table, file: file.rel, line, source: "prisma" });
    models.push({ model: m[1]!, table, file: file.rel, source: "prisma" });
  }
  return { dbAccess: [], tables, models };
}

function sqlFile(file: ParsedFile): DbPart {
  const tables: TableDef[] = [];
  const content = stripSqlComments(file.content);
  for (const m of content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)/gi)) {
    const name = m[1]!.replace(/["`]/g, "").split(".").pop()!;
    tables.push({ name, file: file.rel, line: content.slice(0, m.index).split("\n").length, source: "migration" });
  }
  return { dbAccess: [], tables, models: [] };
}

export function detectDb(file: ParsedFile, ctx: AdapterContext): DbPart {
  if (file.rel.endsWith(".prisma")) return prismaSchema(file);
  if (file.rel.endsWith(".sql")) return sqlFile(file);
  const res: DbPart = { dbAccess: [], tables: [], models: [] };
  if (!file.sf || !DB_DEPS.some((d) => ctx.deps.has(d))) return res;
  const modelImports = ctx.deps.has("@adonisjs/lucid") ? lucidModelImports(file.sf) : new Map<string, ModelImport>();
  const drizzle = ctx.deps.has("drizzle-orm");
  const mongoose = ctx.deps.has("mongoose");
  const mgModels = mongoose ? mongooseModels(file.sf) : new Map<string, { table?: string; node: ts.Node }>();
  const mgImports = mongoose ? mongooseModelImports(file.sf) : new Map<string, ModelImport>();
  for (const [model, m] of mgModels) {
    if (m.table !== undefined) res.models.push({ model, table: m.table, file: file.rel, source: "mongoose" });
  }
  const at = (n: ts.Node) => ({ file: file.rel, line: lineOf(n), symbol: enclosingSymbol(n) });
  const push = (a: DbAccessDraft) => res.dbAccess.push(a);
  const classRepoFields = new Map<ts.ClassLikeDeclaration, Map<string, string>>();
  const repoFieldsFor = (cls: ts.ClassLikeDeclaration): Map<string, string> => {
    let m = classRepoFields.get(cls);
    if (!m) {
      m = repoFields(cls);
      classRepoFields.set(cls, m);
    }
    return m;
  };

  walk(file.sf, (node) => {
    if (ts.isClassDeclaration(node)) {
      const m = modelClass(node, file.rel);
      if (m) res.models.push(m);
    }
    if (ts.isTaggedTemplateExpression(node) && SQL_TAG_RE.test(lastName(node.tag))) {
      const tpl = node.template;
      const text = ts.isTemplateExpression(tpl) ? tpl.getText().slice(1, -1) : tpl.text;
      for (const t of sqlTables(text)) push({ table: t.table, op: t.op, via: "sql", at: at(node) });
    }
    if (!ts.isCallExpression(node)) return;
    const e = node.expression;
    const arg0 = node.arguments[0];

    if (arg0 && (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0) || ts.isTemplateExpression(arg0)) && SQL_CALL_RE.test(lastName(e))) {
      const text = ts.isTemplateExpression(arg0) ? arg0.getText().slice(1, -1) : arg0.text;
      const found = sqlTables(text);
      for (const t of found) push({ table: t.table, op: t.op, via: "sql", at: at(node) });
      if (found.length) return;
    }

    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && modelImports.has(e.expression.text) && MODEL_STATIC[e.name.text]) {
      const op = e.name.text === "query" ? opFromChain(node) : MODEL_STATIC[e.name.text]!;
      const imp = modelImports.get(e.expression.text)!;
      push({ model: imp.model, op, via: "lucid", at: at(node), ...(imp.defaultFrom ? { modelImport: imp.defaultFrom } : {}) });
      return;
    }
    // `new Customer(data).save()` / `const doc = new Customer(data); doc.save()` (v0.2a): an insert.
    if (mongoose && ts.isPropertyAccessExpression(e) && e.name.text === "save" && node.arguments.length <= 1) {
      const local = newDocModel(e.expression);
      const imp = local === undefined || mgModels.has(local) ? undefined : mgImports.get(local);
      if (local !== undefined && (mgModels.has(local) || imp)) {
        push({
          model: imp ? imp.model : local, op: "insert", via: "mongoose", at: at(node),
          ...(imp?.defaultFrom ? { modelImport: imp.defaultFrom } : {}),
        });
        return;
      }
    }
    if (mongoose && ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && MONGOOSE_OPS[e.name.text]) {
      const local = e.expression.text;
      const imp = mgModels.has(local) ? undefined : mgImports.get(local);
      if (mgModels.has(local) || imp) {
        // A model whose collection could not be read keeps its model name and no table (never a guessed one).
        push({
          model: imp ? imp.model : local, op: MONGOOSE_OPS[e.name.text]!, via: "mongoose", at: at(node),
          ...(imp?.defaultFrom ? { modelImport: imp.defaultFrom } : {}),
        });
        return;
      }
    }
    if (ctx.deps.has("@prisma/client") && ts.isPropertyAccessExpression(e) && PRISMA_OPS[e.name.text] && ts.isPropertyAccessExpression(e.expression) && /prisma|db|client|tx/i.test(rootName(e.expression))) {
      push({ model: e.expression.name.text, op: PRISMA_OPS[e.name.text]!, via: "prisma", at: at(node) });
      return;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = enclosingClass(node);
      const entity = cls && repoFieldsFor(cls).get(e.expression.name.text);
      if (entity) {
        const method = e.name.text;
        const op = method === "createQueryBuilder" ? "read" : REPO_OPS[method];
        if (op) {
          push({ model: entity, op, via: "typeorm", at: at(node) });
          return;
        }
      }
    }
    if (ts.isPropertyAccessExpression(e) && REPO_OPS[e.name.text] && ts.isCallExpression(e.expression) && /getRepository$/.test(e.expression.expression.getText())) {
      const model = e.expression.arguments[0];
      if (model && ts.isIdentifier(model)) push({ model: model.text, op: REPO_OPS[e.name.text]!, via: "typeorm", at: at(node) });
      return;
    }
    if (drizzle && ts.isPropertyAccessExpression(e) && ["insert", "update", "delete"].includes(e.name.text) && arg0 && ts.isIdentifier(arg0) && DRIZZLE_ROOTS.test(rootName(e.expression))) {
      push({ model: arg0.text, op: e.name.text as DbOp, via: "drizzle", at: at(node) });
      return;
    }
    if (ts.isPropertyAccessExpression(e) && ["from", "table", "into"].includes(e.name.text) && arg0) {
      const raw = stringValue(arg0);
      const table = raw === undefined ? undefined : qbTable(raw);
      if (raw !== undefined && !table) return;
      if (table && (QB_ROOTS.test(rootName(e.expression)) || ts.isCallExpression(e.expression))) {
        push({ table, op: opFromChain(node), via: "query-builder", at: at(node) });
        return;
      }
      if (!table && drizzle && ts.isIdentifier(arg0) && DRIZZLE_ROOTS.test(rootName(e.expression))) {
        push({ model: arg0.text, op: "read", via: "drizzle", at: at(node) });
        return;
      }
    }
    if (ts.isPropertyAccessExpression(e) && QB_JOIN_RE.test(e.name.text) && e.name.text !== "joinRaw" && stringValue(arg0) !== undefined) {
      const root = rootName(e.expression);
      const table = qbTable(stringValue(arg0)!);
      if (table && (QB_ROOTS.test(root) || (modelImports.has(root) && ts.isCallExpression(e.expression)))) {
        push({ table, op: "read", via: "query-builder", at: at(node) });
      }
      return;
    }
    if (ts.isIdentifier(e) && /^(knex|db|trx)$/.test(e.text) && stringValue(arg0)) {
      const table = qbTable(stringValue(arg0)!);
      if (table) push({ table, op: opFromChain(node), via: "query-builder", at: at(node) });
      return;
    }
    if (ts.isPropertyAccessExpression(e) && /^createTable(IfNotExists)?$/.test(e.name.text) && arg0) {
      const name = stringValue(arg0) ?? classTableName(node, arg0);
      if (name) res.tables.push({ name, file: file.rel, line: lineOf(node), source: "migration" });
      return;
    }
    if (ts.isIdentifier(e) && /^(pgTable|mysqlTable|sqliteTable)$/.test(e.text) && stringValue(arg0) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      const table = stringValue(arg0)!;
      res.tables.push({ name: table, file: file.rel, line: lineOf(node), source: "drizzle" });
      res.models.push({ model: node.parent.name.text, table, file: file.rel, source: "drizzle" });
    }
  });
  return res;
}
