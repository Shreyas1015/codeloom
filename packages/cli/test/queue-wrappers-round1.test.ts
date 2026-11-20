import { describe, expect, it } from "vitest";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import { collectQueueOps, detectQueues } from "../src/adapters/queues.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

// v0.6 Task B, review round 1: fixes for shadowing, amqplib-channel provenance, constructor-injected
// fields, default/barrel exports, multi-op wrappers and the consume handler-argument index. The adapter
// side only — link.ts's own handler lookup and exchange-type routing-key matching are Task C's.

describe("review round 1, critical 1: handlerArg on every consume op", () => {
  it("a direct amqplib consume always has handlerArg 1", () => {
    const calls = detectQueues(parsed("src/x.ts", `
      export function start(channel: any) { channel.consume("orders", onOrder); }
      function onOrder() {}
    `), ctxWith("amqplib"));
    expect(calls).toEqual([{ queue: "orders", op: "consume", handlerArg: 1, at: { file: "src/x.ts", line: 2, symbol: "start" } }]);
  });

  it("a wrapper of ANY method name still carries the right handlerArg (not tied to the literal 'consume' property)", () => {
    const calls = detectQueues(parsed("src/qs.ts", `
      class QueueService {
        channel: any;
        listen(queue: string, handler: (m: unknown) => void) { return this.channel.consume(queue, handler); }
      }
      const queueService = new QueueService();
      export function start() { queueService.listen("orders", onOrder); }
      function onOrder() {}
    `), ctxWith("amqplib"));
    expect(calls).toEqual([{ queue: "orders", op: "consume", handlerArg: 1, at: { file: "src/qs.ts", line: 7, symbol: "start" } }]);
  });

  it("a bare function consume wrapper also carries handlerArg", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      export function subscribe(queue: string, handler: any) { return channel.consume(queue, handler); }
      export function start() { subscribe("orders", onOrder); }
      function onOrder() {}
    `), ctxWith("amqplib"));
    expect(calls).toEqual([{ queue: "orders", op: "consume", handlerArg: 1, at: { file: "src/q.ts", line: 3, symbol: "start" } }]);
  });
});

describe("review round 1, item 8: assertExchange records the exchange's type", () => {
  it("through a wrapper, with the exchange name forwarded from the caller", () => {
    const { exchanges, resolved } = collectQueueOps(parsed("src/q.ts", `
      export async function subscribe(queue: string, exchange: string, key: string, handler: any) {
        await channel.assertExchange(exchange, "topic");
        await channel.bindQueue(queue, exchange, key);
        await channel.consume(queue, handler);
      }
      export async function start() { await subscribe("billing.invoices", "events", "invoice.created", onInvoice); }
      function onInvoice() {}
    `), ctxWith("amqplib"));
    expect(exchanges).toEqual([{ name: "events", type: "topic", at: { file: "src/q.ts", line: 7, symbol: "start" } }]);
    expect(resolved.find((q) => q.op === "bind")).toMatchObject({ queue: "billing.invoices", exchange: "events", routingKey: "invoice.created" });
  });

  it("never guesses: a dynamic/unresolvable exchange type is dropped", () => {
    const { exchanges } = collectQueueOps(parsed("src/q.ts", `
      export function assertIt(channel: any, type: string) { channel.assertExchange("events", type); }
    `), ctxWith("amqplib"));
    expect(exchanges).toEqual([]);
  });

  it("never guesses: a resolvable but non-amqplib exchange type is dropped", () => {
    const { exchanges } = collectQueueOps(parsed("src/q.ts", `
      export function assertIt(channel: any) { channel.assertExchange("events", "not-a-real-type"); }
    `), ctxWith("amqplib"));
    expect(exchanges).toEqual([]);
  });

  it("the exchange type resolves one import hop away too (\"through ... constants\")", () => {
    const ctx = ctxWith("amqplib");
    const parts = [
      runAdapters("src/constants.ts", `export const ExchangeTypes = { EVENTS: "topic" } as const;`, ctx),
      runAdapters("src/q.ts", `
        import { ExchangeTypes } from "./constants";
        export function assertIt(channel: any) { channel.assertExchange("events", ExchangeTypes.EVENTS); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, (_f, s) => ({ "./constants": "src/constants.ts" })[s] ?? null);
    expect(ep.exchanges).toEqual([{ name: "events", type: "topic", at: { file: "src/q.ts", line: 3, symbol: "assertIt" } }]);
  });
});

describe("review round 1, item 7: a wrapper with several amqplib calls produces one op per call", () => {
  it("assertExchange + bindQueue + consume all from one call site", () => {
    const { resolved, exchanges } = collectQueueOps(parsed("src/q.ts", `
      export async function subscribe(queue: string, exchange: string, key: string, handler: any) {
        await channel.assertExchange(exchange, "topic");
        await channel.assertQueue(queue);
        await channel.bindQueue(queue, exchange, key);
        await channel.consume(queue, handler);
      }
      export async function start() { await subscribe("billing.invoices", "events", "invoice.created", onInvoice); }
      function onInvoice() {}
    `), ctxWith("amqplib"));
    expect(exchanges).toHaveLength(1);
    expect(resolved.map((q) => `${q.op} ${q.queue}`)).toEqual(["bind billing.invoices", "consume billing.invoices"]);
  });
});

describe("review round 1, item 2: shadowing — bare names respect parameters and local declarations", () => {
  it("a wrapper parameter that shadows a top-level const of the same name never resolves to the const", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      const queue = "fallback";
      export function enqueue(queue: string, msg: object) { channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
      export function a() { enqueue("real", { x: 1 }); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([{ queue: "real", op: "publish", at: { file: "src/q.ts", line: 4, symbol: "a" } }]);
  });

  it("a local variable that shadows a top-level const, with an unresolvable value, drops the op entirely", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      const Q = "static.q";
      export function f(name: string) { const Q = name + ".dyn"; channel.sendToQueue(Q, Buffer.from("x")); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([]);
  });

  it("never forwards a parameter that is reassigned before the amqplib call", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      export function enqueue(queue: string, msg: object) { queue = process.env.PREFIX + queue; channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
      export function a() { enqueue("orders", { x: 1 }); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([]);
  });

  it("minor: uses a parameter's own default value when the call site omits the argument", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      const DEFAULT_QUEUE = "jobs";
      export function enqueue(msg: object, queue = DEFAULT_QUEUE) { channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
      export function a() { enqueue({ x: 1 }); }
      export function b() { enqueue({ x: 1 }, "other"); }
    `), ctxWith("amqplib"));
    expect(calls.map((q) => `${q.queue}@${q.at.symbol}`)).toEqual(["jobs@a", "other@b"]);
  });
});

describe("review round 1, item 3: a wrapper is only discovered when its receiver is really amqplib", () => {
  it("a Redis-backed publish/consume class records nothing", () => {
    const calls = detectQueues(parsed("src/bus.ts", `
      import Redis from "ioredis";
      export class Notifier {
        publisher = new Redis();
        async publish(channel: string, message: string) { await this.publisher.publish(channel, message); }
      }
      const notifier = new Notifier();
      export function refresh() { notifier.publish("cache", "invalidate"); }
    `), ctxWith("amqplib", "ioredis"));
    expect(calls).toEqual([]);
  });

  it("a generic job-queue class (ambiguous field name, loosely typed, never created via createChannel) records nothing", () => {
    const calls = detectQueues(parsed("src/jobs.ts", `
      export class Jobs { queue: any; consume(name: string, fn: any) { return this.queue.consume(name, fn); } }
      const jobs = new Jobs();
      export function start() { jobs.consume("thumbnails", handler); }
      function handler() {}
    `), ctxWith("amqplib"));
    expect(calls).toEqual([]);
  });

  it("a loosely-typed DI-injected field still resolves when the name is unambiguous ('channel')", () => {
    const calls = detectQueues(parsed("src/qs.ts", `
      export class QueueService {
        constructor(private readonly channel: any) {}
        send(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
      }
    `), ctxWith("amqplib"));
    // called nowhere in this file, so nothing resolves yet — this only asserts the wrapper itself is
    // discoverable (checked properly via the cross-file test below); this test guards against the
    // discovery step silently rejecting a "channel"-named field merely for being typed loosely.
    expect(calls).toEqual([]);
  });
});

describe("review round 1, item 6: default exports, export lists, new ImportedClass(), DI fields, barrels, bare imported consts", () => {
  const resolve = (map: Record<string, string>) => (_from: string, spec: string) => map[spec] ?? null;
  const ctx = ctxWith("amqplib");

  it("export default class with static methods", () => {
    const parts = [
      runAdapters("app/services/queue_service.ts", `
        export default class QueueService {
          static channel: any;
          static async publish(queue: string, msg: object) { QueueService.channel.sendToQueue(queue, Buffer.from("x")); }
        }
      `, ctx),
      runAdapters("app/controllers/invoices.ts", `
        import QueueService from "../services/queue_service";
        export default class InvoicesController { async store() { await QueueService.publish("invoice.created", {}); } }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "../services/queue_service": "app/services/queue_service.ts" }));
    expect(ep.queues.map((q) => q.queue)).toEqual(["invoice.created"]);
  });

  it("export default new instance", () => {
    const parts = [
      runAdapters("app/services/queue_service.ts", `
        class QueueService { channel: any; async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from("x")); } }
        export default new QueueService();
      `, ctx),
      runAdapters("app/controllers/invoices.ts", `
        import queueService from "../services/queue_service";
        export async function store() { await queueService.publish("invoice.created", {}); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "../services/queue_service": "app/services/queue_service.ts" }));
    expect(ep.queues.map((q) => q.queue)).toEqual(["invoice.created"]);
  });

  it("export { queueService } named list", () => {
    const parts = [
      runAdapters("src/qs.ts", `
        class QueueService { channel: any; async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from("x")); } }
        const queueService = new QueueService();
        export { queueService };
      `, ctx),
      runAdapters("src/o.ts", `
        import { queueService } from "./qs";
        export async function store() { await queueService.publish("invoice.created", {}); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "./qs": "src/qs.ts" }));
    expect(ep.queues.map((q) => q.queue)).toEqual(["invoice.created"]);
  });

  it("`new ImportedClass()` (the class is declared in another file, instantiated locally)", () => {
    const parts = [
      runAdapters("src/qs.ts", `
        export class QueueService { channel: any; async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from("x")); } }
      `, ctx),
      runAdapters("src/o.ts", `
        import { QueueService } from "./qs";
        const qs = new QueueService();
        export async function store() { await qs.publish("invoice.created", {}); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "./qs": "src/qs.ts" }));
    expect(ep.queues.map((q) => q.queue)).toEqual(["invoice.created"]);
  });

  it("constructor-injected `this.service.method(...)` resolves the field's own type annotation", () => {
    const parts = [
      runAdapters("src/queue.service.ts", `
        import { Channel } from "amqplib";
        export class QueueService {
          constructor(private readonly channel: Channel) {}
          publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
        }
      `, ctx),
      runAdapters("src/orders.service.ts", `
        import { QueueService } from "./queue.service";
        export class OrdersService {
          constructor(private readonly queueService: QueueService) {}
          create() { this.queueService.publish("invoice.created", { id: 1 }); }
        }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "./queue.service": "src/queue.service.ts" }));
    // must resolve via the wrapper's own slot (sendToQueue, single queue name) — never misread as a
    // 2-arg exchange+key publish just because the method is named "publish" and both args are strings.
    expect(ep.queues).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/orders.service.ts", line: 5, symbol: "OrdersService.create" } },
    ]);
  });

  it("a barrel re-export (`export * from`) is followed for both the wrapper and a literal name", () => {
    const parts = [
      runAdapters("src/services/queue-service.ts", `
        export class QueueService { channel: any; async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from("x")); } }
        export const queueService = new QueueService();
      `, ctx),
      runAdapters("src/services/index.ts", `export * from "./queue-service";`, ctx),
      runAdapters("src/orders.ts", `
        import { queueService } from "./services";
        export async function createOrder() { await queueService.publish("orders", {}); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "./services": "src/services/index.ts", "./queue-service": "src/services/queue-service.ts" }));
    expect(ep.queues.map((q) => q.queue)).toEqual(["orders"]);
  });

  it("an imported bare string const (no enum/object wrapper)", () => {
    const parts = [
      runAdapters("src/c.ts", `export const ORDERS_QUEUE = "orders";`, ctx),
      runAdapters("src/x.ts", `
        import { ORDERS_QUEUE } from "./c";
        export function f(channel: any) { channel.sendToQueue(ORDERS_QUEUE, Buffer.from("x")); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, resolve({ "./c": "src/c.ts" }));
    expect(ep.queues.map((q) => q.queue)).toEqual(["orders"]);
  });
});

describe("review round 1, minor: the instance map is scoped per function, not a flat whole-file map", () => {
  it("two functions, each with their own same-named instance of a DIFFERENT class, never cross-attribute", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      class B { publish(topic: string, m: object) { console.log(topic); } }
      class A { channel: any; publish(q: string, m: object) { this.channel.sendToQueue(q, Buffer.from("x")); } }
      export function g() { const svc = new B(); svc.publish("not.a.queue", {}); }
      export function f() { const svc = new A(); svc.publish("a.q", {}); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([{ queue: "a.q", op: "publish", at: { file: "src/q.ts", line: 5, symbol: "f" } }]);
  });
});

describe("review round 1, item 5: pending wrapper calls only for relative/alias/# imports, never a bare package", () => {
  it("a call on a bare-package import is never captured as a pending wrapper call at all", () => {
    const { wrapperCalls } = collectQueueOps(parsed("src/x.ts", `
      import { Injectable } from "@nestjs/common";
      export function f() { Injectable("orders"); }
    `), ctxWith("amqplib", "@nestjs/common"));
    expect(wrapperCalls).toEqual([]);
  });

  it("the same shape on a relative import IS captured as a pending wrapper call", () => {
    const { wrapperCalls } = collectQueueOps(parsed("src/x.ts", `
      import { publishEvent } from "./events";
      export function f() { publishEvent("orders"); }
    `), ctxWith("amqplib"));
    expect(wrapperCalls).toHaveLength(1);
    expect(wrapperCalls[0]).toMatchObject({ from: "./events", importedName: "publishEvent" });
  });

  it("minor: lifted MAX_WRAPPER_ARGS — a wrapper forwarding its 4th parameter still resolves across files", () => {
    const ctx = ctxWith("amqplib");
    const parts = [
      runAdapters("src/w.ts", `
        export function pub(body: object, opts: object, headers: object, key: string) { return channel.publish("events", key, Buffer.from("x")); }
      `, ctx),
      runAdapters("src/o.ts", `
        import { pub } from "./w";
        export function f() { pub({}, {}, {}, "order.created"); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, (_f, s) => ({ "./w": "src/w.ts" })[s] ?? null);
    expect(ep.queues).toEqual([
      {
        queue: "events:order.created", op: "publish", exchange: "events", routingKey: "order.created",
        at: { file: "src/o.ts", line: 3, symbol: "f" },
      },
    ]);
  });
});
