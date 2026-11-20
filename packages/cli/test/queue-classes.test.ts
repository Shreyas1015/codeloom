import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import type { EndpointsFile, QueueOp } from "../src/store/schemas.js";
import { ctxWith } from "./adapter-helpers.js";

// v0.6 queues fix: amqplib used only through class hierarchies (a base publisher / consumer holding the
// exchange, routing key and queue in fields, set by each subclass's `super(...)` or a field override), and
// through a shared singleton broker (`X.getInstance()`). Every file is indexed alone, then finalized
// together, exactly as `codeloom index` does.

/** Every file run through the adapters, then finalized with a resolver for relative and `#`-alias specifiers. */
function endpointsOf(files: Record<string, string>): EndpointsFile {
  const ctx = ctxWith("amqplib");
  const parts = Object.entries(files).map(([rel, code]) => runAdapters(rel, code, ctx));
  const exists = (rel: string) => Object.hasOwn(files, rel);
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith(".")) base = posix.join(posix.dirname(from), spec);
    else if (spec.startsWith("#queue/")) base = `src/queue/${spec.slice("#queue/".length)}`;
    else return null;
    base = base.replace(/\.js$/, "");
    for (const cand of [base, `${base}.ts`, `${base}/index.ts`]) if (exists(cand)) return cand;
    return null;
  };
  return finalizeEndpoints("demo-api", parts, resolve);
}

const brief = (q: QueueOp) =>
  `${q.op} ${q.queue} @${q.at.file}:${q.at.line} ${q.at.symbol}${q.handler ? ` -> ${q.handler.file}#${q.handler.symbol}` : ""}`;

const NAMES = `export const Exchanges = { BILLING: "billing", SHOP: "shop-events" } as const;
export const RoutingKeys = { INVOICE_CREATED: "invoice.created", ORDER_PLACED: "order.placed" } as const;
export const Queues = { INVOICES: "billing.invoices", EMAILS: "emails" } as const;
`;

const BASE_PUBLISHER = `import type { Channel } from "amqplib";

export abstract class BasePublisher<T> {
  static channel: Channel;
  exchange: string;
  routingKey: string;
  payload: T;

  constructor(exchange: string, routingKey: string, payload: T) {
    this.exchange = exchange;
    this.routingKey = routingKey;
    this.payload = payload;
  }

  async publish() {
    BasePublisher.channel.publish(this.exchange, this.routingKey, Buffer.from(JSON.stringify(this.payload)));
  }
}
`;

describe("a base publisher whose subclass passes the exchange through super(...)", () => {
  const files = {
    "src/queue/names.ts": NAMES,
    "src/queue/base-publisher.ts": BASE_PUBLISHER,
    "src/queue/invoice-publisher.ts": `import { BasePublisher } from "./base-publisher";
import { Exchanges } from "./names";

export class InvoicePublisher<T> extends BasePublisher<T> {
  constructor(routingKey: string, payload: T) {
    super(Exchanges.BILLING, routingKey, payload);
  }
}
`,
    "src/invoices.ts": `import { InvoicePublisher } from "./queue/invoice-publisher";
import { RoutingKeys } from "./queue/names";

export async function createInvoice(req: any, res: any) {
  await new InvoicePublisher(RoutingKeys.INVOICE_CREATED, { id: 1 }).publish();
  res.json({});
}

export async function retryInvoice(req: any) {
  await new InvoicePublisher(req.body.key, { id: 2 }).publish();
}
`,
  };

  it("records the publish where the subclass is created and published, with the exchange from super(...)", () => {
    const e = endpointsOf(files);
    expect(e.queues.filter((q) => q.op === "publish").map(brief)).toEqual([
      "publish billing:invoice.created @src/invoices.ts:5 createInvoice",
    ]);
    expect(e.queues.find((q) => q.op === "publish")).toMatchObject({ exchange: "billing", routingKey: "invoice.created" });
  });

  it("records a publish whose routing key it cannot read as unknown, never as a guess", () => {
    const e = endpointsOf(files);
    expect(e.queues.some((q) => q.at.symbol === "retryInvoice")).toBe(false);
    expect(e.queueUnknown).toEqual([{
      at: { file: "src/invoices.ts", line: 10, symbol: "retryInvoice" }, op: "publish", exchange: "billing", missing: ["routingKey"],
    }]);
  });
});

describe("class field initialisers, subclass overrides and static readonly members", () => {
  const files = {
    "src/queue/names.ts": NAMES,
    "src/queue/event-publisher.ts": `import type { Channel } from "amqplib";
import { Exchanges } from "./names";

export abstract class EventPublisher {
  protected exchange: string = Exchanges.SHOP;
  protected abstract routingKey: string;

  constructor(private readonly channel: Channel) {}

  send(message: object) {
    this.channel.publish(this.exchange, this.routingKey, Buffer.from(JSON.stringify(message)));
  }
}
`,
    "src/queue/order-publishers.ts": `import { EventPublisher } from "./event-publisher";
import { RoutingKeys } from "./names";

export class OrderPlacedPublisher extends EventPublisher {
  protected routingKey = RoutingKeys.ORDER_PLACED;
}

export class CustomerUpdatedPublisher extends EventPublisher {
  static readonly KEY = "customer.updated";
  protected exchange = "customers";
  protected routingKey = CustomerUpdatedPublisher.KEY;
}
`,
    "src/orders/order-service.ts": `import { OrderPlacedPublisher } from "../queue/order-publishers";

export class OrderService {
  constructor(private readonly orderPlaced: OrderPlacedPublisher) {}

  async place(order: { id: number }) {
    this.orderPlaced.send(order);
    return order;
  }
}
`,
  };

  it("an injected subclass instance publishes from the method that calls it, with the overridden routing key", () => {
    const e = endpointsOf(files);
    expect(e.queues.map(brief)).toContain("publish shop-events:order.placed @src/orders/order-service.ts:7 OrderService.place");
  });

  it("a subclass nobody calls is still recorded, at the subclass, with its own exchange and static key", () => {
    const e = endpointsOf(files);
    expect(e.queues.map(brief)).toContain("publish customers:customer.updated @src/queue/order-publishers.ts:8 CustomerUpdatedPublisher");
    // The abstract base on its own publishes nothing: its routing key is never set there.
    expect(e.queues.filter((q) => q.op === "publish")).toHaveLength(2);
    expect(e.queueUnknown ?? []).toEqual([]);
  });
});

describe("a consumer base class whose consume loop hands each message to the subclass", () => {
  const BASE_CONSUMER = `import type { Channel } from "amqplib";

export abstract class BaseConsumer {
  protected exchange = "billing";
  protected abstract queue: string;
  protected abstract bindingKey: string;

  constructor(protected readonly channel: Channel) {}

  async start() {
    await this.channel.assertExchange(this.exchange, "topic");
    const q = await this.channel.assertQueue(this.queue, { durable: true });
    await this.channel.bindQueue(q.queue, this.exchange, this.bindingKey);
    await this.channel.consume(q.queue, async (msg) => {
      if (!msg) return;
      await this.handle(JSON.parse(msg.content.toString()));
      this.channel.ack(msg);
    });
  }

  protected abstract handle(payload: unknown): Promise<void>;
}
`;
  const files = {
    "src/queue/names.ts": NAMES,
    "src/queue/base-consumer.ts": BASE_CONSUMER,
    "src/queue/invoice-consumer.ts": `import { BaseConsumer } from "./base-consumer";
import { Queues, RoutingKeys } from "./names";

export class InvoiceCreatedConsumer extends BaseConsumer {
  protected queue = Queues.INVOICES;
  protected bindingKey = RoutingKeys.INVOICE_CREATED;

  protected async handle(payload: unknown) {
    console.log(payload);
  }
}
`,
  };

  it("records the consume, its binding and the exchange type, with the subclass's handle method as the handler", () => {
    const e = endpointsOf(files);
    expect(e.queues.map(brief)).toEqual([
      "bind billing.invoices @src/queue/base-consumer.ts:13 BaseConsumer.start",
      "consume billing.invoices @src/queue/base-consumer.ts:14 BaseConsumer.start -> src/queue/invoice-consumer.ts#InvoiceCreatedConsumer.handle",
    ]);
    expect(e.queues[0]).toMatchObject({ exchange: "billing", routingKey: "invoice.created" });
    expect(e.exchanges).toEqual([{ name: "billing", type: "topic", at: { file: "src/queue/base-consumer.ts", line: 11, symbol: "BaseConsumer.start" } }]);
  });

  it("takes the queue and exchange from the constructor arguments where the consumer is created", () => {
    const e = endpointsOf({
      "src/queue/names.ts": NAMES,
      "src/queue/consumer.ts": `import type { Channel, Replies } from "amqplib";

export abstract class Consumer {
  queueName: string;
  exchangeName: string;
  queueObj!: Replies.AssertQueue;

  constructor(queueName: string, exchangeName: string, public channel: Channel) {
    this.queueName = queueName;
    this.exchangeName = exchangeName;
  }

  async bind() {
    await this.channel.assertExchange(this.exchangeName, "direct");
    this.queueObj = await this.channel.assertQueue(this.queueName);
    await this.channel.bindQueue(this.queueObj.queue, this.exchangeName, this.queueName);
  }
}
`,
      "src/queue/email-consumer.ts": `import type { Channel } from "amqplib";
import { Consumer } from "./consumer";

export class EmailConsumer extends Consumer {
  constructor(queueName: string, exchangeName: string, channel: Channel) {
    super(queueName, exchangeName, channel);
  }

  async listen() {
    await this.bind();
    await this.channel.consume(this.queueObj.queue, async (message) => {
      if (message) this.channel.ack(message);
    });
  }
}
`,
      "src/queue/start.ts": `import amqp from "amqplib";
import { EmailConsumer } from "./email-consumer";

export async function startConsumers() {
  const channel = await (await amqp.connect("amqp://localhost")).createChannel();
  await new EmailConsumer("emails", "notifications", channel).listen();
}
`,
    });
    expect(e.queues.map(brief)).toEqual([
      "bind emails @src/queue/consumer.ts:16 Consumer.bind",
      "consume emails @src/queue/email-consumer.ts:11 EmailConsumer.listen",
    ]);
    expect(e.exchanges?.map((x) => `${x.name}:${x.type}`)).toEqual(["notifications:direct"]);
    expect(e.queueUnknown ?? []).toEqual([]);
  });
});

describe("a shared singleton broker (getInstance)", () => {
  const BUS = `import type { Channel } from "amqplib";

export class MessageBus {
  private static instance: MessageBus | null = null;
  private channel!: Channel;

  private constructor() {}

  static getInstance(): MessageBus {
    if (!MessageBus.instance) MessageBus.instance = new MessageBus();
    return MessageBus.instance;
  }

  async publish(exchange: string, routingKey: string, body: object) {
    this.channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)));
  }

  async send(message: { queue: string; body: object }) {
    const queue = message.queue;
    await this.sendRaw(queue, message.body);
  }

  private async sendRaw(queueName: string, body: object) {
    await new Promise<void>((resolve) => {
      this.channel.sendToQueue(queueName, Buffer.from(JSON.stringify(body)));
      resolve();
    });
  }
}

export const messageBus = MessageBus.getInstance();
`;
  const files = {
    "src/queue/names.ts": NAMES,
    "src/queue/message-bus.ts": BUS,
    "src/queue/messages.ts": `import { Queues } from "./names";

export abstract class Message {
  queue: string = Queues.EMAILS;
  onQueue(queue: string): this {
    this.queue = queue;
    return this;
  }
}

export class InvoiceMessage extends Message {
  constructor(public body: object) {
    super();
  }
}
`,
    "src/orders.ts": `import { MessageBus, messageBus } from "#queue/message-bus";
import { InvoiceMessage } from "#queue/messages";
import { Exchanges, RoutingKeys } from "#queue/names";

export async function placeOrder() {
  await MessageBus.getInstance().publish(Exchanges.SHOP, RoutingKeys.ORDER_PLACED, { id: 1 });
}

export async function billOrder() {
  const bus = MessageBus.getInstance();
  const message = new InvoiceMessage({ id: 1 }).onQueue("billing.invoices");
  await bus.send(message);
}

export async function emailOrder() {
  await messageBus.send(new InvoiceMessage({ id: 1 }));
}

export class Notifier {
  private bus = MessageBus.getInstance();

  async notify() {
    await this.bus.publish("notifications", "order.shipped", {});
  }
}
`,
  };

  it("resolves getInstance(), a stored instance, an exported instance and a field to the broker's own methods", () => {
    const e = endpointsOf(files);
    expect(e.queues.map(brief)).toEqual([
      "publish shop-events:order.placed @src/orders.ts:6 placeOrder",
      "publish billing.invoices @src/orders.ts:12 billOrder",
      "publish emails @src/orders.ts:16 emailOrder",
      "publish notifications:order.shipped @src/orders.ts:23 Notifier.notify",
    ]);
  });

  it("a subclass whose constructor calls a setter (this.onQueue(...)) publishes to that queue, not the base default", () => {
    const e = endpointsOf({
      ...files,
      "src/queue/receipt-message.ts": `import { Message } from "./messages";

export class ReceiptMessage extends Message {
  constructor() {
    super();
    this.onQueue("billing.receipts");
  }
}
`,
      "src/receipts.ts": `import { messageBus } from "#queue/message-bus";
import { ReceiptMessage } from "#queue/receipt-message";

export async function sendReceipt() {
  await messageBus.send(new ReceiptMessage());
}
`,
    });
    expect(e.queues.filter((q) => q.at.file === "src/receipts.ts").map(brief)).toEqual(["publish billing.receipts @src/receipts.ts:5 sendReceipt"]);
  });
});

describe("unresolved names", () => {
  it("a consume whose queue comes from a runtime value is recorded as unknown where the value is lost", () => {
    const e = endpointsOf({
      "src/queue/worker.ts": `import type { Channel } from "amqplib";

export class Worker {
  constructor(private readonly channel: Channel) {}

  async listen(queue: string) {
    await this.channel.consume(queue, async () => {});
  }
}

export async function start(worker: Worker, config: { queue: string }) {
  await worker.listen(config.queue);
}
`,
    });
    expect(e.queues).toEqual([]);
    // The consume callback is inline in Worker.listen: that is the handler an answer would start from.
    expect(e.queueUnknown).toEqual([{
      at: { file: "src/queue/worker.ts", line: 12, symbol: "start" }, op: "consume", missing: ["queue"],
      handler: { file: "src/queue/worker.ts", symbol: "Worker.listen" },
    }]);
  });
});
