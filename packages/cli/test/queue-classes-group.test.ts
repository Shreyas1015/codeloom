import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { mapGaps } from "../src/map/gaps.js";
import { saveMapAnswers } from "../src/map/save.js";
import { type Chain, ChainsFileSchema } from "../src/store/schemas.js";
import { commitAll } from "./helpers.js";

// v0.6 queues fix, end to end: demo-api publishes through a base publisher class, demo-billing consumes through
// a consumer base class, each repo indexed on its own into one group. A publish whose routing key is a runtime
// value becomes a `queue-unknown` gap, and the answer connects it.

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `codeloom-${prefix}-`));

function shopRepo(name: "api" | "billing", extra: Record<string, string>): string {
  const dest = join(tmp("p"), name);
  cpSync(fileURLToPath(new URL(`../../../fixtures/demo-shop/${name}`, import.meta.url)), dest, { recursive: true });
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    writeFileSync(join(dest, rel), content);
  }
  git(dest, "init", "-q", "-b", "main");
  commitAll(dest);
  git(dest, "remote", "add", "origin", `git@github.com:demo-shop/demo-${name}.git`);
  return dest;
}

const API: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "demo-api", private: true, type: "module",
    imports: { "#controllers/*": "./app/controllers/*.js", "#services/*": "./app/services/*.js", "#models/*": "./app/models/*.js" },
    dependencies: { "@adonisjs/core": "^6.0.0", "@adonisjs/lucid": "^21.0.0", amqplib: "^0.10.0" },
  }),
  "app/queue/names.ts": `export const RoutingKeys = { CUSTOMER_CREATED: "customer.created" } as const;\n`,
  "app/queue/base_publisher.ts": `import type { Channel } from "amqplib";

export abstract class BasePublisher<T> {
  static channel: Channel;
  exchange: string;
  routingKey: string;

  constructor(exchange: string, routingKey: string, protected payload: T) {
    this.exchange = exchange;
    this.routingKey = routingKey;
  }

  async publish() {
    BasePublisher.channel.publish(this.exchange, this.routingKey, Buffer.from(JSON.stringify(this.payload)));
  }
}
`,
  "app/queue/customer_publisher.ts": `import { BasePublisher } from "./base_publisher.js";

export class CustomerPublisher<T> extends BasePublisher<T> {
  constructor(routingKey: string, payload: T) {
    super("shop-events", routingKey, payload);
  }
}
`,
  "app/services/customer_service.ts": `import db from "@adonisjs/lucid/services/db";
import Customer from "#models/customer";
import { CustomerPublisher } from "../queue/customer_publisher.js";
import { RoutingKeys } from "../queue/names.js";

export default class CustomerService {
  async create(payload: { name: string; email: string; city: string }) {
    const customer = await Customer.create(payload);
    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });
    await new CustomerPublisher(RoutingKeys.CUSTOMER_CREATED, { id: customer.id }).publish();
    return customer;
  }

  async find(id: number) {
    await new CustomerPublisher(this.keyFor(id), { id }).publish();
    return Customer.findOrFail(id);
  }

  keyFor(id: number) {
    return id > 0 ? "customer.viewed" : "customer.created";
  }
}
`,
};

const BILLING: Record<string, string> = {
  "src/queue/base-consumer.ts": `import type { Channel } from "amqplib";

export abstract class BaseConsumer {
  protected exchange = "shop-events";
  protected abstract queue: string;
  protected abstract bindingKey: string;

  constructor(protected readonly channel: Channel) {}

  async start() {
    await this.channel.assertExchange(this.exchange, "topic");
    const q = await this.channel.assertQueue(this.queue);
    await this.channel.bindQueue(q.queue, this.exchange, this.bindingKey);
    await this.channel.consume(q.queue, async (msg) => {
      if (msg) await this.handle(JSON.parse(msg.content.toString()));
    });
  }

  protected abstract handle(payload: unknown): Promise<void>;
}
`,
  "src/queue/customer-consumer.ts": `import { PrismaClient } from "@prisma/client";
import { BaseConsumer } from "./base-consumer";

const prisma = new PrismaClient();

export class CustomerCreatedConsumer extends BaseConsumer {
  protected queue = "billing.customers";
  protected bindingKey = "customer.created";

  protected async handle(payload: unknown) {
    await prisma.invoice.create({ data: { customerId: 1 } });
  }
}
`,
};

const chainsOf = (root: string): Chain[] => ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8"))).chains;
const brief = (c: Chain) => c.stops.map((s) => `${s.repo}|${s.kind}|${s.label ?? s.symbol}`);

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.CODELOOM_HOME;
  process.env.CODELOOM_HOME = tmp("home");
});
afterEach(() => {
  process.env.CODELOOM_HOME = savedHome;
});

async function indexBoth(): Promise<{ api: string; root: string }> {
  const api = shopRepo("api", API);
  await runIndex(api);
  const { root } = await runIndex(shopRepo("billing", BILLING));
  return { api, root };
}

describe("queues through classes across repos (v0.6 queues fix)", () => {
  it("connects a subclass publish in one repo to a consumer subclass's handler and table in another", async () => {
    const { root } = await indexBoth();
    const chain = chainsOf(root).find((c) => c.entry.startsWith("route:demo-api:POST /api/customers"))!;
    const stops = brief(chain);
    const publish = stops.indexOf("demo-api|publish|shop-events:customer.created");
    expect(publish).toBeGreaterThan(0);
    expect(stops.slice(publish)).toEqual(expect.arrayContaining([
      "demo-billing|consume|billing.customers", "demo-billing|handler|CustomerCreatedConsumer.handle", "demo-billing|db|invoices",
    ]));
    const report = await buildReport(root);
    // demo-billing's own fixture publishes 2 and consumes 2; the consumer subclass adds one consume.
    expect(report.queues).toEqual([{ repo: "demo-api", publish: 1, consume: 0 }, { repo: "demo-billing", publish: 2, consume: 3 }]);
  }, 120_000);

  it("asks about a publish whose routing key is a runtime value, and the answer connects it", async () => {
    const { api, root } = await indexBoth();
    const gap = mapGaps(api).gaps.find((g) => g.kind === "queue-unknown")!;
    expect(gap.question).toMatch(/^demo-api publishes with a routing key codeloom cannot read/);
    expect(gap.evidence[0]).toMatch(/^demo-api app\/services\/customer_service\.ts:15 CustomerService\.find: publishes exchange shop-events/);
    expect(gap.close).toBe("queue-name|ignore-gap");
    const show = () => chainsOf(root).find((c) => c.entry.startsWith("route:demo-api:GET /api/customers/:id"))!;
    expect(brief(show()).some((s) => s.includes("|consume|"))).toBe(false);

    expect(() => saveMapAnswers(api, { answers: [{ kind: "queue-name", repo: "demo-api", at: "app/services/customer_service.ts:15" }] }))
      .toThrow(/needs its routingKey/);
    expect(() => saveMapAnswers(api, { answers: [{ kind: "queue-name", repo: "demo-api", at: "app/services/customer_service.ts:99", routingKey: "x" }] }))
      .toThrow(/no publish or consume with an unread name at app\/services\/customer_service\.ts:99/);
    const saved = saveMapAnswers(api, { answers: [{ kind: "queue-name", repo: "demo-api", at: "app/services/customer_service.ts:15", routingKey: "customer.created" }] });
    expect(saved.closed.map((g) => g.kind)).toContain("queue-unknown");
    expect(brief(show())).toEqual(expect.arrayContaining([
      "demo-api|publish|shop-events:customer.created", "demo-billing|consume|billing.customers", "demo-billing|db|invoices",
    ]));
    expect(mapGaps(api).gaps.some((g) => g.kind === "queue-unknown")).toBe(false);
  }, 120_000);
});
