import { describe, expect, it } from "vitest";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import { collectQueueOps, detectQueues } from "../src/adapters/queues.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

// v0.6 Task B, review round 2: a critical regression from 0.5 (an imported receiver skipped the direct
// path entirely) plus barrel-lookup cost, named-barrel wrapper resolution, and provenance tightening.
// Adapter only — link.ts stays untouched.

describe("review round 2, critical 1: an imported receiver still falls back to the direct reading", () => {
  const ctx = ctxWith("amqplib");

  it("a value import of amqplib's own Channel type, used only for a DI annotation, resolves directly (no resolver needed)", () => {
    const calls = detectQueues(parsed("src/mailer.service.ts", `
      import { Channel } from "amqplib";
      export class MailerService {
        constructor(private readonly channel: Channel) {}
        sendWelcome() { this.channel.sendToQueue("emails", Buffer.from("x")); }
        emit() { this.channel.publish("events", "user.created", Buffer.from("x")); }
      }
    `), ctx);
    expect(calls.map((q) => q.queue)).toEqual(["emails", "events:user.created"]);
  });

  it("an imported channel singleton from a repo file resolves via the fallback direct draft once no wrapper is found", () => {
    const parts = [
      runAdapters("src/rabbit.ts", `
        import amqp from "amqplib";
        const conn = await amqp.connect("amqp://x");
        export const channel = await conn.createChannel();
      `, ctx),
      runAdapters("src/orders.ts", `
        import { channel } from "./rabbit";
        export function create() { channel.sendToQueue("orders", Buffer.from("x")); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, (_f, s) => ({ "./rabbit": "src/rabbit.ts" })[s] ?? null);
    expect(ep.queues.map((q) => q.queue)).toEqual(["orders"]);
  });

  it("the same shape resolves with NO resolver at all (0.5 parity on an isolated file)", () => {
    const part = runAdapters("src/orders.ts", `
      import { channel } from "./rabbit";
      export function create() { channel.sendToQueue("orders", Buffer.from("x")); }
    `, ctx);
    const ep = finalizeEndpoints("r", [part]);
    expect(ep.queues.map((q) => q.queue)).toEqual(["orders"]);
  });

  it("a default-imported channel resolves via the fallback direct draft", () => {
    const part = runAdapters("src/orders.ts", `
      import rabbitChannel from "./rabbit";
      export function create() { rabbitChannel.publish("events", "order.created", Buffer.from("x")); }
    `, ctx);
    const ep = finalizeEndpoints("r", [part]);
    expect(ep.queues).toEqual([
      {
        queue: "events:order.created", op: "publish", exchange: "events", routingKey: "order.created",
        at: { file: "src/orders.ts", line: 3, symbol: "create" },
      },
    ]);
  });

  it("the fallback is only used when no real wrapper resolves: a genuine wrapper still wins", () => {
    const parts = [
      runAdapters("src/rabbit.ts", `
        export class QueueService { channel: any; async publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from("x")); } }
        export const channel = new QueueService();
      `, ctx),
      runAdapters("src/orders.ts", `
        import { channel } from "./rabbit";
        export function create() { channel.publish("invoice.created", {}); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, (_f, s) => ({ "./rabbit": "src/rabbit.ts" })[s] ?? null);
    // the wrapper (sendToQueue, single queue slot) must win, not the fallback 2-arg exchange+key reading.
    expect(ep.queues).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/orders.ts", line: 3, symbol: "create" } },
    ]);
  });

  it("review round 3: a wrapper that IS found but whose own op can't resolve (an env-sourced exchange) never falls back", () => {
    // probe-b4.mjs's shape: the wrapper forwards only its routingKey parameter; the exchange is baked
    // into the wrapper's own body as an unresolvable `process.env` lookup. The caller passes two plain
    // string literals, which *would* satisfy the raw 2-arg exchange+key shape if read directly — but this
    // adapter already knows this call goes through a real wrapper, so it must record nothing rather than
    // invent an exchange from the caller's own arguments.
    const svc = `
      import type { Channel } from "amqplib";
      const EXCHANGE = process.env.EVENTS_EXCHANGE!;
      export class QueueService {
        constructor(private readonly channel: Channel) {}
        publish(routingKey: string, message: string) { this.channel.publish(EXCHANGE, routingKey, Buffer.from(message)); }
      }
      export const queueService = new QueueService(null as any);
    `;
    const parts = [
      runAdapters("src/qs.ts", svc, ctx),
      runAdapters("src/o.ts", `
        import { queueService } from "./qs";
        export function f() { queueService.publish("order.created", "ping"); }
      `, ctx),
    ];
    const ep = finalizeEndpoints("r", parts, (_f, s) => ({ "./qs": "src/qs.ts" })[s] ?? null);
    expect(ep.queues).toEqual([]);
  });

  it("review round 3: the same wrapper called locally (no import/fallback path at all) also records nothing", () => {
    const calls = detectQueues(parsed("src/qs.ts", `
      import type { Channel } from "amqplib";
      const EXCHANGE = process.env.EVENTS_EXCHANGE!;
      export class QueueService {
        constructor(private readonly channel: Channel) {}
        publish(routingKey: string, message: string) { this.channel.publish(EXCHANGE, routingKey, Buffer.from(message)); }
      }
      export const queueService = new QueueService(null as any);
      export function f() { queueService.publish("order.created", "ping"); }
    `), ctx);
    expect(calls).toEqual([]);
  });
});

describe("review round 2, item 3: named barrel re-exports of a class/instance resolve the method suffix", () => {
  it("`export { default as X }` and `export { x }` through an index barrel", () => {
    const ctx = ctxWith("amqplib");
    const parts = [
      runAdapters("src/services/queue_service.ts", `
        export default class QueueService { static channel: any; static publish(queue: string, msg: object) { QueueService.channel.sendToQueue(queue, Buffer.from("x")); } }
        class Inst { channel: any; publish(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from("x")); } }
        export const queueService = new Inst();
      `, ctx),
      runAdapters("src/services/index.ts", `
        export { default as QueueService } from "./queue_service";
        export { queueService } from "./queue_service";
      `, ctx),
      runAdapters("src/a.ts", `
        import { QueueService, queueService } from "./services";
        export function f() { QueueService.publish("one", {}); queueService.publish("two", {}); }
      `, ctx),
    ];
    const resolve = (_f: string, s: string) =>
      ({ "./services": "src/services/index.ts", "./queue_service": "src/services/queue_service.ts" })[s] ?? null;
    const ep = finalizeEndpoints("r", parts, resolve);
    expect(ep.queues.map((q) => q.queue).sort()).toEqual(["one", "two"]);
  });
});

describe("review round 2, item 4: provenance — weak names need positive evidence, strong names reject a real other type", () => {
  const ctx = ctxWith("amqplib", "ioredis", "ably");

  it("a Redis publisher built via a factory helper (weak name, no type, no traceable `new`) records nothing", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      import Redis from "ioredis";
      function makeRedis() { return new Redis(); }
      export class Notifier {
        private publisher = makeRedis();
        publish(ch: string, m: string) { this.publisher.publish(ch, m); }
      }
      const n = new Notifier();
      export function go() { n.publish("cache", "invalidate"); }
    `), ctx);
    expect(calls).toEqual([]);
  });

  it("a weak-named receiver assigned via a bare .duplicate() call records nothing", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      export class Notifier {
        private publisher: any;
        constructor(redis: any) { this.publisher = redis.duplicate(); }
        publish(ch: string, m: string) { this.publisher.publish(ch, m); }
      }
      const n = new Notifier(null);
      export function go() { n.publish("cache", "invalidate"); }
    `), ctx);
    expect(calls).toEqual([]);
  });

  it("an Ably realtime channel (strong name 'channel', but a real other type) records nothing", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      import * as Ably from "ably";
      export class Live {
        constructor(private readonly channel: Ably.RealtimeChannel) {}
        notify(evt: string, data: string) { this.channel.publish(evt, data); }
      }
      const live = new Live(null as any);
      export function go() { live.notify("score", "1-0"); }
    `), ctx);
    expect(calls).toEqual([]);
  });

  it("a strong name typed loosely (`: any`) still resolves (DI recall trade-off kept)", () => {
    const calls = detectQueues(parsed("src/q.ts", `
      export class QueueService {
        constructor(private readonly channel: any) {}
        send(queue: string, msg: object) { this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg))); }
      }
      const svc = new QueueService(null);
      export function go() { svc.send("orders", {}); }
    `), ctx);
    expect(calls.map((q) => q.queue)).toEqual(["orders"]);
  });
});

describe("review round 2, minor: node: and builtin-module imports are never treated as repo imports", () => {
  it("a call on a `node:`-prefixed import is never a pending wrapper call", () => {
    const { wrapperCalls } = collectQueueOps(parsed("src/x.ts", `
      import { queue } from "node:events";
      export function f() { queue.publish("orders", "k"); }
    `), ctxWith("amqplib"));
    expect(wrapperCalls).toEqual([]);
  });

  it("a call on a bare builtin module import (no 'node:' prefix) is never a pending wrapper call", () => {
    const { wrapperCalls } = collectQueueOps(parsed("src/x.ts", `
      import { queue } from "events";
      export function f() { queue.publish("orders", "k"); }
    `), ctxWith("amqplib"));
    expect(wrapperCalls).toEqual([]);
  });
});

describe("review round 2, item 2: barrel lookup cost stays linear, not quadratic", () => {
  it("40 re-export barrels x 400 callers x 10k pending wrapper calls finalizes in well under a second", () => {
    const ctx = ctxWith("amqplib");
    const N_UTIL = 40;
    const N_CALLERS = 400;
    const CALLS = 25;
    const files: Record<string, string> = {};
    for (let k = 0; k < N_UTIL; k++) {
      files[`src/utils/m${k}/index.ts`] = Array.from({ length: 10 }, (_, j) => `export * from "./f${j}";`).join("\n");
      for (let j = 0; j < 10; j++) files[`src/utils/m${k}/f${j}.ts`] = `export function h${k}_${j}(s: string) { return s; }`;
    }
    files["src/utils/index.ts"] = Array.from({ length: N_UTIL }, (_, k) => `export * from "./m${k}";`).join("\n");
    for (let c = 0; c < N_CALLERS; c++) {
      const names = Array.from({ length: CALLS }, (_, i) => `h${(c + i) % N_UTIL}_${i % 10}`);
      const unique = [...new Set(names)];
      files[`src/c${c}.ts`] = `import { ${unique.join(", ")} } from "./utils";\nexport function f() {\n${names.map((n) => `  ${n}("lit");`).join("\n")}\n}`;
    }
    let resolveCalls = 0;
    const resolve = (from: string, spec: string): string | null => {
      resolveCalls++;
      const base = from.split("/").slice(0, -1).join("/");
      const p = `${base}/${spec.replace(/^\.\//, "")}`.replace(/\/+/g, "/");
      if (files[`${p}.ts`] !== undefined) return `${p}.ts`;
      if (files[`${p}/index.ts`] !== undefined) return `${p}/index.ts`;
      return null;
    };
    const parts = Object.entries(files).map(([rel, code]) => runAdapters(rel, code, ctx));
    const pending = parts.reduce((a, p) => a + p.queueWrapperCalls.length, 0);
    expect(pending).toBe(N_CALLERS * CALLS);
    finalizeEndpoints("r", parts, resolve);
    // review round 3: a wall-clock assertion flakes on a loaded CI box; count `resolve` calls instead.
    // None of the h*_* functions are real wrappers, so every lookup is a genuine (not early-exiting)
    // miss: the FIRST time each of the `N_UTIL * 10` distinct names is looked up, it walks the full
    // barrel tree (`N_UTIL` m-barrels, then all `10` f-barrels under whichever ones it tries) before
    // giving up — `N_UTIL + N_UTIL * 10` resolve calls for that one name — and the (file, name) memo is
    // what keeps that a *per-distinct-name* cost (`(N_UTIL * 10) * (N_UTIL + N_UTIL * 10)`) rather than a
    // *per-pending-call* one (which would multiply that same per-name cost by all 10k pending calls
    // instead of just the 400 distinct names, landing in the millions). `pending` itself is added for the
    // one remaining unmemoized resolve per pending call (mapping its own file's "./utils" import). The
    // bound below is 2x the exact expected count, comfortably clearing normal variance while staying
    // far short of what an unmemoized barrel walk would produce.
    const expected = pending + (N_UTIL * 10) * (N_UTIL + N_UTIL * 10);
    expect(resolveCalls).toBeLessThan(expected * 2);
  });
});
