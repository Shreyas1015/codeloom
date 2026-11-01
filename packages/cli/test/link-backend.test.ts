import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";
import type { CallResolver } from "../src/linker/resolve-calls.js";
import {
  findHandler, linkAll, linkBackend, linkConsumers, pairQueues, parseLinkRef, resolveManualLinks,
} from "../src/linker/link.js";
import { effectiveRoutes } from "../src/linker/mounts.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { EndpointsFile, Route } from "../src/store/schemas.js";
import { parsed } from "./adapter-helpers.js";

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

function endpoints(repo: string, partial: Partial<EndpointsFile>): EndpointsFile {
  return {
    version: 2, repo, pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [],
    dbAccess: [], tables: [], models: [], queues: [], ...partial,
  };
}

function index(files: Record<string, string>): RepoCodeIndex {
  const idx: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) idx.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return idx;
}

function repoWith(id: string, files: Record<string, string>, ep: Partial<EndpointsFile>, abs?: string): { data: RepoData; resolver: CallResolver } {
  const idx = index(files);
  return {
    data: { ref: { id, path: id }, abs: abs ?? `/ws/${id}`, graph: graphStub(), endpoints: endpoints(id, ep) },
    resolver: createCallResolver({ repo: id, index: idx, files: new Set(idx.keys()), aliases: [] }),
  };
}

function ws(repos: RepoData[], links: WorkspaceData["links"] = []): WorkspaceData {
  return { root: "/ws", name: "ws", repos, links };
}

describe("findHandler", () => {
  it("resolves a non-inline handler straight from route.handler", () => {
    const { data, resolver } = repoWith("api", {
      "app/controllers/customers_controller.ts": "export default class CustomersController { async store() { return 1; } }",
    }, {});
    const route: Route = {
      method: "POST", path: "/api/customers", handler: "CustomersController.store", inline: false,
      framework: "adonis", at: { file: "start/routes.ts", line: 1, symbol: "<module>" },
      handlerFile: "app/controllers/customers_controller.ts",
    };
    const er = effectiveRoutes(endpoints("api", { routes: [route] }))[0]!;
    const found = findHandler({ ws: ws([data]), resolvers: new Map([["api", resolver]]) }, er);
    expect(found).toEqual({ ref: { repo: "api", file: "app/controllers/customers_controller.ts", symbol: "CustomersController.store" }, confidence: "exact" });
  });

  it("resolves a next-api \"default\" handler to the file's actual default export", () => {
    const { data, resolver } = repoWith("api", {
      "pages/api/widgets.ts": "export default function handler(req, res) { res.end(); }",
    }, {});
    const route: Route = {
      method: "ANY", path: "/api/widgets", handler: "default", inline: false, framework: "next-api",
      at: { file: "pages/api/widgets.ts", line: 1, symbol: "default" }, handlerFile: "pages/api/widgets.ts",
    };
    const er = effectiveRoutes(endpoints("api", { routes: [route] }))[0]!;
    const found = findHandler({ ws: ws([data]), resolvers: new Map([["api", resolver]]) }, er);
    expect(found).toEqual({ ref: { repo: "api", file: "pages/api/widgets.ts", symbol: "handler" }, confidence: "exact" });
  });

  it("falls back to a synthetic symbol spanning the handler's own lines for an anonymous inline callback", () => {
    const code = ["import express from \"express\";", "const app = express();", "app.get(\"/health\", (_req, res) => {", "  res.json({ ok: true });", "});", ""].join("\n");
    const { data, resolver } = repoWith("billing", { "src/server.ts": code }, {});
    const route: Route = {
      method: "GET", path: "/health", handler: "GET /health", inline: true, framework: "express",
      at: { file: "src/server.ts", line: 3, symbol: "<module>" }, handlerFile: "src/server.ts", handlerLines: [3, 5],
    };
    const er = effectiveRoutes(endpoints("billing", { routes: [route] }))[0]!;
    const found = findHandler({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) }, er);
    expect(found).toEqual({ ref: { repo: "billing", file: "src/server.ts", symbol: "GET /health" }, confidence: "exact" });
  });

  it("returns null when the route has no known handler file", () => {
    const route: Route = { method: "GET", path: "/x", handler: "f", inline: false, framework: "express", at: { file: "a.ts", line: 1, symbol: "<module>" } };
    const er = effectiveRoutes(endpoints("api", { routes: [route] }))[0]!;
    expect(findHandler({ ws: ws([]), resolvers: new Map() }, er)).toBeNull();
  });
});

describe("linkBackend", () => {
  it("walks handler -> service and records a db hit and an unresolved call", () => {
    const { data, resolver } = repoWith("api", {
      "app/controllers/customers_controller.ts": [
        'import CustomerService from "../services/customer_service.js";',
        "export default class CustomersController {",
        "  async store() {",
        "    logger.track();",
        "    return new CustomerService().create({});",
        "  }",
        "}",
        "",
      ].join("\n"),
      "app/services/customer_service.ts": [
        "export default class CustomerService {",
        "  async create(payload) {",
        "    return payload;",
        "  }",
        "}",
        "",
      ].join("\n"),
    }, {
      routes: [{
        method: "POST", path: "/api/customers", handler: "CustomersController.store", inline: false,
        framework: "adonis", at: { file: "start/routes.ts", line: 1, symbol: "<module>" },
        handlerFile: "app/controllers/customers_controller.ts",
      }],
      dbAccess: [{ table: "customers", op: "insert", via: "lucid", at: { file: "app/services/customer_service.ts", line: 2, symbol: "CustomerService.create" } }],
    });
    const links = linkBackend({ ws: ws([data]), resolvers: new Map([["api", resolver]]) });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      repo: "api", handler: { repo: "api", file: "app/controllers/customers_controller.ts", symbol: "CustomersController.store" },
      handlerConfidence: "exact",
      hits: [{ kind: "db", access: { table: "customers", op: "insert" } }],
    });
    expect(links[0]!.hits[0]!.viaPath.map((s) => s.ref.symbol)).toEqual(["CustomersController.store", "CustomerService.create"]);
    expect(links[0]!.unresolved).toEqual([{ at: { file: "app/controllers/customers_controller.ts", line: 4, symbol: "CustomersController.store" }, reason: 'could not resolve "logger.track(...)"' }]);
  });

  it("reports handler-not-found when the route's handler file is unknown", () => {
    const { data, resolver } = repoWith("billing", {}, {
      routes: [{ method: "GET", path: "/mystery", handler: "doIt", inline: false, framework: "express", at: { file: "src/server.ts", line: 1, symbol: "<module>" } }],
    });
    const links = linkBackend({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) });
    expect(links[0]).toMatchObject({ handler: null, handlerConfidence: "guess", hits: [], unresolved: [] });
  });
});

describe("pairQueues", () => {
  it("pairs a plain sendToQueue with a same-name consume, exact", () => {
    const billing = repoWith("billing", {}, { queues: [{ queue: "invoice.created", op: "publish", at: { file: "src/invoices.ts", line: 1, symbol: "createInvoice" } }] }).data;
    const notifier = repoWith("worker", {}, { queues: [{ queue: "invoice.created", op: "consume", at: { file: "src/events.ts", line: 1, symbol: "startConsumer" } }] }).data;
    const pairs = pairQueues(ws([billing, notifier]));
    expect(pairs).toEqual([{
      publish: billing.endpoints.queues[0], consume: notifier.endpoints.queues[0],
      repoFrom: "billing", repoTo: "worker", confidence: "exact",
    }]);
  });

  it("pairs an exchange publish with a topic-wildcard binding, as param", () => {
    const billing = repoWith("billing", {}, {
      queues: [
        { queue: "emails", op: "bind", exchange: "billing", routingKey: "invoice.*", at: { file: "src/notify-consumer.ts", line: 1, symbol: "startNotifier" } },
        { queue: "emails", op: "consume", at: { file: "src/notify-consumer.ts", line: 2, symbol: "startNotifier" } },
        { queue: "billing:invoice.paid", op: "publish", exchange: "billing", routingKey: "invoice.paid", at: { file: "src/invoices.ts", line: 10, symbol: "payInvoice" } },
      ],
    }).data;
    const pairs = pairQueues(ws([billing]));
    expect(pairs).toEqual([{
      publish: billing.endpoints.queues[2], consume: billing.endpoints.queues[1],
      repoFrom: "billing", repoTo: "billing", confidence: "param",
    }]);
  });

  it("falls back to a guess pairing when an exchange publish matches no binding", () => {
    const a = repoWith("a", {}, { queues: [{ queue: "x:k", op: "publish", exchange: "x", routingKey: "k", at: { file: "a.ts", line: 1, symbol: "f" } }] }).data;
    const b = repoWith("b", {}, { queues: [{ queue: "k", op: "consume", at: { file: "b.ts", line: 1, symbol: "g" } }] }).data;
    const pairs = pairQueues(ws([a, b]));
    expect(pairs).toMatchObject([{ confidence: "guess" }]);
  });
});

describe("linkConsumers", () => {
  it("resolves a named consume callback and walks its calls to a db hit", () => {
    const code = [
      'import amqp from "amqplib";',
      "export async function startNotifier() {",
      "  const conn = await amqp.connect();",
      "  const channel = await conn.createChannel();",
      '  await channel.bindQueue("emails", "billing", "invoice.*");',
      '  await channel.consume("emails", handleEmail);',
      "}",
      "",
      "async function handleEmail(msg) {",
      "  return prisma.emailLog.create({ data: {} });",
      "}",
      "",
    ].join("\n");
    const { data, resolver } = repoWith("billing", { "src/notify-consumer.ts": code }, {
      queues: [{ queue: "emails", op: "consume", at: { file: "src/notify-consumer.ts", line: 6, symbol: "startNotifier" } }],
      dbAccess: [{ table: "email_logs", op: "insert", via: "prisma", at: { file: "src/notify-consumer.ts", line: 10, symbol: "handleEmail" } }],
    });
    const links = linkConsumers({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      repo: "billing", handler: { repo: "billing", file: "src/notify-consumer.ts", symbol: "handleEmail" },
      hits: [{ kind: "db", access: { table: "email_logs" } }],
    });
  });

  it("falls back to the consume call's own enclosing symbol for an inline callback", () => {
    const code = [
      'import amqp from "amqplib";',
      "export async function startConsumer() {",
      "  const conn = await amqp.connect();",
      "  const channel = await conn.createChannel();",
      '  await channel.consume("invoice.created", (msg) => {',
      "    if (msg) channel.ack(msg);",
      "  });",
      "}",
      "",
    ].join("\n");
    const { data, resolver } = repoWith("billing", { "src/events.ts": code }, {
      queues: [{ queue: "invoice.created", op: "consume", at: { file: "src/events.ts", line: 5, symbol: "startConsumer" } }],
    });
    const links = linkConsumers({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) });
    expect(links[0]).toMatchObject({ handler: { repo: "billing", file: "src/events.ts", symbol: "startConsumer" }, hits: [] });
  });
});

describe("parseLinkRef", () => {
  it("parses a symbol ref", () => {
    expect(parseLinkRef("api:app/services/customer_service.ts#CustomerService.create")).toEqual({
      kind: "symbol", repo: "api", file: "app/services/customer_service.ts", symbol: "CustomerService.create",
    });
  });
  it("parses a route ref", () => {
    expect(parseLinkRef("route:billing:POST /billing/invoices")).toEqual({ kind: "route", repo: "billing", method: "POST", path: "/billing/invoices" });
  });
  it("parses a queue ref", () => {
    expect(parseLinkRef("queue:billing:invoice.created")).toEqual({ kind: "queue", repo: "billing", queue: "invoice.created" });
  });
  it("returns null for an unparseable ref", () => {
    expect(parseLinkRef("not-a-ref")).toBeNull();
  });
});

describe("resolveManualLinks", () => {
  it("resolves a link between two existing symbols", () => {
    const { data, resolver } = repoWith("api", { "a.ts": "export function f() { return 1; }", "b.ts": "export function g() { return 2; }" }, {});
    const links = resolveManualLinks({
      ws: ws([data], [{ from: "api:a.ts#f", to: "api:b.ts#g" }]),
      resolvers: new Map([["api", resolver]]),
    });
    // a symbol target is walked like a handler (final review batch 2, item B)
    expect(links).toEqual([{
      from: "api:a.ts#f", to: "api:b.ts#g", resolved: true,
      target: { handler: { repo: "api", file: "b.ts", symbol: "g" }, hits: [], unresolved: [] },
    }]);
  });

  it("marks a link unresolved when a referenced symbol does not exist", () => {
    const { data, resolver } = repoWith("api", { "a.ts": "export function f() { return 1; }" }, {});
    const links = resolveManualLinks({
      ws: ws([data], [{ from: "api:a.ts#f", to: "api:a.ts#missing" }]),
      resolvers: new Map([["api", resolver]]),
    });
    expect(links).toEqual([{ from: "api:a.ts#f", to: "api:a.ts#missing", resolved: false, reason: '"api:a.ts#missing" was not found' }]);
  });

  it("marks a link unresolved when it cannot be parsed", () => {
    const links = resolveManualLinks({ ws: ws([], [{ from: "garbage", to: "also garbage" }]), resolvers: new Map() });
    expect(links).toEqual([{ from: "garbage", to: "also garbage", resolved: false, reason: "could not parse link reference" }]);
  });
});

describe("linkAll", () => {
  it("combines every stage into one result", () => {
    const result = linkAll({ ws: ws([]), resolvers: new Map() });
    expect(result).toEqual({ ui: [], backend: [], consumers: [], queuePairs: [], manual: [], uiReach: [] });
  });
});

describe("backend linking — beyond the brief", () => {
  it("joins an anonymous inline handler's calls and accesses by its line range", () => {
    const code = [
      'import { saveInvoice } from "./repo.js";',               // 1
      "export function registerRoutes(app) {",                  // 2
      '  app.post("/invoices", async (req, res) => {',          // 3
      "    await saveInvoice(req.body);",                       // 4
      "    await db.audit.create({});",                         // 5
      "    res.json({});",                                      // 6
      "  });",                                                  // 7
      '  app.get("/other", (_req, res) => { helper(); res.end(); });', // 8
      "}",                                                      // 9
      "",
    ].join("\n");
    const { data, resolver } = repoWith("billing", {
      "src/routes.ts": code,
      "src/repo.ts": "export async function saveInvoice(x) { return x; }\n",
    }, {
      routes: [{
        method: "POST", path: "/invoices", handler: "POST /invoices", inline: true, framework: "express",
        at: { file: "src/routes.ts", line: 3, symbol: "registerRoutes" }, handlerFile: "src/routes.ts", handlerLines: [3, 7],
      }],
      dbAccess: [
        { table: "invoices", op: "insert", via: "prisma", at: { file: "src/repo.ts", line: 1, symbol: "saveInvoice" } },
        { table: "audits", op: "insert", via: "prisma", at: { file: "src/routes.ts", line: 5, symbol: "registerRoutes" } },
      ],
    });
    const [link] = linkBackend({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) });
    expect(link!.handler).toEqual({ repo: "billing", file: "src/routes.ts", symbol: "POST /invoices" });
    expect(link!.hits.map((h) => (h.kind === "db" ? h.access.table : h.op.queue))).toEqual(["audits", "invoices"]);
    expect(link!.hits[1]!.viaPath.map((s) => s.ref.symbol)).toEqual(["POST /invoices", "saveInvoice"]);
    // Calls of the sibling handler on line 8 (helper()) are not this handler's.
    expect(link!.unresolved).toEqual([{ at: { file: "src/routes.ts", line: 6, symbol: "POST /invoices" }, reason: 'could not resolve "res.json(...)"' }]);
  });

  it("marks a named handler the code index does not know as a guess", () => {
    const { data, resolver } = repoWith("api", { "src/h.ts": "export function other() {}\n" }, {});
    const route: Route = {
      method: "GET", path: "/x", handler: "missing", inline: false, framework: "express",
      at: { file: "src/app.ts", line: 1, symbol: "<module>" }, handlerFile: "src/h.ts",
    };
    const er = effectiveRoutes(endpoints("api", { routes: [route] }))[0]!;
    expect(findHandler({ ws: ws([data]), resolvers: new Map([["api", resolver]]) }, er))
      .toEqual({ ref: { repo: "api", file: "src/h.ts", symbol: "missing" }, confidence: "guess" });
  });

  it("matches '#' bindings against zero or more words and keeps one pair per publish/consume", () => {
    const repo = repoWith("b", {}, {
      queues: [
        { queue: "all", op: "bind", exchange: "ex", routingKey: "invoice.#", at: { file: "c.ts", line: 1, symbol: "s" } },
        { queue: "all", op: "bind", exchange: "ex", routingKey: "invoice", at: { file: "c.ts", line: 2, symbol: "s" } },
        { queue: "all", op: "consume", at: { file: "c.ts", line: 3, symbol: "s" } },
        { queue: "ex:invoice", op: "publish", exchange: "ex", routingKey: "invoice", at: { file: "p.ts", line: 1, symbol: "p" } },
      ],
    }).data;
    expect(pairQueues(ws([repo]))).toMatchObject([{ confidence: "exact", consume: { op: "consume", queue: "all" } }]);
  });

  it("rejects a route ref with an unknown HTTP method", () => {
    expect(parseLinkRef("route:api:FETCH /x")).toBeNull();
  });
});

describe("store sites are terminals (Task 12 fix)", () => {
  it("does not walk on through a call that is itself a recorded DbAccess or QueueOp site", () => {
    const files = {
      "src/notify.ts": [
        "export async function handleEmail(msg) {",
        "  await db.create({ data: {} });",
        '  await channel.publish("billing", "x");',
        "}",
        "",
      ].join("\n"),
      // `db.create(...)` / `channel.publish(...)` would otherwise be unique-method guesses onto these.
      "src/invoice-service.ts": [
        "export const invoiceService = {",
        "  async create(data) {",
        "    return store.insertInvoice(data);",
        "  },",
        "  async publish(id) {",
        "    return store.insertOutbox(id);",
        "  },",
        "};",
        "",
      ].join("\n"),
    };
    const { data, resolver } = repoWith("billing", files, {
      queues: [
        { queue: "emails", op: "consume", at: { file: "src/notify.ts", line: 1, symbol: "handleEmail" } },
        { queue: "billing:x", op: "publish", exchange: "billing", routingKey: "x", at: { file: "src/notify.ts", line: 3, symbol: "handleEmail" } },
      ],
      dbAccess: [
        { table: "email_logs", op: "insert", via: "prisma", at: { file: "src/notify.ts", line: 2, symbol: "handleEmail" } },
        { table: "invoices", op: "insert", via: "prisma", at: { file: "src/invoice-service.ts", line: 3, symbol: "invoiceService.create" } },
        { table: "outbox", op: "insert", via: "prisma", at: { file: "src/invoice-service.ts", line: 6, symbol: "invoiceService.publish" } },
      ],
    });
    // Sanity: without the fix these sites do resolve (as guesses), so the walk would follow them.
    expect(resolver.callsFrom({ repo: "billing", file: "src/notify.ts", symbol: "handleEmail" }).map((c) => c.target.symbol))
      .toEqual(["invoiceService.create", "invoiceService.publish"]);
    const [link] = linkConsumers({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) });
    expect(link!.hits.map((h) => (h.kind === "db" ? h.access.table : h.op.queue))).toEqual(["email_logs", "billing:x"]);
    expect(link!.hits.every((h) => h.viaPath.length === 1)).toBe(true);
  });
});

describe("store-site terminals only drop guesses (Task 12 review fix 1)", () => {
  it("follows an exact call on the same line as a consume: a one-line inline consumer reaches its store", () => {
    const code = [
      "export async function startJobs(conn) {",                       // 1
      "  const ch = await conn.createChannel();",                      // 2
      '  ch.consume("inline", (m) => recordJob(m));',                  // 3
      "}",                                                             // 4
      "export async function recordJob(m) {",                          // 5
      "  return prisma.job.create({ data: {} });",                     // 6
      "}",                                                             // 7
      "",
    ].join("\n");
    const { data, resolver } = repoWith("billing", { "src/jobs.ts": code }, {
      queues: [{ queue: "inline", op: "consume", at: { file: "src/jobs.ts", line: 3, symbol: "startJobs" } }],
      dbAccess: [{ model: "job", op: "insert", via: "prisma", at: { file: "src/jobs.ts", line: 6, symbol: "recordJob" } }],
    });
    const [link] = linkConsumers({ ws: ws([data]), resolvers: new Map([["billing", resolver]]) });
    expect(link!.hits.map((h) => (h.kind === "db" ? h.access.model : h.op.queue))).toEqual(["job"]);
    expect(link!.hits[0]!.viaPath.map((s) => s.ref.symbol)).toEqual(["startJobs", "recordJob"]);
  });

  it("keeps an exact hop nested inside a store call, and still reports other unresolved calls on that line", () => {
    const code = [
      'import { buildAudit } from "./audit.js";',                                    // 1
      "export async function createAudit(req, res) {",                               // 2
      "  res.json(await prisma.audit.create({ data: await buildAudit() }));",        // 3
      "}",                                                                           // 4
      "",
    ].join("\n");
    const { data, resolver } = repoWith("api", {
      "src/h.ts": code,
      "src/audit.ts": 'export async function buildAudit() {\n  return db.from("users").select();\n}\n',
    }, {
      routes: [{
        method: "POST", path: "/audit", handler: "createAudit", inline: false, framework: "express",
        at: { file: "src/app.ts", line: 1, symbol: "<module>" }, handlerFile: "src/h.ts",
      }],
      dbAccess: [
        { model: "audit", op: "insert", via: "prisma", at: { file: "src/h.ts", line: 3, symbol: "createAudit" } },
        { table: "users", op: "read", via: "query-builder", at: { file: "src/audit.ts", line: 2, symbol: "buildAudit" } },
      ],
    });
    const [link] = linkBackend({ ws: ws([data]), resolvers: new Map([["api", resolver]]) });
    expect(link!.hits.map((h) => (h.kind === "db" ? h.access.table ?? h.access.model : ""))).toEqual(["audit", "users"]);
    expect(link!.hits[1]!.viaPath.map((s) => s.ref.symbol)).toEqual(["createAudit", "buildAudit"]);
    // res.json is not the store call: it is reported; prisma.audit.create (the store call) and db.from are not.
    expect(link!.unresolved).toEqual([{ at: { file: "src/h.ts", line: 3, symbol: "createAudit" }, reason: 'could not resolve "res.json(...)"' }]);
  });
});
