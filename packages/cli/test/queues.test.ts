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
});
