import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "../src/commands/index-cmd.js";
import { freshHome, makeRepo } from "./helpers.js";

// The map-interview test setup (0.6 spec §5): six demo-shop repos, each its own git repo, indexed one by one
// into one group (a temp CODELOOM_HOME, never the real one):
// - demo-web calls `${process.env.LEGACY_BILLING_URL}/invoices/:id`, which demo-api and demo-billing both serve;
// - demo-web's reports page calls a URL codeloom cannot read, and nothing calls demo-api's GET /reports;
// - demo-api publishes shop/order.placed and demo-worker consumes orders-queue (bound outside the code);
// - demo-web's search page goes through its own /api/search/* proxy route, and demo-search is not connected;
// - demo-tools has no pages, routes or queues.

const prisma = (models: Record<string, string>) =>
  Object.entries(models).map(([m, table]) => `model ${m} {\n  id Int @id\n  @@map("${table}")\n}\n`).join("\n");

const express = (name: string, extra: Record<string, string>, deps: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({ name, dependencies: { express: "^4", "@prisma/client": "^5", ...deps } }),
  ...extra,
});

export const REPOS: Record<string, Record<string, string>> = {
  web: {
    "package.json": JSON.stringify({ name: "demo-web", dependencies: { next: "^15", react: "^19" } }),
    "app/invoices/[id]/page.tsx": `import { getInvoice } from "../../../lib/invoices";

export default async function InvoicePage({ params }: { params: { id: string } }) {
  const invoice = await getInvoice(params.id);
  return <h1>{invoice.total}</h1>;
}
`,
    "lib/invoices.ts": `export async function getInvoice(id: string) {
  const res = await fetch(\`\${process.env.LEGACY_BILLING_URL}/invoices/\${id}\`);
  return res.json();
}
`,
    "app/reports/page.tsx": `import { loadReport } from "../../lib/reports";

export default async function ReportsPage() {
  const report = await loadReport();
  return <pre>{JSON.stringify(report)}</pre>;
}
`,
    "lib/reports.ts": `function reportUrl(): string {
  return [process.env.REPORTS_BASE, "reports"].join("/");
}

export async function loadReport() {
  const res = await fetch(reportUrl());
  return res.json();
}
`,
    "app/search/page.tsx": `import { searchProducts } from "../../lib/search";

export default async function SearchPage() {
  const products = await searchProducts();
  return <ul>{products.length}</ul>;
}
`,
    "lib/search.ts": `export async function searchProducts() {
  const res = await fetch("/api/search/products");
  return res.json();
}
`,
    "app/api/search/[...path]/route.ts": `export async function GET() {
  return Response.json({ ok: true });
}
`,
    "app/checkout/page.tsx": `import { placeOrder } from "../../lib/orders";

export default function CheckoutPage() {
  return <button onClick={() => void placeOrder()}>Buy</button>;
}
`,
    "lib/orders.ts": `export async function placeOrder() {
  const res = await fetch("/orders", { method: "POST" });
  return res.json();
}
`,
  },
  api: express("demo-api", {
    "prisma/schema.prisma": prisma({ LegacyInvoice: "legacy_invoices", Report: "reports", Order: "orders" }),
    "src/server.ts": `import express from "express";
import { getInvoice, getReport, placeOrder } from "./handlers";

const app = express();
app.get("/invoices/:id", getInvoice);
app.get("/reports", getReport);
app.post("/orders", placeOrder);
app.listen(3000);
`,
    "src/handlers.ts": `import type { Request, Response } from "express";
import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function getInvoice(req: Request, res: Response) {
  res.json(await prisma.legacyInvoice.findUnique({ where: { id: Number(req.params.id) } }));
}

export async function getReport(req: Request, res: Response) {
  res.json(await prisma.report.findMany());
}

export async function placeOrder(req: Request, res: Response) {
  const order = await prisma.order.create({ data: { id: 1 } });
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.publish("shop", "order.placed", Buffer.from(JSON.stringify(order)));
  res.json(order);
}
`,
  }, { amqplib: "^0.10" }),
  billing: express("demo-billing", {
    "prisma/schema.prisma": prisma({ Invoice: "invoices" }),
    "src/server.ts": `import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();

export async function showInvoice(req: express.Request, res: express.Response) {
  res.json(await prisma.invoice.findUnique({ where: { id: Number(req.params.id) } }));
}

app.get("/invoices/:id", showInvoice);
app.listen(4000);
`,
  }),
  search: express("demo-search", {
    "prisma/schema.prisma": prisma({ Product: "products" }),
    "src/server.ts": `import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();

export async function listProducts(req: express.Request, res: express.Response) {
  res.json(await prisma.product.findMany());
}

app.get("/products", listProducts);
app.listen(4100);
`,
  }),
  worker: {
    "package.json": JSON.stringify({ name: "demo-worker", dependencies: { amqplib: "^0.10", "@prisma/client": "^5" } }),
    "prisma/schema.prisma": prisma({ OrderEvent: "order_events" }),
    "src/worker.ts": `import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function start() {
  const channel = await (await amqp.connect(process.env.AMQP_URL ?? "amqp://x")).createChannel();
  await channel.consume("orders-queue", handleOrder);
}

async function handleOrder(msg: unknown) {
  await prisma.orderEvent.create({ data: { id: 1 } });
}
`,
  },
  tools: {
    "package.json": JSON.stringify({ name: "demo-tools" }),
    "src/slug.ts": `export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
`,
  },
};

/** The six repos as separate git repos in one parent folder, each with a demo-shop remote, indexed one by one. */
export async function interviewGroup(): Promise<{ home: string; parent: string; repo: Record<string, string>; root: string }> {
  const home = freshHome();
  const parent = mkdtempSync(join(tmpdir(), "codeloom-interview-"));
  const repo: Record<string, string> = {};
  let root = "";
  for (const [name, files] of Object.entries(REPOS)) {
    repo[name] = makeRepo(files, join(parent, name));
    execFileSync("git", ["remote", "add", "origin", `git@github.com:demo-shop/demo-${name}.git`], { cwd: repo[name], stdio: "pipe" });
  }
  for (const name of Object.keys(REPOS)) root = (await runIndex(repo[name]!)).root;
  return { home, parent, repo, root };
}

// ---- the bigger setup: 13 repos, 14 questions (fix round 1: the budget must hold on more than a toy) --------------

const thingsRoute = (name: string, table: string, extra = "") => express(`demo-${name}`, {
  "prisma/schema.prisma": prisma({ Thing: table }),
  "src/server.ts": `import express from "express";
import { PrismaClient } from "@prisma/client";
import amqp from "amqplib";

const prisma = new PrismaClient();
const app = express();

export async function showThing(req: express.Request, res: express.Response) {
  res.json(await prisma.thing.findUnique({ where: { id: Number(req.params.id) } }));
}
${extra}
app.get("/things/:id", showThing);
app.listen(3000);
`,
}, { amqplib: "^0.10" });

/** A UI repo with one page per env var base, each calling `${process.env.<ENV>}/things/:id`. The env names carry
 * a word no repo has (`ORDERS_LEGACY_URL`), so codeloom's own base hints (0.6 §2) never settle them: each is a
 * question, with the repo its other word names proposed. */
function ui(name: string, envs: string[], extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: `demo-${name}`, dependencies: { next: "^15", react: "^19" } }), ...extra };
  for (const env of envs) {
    const slug = env.split("_")[0]!.toLowerCase();
    const fn = `get${slug[0]!.toUpperCase()}${slug.slice(1)}Thing`;
    files[`app/${slug}/[id]/page.tsx`] = `import { ${fn} } from "../../../lib/${slug}";

export default async function Page({ params }: { params: { id: string } }) {
  const thing = await ${fn}(params.id);
  return <h1>{thing.name}</h1>;
}
`;
    files[`lib/${slug}.ts`] = `export async function ${fn}(id: string) {
  const res = await fetch(\`\${process.env.${env}}/things/\${id}\`);
  return res.json();
}
`;
  }
  return files;
}

export const BIG_REPOS: Record<string, Record<string, string>> = {
  orders: thingsRoute("orders", "orders", `
export async function placeOrder(req: express.Request, res: express.Response) {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.publish("shop", "order.created", Buffer.from("{}"));
  res.json({});
}
app.post("/orders", placeOrder);`),
  catalog: thingsRoute("catalog", "products_catalog", `
export async function getReport(req: express.Request, res: express.Response) {
  res.json(await prisma.thing.findMany());
}
app.get("/reports", getReport);`),
  payments: thingsRoute("payments", "payments", `
app.get("/health", (_req, res) => res.json({ ok: true }));`),
  shipping: thingsRoute("shipping", "shipments"),
  users: thingsRoute("users", "users", `
export async function createUser(req: express.Request, res: express.Response) {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  channel.sendToQueue("audit.events", Buffer.from("{}"));
  res.json({});
}
app.post("/users", createUser);`),
  reviews: thingsRoute("reviews", "reviews"),
  search: REPOS.search!,
  mailer: {
    "package.json": JSON.stringify({ name: "demo-mailer", dependencies: { amqplib: "^0.10", "@prisma/client": "^5" } }),
    "prisma/schema.prisma": prisma({ Mail: "mails" }),
    "src/worker.ts": `import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function start() {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  await channel.consume("mail-queue", sendMail);
}

async function sendMail(msg: unknown) {
  await prisma.mail.create({ data: { id: 1 } });
}
`,
  },
  auditor: {
    "package.json": JSON.stringify({ name: "demo-auditor", dependencies: { amqplib: "^0.10", "@prisma/client": "^5" } }),
    "prisma/schema.prisma": prisma({ AuditEntry: "audit_entries" }),
    "src/worker.ts": `import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function start() {
  const channel = await (await amqp.connect("amqp://x")).createChannel();
  await channel.consume("audit-log", record);
}

async function record(msg: unknown) {
  await prisma.auditEntry.create({ data: { id: 1 } });
}
`,
  },
  kit: { ...REPOS.tools!, "package.json": JSON.stringify({ name: "demo-kit" }) },
  shop: ui("shop", ["ORDERS_LEGACY_URL", "CATALOG_LEGACY_URL", "PAYMENTS_LEGACY_URL"], {
    "app/reports/page.tsx": REPOS.web!["app/reports/page.tsx"]!,
    "lib/reports.ts": REPOS.web!["lib/reports.ts"]!,
    "app/checkout/page.tsx": `import { checkout } from "../../lib/checkout";

export default function CheckoutPage() {
  return <button onClick={() => void checkout()}>Buy</button>;
}
`,
    "lib/checkout.ts": `export async function checkout() {
  const res = await fetch("/orders", { method: "POST" });
  return res.json();
}
`,
  }),
  admin: ui("admin", ["ORDERS_LEGACY_URL", "USERS_LEGACY_URL", "REVIEWS_LEGACY_URL"], {
    "app/search/page.tsx": REPOS.web!["app/search/page.tsx"]!,
    "lib/search.ts": REPOS.web!["lib/search.ts"]!,
    "app/api/search/[...path]/route.ts": REPOS.web!["app/api/search/[...path]/route.ts"]!,
    "app/team/page.tsx": `import { addUser } from "../../lib/team";

export default function TeamPage() {
  return <button onClick={() => void addUser()}>Add</button>;
}
`,
    "lib/team.ts": `export async function addUser() {
  const res = await fetch("/users", { method: "POST" });
  return res.json();
}
`,
  }),
  partner: ui("partner", ["SHIPPING_LEGACY_URL", "CATALOG_LEGACY_URL"]),
};

/** BIG_REPOS as separate git repos with demo-shop remotes, indexed one by one into one group. */
export async function bigInterviewGroup(): Promise<{ home: string; repo: Record<string, string>; root: string }> {
  const home = freshHome();
  const parent = mkdtempSync(join(tmpdir(), "codeloom-interview-big-"));
  const repo: Record<string, string> = {};
  let root = "";
  for (const [name, files] of Object.entries(BIG_REPOS)) {
    repo[name] = makeRepo(files, join(parent, name));
    execFileSync("git", ["remote", "add", "origin", `git@github.com:demo-shop/demo-${name}.git`], { cwd: repo[name], stdio: "pipe" });
  }
  for (const name of Object.keys(BIG_REPOS)) root = (await runIndex(repo[name]!)).root;
  return { home, repo, root };
}
