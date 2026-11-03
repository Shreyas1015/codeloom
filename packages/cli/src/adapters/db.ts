import ts from "typescript";
import type { DbOp, ModelDef, TableDef } from "../store/schemas.js";
import { enclosingSymbol, lastName, lineOf, prop, rootName, snakePlural, stringValue, walk } from "./ast.js";
import type { AdapterContext, DbAccessDraft, EndpointsPart, ParsedFile } from "./types.js";

type DbPart = Pick<EndpointsPart, "dbAccess" | "tables" | "models">;

const DB_DEPS = ["@adonisjs/lucid", "knex", "@prisma/client", "drizzle-orm", "typeorm", "@nestjs/typeorm", "pg", "mysql2", "better-sqlite3", "postgres", "sqlite3"];
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

/** Names declared by a leading `WITH [RECURSIVE] name AS (` / `, name AS (` list: CTEs, not tables. */
function cteNames(text: string): Set<string> {
  const names = new Set<string>();
  if (!/^\s*with\b/i.test(text)) return names;
  for (const m of text.matchAll(/(?:\bwith(?:\s+recursive)?|,)\s*([\w"`]+)\s*(?:\([^)]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(/gi)) {
    names.add(m[1]!.replace(/["`]/g, "").toLowerCase());
  }
  return names;
}

export function sqlTables(text: string): Array<{ table: string; op: DbOp }> {
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
  for (const m of text.matchAll(new RegExp(`delete\\s+from\\s+${ident}`, "gi"))) add(m[1]!, "delete");
  for (const m of text.matchAll(new RegExp(`(?<!delete\\s+)\\b(?:from|join)\\s+${ident}`, "gi"))) add(m[1]!, "read");
  return out;
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
  for (const m of file.content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)/gi)) {
    const name = m[1]!.replace(/["`]/g, "").split(".").pop()!;
    tables.push({ name, file: file.rel, line: file.content.slice(0, m.index).split("\n").length, source: "migration" });
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
