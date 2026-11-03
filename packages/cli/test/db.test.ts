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

  it("records a raw-SQL call once, not again as a model call", () => {
    expect(access("app/x.ts", `
      import Customer from "#models/customer";
      export const f = () => Customer.query("select * from customers");
    `, "@adonisjs/lucid")).toEqual(["read customers via sql @f"]);
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

  describe("TypeORM injected repositories", () => {
    it("reads a constructor-property repository (Nest @InjectRepository, typed field)", () => {
      // Shape copied (minimally) from fixtures/evals/realworld-nest/api/src/user/user.service.ts
      expect(access("src/user/user.service.ts", `
        @Injectable()
        export class UserService {
          constructor (
            @InjectRepository(UserEntity)
            private readonly userRepository: Repository<UserEntity>,
          ) {}

          async createUser (userInfo: any) {
            return this.userRepository.save(Object.assign(new UserEntity(), userInfo))
          }

          async findUser (by: any) {
            return this.userRepository.findOne({ where: by })
          }
        }
      `, "typeorm", "@nestjs/typeorm")).toEqual([
        "insert model:UserEntity via typeorm @UserService.createUser",
        "read model:UserEntity via typeorm @UserService.findUser",
      ]);
    });

    it("reads a class-property repository typed Repository<E>, assigned in the constructor body", () => {
      expect(access("src/order/order.service.ts", `
        export class OrderService {
          private readonly orderRepository: Repository<Order>;
          constructor(orderRepository: Repository<Order>) {
            this.orderRepository = orderRepository;
          }
          list() { return this.orderRepository.find(); }
          remove(id: number) { return this.orderRepository.delete(id); }
        }
      `, "typeorm")).toEqual([
        "read model:Order via typeorm @OrderService.list",
        "delete model:Order via typeorm @OrderService.remove",
      ]);
    });

    it("reads an @InjectRepository field with no type annotation", () => {
      expect(access("src/tag/tag.service.ts", `
        export class TagService {
          constructor(@InjectRepository(Tag) private readonly tagRepository) {}
          all() { return this.tagRepository.find(); }
        }
      `, "@nestjs/typeorm")).toEqual(["read model:Tag via typeorm @TagService.all"]);
    });

    it("ignores a non-repository field", () => {
      expect(access("src/user/user.service.ts", `
        export class UserService {
          constructor(private readonly http: HttpService) {}
          ping() { return this.http.get("/health"); }
        }
      `, "typeorm")).toEqual([]);
    });

    it("reads createQueryBuilder as a read on the repository's entity", () => {
      expect(access("src/order/order.service.ts", `
        export class OrderService {
          constructor(@InjectRepository(Order) private readonly orderRepository: Repository<Order>) {}
          totals() { return this.orderRepository.createQueryBuilder("o").getMany(); }
        }
      `, "typeorm")).toEqual(["read model:Order via typeorm @OrderService.totals"]);
    });

    it("supports MongoRepository/TreeRepository and the newer repository ops", () => {
      expect(access("src/mix.ts", `
        export class MixService {
          constructor(
            @InjectRepository(Comment) private readonly commentRepository: MongoRepository<Comment>,
            @InjectRepository(Category) private readonly categoryRepository: TreeRepository<Category>,
          ) {}
          count() { return this.commentRepository.findAndCount(); }
          has() { return this.commentRepository.exists(); }
          build() { return this.categoryRepository.preload({ id: 1 }); }
          combine() { return this.categoryRepository.merge({}, {}); }
        }
      `, "typeorm")).toEqual([
        "read model:Comment via typeorm @MixService.count",
        "read model:Comment via typeorm @MixService.has",
        "read model:Category via typeorm @MixService.build",
        "update model:Category via typeorm @MixService.combine",
      ]);
    });
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

describe("H1: aliases and CTEs never become table names", () => {
  it("takes the table before ` as ` in query-builder args (from, join, Model.query().from, knex())", () => {
    expect(access("app/services/invoice_service.ts", `
      import db from "@adonisjs/lucid/services/db";
      import Invoice from "#models/invoice";
      export const a = () => db.from("customers as cust").join("invoices AS inv", "inv.customer_id", "cust.id");
      export const b = () => Invoice.query().from(" invoice_lines as line ");
      export const c = () => knex("\`payments\` as pay").where({});
      export const d = () => db.from("customers").leftJoin("invoices as inv2", "inv2.customer_id", "customers.id");
    `, "@adonisjs/lucid", "knex")).toEqual([
      "read invoices via query-builder @a",
      "read customers via query-builder @a",
      "read invoice_lines via query-builder @b",
      "read model:Invoice via lucid @b",
      "read payments via query-builder @c",
      "read invoices via query-builder @d",
      "read customers via query-builder @d",
    ]);
  });

  it("does not read Array#join or other non-query join calls as tables", () => {
    expect(access("src/fmt.ts", `
      export const f = (xs: string[]) => xs.map((x) => x.trim()).join(", ");
      export const g = (xs: string[]) => xs.join("customers");
      export const h = () => path.join("invoices", "x");
    `, "knex")).toEqual([]);
  });

  it("never reports CTE names declared in a WITH list", () => {
    expect(sqlTables(`WITH recent_invoices AS (SELECT * FROM invoices), big AS (SELECT * FROM recent_invoices r WHERE r.total > 9)
      SELECT c.id FROM customers AS c JOIN big b ON b.customer_id = c.id`)).toEqual([
      { table: "invoices", op: "read" },
      { table: "customers", op: "read" },
    ]);
    expect(sqlTables(`with recursive tree as (select id from customers union all select c.id from customers c join tree t on t.id = c.parent_id) select * from tree`))
      .toEqual([{ table: "customers", op: "read" }]);
    expect(sqlTables(`SELECT * FROM public.customers cust JOIN "billing"."invoices" AS inv ON inv.customer_id = cust.id`)).toEqual([
      { table: "customers", op: "read" },
      { table: "invoices", op: "read" },
    ]);
  });

  it("records a model imported under another name by its real class name", () => {
    expect(access("app/services/s.ts", `
      import { Customer as CustomerModel } from "#models/customer";
      export const f = () => CustomerModel.findOrFail(1);
    `, "@adonisjs/lucid")).toEqual(["read model:Customer via lucid @f"]);
  });
});

describe("H1 follow-up: FROM inside a SQL function call is not a table", () => {
  const tables = (sql: string) => sqlTables(sql).map((t) => `${t.op} ${t.table}`);

  it("skips FROM in EXTRACT, SUBSTRING, TRIM, OVERLAY and leaves POSITION alone", () => {
    expect(tables(`SELECT EXTRACT(year FROM created_at) AS y FROM invoices`)).toEqual(["read invoices"]);
    expect(tables(`SELECT SUBSTRING(code FROM 2 FOR 3) FROM customers`)).toEqual(["read customers"]);
    expect(tables(`SELECT TRIM(BOTH ' ' FROM name) FROM customers`)).toEqual(["read customers"]);
    expect(tables(`SELECT TRIM(LEADING '(' FROM name) FROM customers`)).toEqual(["read customers"]);
    expect(tables(`SELECT POSITION('a' IN email) FROM customers`)).toEqual(["read customers"]);
    expect(tables(`SELECT OVERLAY(code PLACING 'x' FROM 2 FOR 1) FROM invoices`)).toEqual(["read invoices"]);
    expect(tables(`SELECT date_part('day', due_at), extract (month from issued_at) FROM invoices i JOIN customers c ON c.id = i.customer_id`))
      .toEqual(["read invoices", "read customers"]);
    expect(tables(`UPDATE invoices SET year = EXTRACT(YEAR FROM issued_at)`)).toEqual(["update invoices"]);
  });

  it("still finds tables in sub-selects, including ones inside a function call", () => {
    expect(tables(`SELECT id FROM customers WHERE id IN (SELECT customer_id FROM invoices)`)).toEqual(["read customers", "read invoices"]);
    expect(tables(`SELECT COALESCE((SELECT max(total) FROM invoices i WHERE i.customer_id = c.id), 0) FROM customers c`))
      .toEqual(["read invoices", "read customers"]);
    expect(tables(`SELECT * FROM customers c WHERE EXISTS ( select 1 from invoice_lines l WHERE l.customer_id = c.id )`))
      .toEqual(["read customers", "read invoice_lines"]);
    expect(tables(`SELECT * FROM customers c WHERE (c.active AND (c.id IN (SELECT customer_id FROM invoices)))`))
      .toEqual(["read customers", "read invoices"]);
    expect(tables(`SELECT EXTRACT(year FROM (SELECT max(issued_at) FROM invoices))`)).toEqual(["read invoices"]);
  });
});

describe("H9: table-valued functions and every CTE name are not tables", () => {
  const tables = (sql: string) => sqlTables(sql).map((t) => `${t.op} ${t.table}`);

  it("skips an identifier followed by ( after FROM / JOIN (a table-valued function)", () => {
    expect(tables(`SELECT t.tag FROM invoices i, jsonb_array_elements_text(i.tags) t`)).toEqual(["read invoices"]);
    expect(tables(`SELECT tag FROM jsonb_array_elements_text($1::jsonb) AS tag`)).toEqual([]);
    expect(tables(`SELECT n FROM generate_series(1, 3) n JOIN customers c ON c.id = n`)).toEqual(["read customers"]);
    expect(tables(`SELECT * FROM unnest($1::int[]) AS ids(id) JOIN invoices i ON i.id = ids.id`)).toEqual(["read invoices"]);
    expect(tables(`SELECT * FROM customers c CROSS JOIN LATERAL jsonb_to_record(c.meta) AS m(a int)`)).toEqual(["read customers"]);
    expect(tables(`SELECT * FROM public.invoice_totals (2024) t`)).toEqual([]);
    expect(tables(`INSERT INTO customers (id, name) VALUES (1, 'a')`)).toEqual(["insert customers"]);
  });

  it("never reports any name in a WITH list, with or without RECURSIVE or column lists", () => {
    expect(tables(`WITH a AS (SELECT * FROM customers), b AS (SELECT * FROM a), c AS (SELECT * FROM b JOIN invoices i ON i.customer_id = b.id)
      SELECT * FROM c JOIN a ON a.id = c.id`)).toEqual(["read customers", "read invoices"]);
    expect(tables(`WITH RECURSIVE a(id) AS (SELECT id FROM customers), b(x, y) AS (SELECT 1, 2), c (z) AS (SELECT z FROM b)
      SELECT * FROM a JOIN b ON true JOIN c ON true`)).toEqual(["read customers"]);
    expect(tables(`with totals as materialized (select customer_id, sum(total) s from invoices group by 1), "ranked" as (select * from totals)
      select * from ranked`)).toEqual(["read invoices"]);
    expect(tables(`WITH a AS (SELECT * FROM customers),
      b AS (SELECT * FROM invoices WHERE customer_id IN (SELECT id FROM a)),
      c AS (SELECT count(*) FROM b)
      INSERT INTO invoice_lines SELECT * FROM c`)).toEqual(["insert invoice_lines", "read customers", "read invoices"]);
    expect(tables(`WITH a AS (SELECT (x).f AS y, 'a, b as (' AS s FROM customers), b AS (SELECT * FROM a) SELECT * FROM b`))
      .toEqual(["read customers"]);
    expect(tables(`SELECT * FROM (WITH a AS (SELECT * FROM invoices), b AS (SELECT * FROM a) SELECT * FROM b) x JOIN customers c ON c.id = x.customer_id`))
      .toEqual(["read invoices", "read customers"]);
    expect(tables(`INSERT INTO invoice_lines (id) WITH src AS (SELECT id FROM invoices), more AS (SELECT id FROM src) SELECT id FROM more`))
      .toEqual(["insert invoice_lines", "read invoices"]);
  });
});
