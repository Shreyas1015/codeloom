import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { hopsFromChains, hopKey } from "../src/evals/score.js";
import { ChainsFileSchema, type Chain } from "../src/store/schemas.js";
import { makeRepo } from "./helpers.js";

// Final review batch 2, item A: publish hits continue into the paired consumer's stops (one level).

const PRISMA = `
model OrderLog {
  id Int @id
  @@map("order_logs")
}
model AuditLog {
  id Int @id
  @@map("audit_logs")
}
model Shipment {
  id Int @id
  @@map("shipments")
}
`;

function app(): string {
  return makeRepo({
    "package.json": JSON.stringify({ name: "q", dependencies: { express: "^4", amqplib: "^0.10", "@prisma/client": "^5" } }),
    "prisma/schema.prisma": PRISMA,
    "src/server.ts": `
import express from "express";
import { createOrder, ship, ping } from "./orders";
const app = express();
app.post("/orders", createOrder);
app.post("/ship", ship);
app.post("/ping", ping);
app.listen(3000);
`,
    "src/orders.ts": `
import type { Request, Response } from "express";
import amqp from "amqplib";
export async function createOrder(req: Request, res: Response) {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.sendToQueue("orders", Buffer.from("x"));
  res.json({});
}
export async function ship(req: Request, res: Response) {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.publish("logistics", "shipments", Buffer.from("x"));
  res.json({});
}
export async function ping(req: Request, res: Response) {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.sendToQueue("nobody-listens", Buffer.from("x"));
  res.json({});
}
`,
    "src/consumers.ts": `
import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
export async function start() {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  await channel.consume("orders", handleOrder);
  await channel.consume("audit", handleAudit);
  await channel.consume("shipments", handleShipment);
}
async function handleOrder(msg: unknown) {
  await prisma.orderLog.create({ data: { id: 1 } });
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.sendToQueue("audit", Buffer.from("x"));
}
async function handleAudit(msg: unknown) {
  await prisma.auditLog.create({ data: { id: 1 } });
}
async function handleShipment(msg: unknown) {
  await prisma.shipment.create({ data: { id: 1 } });
}
`,
  });
}

async function chainsOf(root: string): Promise<Chain[]> {
  await runIndex(root);
  return ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8"))).chains;
}

const brief = (c: Chain) => c.stops.map((s) => `${s.kind}:${s.label ?? s.symbol}:${s.hop.confidence}`);

describe("queue pairing into chains", () => {
  it("an exact pair continues into the consumer handler and its stores, one level only", async () => {
    const chains = await chainsOf(app());
    const order = chains.find((c) => c.entry === "route:q:POST /orders")!;
    expect(brief(order)).toEqual([
      "route:POST /orders:exact",
      "handler:createOrder:exact",
      "publish:orders:exact",
      "consume:orders:exact",
      "handler:handleOrder:exact",
      "db:order_logs:exact",
      "publish:audit:exact",
      // not followed further: no consume:audit / audit_logs here
    ]);
    expect(order.confidence).toBe("exact");
    // the consumer chain still exists on its own, and it does continue into its own pair
    const consumer = chains.find((c) => c.entry === "consumer:q:orders#src/consumers.ts#handleOrder")!;
    expect(consumer.name).toBe("consume orders · handleOrder");
    expect(brief(consumer)).toEqual([
      "consume:orders:exact",
      "handler:handleOrder:exact",
      "db:order_logs:exact",
      "publish:audit:exact",
      "consume:audit:exact",
      "handler:handleAudit:exact",
      "db:audit_logs:exact",
    ]);
  });

  it("a heuristic (no binding) pair stays a guess, with the pair's reason", async () => {
    const chains = await chainsOf(app());
    const ship = chains.find((c) => c.entry === "route:q:POST /ship")!;
    expect(brief(ship)).toEqual([
      "route:POST /ship:exact",
      "handler:ship:exact",
      "publish:logistics:shipments:exact",
      "consume:shipments:guess",
      "handler:handleShipment:guess",
      "db:shipments:guess",
    ]);
    expect(ship.stops[3]!.hop.reason).toMatch(/no binding found/);
    expect(ship.confidence).toBe("guess");
  });

  it("a publish with no pair is unchanged: the queue stop ends the chain", async () => {
    const chains = await chainsOf(app());
    const ping = chains.find((c) => c.entry === "route:q:POST /ping")!;
    expect(brief(ping)).toEqual(["route:POST /ping:exact", "handler:ping:exact", "publish:nobody-listens:exact"]);
  });

  it("the scorer keys appended consumer stores to the consumer, never to the route", async () => {
    const chains = await chainsOf(app());
    const keys = hopsFromChains(chains).map((f) => hopKey(f.hop));
    expect(keys).toContain("handler-store|consumer:q:orders#src/consumers.ts#handleOrder||orders|consume");
    expect(keys).toContain("handler-store|consumer:q:orders#src/consumers.ts#handleOrder|order_logs||insert");
    expect(keys.filter((k) => k.startsWith("handler-store|q:POST /orders|"))).toEqual(["handler-store|q:POST /orders||orders|publish"]);
  });
});
