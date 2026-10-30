import ts from "typescript";
import type { DbAccess, DbOp, ModelDef, TableDef } from "../store/schemas.js";
import { enclosingSymbol, lineOf, prop, rootName, snakePlural, stringValue, walk } from "./ast.js";
import type { AdapterContext, EndpointsPart, ParsedFile } from "./types.js";

type DbPart = Pick<EndpointsPart, "dbAccess" | "tables" | "models">;

const DB_DEPS = ["@adonisjs/lucid", "knex", "@prisma/client", "drizzle-orm", "typeorm", "pg", "mysql2", "better-sqlite3", "postgres", "sqlite3"];
const QB_ROOTS = /^(db|knex|trx|database|Database|connection|query|qb|sql|tx)$/;
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
  save: "insert", insert: "insert", create: "insert", update: "update", upsert: "update",
  delete: "delete", remove: "delete", softDelete: "delete",
};

export function sqlTables(text: string): Array<{ table: string; op: DbOp }> {
  if (!/^\s*(select|insert|update|delete|with)\b/i.test(text)) return [];
  const out: Array<{ table: string; op: DbOp }> = [];
  const seen = new Set<string>();
  const add = (raw: string, op: DbOp) => {
    const name = raw.replace(/["`[\]]/g, "").split(".").pop()!.toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/.test(name) || seen.has(`${op}:${name}`)) return;
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

function importedFrom(sf: ts.SourceFile, re: RegExp): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !re.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.add(el.name.text);
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
  const modelImports = importedFrom(file.sf, /model/i);
  const drizzle = ctx.deps.has("drizzle-orm");
  const at = (n: ts.Node) => ({ file: file.rel, line: lineOf(n), symbol: enclosingSymbol(n) });
  const push = (a: DbAccess) => res.dbAccess.push(a);

  walk(file.sf, (node) => {
    if (ts.isClassDeclaration(node)) {
      const m = modelClass(node, file.rel);
      if (m) res.models.push(m);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? node.getText().slice(1, -1) : node.text;
      for (const t of sqlTables(text)) push({ table: t.table, op: t.op, via: "sql", at: at(node) });
    }
    if (!ts.isCallExpression(node)) return;
    const e = node.expression;
    const arg0 = node.arguments[0];

    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && modelImports.has(e.expression.text) && MODEL_STATIC[e.name.text]) {
      const op = e.name.text === "query" ? opFromChain(node) : MODEL_STATIC[e.name.text]!;
      push({ model: e.expression.text, op, via: "lucid", at: at(node) });
      return;
    }
    if (ctx.deps.has("@prisma/client") && ts.isPropertyAccessExpression(e) && PRISMA_OPS[e.name.text] && ts.isPropertyAccessExpression(e.expression) && /prisma|db|client|tx/i.test(rootName(e.expression))) {
      push({ model: e.expression.name.text, op: PRISMA_OPS[e.name.text]!, via: "prisma", at: at(node) });
      return;
    }
    if (ts.isPropertyAccessExpression(e) && REPO_OPS[e.name.text] && ts.isCallExpression(e.expression) && /getRepository$/.test(e.expression.expression.getText())) {
      const model = e.expression.arguments[0];
      if (model && ts.isIdentifier(model)) push({ model: model.text, op: REPO_OPS[e.name.text]!, via: "typeorm", at: at(node) });
      return;
    }
    if (drizzle && ts.isPropertyAccessExpression(e) && ["insert", "update", "delete"].includes(e.name.text) && arg0 && ts.isIdentifier(arg0)) {
      push({ model: arg0.text, op: e.name.text as DbOp, via: "drizzle", at: at(node) });
      return;
    }
    if (ts.isPropertyAccessExpression(e) && ["from", "table", "into"].includes(e.name.text) && arg0) {
      const table = stringValue(arg0);
      if (table && (QB_ROOTS.test(rootName(e.expression)) || ts.isCallExpression(e.expression))) {
        push({ table, op: opFromChain(node), via: "query-builder", at: at(node) });
        return;
      }
      if (!table && drizzle && ts.isIdentifier(arg0)) {
        push({ model: arg0.text, op: "read", via: "drizzle", at: at(node) });
        return;
      }
    }
    if (ts.isIdentifier(e) && /^(knex|db|trx)$/.test(e.text) && stringValue(arg0)) {
      push({ table: stringValue(arg0)!, op: opFromChain(node), via: "query-builder", at: at(node) });
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
