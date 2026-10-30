import { describe, expect, it } from "vitest";
import { detectDb, sqlTables } from "../src/adapters/db.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

const access = (rel: string, code: string, ...deps: string[]) =>
  detectDb(parsed(rel, code), ctxWith(...deps)).dbAccess.map((a) => `${a.op} ${a.table ?? `model:${a.model}`} via ${a.via} @${a.at.symbol}`);

describe("detectDb", () => {
  it("reads Lucid models and Adonis query builders", () => {
    expect(access("app/services/customer_service.ts", `
      import Customer from "#models/customer";
      import db from "@adonisjs/lucid/services/db";
      export default class CustomerService {
        async create(p: any) { const b = await Customer.create(p); await db.table("audit_logs").insert({}); return b; }
        async find(id: number) { return Customer.findOrFail(id); }
        async purge() { await Customer.query().where("old", true).delete(); }
        async stats() { return Promise.all([Object.keys({})]); }
      }
    `, "@adonisjs/lucid")).toEqual([
      "insert model:Customer via lucid @CustomerService.create",
      "insert audit_logs via query-builder @CustomerService.create",
      "read model:Customer via lucid @CustomerService.find",
      "delete model:Customer via lucid @CustomerService.purge",
    ]);
  });

  it("names DB access inside an object-literal service by variable.method", () => {
    expect(access("src/order_service.ts", `
      export const orderService = {
        async create(data: any) { return prisma.order.create({ data }); },
        list: () => prisma.order.findMany(),
      };
    `, "@prisma/client")).toEqual([
      "insert model:order via prisma @orderService.create",
      "read model:order via prisma @orderService.list",
    ]);
  });

  it("reads Prisma client calls", () => {
    expect(access("src/invoices.ts", `
      const prisma = new PrismaClient();
      export async function createInvoice() { return prisma.invoice.create({ data: {} }); }
      class Repo { constructor(private prisma: any) {} list() { return this.prisma.payment.findMany(); } }
    `, "@prisma/client")).toEqual([
      "insert model:invoice via prisma @createInvoice",
      "read model:payment via prisma @Repo.list",
    ]);
  });

  it("reads TypeORM repositories and Drizzle", () => {
    expect(access("src/a.ts", `export const save = () => dataSource.getRepository(Order).save({});`, "typeorm"))
      .toEqual(["insert model:Order via typeorm @save"]);
    expect(access("src/b.ts", `
      export const add = () => db.insert(orders).values({});
      export const list = () => db.select().from(orders);
    `, "drizzle-orm")).toEqual(["insert model:orders via drizzle @add", "read model:orders via drizzle @list"]);
  });

  it("reads knex calls and raw SQL", () => {
    expect(access("src/k.ts", `
      export const all = () => knex("orders").where({ paid: true });
      export const q = () => pool.query("SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id");
    `, "knex", "pg")).toEqual([
      "read orders via query-builder @all",
      "read orders via sql @q",
      "read users via sql @q",
    ]);
  });

  it("finds tables and models", () => {
    const migration = detectDb(parsed("database/migrations/1_create_customers.ts", `
      export default class extends BaseSchema {
        protected tableName = "customers";
        async up() { this.schema.createTable(this.tableName, () => {}); }
      }`), ctxWith("@adonisjs/lucid"));
    expect(migration.tables.map((t) => `${t.name}:${t.source}`)).toEqual(["customers:migration"]);

    const model = detectDb(parsed("app/models/customer_contact.ts", `export default class CustomerContact extends BaseModel {}`), ctxWith("@adonisjs/lucid"));
    expect(model.models).toEqual([{ model: "CustomerContact", table: "customer_contacts", file: "app/models/customer_contact.ts", source: "lucid" }]);

    const custom = detectDb(parsed("app/models/person.ts", `export default class Person extends BaseModel { static table = "people"; }`), ctxWith("@adonisjs/lucid"));
    expect(custom.models[0]!.table).toBe("people");

    const entity = detectDb(parsed("src/order.entity.ts", `@Entity("orders") export class Order {}`), ctxWith("typeorm"));
    expect(entity.models[0]).toMatchObject({ model: "Order", table: "orders", source: "typeorm" });

    const drizzle = detectDb(parsed("src/schema.ts", `export const orders = pgTable("orders", {});`), ctxWith("drizzle-orm"));
    expect(drizzle.models[0]).toMatchObject({ model: "orders", table: "orders", source: "drizzle" });
  });

  it("reads Prisma schema and .sql files", () => {
    const prisma = detectDb(parsed("prisma/schema.prisma", `model Invoice {\n  id Int @id\n  @@map("invoices")\n}\n\nmodel Payment {\n  id Int @id\n}\n`), ctxWith());
    expect(prisma.models.map((m) => `${m.model}=${m.table}`)).toEqual(["Invoice=invoices", "Payment=Payment"]);
    const sql = detectDb(parsed("db/001_init.sql", `CREATE TABLE IF NOT EXISTS public.orders (id int);`), ctxWith());
    expect(sql.tables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("ignores repos without a DB library", () => {
    expect(access("src/x.ts", `const r = Customer.create({});`)).toEqual([]);
  });

  it("does not scan plain strings as SQL", () => {
    expect(access("src/labels.ts", `
      export const label = "Select an option from the list";
      toast("Delete from favorites to continue");
    `, "pg")).toEqual([]);
  });

  it("reads SQL from tagged templates", () => {
    expect(access("src/q.ts", `export const q = () => sql\`SELECT id FROM orders\`;`, "pg")).toEqual([
      "read orders via sql @q",
    ]);
  });

  it("requires a real Lucid models path, not any /model/ match", () => {
    expect(access("src/utils.ts", `
      import helpers from "./modeling-utils";
      export const f = () => helpers.create({});
    `, "@adonisjs/lucid")).toEqual([]);
    expect(access("src/g.ts", `
      import User from "App/Models/User";
      export const g = () => User.find(1);
    `, "@adonisjs/lucid")).toEqual(["read model:User via lucid @g"]);
  });

  it("requires a DB-like receiver for Drizzle insert/update/delete and from()", () => {
    expect(access("src/cache.ts", `export const put = (item: any) => cache.insert(item);`, "drizzle-orm")).toEqual([]);
    expect(access("src/tx.ts", `export const add = () => tx.insert(orders).values({});`, "drizzle-orm")).toEqual([
      "insert model:orders via drizzle @add",
    ]);
  });
});

describe("sqlTables", () => {
  it("classifies statements", () => {
    expect(sqlTables(`INSERT INTO "orders" (id) VALUES (1)`)).toEqual([{ table: "orders", op: "insert" }]);
    expect(sqlTables(`UPDATE orders SET paid = true`)).toEqual([{ table: "orders", op: "update" }]);
    expect(sqlTables(`DELETE FROM orders WHERE id = 1`)).toEqual([{ table: "orders", op: "delete" }]);
    expect(sqlTables(`not sql from orders`)).toEqual([]);
  });
});
