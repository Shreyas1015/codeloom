import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport } from "../src/commands/check.js";
import { formatCheckText } from "../src/check/format.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { type Chain, type ChainsFile, ChainsFileSchema } from "../src/store/schemas.js";

// 0.6 Task C, fix round 1: the review's probe group (mk.sh) and size shape (gen.mjs), as tests.

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `codeloom-${prefix}-`));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

const PRISMA = `model Customer {
  id Int @id
  @@map("customers")
}
model Invoice {
  id Int @id
  @@map("invoices")
}
model Notification {
  id Int @id
  @@map("notifications")
}
`;

/** A repo at `<parent>/<folder>` with a package.json named `pkg`, `files`, and remote `demo-shop/<pkg>`. */
function repo(parent: string, folder: string, pkg: string, files: Record<string, string>, deps = true): string {
  const d = join(parent, folder);
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      name: pkg, private: true,
      dependencies: deps ? { express: "^4.21.0", "@prisma/client": "^5.0.0", amqplib: "^0.10.0", axios: "^1.0.0" } : {},
    }),
    ...(deps ? { "prisma/schema.prisma": PRISMA } : {}),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), content);
  }
  git(d, "init", "-q", "-b", "main");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  // The remote's repo name is the package name, so the repo's id stays the package name (0.6: a group repo is
  // named by its remote); the folder is still one of the names its call bases are matched by.
  git(d, "remote", "add", "origin", `git@github.com:demo-shop/${pkg.replace(/@/g, "").replace(/\//g, "-")}.git`);
  return d;
}

const CORE = `import express from "express";
import { PrismaClient } from "@prisma/client";
import amqp from "amqplib";
const prisma = new PrismaClient();
const app = express();
app.get("/customers/:id", async (req, res) => { res.json(await prisma.customer.findUnique({ where: { id: 1 } })); });
app.post("/customers", async (req, res) => { res.json(await prisma.customer.create({ data: { id: 1 } })); });
app.listen(3000);
export async function startConsumers() {
  const ch = await (await amqp.connect("amqp://x")).createChannel();
  await ch.bindQueue("core-q", "events", "customer.*");
  await ch.consume("core-q", onCustomerEvent);
  await ch.bindQueue("core-topic-q", "amq.topic", "customer.#");
  await ch.consume("core-topic-q", onCustomerEvent);
}
async function onCustomerEvent(msg: unknown) { await prisma.customer.update({ where: { id: 1 }, data: {} }); }
`;

const BILLING = `import express from "express";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const app = express();
app.post("/invoices", async (req, res) => { res.json(await prisma.invoice.create({ data: { id: 1 } })); });
app.listen(3001);
`;

const NOTIFY = `import express from "express";
import axios from "axios";
import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";
import { coreClient } from "./core-client";
import config from "config";
declare const configService: any;
declare const env: any;
const prisma = new PrismaClient();
const app = express();
axios.defaults.baseURL = process.env.CORE_SERVICE_URL;
app.post("/n/env", async (req, res) => {
  await axios.get(\`\${process.env.CORE_SERVICE_URL}/customers/\${req.body.id}\`);
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/config-get", async (req, res) => {
  await axios.get(\`\${config.get("services.core.url")}/customers/\${req.body.id}\`);
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/config-service", async (req, res) => {
  await axios.get(\`\${configService.getOrThrow<string>("CORE_SERVICE_URL")}/customers/\${req.body.id}\`);
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/adonis-env", async (req, res) => {
  await axios.get(\`\${env.get("CORE_SERVICE_URL")}/customers/\${req.body.id}\`);
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/client", async (req, res) => {
  await coreClient.get(\`/customers/\${req.body.id}\`);
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.get("/customers/:id", async (req, res) => {
  const r = await axios.get(\`/customers/\${req.params.id}\`);
  res.json(r.data);
});
app.post("/n/vendor", async (req, res) => {
  await axios.post("https://billing.vendor.com/invoices", {});
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/local", async (req, res) => {
  await axios.post("http://localhost:3001/invoices", {});
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/dynamic", async (req, res) => {
  await axios.post(\`\${pickBase()}/invoices\`, {});
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
app.post("/n/publish", async (req, res) => {
  const ch = await (await amqp.connect("amqp://x")).createChannel();
  ch.publish("events", "customer.created", Buffer.from("x"));
  ch.publish("amq.topic", "customer.created.v1", Buffer.from("x"));
  res.json(await prisma.notification.create({ data: { id: 1 } }));
});
function pickBase(): string { return ""; }
app.listen(3002);
`;

const readFile = (root: string): ChainsFile => ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")));

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.CODELOOM_HOME;
  process.env.CODELOOM_HOME = tmp("home");
});
afterEach(() => {
  process.env.CODELOOM_HOME = savedHome;
});

/** The probe group: core (routes + consumers), billing, a notification service calling core in five ways, and
 * a `core` library with no routes (its name must not make CORE_SERVICE_URL ambiguous). */
async function probeGroup(): Promise<ChainsFile & { root: string; connections: Array<{ from: string; to: string }> }> {
  const parent = tmp("probe");
  const paths = [
    repo(parent, "sunny-core-service", "@acme/core", { "src/server.ts": CORE }),
    repo(parent, "billing", "demo-billing", { "src/server.ts": BILLING }),
    repo(parent, "notification-service", "@acme/notification-service", {
      "src/core-client.ts": 'import axios from "axios";\nexport const coreClient = axios.create({ baseURL: process.env.CORE_SERVICE_URL });\n',
      "src/server.ts": NOTIFY,
    }),
    repo(parent, "core", "@acme/core-lib", { "src/index.ts": "export const version = 1;\n" }, false),
  ];
  let last: Awaited<ReturnType<typeof runIndex>> | undefined;
  for (const p of paths) last = await runIndex(p);
  return { ...readFile(last!.root), root: last!.root, connections: last!.group?.connections ?? [] };
}

/** The chain of route `label` in repo `repo` and the service routes its calls reach (repo + label). */
function serviceRoutes(chains: Chain[], entry: string): string[] {
  const chain = chains.find((c) => c.entry === entry);
  if (!chain) return [`no chain ${entry}`];
  return chain.stops.filter((s, i) => s.kind === "route" && i > 0 && chain.stops[s.from ?? -1]?.kind === "call")
    .map((s) => `${s.repo} ${s.label}`);
}

describe("fix round 1: the review's probe group", () => {
  it("follows env, config.get, getOrThrow, env.get and client bases to core, and nothing else", async () => {
    const { chains } = await probeGroup();
    const n = (path: string) => serviceRoutes(chains, `route:acme-notification-service:POST ${path}`);
    for (const path of ["/n/env", "/n/config-get", "/n/config-service", "/n/adonis-env", "/n/client"]) {
      expect([path, n(path)]).toEqual([path, ["acme-core GET /customers/:id"]]);
    }
    for (const path of ["/n/vendor", "/n/local", "/n/dynamic"]) expect([path, n(path)]).toEqual([path, []]);
    // a backend's relative URL never links, not even to its own route
    expect(serviceRoutes(chains, "route:acme-notification-service:GET /customers/:id")).toEqual([]);
  });

  it("records relative, public-host, loopback and unreadable bases reached from handlers", async () => {
    const { unresolvedBases } = await probeGroup();
    const brief = (unresolvedBases ?? []).map((b) => `${b.kind} ${b.base} ${b.reason} [${b.candidates.join(",")}] ${b.calls.map((c) => c.path).join(",")}`);
    expect(brief.sort()).toEqual([
      "expr pickBase() unknown [] /invoices",
      "relative axios unknown [] /customers/:id",
      "host billing.vendor.com unconfirmed [demo-billing] /invoices",
      "host localhost:3001 unknown [] /invoices",
    ].sort());
  });

  it("counts only direct repo → repo edges as connections", async () => {
    const { connections } = await probeGroup();
    expect(connections.map((c) => `${c.from} → ${c.to}`)).toEqual(["acme-notification-service → acme-core"]);
  });

  it("pairs an undeclared exchange's wildcard binding as a topic, and amq.topic as topic", async () => {
    const { chains } = await probeGroup();
    const publish = chains.find((c) => c.entry === "route:acme-notification-service:POST /n/publish")!;
    const consumes = publish.stops.filter((s) => s.kind === "consume").map((s) => `${s.label}:${s.hop.confidence}`);
    expect(consumes.sort()).toEqual(["core-q:param", "core-topic-q:param"]);
  });

  it("says how many routes have a caller, from the UI and from services", async () => {
    const { root } = await probeGroup();
    const text = formatCheckText(await buildReport(root));
    expect(text).toMatch(/\d+\/\d+ routes have a caller \(0 from UI, 1 from services\)/);
  });
});

describe("fix round 1: ambiguous bases", () => {
  it("links when exactly one candidate repo has the route, and records it when none or both do", async () => {
    const parent = tmp("amb");
    const caller = repo(parent, "orders", "orders", {
      "src/server.ts": `import express from "express";
import axios from "axios";
const app = express();
app.post("/orders", async (req, res) => { await axios.post(\`\${process.env.BILLING_URL}/invoices\`, {}); res.json({}); });
app.post("/refunds", async (req, res) => { await axios.post(\`\${process.env.BILLING_URL}/refunds\`, {}); res.json({}); });
app.listen(1);
`,
    });
    const billing = repo(parent, "billing", "demo-billing", { "src/server.ts": BILLING });
    const other = repo(parent, "billing-service", "billing-service", {
      "src/server.ts": 'import express from "express";\nconst app = express();\napp.post("/payments", (req, res) => res.json({}));\napp.listen(2);\n',
    });
    let root = "";
    for (const p of [caller, billing, other]) root = (await runIndex(p)).root;
    const { chains, unresolvedBases } = readFile(root);
    expect(serviceRoutes(chains, "route:orders:POST /orders")).toEqual(["demo-billing POST /invoices"]);
    expect(serviceRoutes(chains, "route:orders:POST /refunds")).toEqual([]);
    expect(unresolvedBases?.map((b) => [b.base, b.reason, b.candidates, b.calls.map((c) => c.path)])).toEqual([
      ["BILLING_URL", "ambiguous", ["billing-service", "demo-billing"], ["/refunds"]],
    ]);
  });
});

/** gen.mjs: `n` services, `routes` routes each, every handler calling `fan` routes of the next services. */
function generate(parent: string, n: number, routes: number, fan: number): void {
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  const repos: Array<{ id: string; path: string }> = [];
  for (let k = 0; k < n; k++) {
    const lines = ['import express from "express";', 'import axios from "axios";', 'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();", "const app = express();"];
    for (let i = 0; i < routes; i++) {
      lines.push(`app.get("/r${i}/:id", async (req, res) => {`, `  await prisma.item${k}.findUnique({ where: { id: 1 } });`);
      for (let f = 0; f < fan; f++) {
        const t = (k + 1 + f) % n;
        const ti = (i * 7 + f * 13) % routes;
        lines.push(`  await axios.get(\`\${process.env.${names[t]!.toUpperCase()}_SERVICE_URL}/r${ti}/\${req.params.id}\`);`);
      }
      lines.push("  res.json({});", "});");
    }
    lines.push("app.listen(3000);");
    const d = join(parent, `${names[k]}-service`);
    mkdirSync(join(d, "src"), { recursive: true });
    mkdirSync(join(d, "prisma"), { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({
      name: `@demo/${names[k]}-service`, private: true, dependencies: { express: "^4", "@prisma/client": "^5", axios: "^1" },
    }));
    writeFileSync(join(d, "prisma/schema.prisma"), `model Item${k} {\n  id Int @id\n  @@map("items_${k}")\n}\n`);
    writeFileSync(join(d, "src/server.ts"), lines.join("\n"));
    git(d, "init", "-q", "-b", "main");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "init");
    repos.push({ id: `${names[k]}-service`, path: `${names[k]}-service` });
  }
  writeFileSync(join(parent, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "gen", repos, links: [] }));
}

describe("fix round 1: chain size", () => {
  it("keeps chains.json small on 10 services × 30 routes × 3 calls per handler", async () => {
    const parent = tmp("gen");
    generate(parent, 10, 30, 3);
    const started = Date.now();
    await runIndex(parent);
    const seconds = (Date.now() - started) / 1000;
    const bytes = statSync(join(parent, ".codeloom", "chains.json")).size;
    const { chains } = readFile(parent);
    expect(chains).toHaveLength(300);
    // 0.6 Task C review: 237 MB and 2.6 GB of memory before the per-chain bounds.
    expect(Math.max(...chains.map((c) => c.stops.length))).toBeLessThanOrEqual(45);
    expect(bytes).toBeLessThan(6_000_000);
    expect(seconds).toBeLessThan(60);
    // Each route is expanded at most once per chain; a deeper route ends at its own stop, pointing at its chain.
    for (const c of chains) {
      const expanded = c.stops.filter((s, i) => s.kind === "handler" && c.stops[s.from ?? -1]?.kind === "route").map((s) => `${s.repo}:${s.file}:${s.line}`);
      expect(new Set(expanded).size).toBe(expanded.length);
    }
    expect(chains.some((c) => c.stops.some((s) => s.kind === "route" && s.continues !== undefined))).toBe(true);
  }, 180_000);
});

describe("fix round 2", () => {
  /** g3mk.mjs: a web page → orders (its handler reads `tables` tables, then calls payments) → payments → table. */
  async function ordersGroup(tables: number): Promise<ChainsFile> {
    const parent = tmp("g3");
    const models = Array.from({ length: tables }, (_, i) => `model T${i} {\n  id Int @id\n  @@map("t${i}")\n}`).join("\n");
    const steps = Array.from({ length: tables }, (_, i) => `async function step${i}() { await prisma.t${i}.findUnique({ where: { id: 1 } }); }`).join("\n");
    const orders = repo(parent, "orders-service", "orders-service", {
      "prisma/schema.prisma": models,
      "src/server.ts": `import express from "express";\nimport axios from "axios";\nimport { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nconst app = express();\n${steps}\nasync function placeOrder(req: any, res: any) {\n${Array.from({ length: tables }, (_, i) => `  await step${i}();`).join("\n")}\n  await axios.post(\`\${process.env.PAYMENTS_SERVICE_URL}/payments\`, {});\n  res.json({});\n}\napp.post("/orders", placeOrder);\napp.listen(1);\n`,
    });
    const payments = repo(parent, "payments-service", "payments-service", {
      "prisma/schema.prisma": "model Payment {\n  id Int @id\n  @@map(\"payments\")\n}",
      "src/server.ts": 'import express from "express";\nimport { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nconst app = express();\napp.post("/payments", async (req, res) => { res.json(await prisma.payment.create({ data: { id: 1 } })); });\napp.listen(2);\n',
    });
    const web = repo(parent, "shop-web", "shop-web", {
      "package.json": JSON.stringify({ name: "shop-web", dependencies: { next: "^15", react: "^19" } }),
      "app/checkout/page.tsx": '"use client";\nexport default function Checkout() {\n  return <button onClick={() => fetch(`${process.env.NEXT_PUBLIC_ORDERS_URL}/orders`, { method: "POST" })}>Buy</button>;\n}\n',
    }, false);
    let root = "";
    for (const p of [orders, payments, web]) root = (await runIndex(p)).root;
    return readFile(root);
  }

  it("always expands a route the chain's own entry calls, however many tables that entry touches", async () => {
    const { chains } = await ordersGroup(12);
    const page = chains.find((c) => c.entry === "page:shop-web:/checkout")!;
    expect(page.stops.filter((s) => s.kind === "db" && s.repo === "orders-service")).toHaveLength(12);
    expect(page.stops.map((s) => `${s.repo}|${s.kind}|${s.label ?? s.symbol}`)).toEqual(expect.arrayContaining([
      "payments-service|route|POST /payments", "payments-service|handler|POST /payments", "payments-service|db|payments",
    ]));
  });

  it("points `continues` only at route chains that exist", async () => {
    const parent = tmp("cont");
    // a → b → c → d: in a's chain, d is the third hop and is not expanded; d is also called by a page.
    const svc = (name: string, next?: string) => repo(parent, name, name, {
      "src/server.ts": `import express from "express";\nimport axios from "axios";\nimport { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nconst app = express();\napp.post("/${name}", async (req, res) => {\n  await prisma.customer.create({ data: { id: 1 } });\n${next ? `  await axios.post(\`\${process.env.${next.toUpperCase()}_URL}/${next}\`, {});\n` : ""}  res.json({});\n});\napp.post("/${name}-other", async (req, res) => { res.json(await prisma.invoice.create({ data: { id: 1 } })); });\napp.listen(1);\n`,
    });
    const paths = [svc("alpha", "bravo"), svc("bravo", "charlie"), svc("charlie", "delta"), svc("delta"),
      repo(parent, "web", "web", {
        "package.json": JSON.stringify({ name: "web", dependencies: { next: "^15", react: "^19" } }),
        "app/pay/page.tsx": '"use client";\nexport default function Pay() {\n  return <button onClick={() => fetch(`${process.env.NEXT_PUBLIC_DELTA_URL}/delta`, { method: "POST" })}>Pay</button>;\n}\n',
        "app/refund/page.tsx": '"use client";\nexport default function Refund() {\n  return <button onClick={() => fetch(`${process.env.NEXT_PUBLIC_DELTA_URL}/delta-other`, { method: "POST" })}>Refund</button>;\n}\n',
      }, false)];
    let root = "";
    for (const p of paths) root = (await runIndex(p)).root;
    const { chains } = readFile(root);
    const ids = new Map(chains.map((c) => [c.id, c]));
    const pointers = chains.flatMap((c) => c.stops.filter((s) => s.continues !== undefined).map((s) => ({ s, target: ids.get(s.continues!) })));
    expect(pointers.length).toBeGreaterThan(0);
    for (const { s, target } of pointers) {
      expect(target, `${s.repo} ${s.label}`).toBeDefined();
      expect(target!.entry).toBe(`route:${s.repo}:${s.label}`);
    }
    expect(pointers.some(({ s }) => s.repo === "delta" && s.label === "POST /delta")).toBe(true);
  });
});
