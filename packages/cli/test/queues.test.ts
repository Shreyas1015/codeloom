import { describe, expect, it } from "vitest";
import { collectQueueOps, detectQueues } from "../src/adapters/queues.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

const ops = (code: string, ...deps: string[]) =>
  detectQueues(parsed("src/events.ts", code), ctxWith(...deps)).map((q) => `${q.op} ${q.queue} @${q.at.symbol}`);

describe("detectQueues", () => {
  it("reads amqplib publish and consume", () => {
    expect(ops(`
      export async function publishInvoiceCreated(channel: any) { channel.sendToQueue("invoice.created", Buffer.from("")); }
      export async function announce(ch: any) { ch.publish("billing", "invoice.paid", Buffer.from("")); ch.publish("", "direct.q", Buffer.from("")); }
      export async function startConsumer(channel: any) { await channel.consume("invoice.created", () => {}); }
    `, "amqplib")).toEqual([
      "publish invoice.created @publishInvoiceCreated",
      "publish billing:invoice.paid @announce",
      "publish direct.q @announce",
      "consume invoice.created @startConsumer",
    ]);
  });

  it("needs a RabbitMQ dependency", () => {
    expect(ops(`channel.sendToQueue("x", b);`, "express")).toEqual([]);
  });

  it("records a fanout publish with an empty routing key as the exchange name", () => {
    expect(ops(`
      export function fan(channel: any) { channel.publish("logs", "", Buffer.from("")); }
    `, "amqplib")).toEqual(["publish logs @fan"]);
  });

  it("records exchange and routing key on an exchange publish, and none on sendToQueue", () => {
    const calls = detectQueues(parsed("src/events.ts", `
      export function publishInvoiceCreated(channel: any) { channel.sendToQueue("invoice.created", Buffer.from("")); }
      export function announce(ch: any) { ch.publish("billing", "invoice.paid", Buffer.from("")); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/events.ts", line: 2, symbol: "publishInvoiceCreated" } },
      {
        queue: "billing:invoice.paid", op: "publish", exchange: "billing", routingKey: "invoice.paid",
        at: { file: "src/events.ts", line: 3, symbol: "announce" },
      },
    ]);
  });

  it("records a topic bind and a consume with its handler argument index", () => {
    const calls = detectQueues(parsed("src/notify-consumer.ts", `
      export function startNotifier(channel: any) {
        channel.assertExchange("billing", "topic");
        channel.bindQueue("emails", "billing", "invoice.*");
        channel.consume("emails", () => {});
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      {
        queue: "emails", op: "bind", exchange: "billing", routingKey: "invoice.*",
        at: { file: "src/notify-consumer.ts", line: 4, symbol: "startNotifier" },
      },
      {
        queue: "emails", op: "consume", handlerArg: 1,
        at: { file: "src/notify-consumer.ts", line: 5, symbol: "startNotifier" },
      },
    ]);
  });

  it("v0.6 Task B review round 1, item 8: a direct assertExchange records the exchange's type", () => {
    const { exchanges } = collectQueueOps(parsed("src/notify-consumer.ts", `
      export function startNotifier(channel: any) {
        channel.assertExchange("billing", "topic");
      }
    `), ctxWith("amqplib"));
    expect(exchanges).toEqual([
      { name: "billing", type: "topic", at: { file: "src/notify-consumer.ts", line: 3, symbol: "startNotifier" } },
    ]);
  });

  it("skips a bind whose routing key is not a string literal", () => {
    const calls = detectQueues(parsed("src/x.ts", `
      export function bad(channel: any, key: string) { channel.bindQueue("emails", "billing", key); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([]);
  });
});

describe("detectQueues: wrapper functions and classes (v0.6 Task B)", () => {
  it("follows a class method wrapper, resolving the queue name from an object-literal const", () => {
    const calls = detectQueues(parsed("src/invoice-service.ts", `
      import amqp from "amqplib";
      export const Queues = { INVOICE_CREATED: "invoice.created" } as const;
      class QueueService {
        channel: any;
        async publish(queue: string, msg: object) {
          this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg)));
        }
      }
      const queueService = new QueueService();
      export async function createInvoice(payload: object) {
        await queueService.publish(Queues.INVOICE_CREATED, payload);
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/invoice-service.ts", line: 12, symbol: "createInvoice" } },
    ]);
  });

  it("follows a class method wrapper called on the class name itself, resolving the queue from an enum", () => {
    const calls = detectQueues(parsed("src/invoice-service.ts", `
      import amqp from "amqplib";
      enum Queues { INVOICE_CREATED = "invoice.created" }
      class QueueService {
        static channel: any;
        static async publish(queue: string, msg: object) {
          QueueService.channel.sendToQueue(queue, Buffer.from(JSON.stringify(msg)));
        }
      }
      export async function createInvoice(payload: object) {
        await QueueService.publish(Queues.INVOICE_CREATED, payload);
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/invoice-service.ts", line: 11, symbol: "createInvoice" } },
    ]);
  });

  it("follows a bare function wrapper: a baked-in exchange plus the caller's own routing key", () => {
    const calls = detectQueues(parsed("src/events.ts", `
      import { Channel } from "amqplib";
      declare const channel: Channel;
      export function publishEvent(name: string, body: object) {
        return channel.publish("events", name, Buffer.from(JSON.stringify(body)));
      }
      export async function createOrder(body: object) {
        publishEvent("order.created", body);
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      {
        queue: "events:order.created", op: "publish", exchange: "events", routingKey: "order.created",
        at: { file: "src/events.ts", line: 8, symbol: "createOrder" },
      },
    ]);
  });

  it("follows a class method consume wrapper, resolving the queue from a static readonly member", () => {
    const calls = detectQueues(parsed("src/invoice-service.ts", `
      import amqp from "amqplib";
      class Queues { static readonly INVOICE_CREATED = "invoice.created"; }
      class QueueService {
        channel: any;
        async consume(queue: string, handler: (msg: unknown) => void) {
          return this.channel.consume(queue, handler);
        }
      }
      const queueService = new QueueService();
      export async function handleInvoiceCreated() {}
      export async function startConsumer() {
        await queueService.consume(Queues.INVOICE_CREATED, handleInvoiceCreated);
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      {
        queue: "invoice.created", op: "consume", handlerArg: 1,
        at: { file: "src/invoice-service.ts", line: 13, symbol: "startConsumer" },
      },
    ]);
  });

  it("never guesses: a wrapper call whose argument is a runtime variable (not a literal/const/enum) is skipped", () => {
    const calls = detectQueues(parsed("src/x.ts", `
      import amqp from "amqplib";
      export function publishEvent(name: string, body: object) {
        return channel.publish("events", name, Buffer.from(JSON.stringify(body)));
      }
      export function createOrder(dynamicName: string, body: object) {
        publishEvent(dynamicName, body);
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([]);
  });

  it("still detects a direct amqplib call whose literal is an enum/const member (not just wrapper calls)", () => {
    const calls = detectQueues(parsed("src/events.ts", `
      import amqp from "amqplib";
      export const Queues = { INVOICE_CREATED: "invoice.created" } as const;
      export function publishInvoiceCreated(channel: any, payload: object) {
        channel.sendToQueue(Queues.INVOICE_CREATED, Buffer.from(JSON.stringify(payload)));
      }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([
      { queue: "invoice.created", op: "publish", at: { file: "src/events.ts", line: 5, symbol: "publishInvoiceCreated" } },
    ]);
  });
});
