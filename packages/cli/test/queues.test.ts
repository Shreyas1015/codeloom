import { describe, expect, it } from "vitest";
import { detectQueues } from "../src/adapters/queues.js";
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

  it("records a topic bind, and ignores assertExchange", () => {
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
      { queue: "emails", op: "consume", at: { file: "src/notify-consumer.ts", line: 5, symbol: "startNotifier" } },
    ]);
  });

  it("skips a bind whose routing key is not a string literal", () => {
    const calls = detectQueues(parsed("src/x.ts", `
      export function bad(channel: any, key: string) { channel.bindQueue("emails", "billing", key); }
    `), ctxWith("amqplib"));
    expect(calls).toEqual([]);
  });
});
