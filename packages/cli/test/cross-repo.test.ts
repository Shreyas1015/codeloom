import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport } from "../src/commands/check.js";
import { formatCheckText } from "../src/check/format.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { hopsFromChains } from "../src/evals/score.js";
import { type Chain, type ChainsFile, ChainsFileSchema } from "../src/store/schemas.js";
import { commitAll } from "./helpers.js";

// 0.6 Task C (spec §2–§3): demo-shop web + api + billing as three separately indexed repos. The api calls
// billing over HTTP (an env-var base naming billing) and over RabbitMQ (a queue, and a topic exchange).

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `codeloom-${prefix}-`));

type Shop = "web" | "api" | "billing";

/** One demo-shop repo as its own git repo at `<parent>/<folder>` with `extra` files written over it. */
function shopRepo(
  name: Shop, parent: string, extra: Record<string, string> = {}, opts: { folder?: string; remote?: string } = {},
): string {
  const dest = join(parent, opts.folder ?? name);
  mkdirSync(parent, { recursive: true });
  cpSync(fileURLToPath(new URL(`../../../fixtures/demo-shop/${name}`, import.meta.url)), dest, { recursive: true });
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    writeFileSync(join(dest, rel), content);
  }
  git(dest, "init", "-q", "-b", "main");
  commitAll(dest);
  git(dest, "remote", "add", "origin", opts.remote ?? `git@github.com:demo-shop/demo-${opts.folder ?? name}.git`);
  return dest;
}

const API_PACKAGE = JSON.stringify({
  name: "demo-api", private: true, type: "module",
  imports: { "#controllers/*": "./app/controllers/*.js", "#services/*": "./app/services/*.js", "#models/*": "./app/models/*.js" },
  dependencies: { "@adonisjs/core": "^6.0.0", "@adonisjs/lucid": "^21.0.0", amqplib: "^0.10.0" },
});

/** The api calls billing over HTTP (`BILLING_API_URL`), publishes to a queue and a topic exchange, and calls
 * a payments service no repo of the group serves (`PAYMENTS_URL`). */
const API_EXTRA: Record<string, string> = {
  "package.json": API_PACKAGE,
  "app/services/customer_service.ts": `import db from "@adonisjs/lucid/services/db";
import Customer from "#models/customer";
import { publishCustomerCreated, publishCustomerViewed } from "#services/customer_events";

export default class CustomerService {
  async create(payload: { name: string; email: string; city: string }) {
    const customer = await Customer.create(payload);
    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });
    await fetch(\`\${process.env.BILLING_API_URL}/billing/invoices\`, { method: "POST", body: JSON.stringify({ customerId: customer.id }) });
    await publishCustomerCreated(customer.id);
    return customer;
  }

  async find(id: number) {
    await publishCustomerViewed(id);
    await fetch(\`\${process.env.PAYMENTS_URL}/charges/\${id}\`);
    return Customer.findOrFail(id);
  }
}
`,
  "app/services/customer_events.ts": `import amqp from "amqplib";

export async function publishCustomerCreated(id: number) {
  const channel = await (await amqp.connect("amqp://localhost")).createChannel();
  channel.sendToQueue("customer.created", Buffer.from(String(id)));
}

export async function publishCustomerViewed(id: number) {
  const channel = await (await amqp.connect("amqp://localhost")).createChannel();
  channel.publish("shop-events", "customer.viewed", Buffer.from(String(id)));
}
`,
};

/** Billing consumes the api's queue, binds a queue to the api's topic exchange, and has a worker class whose
 * consume handler is passed as `this.handleCustomerDeleted`. */
const BILLING_EXTRA: Record<string, string> = {
  "src/customer-consumer.ts": `import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function startCustomerConsumer() {
  const channel = await (await amqp.connect("amqp://localhost")).createChannel();
  await channel.consume("customer.created", handleCustomerCreated);
  await channel.assertExchange("shop-events", "topic");
  await channel.bindQueue("billing-customers", "shop-events", "customer.*");
  await channel.consume("billing-customers", handleCustomerEvent);
}

async function handleCustomerCreated(msg: unknown) {
  await prisma.invoice.create({ data: { customerId: 1 } });
}

async function handleCustomerEvent(msg: unknown) {
  await prisma.emailLog.create({ data: { invoiceId: 1 } });
}
`,
  "src/customer-worker.ts": `import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class CustomerWorker {
  async start() {
    const channel = await (await amqp.connect("amqp://localhost")).createChannel();
    await channel.consume("customer.deleted", this.handleCustomerDeleted);
  }

  async handleCustomerDeleted(msg: unknown) {
    await prisma.emailLog.create({ data: { invoiceId: 2 } });
  }

  async cleanup() {
    await prisma.invoice.deleteMany({});
  }
}
`,
};

const readFile = (root: string): ChainsFile => ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")));
const brief = (c: Chain) => c.stops.map((s) => `${s.repo}|${s.kind}|${s.label ?? s.symbol}`);

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.CODELOOM_HOME;
  process.env.CODELOOM_HOME = tmp("home");
});
afterEach(() => {
  process.env.CODELOOM_HOME = savedHome;
});

/** web, api and billing in three parent folders, indexed one by one in `order`. Returns the group root. */
async function indexShop(order: Shop[], extra: Partial<Record<Shop, Record<string, string>>> = {}): Promise<string> {
  const make: Record<Shop, () => string> = {
    web: () => shopRepo("web", tmp("p"), extra.web ?? {}),
    api: () => shopRepo("api", tmp("p"), { ...API_EXTRA, ...(extra.api ?? {}) }),
    billing: () => shopRepo("billing", tmp("p"), { ...BILLING_EXTRA, ...(extra.billing ?? {}) }),
  };
  let root = "";
  for (const name of order) root = (await runIndex(make[name]())).root;
  return root;
}

describe("cross-repo journeys in a group (0.6 §2–§3)", () => {
  it("continues a UI → api → HTTP (BILLING_API_URL) → billing route → handler → table chain", async () => {
    const { chains } = readFile(await indexShop(["web", "api", "billing"]));
    const page = chains.find((c) => c.entry === "page:demo-web:/customers/new")!;
    const stops = brief(page);
    const call = page.stops.findIndex((s) => s.kind === "call" && s.repo === "demo-api");
    expect(call).toBeGreaterThan(0);
    expect(page.stops[call]).toMatchObject({ lane: "code", op: "POST", label: "/billing/invoices", file: "app/services/customer_service.ts" });
    const route = page.stops.findIndex((s, i) => i > call && s.kind === "route" && s.repo === "demo-billing");
    expect(page.stops[route]).toMatchObject({ label: "POST /billing/invoices", from: call, hop: { confidence: "exact" } });
    expect(stops.slice(route)).toEqual(expect.arrayContaining([
      "demo-billing|handler|createInvoice",
      "demo-billing|db|invoices",
      "demo-billing|publish|invoice.created",
    ]));
    // The UI call stays the chain's UI stop; the service call is backend code, not a second UI call.
    expect(page.stops.filter((s) => s.lane === "ui").map((s) => s.kind)).toEqual(["page", "function", "call"]);
    expect(page).toMatchObject({ complete: true, confidence: "exact" });
  });

  it("links an api publish to a billing consume by queue name and continues into its handler's table", async () => {
    const { chains } = readFile(await indexShop(["web", "api", "billing"]));
    const page = chains.find((c) => c.entry === "page:demo-web:/customers/new")!;
    const stops = brief(page);
    const publish = stops.indexOf("demo-api|publish|customer.created");
    expect(publish).toBeGreaterThan(0);
    expect(stops.slice(publish)).toEqual(expect.arrayContaining([
      "demo-billing|consume|customer.created", "demo-billing|handler|handleCustomerCreated", "demo-billing|db|invoices",
    ]));
  });

  it("links a topic exchange publish to a bound queue's consumer in another repo", async () => {
    const { chains } = readFile(await indexShop(["web", "api", "billing"]));
    const page = chains.find((c) => c.entry === "page:demo-web:/customers/:id")!;
    const stops = brief(page);
    const publish = stops.indexOf("demo-api|publish|shop-events:customer.viewed");
    expect(publish).toBeGreaterThan(0);
    const consume = page.stops.find((s) => s.kind === "consume" && s.label === "billing-customers")!;
    expect(consume).toMatchObject({ repo: "demo-billing", hop: { confidence: "param" } });
    expect(stops.slice(publish)).toEqual(expect.arrayContaining(["demo-billing|handler|handleCustomerEvent", "demo-billing|db|email_logs"]));
  });

  it("resolves a consume handler passed as this.handleX to exactly that method", async () => {
    const { chains } = readFile(await indexShop(["billing"]));
    const chain = chains.find((c) => c.entry.startsWith("consumer:demo-billing:customer.deleted#"))!;
    expect(chain.entry).toBe("consumer:demo-billing:customer.deleted#src/customer-worker.ts#CustomerWorker.handleCustomerDeleted");
    expect(brief(chain)).toEqual([
      "demo-billing|consume|customer.deleted",
      "demo-billing|handler|CustomerWorker.handleCustomerDeleted",
      "demo-billing|db|email_logs",
    ]);
    expect(chain.confidence).toBe("exact");
  });

  it("records a call whose env base names no repo as an unresolved base, and links nothing for it", async () => {
    const file = readFile(await indexShop(["web", "api", "billing"]));
    expect(file.unresolvedBases).toEqual([{
      base: "PAYMENTS_URL", kind: "env", reason: "unknown", candidates: [],
      calls: [{ repo: "demo-api", file: "app/services/customer_service.ts", line: 16, symbol: "CustomerService.find", method: "GET", path: "/charges/:id" }],
    }]);
    expect(file.chains.some((c) => c.stops.some((s) => s.kind === "call" && s.label?.startsWith("/charges")
      && c.stops.some((t) => t.kind === "route" && t.from === c.stops.indexOf(s))))).toBe(false);
  });

  it("gives the same chains and unresolved bases in any index order", async () => {
    const a = readFile(await indexShop(["web", "api", "billing"]));
    process.env.CODELOOM_HOME = tmp("home");
    const b = readFile(await indexShop(["billing", "web", "api"]));
    process.env.CODELOOM_HOME = tmp("home");
    const c = readFile(await indexShop(["api", "billing", "web"]));
    expect(b.chains).toEqual(a.chains);
    expect(c.chains).toEqual(a.chains);
    expect(b.unresolvedBases).toEqual(a.unresolvedBases);
    expect(c.unresolvedBases).toEqual(a.unresolvedBases);
  });

  it("check reports queue counts per repo", async () => {
    const root = await indexShop(["web", "api", "billing"]);
    const report = await buildReport(root);
    expect(report.queues).toEqual([
      { repo: "demo-api", publish: 2, consume: 0 },
      { repo: "demo-billing", publish: 2, consume: 5 },
    ]);
    expect(formatCheckText(report)).toMatch(/queues: demo-api 2 published; demo-billing 2 published, 5 consumed/);
  });

  it("treats a Next.js catch-all route that forwards to an env base as a proxy to that repo", async () => {
    const root = await indexShop(["web", "api", "billing"], {
      web: {
        "app/api/billing/[...path]/route.ts": `export async function POST(req: Request, { params }: { params: { path: string[] } }) {
  const res = await fetch(\`\${process.env.BILLING_API_URL}/billing/\${params.path.join("/")}\`, { method: "POST", body: await req.text() });
  return new Response(await res.text(), { status: res.status });
}
`,
        "app/invoices/[id]/pay/page.tsx": `"use client";
export default function PayInvoicePage({ params }: { params: { id: string } }) {
  return <button onClick={() => fetch(\`/api/billing/invoices/\${params.id}/pay\`, { method: "POST" })}>Pay</button>;
}
`,
      },
    });
    const { chains } = readFile(root);
    const proxied = chains.filter((c) => c.entry === "page:demo-web:/invoices/:id/pay"
      && c.stops.some((s) => s.kind === "route" && s.repo === "demo-billing"));
    expect(proxied).toHaveLength(1);
    // The call passes through the proxy route; that route gets no dead-end chain of its own.
    expect(chains.filter((c) => c.entry === "page:demo-web:/invoices/:id/pay")).toHaveLength(1);
    expect(brief(proxied[0]!).slice(0, 5)).toEqual([
      "demo-web|page|PayInvoicePage", "demo-web|call|/api/billing/invoices/:id/pay", "demo-web|route|POST /api/billing/:path*",
      "demo-billing|route|POST /billing/invoices/:id/pay", "demo-billing|handler|payInvoice",
    ]);
    expect(brief(proxied[0]!)).toEqual(expect.arrayContaining([
      "demo-billing|route|POST /billing/invoices/:id/pay", "demo-billing|handler|payInvoice", "demo-billing|db|invoices",
    ]));
    // The forwarding fetch itself is the proxy, never a service call guessed onto some billing route.
    const forward = chains.flatMap((c) => c.stops).filter((s) => s.kind === "call" && s.file === "app/api/billing/[...path]/route.ts");
    expect(forward).toEqual([]);
  });
});

describe("workspace-folder mode (codeloom.workspace.json)", () => {
  it("links service-to-service HTTP and queues across its repos the same way", async () => {
    const root = tmp("ws");
    shopRepo("web", root);
    shopRepo("api", root, API_EXTRA);
    shopRepo("billing", root, BILLING_EXTRA);
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", links: [],
      repos: [{ id: "demo-api", path: "api" }, { id: "demo-billing", path: "billing" }, { id: "demo-web", path: "web" }],
    }));
    await runIndex(root);
    const { chains, unresolvedBases } = readFile(root);
    const page = chains.find((c) => c.entry === "page:demo-web:/customers/new")!;
    expect(brief(page)).toEqual(expect.arrayContaining([
      "demo-api|call|/billing/invoices", "demo-billing|route|POST /billing/invoices", "demo-billing|db|invoices",
      "demo-billing|consume|customer.created", "demo-billing|handler|handleCustomerCreated",
    ]));
    expect(unresolvedBases?.map((b) => b.base)).toEqual(["PAYMENTS_URL"]);
  });
});

describe("what a backend call's base does not say (0.6 §3)", () => {
  it("never links a call with a base naming no repo to another repo's route by its path alone", async () => {
    const service = API_EXTRA["app/services/customer_service.ts"]!.replace("process.env.BILLING_API_URL", "process.env.API_URL");
    const root = await indexShop(["api", "billing"], { api: { "app/services/customer_service.ts": service } });
    const file = readFile(root);
    const create = file.chains.find((c) => c.entry === "route:demo-api:POST /api/customers")!;
    expect(create.stops.filter((s) => s.repo === "demo-billing" && s.kind === "route")).toEqual([]);
    expect(file.unresolvedBases?.map((b) => [b.base, b.reason, b.calls.map((c) => c.path)])).toEqual([
      ["API_URL", "unknown", ["/billing/invoices"]],
      ["PAYMENTS_URL", "unknown", ["/charges/:id"]],
    ]);
  });

  it("links a UI call to an internal-looking host naming one repo (it used to be a third party)", async () => {
    const billing = "import axios from \"axios\";\n\nexport const billingApi = axios.create({ baseURL: \"http://billing:4000\" });\n";
    const root = await indexShop(["web", "billing"], { web: { "lib/billing-api.ts": billing } });
    const { chains, external } = readFile(root);
    const page = chains.find((c) => c.entry === "page:demo-web:/invoices/new")!;
    expect(page.stops.find((s) => s.kind === "route")).toMatchObject({ repo: "demo-billing", label: "POST /billing/invoices" });
    expect(external ?? []).toEqual([]);
  });

  it("never links a public-looking host by its name: it stays a third party, and the question is recorded", async () => {
    const billing = "import axios from \"axios\";\n\nexport const billingApi = axios.create({ baseURL: \"https://billing.demo-shop.example\" });\n";
    const root = await indexShop(["web", "billing"], { web: { "lib/billing-api.ts": billing } });
    const { chains, external, unresolvedBases } = readFile(root);
    const page = chains.find((c) => c.entry === "page:demo-web:/invoices/new");
    expect(page?.stops.find((s) => s.kind === "route")).toBeUndefined();
    expect(external?.map((e) => e.base)).toEqual(["billing.demo-shop.example"]);
    expect(unresolvedBases?.filter((b) => b.kind === "host").map((b) => [b.kind, b.base, b.reason, b.candidates])).toEqual([
      ["host", "billing.demo-shop.example", "unconfirmed", ["demo-billing"]],
    ]);
  });
});

describe("routes other services call (0.6 §3)", () => {
  it("are not reported as having no caller, whether a route or a queue consumer calls them", async () => {
    const consumer = BILLING_EXTRA["src/customer-consumer.ts"]!.replace(
      "async function handleCustomerCreated(msg: unknown) {\n",
      "async function handleCustomerCreated(msg: unknown) {\n  await fetch(`${process.env.DEMO_API_URL}/api/customers/${String(msg)}`);\n",
    );
    const root = await indexShop(["api", "billing"], { billing: { "src/customer-consumer.ts": consumer } });
    const uncalled = (await buildReport(root)).items.filter((i) => i.kind === "route-no-caller").map((i) => `${i.repo} ${i.detail}`);
    expect(uncalled).toContain("demo-api POST /api/customers has no caller");
    expect(uncalled).not.toContain("demo-billing POST /billing/invoices has no caller");
    expect(uncalled).not.toContain("demo-api GET /api/customers/:id has no caller");
  });
});

describe("ambiguous bases (0.6 §2)", () => {
  it("links nothing when the env name matches two repos, and records both candidates", async () => {
    const paths = {
      api: shopRepo("api", tmp("p"), API_EXTRA),
      billing: shopRepo("billing", tmp("p"), BILLING_EXTRA),
      other: shopRepo("billing", tmp("p"), {
        "package.json": JSON.stringify({ name: "billing-service", private: true, dependencies: { express: "^4.21.0" } }),
      }, { folder: "billing-service", remote: "git@github.com:demo-shop/billing-service.git" }),
    };
    let root = "";
    for (const p of [paths.api, paths.billing, paths.other]) root = (await runIndex(p)).root;
    const file = readFile(root);
    const page = file.chains.filter((c) => c.stops.some((s) => s.kind === "call" && s.lane === "code" && s.label === "/billing/invoices"));
    expect(page.flatMap((c) => c.stops).filter((s) => s.kind === "route" && s.label === "POST /billing/invoices"
      && s.from !== undefined)).toEqual([]);
    expect(file.unresolvedBases).toEqual(expect.arrayContaining([expect.objectContaining({
      base: "BILLING_API_URL", kind: "env", reason: "ambiguous", candidates: ["billing-service", "demo-billing"],
      calls: [expect.objectContaining({ repo: "demo-api", file: "app/services/customer_service.ts", line: 9, method: "POST", path: "/billing/invoices" })],
    })]));
  });
});

describe("eval hops stay keyed to their own route (0.6 §3)", () => {
  it("keys a service call's stores to the called route, never to the calling route", async () => {
    const { chains } = readFile(await indexShop(["web", "api", "billing"]));
    const keys = hopsFromChains(chains).filter((h) => h.hop.type === "handler-store").map((h) => h.hop)
      .filter((h) => h.type === "handler-store" && h.route === "demo-api:POST /api/customers");
    expect(keys.map((h) => (h.type === "handler-store" ? h.table ?? h.queue : ""))).not.toContain("invoices");
  });
});
