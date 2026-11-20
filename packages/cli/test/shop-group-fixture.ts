import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIndex } from "../src/commands/index-cmd.js";
import { commitAll, freshHome } from "./helpers.js";

// 0.6 Task E test setup: demo-shop web + api + billing, each its own git repo with a github.com/demo-shop remote,
// indexed one by one into one group (a fresh CODELOOM_HOME). The api's customer handlers call billing three ways:
// - `${BILLING_API_URL}/billing/invoices` (a base codeloom's own hints settle: no question);
// - `axios.post("/ledger/entries")`, a relative URL in a backend (its base is set somewhere codeloom cannot see);
// - `billingRequest("/ledger/balances/:id")`, through the api's own fetch wrapper over `LEGACY_BILLING_URL`, a
//   name no repo goes by exactly (so a question, with demo-billing proposed by its word).

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

export function shopRepo(name: "web" | "api" | "billing", parent: string, extra: Record<string, string> = {}): string {
  const dest = join(parent, name);
  mkdirSync(parent, { recursive: true });
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

export const GROUP_API_EXTRA: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "demo-api", private: true, type: "module",
    imports: { "#controllers/*": "./app/controllers/*.js", "#services/*": "./app/services/*.js", "#models/*": "./app/models/*.js" },
    dependencies: { "@adonisjs/core": "^6.0.0", "@adonisjs/lucid": "^21.0.0", axios: "^1.7.0" },
  }),
  "app/services/billing_client.ts": `export async function billingRequest(path: string) {
  const res = await fetch(\`\${process.env.LEGACY_BILLING_URL}\${path}\`);
  return res.json();
}
`,
  "app/services/customer_service.ts": `import db from "@adonisjs/lucid/services/db";
import axios from "axios";
import Customer from "#models/customer";
import { billingRequest } from "#services/billing_client";

export default class CustomerService {
  async create(payload: { name: string; email: string; city: string }) {
    const customer = await Customer.create(payload);
    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });
    await fetch(\`\${process.env.BILLING_API_URL}/billing/invoices\`, { method: "POST", body: JSON.stringify({ customerId: customer.id }) });
    return customer;
  }

  async find(id: number) {
    await axios.post("/ledger/entries", { customerId: id });
    await billingRequest(\`/ledger/balances/\${id}\`);
    return Customer.findOrFail(id);
  }
}
`,
};

export const GROUP_BILLING_EXTRA: Record<string, string> = {
  "src/ledger.ts": `import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function addEntry(req: Request, res: Response) {
  res.json(await prisma.payment.create({ data: { id: 1 } }));
}

export async function getBalance(req: Request, res: Response) {
  res.json(await prisma.invoice.findMany({ where: { customerId: Number(req.params.id) } }));
}
`,
  "src/server.ts": `import express from "express";
import { createInvoice, payInvoice } from "./invoices";
import { addEntry, getBalance } from "./ledger";

const app = express();
const router = express.Router();

router.post("/invoices", createInvoice);
router.post("/invoices/:id/pay", payInvoice);
app.use("/billing", router);
app.post("/ledger/entries", addEntry);
app.get("/ledger/balances/:id", getBalance);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(4000);
`,
};

/** web + api + billing as separate git repos in one group (a fresh CODELOOM_HOME), indexed one by one. */
export async function shopGroup(): Promise<{ home: string; web: string; api: string; billing: string; root: string }> {
  const home = freshHome();
  const parent = mkdtempSync(join(tmpdir(), "codeloom-shop-group-"));
  const web = shopRepo("web", parent);
  const api = shopRepo("api", parent, GROUP_API_EXTRA);
  const billing = shopRepo("billing", parent, GROUP_BILLING_EXTRA);
  let root = "";
  for (const p of [web, api, billing]) root = (await runIndex(p)).root;
  return { home, web, api, billing, root };
}

