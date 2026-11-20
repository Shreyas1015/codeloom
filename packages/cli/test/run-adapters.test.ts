import { describe, expect, it } from "vitest";
import { finalizeEndpoints, loadContext, runAdapters } from "../src/adapters/run.js";
import { emptyPart } from "../src/adapters/types.js";
import { ctxWith } from "./adapter-helpers.js";
import { makeRepo } from "./helpers.js";

describe("loadContext", () => {
  it("gives each file the deps of its nearest package.json, plus the repo root's", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15" } }),
      "apps/api/package.json": JSON.stringify({ dependencies: { express: "^4" } }),
    });
    const ctx = loadContext(repo, ["package.json", "apps/web/package.json", "apps/api/package.json"]);
    const web = ctx.contextFor("apps/web/app/page.tsx");
    expect([...web.deps].sort()).toEqual(["next", "typescript"]);
    expect(web.packageRoot).toBe("apps/web");
    const api = ctx.contextFor("apps/api/src/server.ts");
    expect([...api.deps].sort()).toEqual(["express", "typescript"]);
    expect(api.packageRoot).toBe("apps/api");
    const root = ctx.contextFor("scripts/x.ts");
    expect([...root.deps]).toEqual(["typescript"]);
    expect(root.packageRoot).toBe("");
  });

  it("uses an empty set when no package.json is above a file", () => {
    const repo = makeRepo({ "lib/package.json": JSON.stringify({ dependencies: { pg: "^8" } }) });
    const ctx = loadContext(repo, ["lib/package.json"]);
    expect([...ctx.contextFor("tools/x.ts").deps]).toEqual([]);
    expect([...ctx.contextFor("lib/db.ts").deps]).toEqual(["pg"]);
  });

  it("has a key that changes when any package's deps change", () => {
    const a = makeRepo({ "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15" } }) });
    const b = makeRepo({ "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15", axios: "^1" } }) });
    const c = makeRepo({ "apps/other/package.json": JSON.stringify({ dependencies: { next: "^15" } }) });
    const key = (repo: string, f: string) => loadContext(repo, [f]).key;
    expect(key(a, "apps/web/package.json")).not.toBe(key(b, "apps/web/package.json"));
    expect(key(a, "apps/web/package.json")).not.toBe(key(c, "apps/other/package.json"));
  });
});

describe("runAdapters + finalizeEndpoints", () => {
  it("resolves models to tables across files", () => {
    const ctx = ctxWith("@adonisjs/core", "@adonisjs/lucid");
    const parts = [
      runAdapters("app/models/customer.ts", `export default class Customer extends BaseModel {}`, ctx),
      runAdapters("app/services/s.ts", `import Customer from "#models/customer"; export const f = () => Customer.create({});`, ctx),
      runAdapters("README.md", "# hi", ctx),
      runAdapters("types.d.ts", "declare const x: number;", ctx),
    ];
    const ep = finalizeEndpoints("api", parts);
    expect(ep.version).toBe(2);
    expect(ep.repo).toBe("api");
    expect(ep.dbAccess).toMatchObject([{ model: "Customer", table: "customers", op: "insert" }]);
    expect(ep.tables).toMatchObject([{ name: "customers", source: "model" }]);
  });

  it("keeps unresolved models without a table", () => {
    const ctx = ctxWith("@prisma/client");
    const ep = finalizeEndpoints("x", [runAdapters("a.ts", `export const f = () => prisma.ghost.findMany();`, ctx)]);
    expect(ep.dbAccess[0]).toMatchObject({ model: "ghost" });
    expect(ep.dbAccess[0]!.table).toBeUndefined();
  });

  it("a model name defined with two different tables resolves to no table, never the first one", () => {
    const part1 = emptyPart();
    part1.models.push({ model: "User", table: "users", file: "a/models/user.ts", line: 1, source: "lucid" });
    part1.dbAccess.push({ model: "User", op: "read", via: "lucid", at: { file: "x.ts", line: 1, symbol: "f" } });

    const part2 = emptyPart();
    part2.models.push({ model: "User", table: "accounts", file: "b/models/user.ts", line: 1, source: "lucid" });

    const ep = finalizeEndpoints("test", [part1, part2]);
    expect(ep.dbAccess[0]).toMatchObject({ model: "User", op: "read" });
    expect(ep.dbAccess[0]!.table).toBeUndefined();
  });
});

describe("H1: aliased model imports resolve to the model's table", () => {
  const ctx = ctxWith("@adonisjs/core", "@adonisjs/lucid");
  const modelFiles = () => [
    runAdapters("app/models/customer.ts", `export default class Customer extends BaseModel { static table = "clients"; }`, ctx),
    runAdapters("app/models/invoice_line.ts", `export default class InvoiceLine extends BaseModel {}`, ctx),
  ];
  const resolver = (_from: string, spec: string) =>
    ({ "#models/customer": "app/models/customer.ts", "#models/invoice_line": "app/models/invoice_line.ts" } as Record<string, string>)[spec] ?? null;

  it("a default import with a different local name uses the imported file's model", () => {
    const ep = finalizeEndpoints("api", [...modelFiles(), runAdapters("app/services/s.ts", `
      import CustomerModel from "#models/customer";
      import Lines from "#models/invoice_line";
      export const f = () => CustomerModel.create({});
      export const g = () => Lines.findOrFail(1);
    `, ctx)], resolver);
    expect(ep.dbAccess.map((a) => `${a.model}=${a.table}`)).toEqual(["Customer=clients", "InvoiceLine=invoice_lines"]);
    const json = JSON.stringify(ep);
    expect(json).not.toContain('"CustomerModel"');
    expect(json).not.toContain('"Lines"');
  });

  it("without a resolver falls back to the import path's naming convention", () => {
    const ep = finalizeEndpoints("api", [...modelFiles(), runAdapters("app/services/s.ts", `
      import Lines from "#models/invoice_line";
      export const g = () => Lines.findOrFail(1);
    `, ctx)]);
    expect(ep.dbAccess.map((a) => `${a.model}=${a.table}`)).toEqual(["InvoiceLine=invoice_lines"]);
    expect(JSON.stringify(ep)).not.toContain('"Lines"');
  });

  it("a named import alias uses the imported name", () => {
    const ep = finalizeEndpoints("api", [...modelFiles(), runAdapters("app/services/s.ts", `
      import { Customer as C2 } from "#models/customer";
      export const f = () => C2.query().where("x", 1);
    `, ctx)], resolver);
    expect(ep.dbAccess.map((a) => `${a.model}=${a.table}`)).toEqual(["Customer=clients"]);
  });

  it("endpoints never carry query-builder aliases or CTE names", () => {
    const ep = finalizeEndpoints("api", [runAdapters("app/services/r.ts", `
      import db from "@adonisjs/lucid/services/db";
      export const a = () => db.from("customers as cust").join("invoices as inv", "inv.customer_id", "cust.id");
      export const b = () => db.rawQuery("WITH recent_invoices AS (SELECT * FROM invoices) SELECT * FROM recent_invoices ri");
    `, ctx)]);
    const json = JSON.stringify(ep);
    for (const bad of ["cust", "inv", "ri", "recent_invoices", "customers as cust", "invoices as inv"]) expect(json).not.toContain(`"${bad}"`);
    expect(ep.dbAccess.map((a) => a.table)).toEqual(["invoices", "customers", "invoices"]);
  });
});

describe("imported axios instances (hardening H2)", () => {
  const ctx = ctxWith("axios", "react");
  /** Resolves "./x" / "@/x" specifiers against src/ files by name. */
  const files = ["src/api/client.ts", "src/api/default-client.ts", "src/api/cache.ts", "src/api/invoices.ts"];
  const resolve = (_from: string, spec: string) => {
    const name = spec.replace(/^(\.\/|\.\.\/|@\/)+/, "").replace(/^api\//, "");
    return files.find((f) => f === `src/api/${name}.ts`) ?? null;
  };
  const endpointsOf = (calls: string) => finalizeEndpoints("web", [
    runAdapters("src/api/client.ts", `
      import axios from "axios";
      const API_URL = import.meta.env.VITE_API_URL;
      const customerClient = axios.create({ baseURL: API_URL });
      export const backend = axios.create({ baseURL: "/v1" });
      export { customerClient as customerApi };
    `, ctx),
    runAdapters("src/api/default-client.ts", `
      import axios from "axios";
      const http = axios.create({ baseURL: process.env.API_URL });
      export default http;
    `, ctx),
    runAdapters("src/api/cache.ts", `export const store = { get(k: string) {}, remove(k: string) {} }; export default function track(e: any) {}`, ctx),
    runAdapters("src/api/invoices.ts", calls, ctx),
  ], resolve);
  const show = (ep: ReturnType<typeof finalizeEndpoints>) =>
    ep.httpCalls.map((c) => `${c.method} [${c.path}] ${c.kind}${c.base ? ` base=${c.base}` : ""} client=${c.client} @${c.at.symbol}`);

  it("finds client.get(url) and client(config) on an imported instance, incl. aliases and default exports", () => {
    const ep = endpointsOf(`
      import { backend as svc, customerApi } from "./client";
      import http from "@/api/default-client";
      export const listInvoices = () => svc.get("/invoices");
      export const createCustomer = (data: unknown) => customerApi({ method: "post", url: "/customers", data });
      export async function getCustomer(id: string) {
        const config = { url: \`/customers/\${id}\` };
        return http(config);
      }
    `);
    expect(show(ep)).toEqual([
      "GET [/invoices] literal client=backend @listInvoices",
      "POST [/customers] literal client=customerClient @createCustomer",
      "GET [/customers/:id] template client=http @getCustomer",
    ]);
    // Imported calls take the instance's own name, so its baseURL applies.
    expect(ep.httpClients.map((c) => `${c.name} ${c.baseLiteral ?? c.baseExpr ?? ""}`)).toEqual([
      "customerClient import.meta.env.VITE_API_URL", "backend /v1", "http process.env.API_URL",
    ]);
  });

  it("drops calls on imports that are not HTTP clients, or whose module cannot be resolved", () => {
    const ep = endpointsOf(`
      import track, { store } from "./cache";
      import { gone } from "./missing";
      import { backend } from "./client";
      export const a = () => store.get("/customers/last");
      export const b = () => track({ url: "/customers" });
      export const c = () => gone({ url: "/customers" });
      export const d = () => backend.get("/invoices");
    `);
    expect(show(ep)).toEqual(["GET [/invoices] literal client=backend @d"]);
  });

  it("drops imported-client calls when no import resolver is given", () => {
    const parts = [runAdapters("src/x.ts", `import { backend } from "./client"; export const d = () => backend({ url: "/x" });`, ctx)];
    expect(finalizeEndpoints("web", parts).httpCalls).toEqual([]);
  });
});

describe("v0.6 Task B: queue names one import hop away", () => {
  const ctx = ctxWith("amqplib");
  const resolve = (_from: string, spec: string) =>
    ({ "./constants/queues": "src/constants/queues.ts" } as Record<string, string>)[spec] ?? null;

  it("resolves a wrapper call's queue name from an `as const` object exported by another file", () => {
    const parts = [
      runAdapters("src/constants/queues.ts", `export const Queues = { INVOICE_CREATED: "invoice.created" } as const;`, ctx),
      runAdapters("src/invoice-service.ts", `
        import { Queues } from "./constants/queues";
        class QueueService {
          channel: any;
          async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
        }
        const queueService = new QueueService();
        export async function createInvoice(payload: object) {
          await queueService.publish(Queues.INVOICE_CREATED, payload);
        }
      `, ctx),
    ];
    const ep = finalizeEndpoints("billing", parts, resolve);
    expect(ep.queues).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/invoice-service.ts", line: 9, symbol: "createInvoice" } },
    ]);
  });

  it("resolves a wrapper call's routing key from an enum exported by another file", () => {
    const parts = [
      runAdapters("src/constants/queues.ts", `export enum RoutingKeys { ORDER_CREATED = "order.created" }`, ctx),
      runAdapters("src/events.ts", `
        import { RoutingKeys } from "./constants/queues";
        declare const channel: import("amqplib").Channel;
        export function publishEvent(name: string, body: object) {
          return channel.publish("events", name, Buffer.from(JSON.stringify(body)));
        }
        export function createOrder(body: object) {
          publishEvent(RoutingKeys.ORDER_CREATED, body);
        }
      `, ctx),
    ];
    const ep = finalizeEndpoints("billing", parts, resolve);
    expect(ep.queues).toEqual([
      {
        queue: "events:order.created", op: "publish", exchange: "events", routingKey: "order.created",
        at: { file: "src/events.ts", line: 8, symbol: "createOrder" },
      },
    ]);
  });

  it("never guesses: drops the queue op when the import cannot be resolved to a repo file", () => {
    const parts = [
      runAdapters("src/invoice-service.ts", `
        import { Queues } from "./constants/queues";
        class QueueService {
          channel: any;
          async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
        }
        const queueService = new QueueService();
        export async function createInvoice(payload: object) {
          await queueService.publish(Queues.INVOICE_CREATED, payload);
        }
      `, ctx),
    ];
    expect(finalizeEndpoints("billing", parts, resolve).queues).toEqual([]);
    expect(finalizeEndpoints("billing", parts).queues).toEqual([]); // no resolver at all
  });

  it("never guesses: drops the queue op when the target file has no such exported member", () => {
    const parts = [
      runAdapters("src/constants/queues.ts", `export const Queues = { INVOICE_PAID: "invoice.paid" } as const;`, ctx),
      runAdapters("src/invoice-service.ts", `
        import { Queues } from "./constants/queues";
        class QueueService {
          channel: any;
          async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
        }
        const queueService = new QueueService();
        export async function createInvoice(payload: object) {
          await queueService.publish(Queues.INVOICE_CREATED, payload);
        }
      `, ctx),
    ];
    expect(finalizeEndpoints("billing", parts, resolve).queues).toEqual([]);
  });
});

describe("v0.6 Task B: a wrapper itself resolved one import hop away", () => {
  const ctx = ctxWith("amqplib");
  const resolve = (_from: string, spec: string) =>
    ({ "./queue-service": "src/queue-service.ts", "./events": "src/events.ts" } as Record<string, string>)[spec] ?? null;

  it("resolves a call on an imported service-singleton instance against the class's wrapper method", () => {
    const parts = [
      runAdapters("src/queue-service.ts", `
        import amqp from "amqplib";
        export class QueueService {
          channel: any;
          async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
        }
        export const queueService = new QueueService();
      `, ctx),
      runAdapters("src/invoice-service.ts", `
        import { queueService } from "./queue-service";
        export async function createInvoice(payload: object) {
          await queueService.publish("invoice.created", payload);
        }
      `, ctx),
    ];
    const ep = finalizeEndpoints("billing", parts, resolve);
    expect(ep.queues).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/invoice-service.ts", line: 4, symbol: "createInvoice" } },
    ]);
  });

  it("resolves a bare function wrapper imported from another file, plus the caller's own routing key", () => {
    const parts = [
      runAdapters("src/events.ts", `
        declare const channel: import("amqplib").Channel;
        export function publishEvent(name: string, body: object) {
          return channel.publish("events", name, Buffer.from(JSON.stringify(body)));
        }
      `, ctx),
      runAdapters("src/orders.ts", `
        import { publishEvent } from "./events";
        export function createOrder(body: object) {
          publishEvent("order.created", body);
        }
      `, ctx),
    ];
    const ep = finalizeEndpoints("billing", parts, resolve);
    expect(ep.queues).toEqual([
      {
        queue: "events:order.created", op: "publish", exchange: "events", routingKey: "order.created",
        at: { file: "src/orders.ts", line: 4, symbol: "createOrder" },
      },
    ]);
  });

  it("never guesses: a call to an imported name that is not actually a queue wrapper resolves to nothing", () => {
    const parts = [
      runAdapters("src/queue-service.ts", `export function helper(a: string, b: object) { return { a, b }; }`, ctx),
      runAdapters("src/invoice-service.ts", `
        import { helper } from "./queue-service";
        export async function createInvoice(payload: object) {
          helper("invoice.created", payload);
        }
      `, ctx),
    ];
    expect(finalizeEndpoints("billing", parts, resolve).queues).toEqual([]);
  });

  it("never guesses: drops the call when the wrapper's own import cannot be resolved to a repo file", () => {
    const parts = [
      runAdapters("src/invoice-service.ts", `
        import { queueService } from "./queue-service";
        export async function createInvoice(payload: object) {
          await queueService.publish("invoice.created", payload);
        }
      `, ctx),
    ];
    expect(finalizeEndpoints("billing", parts).queues).toEqual([]); // no resolver at all
  });
});

describe("v0.6 Task B review round 1, item 4: tolerates a part cached before these fields existed", () => {
  it("never throws when a cached part object lacks queueDrafts/queueLiteralExports/queueWrapperExports/queueWrapperCalls/exchanges/exchangeDrafts", () => {
    const part = runAdapters("src/x.ts", `export function f(channel: any) { channel.sendToQueue("a", Buffer.from("x")); }`, ctxWith("amqplib"));
    const old = { ...part } as Record<string, unknown>;
    for (const key of ["queueDrafts", "queueLiteralExports", "queueWrapperExports", "queueWrapperCalls", "exchanges", "exchangeDrafts"]) {
      delete old[key];
    }
    expect(() => finalizeEndpoints("r", [old as never])).not.toThrow();
    expect(finalizeEndpoints("r", [old as never]).queues.map((q) => q.queue)).toEqual(["a"]);
  });
});
