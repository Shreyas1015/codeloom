import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";
import type { CallResolver } from "../src/linker/resolve-calls.js";
import { HANDLER_NOT_FOUND, linkAll, linkConsumers, pairQueues } from "../src/linker/link.js";
import type { QueueOp } from "../src/store/schemas.js";
import { buildChains } from "../src/linker/chains.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { EndpointsFile } from "../src/store/schemas.js";
import { parsed } from "./adapter-helpers.js";

// 0.6 Task C: consume handlers through wrappers (`handlerArg`), `this.handleX`, and exchange types. The queue
// ops are written by hand here, shaped as the RabbitMQ adapter records them.

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

function repoWith(id: string, files: Record<string, string>, ep: Partial<EndpointsFile>): { data: RepoData; resolver: CallResolver } {
  const idx: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) idx.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return {
    data: { ref: { id, path: id }, abs: `/ws/${id}`, graph: graphStub(), endpoints: endpoints(id, ep) },
    resolver: createCallResolver({ repo: id, index: idx, files: new Set(idx.keys()), aliases: [] }),
  };
}

const ws = (repos: RepoData[]): WorkspaceData => ({ root: "/ws", name: "ws", repos, links: [] });

const WORKER = [
  'import { queueService } from "./queue-service";', // 1
  "export async function start() {", // 2
  '  await queueService.listen("order.created", handleOrderCreated);', // 3
  '  await queueService.subscribe("order.paid", { durable: true }, handleOrderPaid);', // 4
  '  await queueService.listen("order.shipped", handlers.shipped);', // 5
  '  await prisma.audit.create({ data: {} });', // 6
  "}", // 7
  "async function handleOrderCreated(msg) {", // 8
  "  await prisma.orderLog.create({ data: {} });", // 9
  "}", // 10
  "async function handleOrderPaid(msg) {", // 11
  "  await prisma.payment.create({ data: {} });", // 12
  "}", // 13
  "",
].join("\n");

const at = (line: number, symbol: string) => ({ file: "src/worker.ts", line, symbol });

describe("consume handlers (0.6 Task C)", () => {
  it("reads the handler at the op's handlerArg, whatever the wrapper's method is called", () => {
    const queues: QueueOp[] = [
      { queue: "order.created", op: "consume", at: at(3, "start"), handlerArg: 1 },
      { queue: "order.paid", op: "consume", at: at(4, "start"), handlerArg: 2 },
    ];
    const { data, resolver } = repoWith("worker", { "src/worker.ts": WORKER }, {
      queues,
      dbAccess: [
        { table: "audits", op: "insert", via: "prisma", at: at(6, "start") },
        { table: "order_logs", op: "insert", via: "prisma", at: at(9, "handleOrderCreated") },
        { table: "payments", op: "insert", via: "prisma", at: at(12, "handleOrderPaid") },
      ],
    });
    const links = linkConsumers({ ws: ws([data]), resolvers: new Map([["worker", resolver]]) });
    expect(links.map((l) => [l.handler.symbol, l.handlerConfidence, l.hits.map((h) => (h.kind === "db" ? h.access.table : ""))])).toEqual([
      ["handleOrderCreated", "exact", ["order_logs"]],
      ["handleOrderPaid", "exact", ["payments"]],
    ]);
  });

  it("never claims the enclosing function as the handler when the handler cannot be found", () => {
    const queues: QueueOp[] = [
      { queue: "order.shipped", op: "consume", at: at(5, "start"), handlerArg: 1 },
      // no handlerArg and a method that is not literally `consume`: the handler position is unknown
      { queue: "order.created", op: "consume", at: at(3, "start") },
    ];
    const { data, resolver } = repoWith("worker", { "src/worker.ts": WORKER }, {
      queues, dbAccess: [{ table: "audits", op: "insert", via: "prisma", at: at(6, "start") }],
    });
    const input = { ws: ws([data]), resolvers: new Map([["worker", resolver]]) };
    const links = linkConsumers(input);
    expect(links.map((l) => [l.consume.queue, l.handler.symbol, l.handlerConfidence])).toEqual([
      ["order.created", "start", "guess"],
      ["order.shipped", "start", "guess"],
    ]);
    expect(links[0]!.unresolved).toContainEqual({ at: at(3, "start"), reason: HANDLER_NOT_FOUND });
    const chain = buildChains(input.ws, linkAll(input)).find((c) => c.entry.startsWith("consumer:worker:order.shipped#"))!;
    expect(chain.stops.find((s) => s.kind === "db")!.hop.confidence).toBe("guess");
    expect(chain.confidence).toBe("guess");
  });

  it("resolves this.handleX and this.handleX.bind(this) to that method of the enclosing class", () => {
    const code = [
      "export class OrderWorker {", // 1
      "  async start() {", // 2
      '    await this.channel.consume("order.created", this.handleCreated);', // 3
      '    await this.channel.consume("order.paid", this.handlePaid.bind(this));', // 4
      "  }", // 5
      "  async handleCreated(msg) { await prisma.orderLog.create({ data: {} }); }", // 6
      "  handlePaid = async (msg) => { await prisma.payment.create({ data: {} }); };", // 7
      "}", // 8
      "",
    ].join("\n");
    const file = (line: number, symbol: string) => ({ file: "src/order-worker.ts", line, symbol });
    const { data, resolver } = repoWith("worker", { "src/order-worker.ts": code }, {
      queues: [
        { queue: "order.created", op: "consume", at: file(3, "OrderWorker.start") },
        { queue: "order.paid", op: "consume", at: file(4, "OrderWorker.start") },
      ],
      dbAccess: [
        { table: "order_logs", op: "insert", via: "prisma", at: file(6, "OrderWorker.handleCreated") },
        { table: "payments", op: "insert", via: "prisma", at: file(7, "OrderWorker.handlePaid") },
      ],
    });
    const links = linkConsumers({ ws: ws([data]), resolvers: new Map([["worker", resolver]]) });
    expect(links.map((l) => [l.handler.symbol, l.handlerConfidence, l.hits.length])).toEqual([
      ["OrderWorker.handleCreated", "exact", 1],
      ["OrderWorker.handlePaid", "exact", 1],
    ]);
  });

  it("keeps an inline callback as the enclosing function, exact (as in 0.5)", () => {
    const code = [
      "export async function start() {",
      '  await channel.consume("jobs", async (msg) => { await prisma.job.create({ data: {} }); });',
      "}",
      "",
    ].join("\n");
    const { data, resolver } = repoWith("worker", { "src/jobs.ts": code }, {
      queues: [{ queue: "jobs", op: "consume", at: { file: "src/jobs.ts", line: 2, symbol: "start" } }],
    });
    const [link] = linkConsumers({ ws: ws([data]), resolvers: new Map([["worker", resolver]]) });
    expect([link!.handler.symbol, link!.handlerConfidence]).toEqual(["start", "exact"]);
  });
});

describe("exchange types (0.6 Task C)", () => {
  type Decl = { name: string; type: string };
  const loc = { file: "c.ts", line: 1, symbol: "s" };
  const pub = (exchange: string, routingKey: string): QueueOp =>
    ({ queue: `${exchange}:${routingKey}`, op: "publish", exchange, routingKey, at: { file: "p.ts", line: 1, symbol: "p" } });
  const bind = (queue: string, exchange: string, routingKey: string): QueueOp => ({ queue, op: "bind", exchange, routingKey, at: loc });
  const consume = (queue: string, line: number): QueueOp => ({ queue, op: "consume", at: { file: "c.ts", line, symbol: "s" } });
  /** An endpoints file part with `assertExchange` declarations, as the adapter records them. */
  const withExchanges = (queues: QueueOp[], exchanges: Decl[]): Partial<EndpointsFile> =>
    ({ queues, exchanges: exchanges.map((x) => ({ ...x, at: loc })) }) as Partial<EndpointsFile>;
  /** Pairs of an api publish with the worker's consumers, as "from>to:queue:confidence". */
  const pairsOf = (publish: QueueOp, ops: QueueOp[], workerTypes: Decl[] = [], apiTypes: Decl[] = []) => {
    const api = repoWith("api", {}, withExchanges([publish], apiTypes)).data;
    const worker = repoWith("worker", {}, withExchanges(ops, workerTypes)).data;
    return pairQueues(ws([api, worker])).map((p) => `${p.repoFrom}>${p.repoTo}:${p.consume.queue}:${p.confidence}`);
  };

  it("fanout: every bound queue, whatever the routing key", () => {
    expect(pairsOf(pub("events", "invoice.paid"), [bind("emails", "events", ""), bind("audit", "events", "x"), consume("emails", 2), consume("audit", 3)],
      [{ name: "events", type: "fanout" }])).toEqual(["api>worker:emails:exact", "api>worker:audit:exact"]);
  });

  it("direct: the same key only — a `*` in a direct binding is a plain character", () => {
    const direct = [{ name: "events", type: "direct" }];
    expect(pairsOf(pub("events", "invoice.paid"), [bind("emails", "events", "invoice.*"), consume("emails", 2)], direct)).toEqual([]);
    expect(pairsOf(pub("events", "invoice.paid"), [bind("emails", "events", "invoice.paid"), consume("emails", 2)], direct))
      .toEqual(["api>worker:emails:exact"]);
  });

  it("topic: `*` and `#` patterns, as param", () => {
    expect(pairsOf(pub("events", "invoice.paid.late"), [
      bind("one", "events", "invoice.*"), bind("many", "events", "invoice.#"), consume("one", 2), consume("many", 3),
    ], [{ name: "events", type: "topic" }])).toEqual(["api>worker:many:param"]);
  });

  it("headers: the key is not used and headers are not read, so only a guess", () => {
    const api = repoWith("api", {}, { queues: [pub("events", "")] }).data;
    const worker = repoWith("worker", {}, withExchanges([bind("emails", "events", ""), consume("emails", 2)], [{ name: "events", type: "headers" }])).data;
    expect(pairQueues(ws([api, worker]))).toMatchObject([{ confidence: "guess", reason: expect.stringMatching(/headers/) }]);
  });

  it("an exchange declared in another repo gives the type; one declared two different ways matches the same key only", () => {
    expect(pairsOf(pub("events", "invoice.paid"), [bind("emails", "events", "invoice.*"), consume("emails", 2)], [], [{ name: "events", type: "direct" }]))
      .toEqual([]);
    expect(pairsOf(pub("events", "invoice.paid"), [bind("a", "events", "invoice.paid"), bind("b", "events", "invoice.*"), consume("a", 2), consume("b", 3)],
      [{ name: "events", type: "topic" }], [{ name: "events", type: "direct" }])).toEqual(["api>worker:a:exact"]);
  });

  it("never declared: the same key exactly, and a `*` / `#` key as a topic pattern (param)", () => {
    expect(pairsOf(pub("events", "invoice.paid"), [bind("a", "events", "invoice.paid"), bind("b", "events", "invoice.*"), bind("c", "events", "x"),
      consume("a", 2), consume("b", 3), consume("c", 4)])).toEqual(["api>worker:a:exact", "api>worker:b:param"]);
  });

  it("knows the built-in amq.* exchanges without a declaration", () => {
    expect(pairsOf(pub("amq.direct", "invoice.paid"), [bind("a", "amq.direct", "invoice.*"), consume("a", 2)])).toEqual([]);
    expect(pairsOf(pub("amq.fanout", "x"), [bind("a", "amq.fanout", "y"), consume("a", 2)])).toEqual(["api>worker:a:exact"]);
    expect(pairsOf(pub("amq.topic", "invoice.paid.late"), [bind("a", "amq.topic", "invoice.#"), consume("a", 2)])).toEqual(["api>worker:a:param"]);
  });
});

describe("consume through a wrapper, end to end (0.6 Task B review, critical 1)", () => {
  it("listen(\"order.created\", handleOrderCreated) inside start() walks handleOrderCreated (order_logs), not start (audits)", async () => {
    const { runIndex } = await import("../src/commands/index-cmd.js");
    const { makeRepo } = await import("./helpers.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repo = makeRepo({
      "package.json": JSON.stringify({ name: "orders-worker", dependencies: { amqplib: "^0.10", "@prisma/client": "^5" } }),
      "prisma/schema.prisma": 'model OrderLog {\n  id Int @id\n  @@map("order_logs")\n}\nmodel Audit {\n  id Int @id\n  @@map("audits")\n}\n',
      "src/queue-service.ts": `import amqp from "amqplib";
export class QueueService {
  channel: any;
  listen(queue: string, handler: (m: unknown) => void) { return this.channel.consume(queue, handler); }
}
export const queueService = new QueueService();
`,
      "src/worker.ts": `import { PrismaClient } from "@prisma/client";
import { queueService } from "./queue-service";
const prisma = new PrismaClient();
export async function start() {
  await queueService.listen("order.created", handleOrderCreated);
  await prisma.audit.create({ data: { id: 1 } });
}
async function handleOrderCreated(msg: unknown) {
  await prisma.orderLog.create({ data: { id: 1 } });
}
`,
    });
    const { root } = await runIndex(repo);
    const chains = JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains as Array<{ entry: string; stops: Array<{ kind: string; label?: string }> }>;
    const chain = chains.find((c) => c.entry.startsWith("consumer:orders-worker:order.created#"))!;
    expect(chain.entry).toBe("consumer:orders-worker:order.created#src/worker.ts#handleOrderCreated");
    expect(chain.stops.filter((s) => s.kind === "db").map((s) => s.label)).toEqual(["order_logs"]);
  });
});
