import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapGaps } from "../src/map/gaps.js";
import { saveMapAnswers, weakened } from "../src/map/save.js";
import { getJourney, listChains } from "../src/mcp/tools/journeys.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { runDoctor } from "../src/commands/doctor.js";
import { type Chain, ChainsFileSchema } from "../src/store/schemas.js";
import { freshHome } from "./helpers.js";
import { shopGroup } from "./shop-group-fixture.js";

// 0.6 Task E: Task D's gaps read Task C's unresolved call bases (setup: shop-group-fixture.ts).

const chainsOf = (root: string): Chain[] => ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8"))).chains;
const brief = (c: Chain) => c.stops.map((s) => `${s.repo}|${s.kind}|${s.label ?? s.symbol}`);

describe("gaps read the linker's unresolved call bases (0.6 Task E)", () => {
  let g: Awaited<ReturnType<typeof shopGroup>>;
  beforeAll(async () => {
    g = await shopGroup();
  }, 300_000);
  beforeEach(() => {
    process.env.CODELOOM_HOME = g.home;
  });

  it("asks about a backend's relative-URL call and a call through its own wrapper, never the base its hints settle", () => {
    const { gaps } = mapGaps(g.api);
    const bases = gaps.filter((x) => x.kind === "unknown-base");
    const relative = bases.find((x) => x.evidence.some((e) => e.includes("POST /ledger/entries")));
    expect(relative, JSON.stringify(bases, null, 1)).toBeDefined();
    expect(relative!.question).toMatch(/demo-api/);
    expect(relative!.question).toMatch(/axios/);
    expect(relative!.evidence[0]).toMatch(/^demo-api app\/services\/customer_service\.ts:\d+ /);

    const wrapper = bases.find((x) => x.evidence.some((e) => e.includes("GET /ledger/balances/:id")));
    expect(wrapper, JSON.stringify(bases, null, 1)).toBeDefined();
    expect(wrapper!.question).toMatch(/LEGACY_BILLING_URL/);
    // The wrapper call's site is the caller (CustomerService.find), not the wrapper itself.
    expect(wrapper!.evidence[0]).toMatch(/^demo-api app\/services\/customer_service\.ts:\d+ CustomerService\.find: GET \/ledger\/balances/);
    expect((wrapper!.suggest ?? []).map((s) => JSON.parse(s))).toContainEqual({ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing", from: "demo-api" });

    // BILLING_API_URL names demo-billing: settled by the hint, no question; and no call-no-route noise for these calls.
    expect(gaps.some((x) => x.question.includes("BILLING_API_URL"))).toBe(false);
    expect(gaps.filter((x) => x.kind === "call-no-route" && x.evidence.some((e) => e.includes("/ledger/")))).toEqual([]);
    // The wrapper's own template call (`fetch(`${LEGACY_BILLING_URL}${path}`)`) is no "cannot read the URL" question:
    // its callers are asked about. And no proposal is ever made from name words alone (billingRequest ~ /billing/…).
    expect(gaps.filter((x) => x.evidence.some((e) => e.includes("billing_client.ts")))).toEqual([]);
    expect(gaps.flatMap((x) => x.suggest ?? []).filter((s) => s.includes("billingRequest"))).toEqual([]);
  });

  it("answering each closes its gap and the web → api → billing chain appears", () => {
    const before = mapGaps(g.api).gaps;
    const relative = before.find((x) => x.kind === "unknown-base" && x.evidence.some((e) => e.includes("POST /ledger/entries")))!;
    const r1 = saveMapAnswers(g.api, { answers: [{ kind: "env", name: "axios", repo: "demo-billing", from: "demo-api" }] });
    expect(r1.closed.map((x) => x.id)).toContain(relative.id);
    // The page's chain keeps its id but now reaches billing: reported as grown.
    expect(r1.grown).toEqual(expect.arrayContaining([expect.objectContaining({ repos: "demo-web → demo-api → demo-billing" })]));
    let page = chainsOf(g.root).find((c) => c.entry === "page:demo-web:/customers/:id")!;
    expect(brief(page)).toEqual(expect.arrayContaining(["demo-billing|route|POST /ledger/entries", "demo-billing|handler|addEntry"]));

    const wrapper = mapGaps(g.api).gaps.find((x) => x.kind === "unknown-base" && x.question.includes("LEGACY_BILLING_URL"))!;
    const r2 = saveMapAnswers(g.api, { answers: [JSON.parse(wrapper.suggest![0]!)] });
    expect(r2.closed.map((x) => x.id)).toContain(wrapper.id);
    page = chainsOf(g.root).find((c) => c.entry === "page:demo-web:/customers/:id")!;
    expect(brief(page)).toEqual(expect.arrayContaining([
      "demo-web|page|CustomerPage", "demo-api|route|GET /api/customers/:id",
      "demo-billing|route|GET /ledger/balances/:id", "demo-billing|handler|getBalance",
    ]));
    // Once placed, neither call is a gap of any kind.
    const after = mapGaps(g.api).gaps;
    expect(after.filter((x) => x.kind === "unknown-base")).toEqual([]);
    expect(after.filter((x) => x.evidence.some((e) => e.includes("billing_client.ts") || e.includes("/ledger/")))).toEqual([]);
    // Answered bases stay known: the same answer saves again, and doctor does not call it stale.
    expect(saveMapAnswers(g.api, { answers: [JSON.parse(wrapper.suggest![0]!)] }).saved).toBe(1);
    expect(saveMapAnswers(g.api, { answers: [{ kind: "env", name: "axios", repo: "demo-billing", from: "demo-api" }] }).saved).toBe(1);
    const stale = runDoctor(g.api, {}).items.find((c) => c.check === "answers");
    expect(stale?.status, JSON.stringify(stale)).toBe("ok");
  });
});

describe("chains cut off with `continues` (0.6 Task E)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  /** A service `name` (express + prisma) whose POST /<name> calls `next` through `<NEXT>_URL`. */
  function svc(parent: string, name: string, next?: string): string {
    const d = join(parent, name);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name, private: true, dependencies: { express: "^4", "@prisma/client": "^5", axios: "^1" } }),
      "prisma/schema.prisma": `model ${name[0]!.toUpperCase()}${name.slice(1)}Row {\n  id Int @id\n  @@map("${name}_rows")\n}\n`,
      "src/server.ts": `import express from "express";\nimport axios from "axios";\nimport { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nconst app = express();\napp.post("/${name}", async (req, res) => {\n  await prisma.${name}Row.create({ data: { id: 1 } });\n${next ? `  await axios.post(\`\${process.env.${next.toUpperCase()}_URL}/${next}\`, {});\n` : ""}  res.json({});\n});\napp.listen(1);\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(d, rel)), { recursive: true });
      writeFileSync(join(d, rel), content);
    }
    git(d, "init", "-q", "-b", "main");
    git(d, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
    git(d, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    git(d, "remote", "add", "origin", `git@github.com:demo-shop/${name}.git`);
    return d;
  }

  it("gaps and answers handle a route that continues in its own chain: no crash, nothing weakened", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-continues-"));
    const paths = [svc(parent, "alpha", "bravo"), svc(parent, "bravo", "charlie"), svc(parent, "charlie", "delta"), svc(parent, "delta")];
    let root = "";
    for (const p of paths) root = (await runIndex(p)).root;
    const chains = chainsOf(root);
    const cut = chains.flatMap((c) => c.stops.filter((x) => x.continues !== undefined));
    expect(cut.length).toBeGreaterThan(0);
    // The route a `continues` names counts as called (by the call stop before it): no uncalled-route gap for it.
    const { gaps } = mapGaps(paths[0]!);
    for (const x of cut) {
      expect(gaps.some((g) => g.kind === "route-no-caller" && g.evidence.some((e) => e.includes(`${x.repo} `) && e.includes(x.label ?? "?")))).toBe(false);
    }
    // The same chains before and after: nothing is weaker, `continues` stops included.
    expect(weakened(chains, chains, new Set(), () => false)).toEqual([]);
    // MCP chain tools say where a cut-off route goes on: the chain it continues in (an id that exists).
    const holder = chains.find((c) => c.stops.some((x) => x.continues !== undefined))!;
    const view = getJourney(paths[0]!, holder.id) as { chains: Array<{ stops: Array<{ kind: string; continues?: { chain: string; name: string } }> }> };
    const shown = view.chains[0]!.stops.find((x) => x.continues !== undefined)!;
    expect(chains.map((c) => c.id)).toContain(shown.continues!.chain);
    expect(shown.continues!.name).toBe(chains.find((c) => c.id === shown.continues!.chain)!.name);
    const listed = listChains(paths[0]!, { detail: true }) as { chains: Array<{ stops: Array<{ continues?: unknown }> }> };
    expect(listed.chains.some((c) => c.stops.some((x) => x.continues !== undefined))).toBe(true);
    // An answer that changes no link saves, and the cut-off chains stay as they were.
    const r = saveMapAnswers(paths[0]!, { answers: [{ kind: "role", repo: "delta", role: "api" }] });
    expect(r.saved).toBe(1);
    expect(chainsOf(root)).toEqual(chains);
  }, 300_000);
});

describe("proposals for a backend's calls never point at a UI repo (0.6 Task E)", () => {
  it("a service call is not proposed to go to a frontend's API or proxy route, by name or by path", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-backend-props-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
    const make = (name: string, files: Record<string, string>) => {
      const d = join(parent, name);
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(d, rel)), { recursive: true });
        writeFileSync(join(d, rel), content);
      }
      git(d, "init", "-q", "-b", "main");
      git(d, "add", "-A");
      git(d, "commit", "-qm", "init");
      git(d, "remote", "add", "origin", `git@github.com:demo-shop/${name}.git`);
      return d;
    };
    const web = make("web", {
      "package.json": JSON.stringify({ name: "web", dependencies: { next: "^15", react: "^19" } }),
      "app/orders/page.tsx": 'export default async function Orders() {\n  const r = await fetch("/api/core/orders");\n  return <p>{String(r.ok)}</p>;\n}\n',
      "app/api/core/[...path]/route.ts": "export async function PATCH(req: Request) {\n  return new Response(null);\n}\n",
    });
    const dispatch = make("dispatch", {
      "package.json": JSON.stringify({ name: "dispatch", dependencies: { express: "^4", axios: "^1" } }),
      "src/server.ts": 'import express from "express";\nimport axios from "axios";\nconst app = express();\nexport async function callCore(req: any, res: any) {\n  await axios.patch(`${process.env.WEB_LEGACY_URL}/api/core/orders`, {});\n  res.json({});\n}\napp.post("/dispatch", callCore);\napp.listen(1);\n',
    });
    await runIndex(web);
    await runIndex(dispatch);
    const gaps = mapGaps(dispatch).gaps;
    const base = gaps.find((g) => g.kind === "unknown-base" && g.question.includes("WEB_LEGACY_URL"));
    expect(base, JSON.stringify(gaps, null, 1)).toBeDefined();
    expect(base!.suggest ?? []).toEqual([]);
    expect(base!.question).not.toMatch(/\(web\?\)/);
    expect(gaps.flatMap((g) => g.suggest ?? []).filter((x) => x.includes('"repo":"web"') || x.includes("route:web:"))).toEqual([]);
  }, 300_000);
});

describe("a base the linker's own hint places is no question (0.6 Task E, acceptance run 2)", () => {
  async function hinted(extra: Record<string, string>) {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-hinted-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
    const make = (name: string, files: Record<string, string>) => {
      const d = join(parent, name);
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(d, rel)), { recursive: true });
        writeFileSync(join(d, rel), content);
      }
      git(d, "init", "-q", "-b", "main");
      git(d, "add", "-A");
      git(d, "commit", "-qm", "init");
      git(d, "remote", "add", "origin", `git@github.com:demo-shop/${name}.git`);
      return d;
    };
    const core = make("demo-core-service", {
      "package.json": JSON.stringify({ name: "demo-core-service", dependencies: { express: "^4" } }),
      "src/server.ts": 'import express from "express";\nconst app = express();\napp.get("/orders/:id", (req, res) => { res.json({}); });\napp.get("/customers/:id", (req, res) => { res.json({}); });\napp.listen(1);\n',
    });
    const fetcher = (fn: string, url: string) => `export async function ${fn}(id: string, path: string) {\n  const r = await fetch(\`${url}\`);\n  return r.json();\n}\n`;
    const web = make("demo-web", {
      "package.json": JSON.stringify({ name: "demo-web", dependencies: { next: "^15", react: "^19" } }),
      "app/orders/[id]/page.tsx": 'import { getOrder } from "../../../lib/orders";\nimport { getCustomer } from "../../../lib/customers";\nexport default async function P() {\n  await getOrder("1", "");\n  await getCustomer("1", "");\n  return <p>x</p>;\n}\n',
      "lib/orders.ts": fetcher("getOrder", "${process.env.NEXT_PUBLIC_DEMO_CORE_SERVICE_URL}/orders/${id}"),
      "lib/customers.ts": fetcher("getCustomer", "${process.env.NEXT_PUBLIC_DEMO_CORE_SERVICE_URL}/customers/${id}"),
      ...extra,
    });
    await runIndex(core);
    await runIndex(web);
    return web;
  }

  it("all its calls link exactly through the hint: no gap", async () => {
    const web = await hinted({});
    expect(mapGaps(web).gaps.filter((g) => g.question.includes("DEMO_CORE_SERVICE_URL"))).toEqual([]);
  }, 120_000);

  it("an unreadable call through it is asked about as that call, never as the base", async () => {
    const web = await hinted({ "lib/any.ts": "export async function anyCall(path: string) {\n  const r = await fetch(`${process.env.NEXT_PUBLIC_DEMO_CORE_SERVICE_URL}${path}`);\n  return r.json();\n}\n" });
    const gaps = mapGaps(web).gaps;
    expect(gaps.filter((g) => g.kind === "unknown-base" && g.question.includes("DEMO_CORE_SERVICE_URL"))).toEqual([]);
  }, 120_000);

  it("a readable call through it that matches nothing is asked about, as matching no route where the name sends it", async () => {
    const web = await hinted({ "lib/gone.ts": "export async function gone() {\n  const r = await fetch(`${process.env.NEXT_PUBLIC_DEMO_CORE_SERVICE_URL}/invoices/archive`);\n  return r.json();\n}\n" });
    const gap = mapGaps(web).gaps.find((g) => g.question.includes("DEMO_CORE_SERVICE_URL"))!;
    expect(gap.question).toMatch(/1 call through NEXT_PUBLIC_DEMO_CORE_SERVICE_URL matches no route in demo-core-service, where its name sends them/);
    expect(gap.suggest ?? []).toEqual([]);
  }, 120_000);
});

describe("a base's proposal follows the clear majority of its matched calls (0.6 Task E, acceptance run 2)", () => {
  async function split(core: number, installer: number) {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-majority-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
    const make = (name: string, files: Record<string, string>) => {
      const d = join(parent, name);
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(d, rel)), { recursive: true });
        writeFileSync(join(d, rel), content);
      }
      git(d, "init", "-q", "-b", "main");
      git(d, "add", "-A");
      git(d, "commit", "-qm", "init");
      git(d, "remote", "add", "origin", `git@github.com:demo-shop/${name}.git`);
      return d;
    };
    const svc = (name: string, prefix: string, n: number) => make(name, {
      "package.json": JSON.stringify({ name, dependencies: { express: "^4" } }),
      "src/server.ts": `import express from "express";\nconst app = express();\n${Array.from({ length: n }, (_, i) => `app.get("/${prefix}${i}/:id", (req, res) => { res.json({}); });\n`).join("")}app.listen(1);\n`,
    });
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "demo-market", dependencies: { next: "^15", react: "^19" } }) };
    const calls = [...Array.from({ length: core }, (_, i) => `core${i}`), ...Array.from({ length: installer }, (_, i) => `inst${i}`), "nowhere"];
    calls.forEach((p, i) => {
      files[`lib/c${i}.ts`] = `export async function c${i}(id: string) {\n  const r = await fetch(\`\${process.env.NEXT_PUBLIC_API_ENDPOINT}/${p}/\${id}\`);\n  return r.json();\n}\n`;
    });
    files["app/page.tsx"] = `${calls.map((_, i) => `import { c${i} } from "../lib/c${i}";`).join("\n")}\nexport default async function Home() {\n${calls.map((_, i) => `  await c${i}("1");`).join("\n")}\n  return <p>x</p>;\n}\n`;
    await runIndex(svc("demo-core", "core", core));
    await runIndex(svc("demo-partner-api", "inst", installer));
    const web = make("demo-market", files);
    await runIndex(web);
    return mapGaps(web).gaps.find((g) => g.kind === "unknown-base" && g.question.includes("NEXT_PUBLIC_API_ENDPOINT"))!;
  }

  it("proposes the repo serving at least 70% of the matched calls", async () => {
    const gap = await split(4, 1);
    expect(gap.question).toMatch(/\(demo-core\?\)/);
    expect((gap.suggest ?? []).map((x) => JSON.parse(x))).toEqual([{ kind: "env", name: "NEXT_PUBLIC_API_ENDPOINT", repo: "demo-core", from: "demo-market" }]);
  }, 120_000);

  it("proposes nothing without a clear majority, and shows the split", async () => {
    const gap = await split(3, 2);
    expect(gap.suggest ?? []).toEqual([]);
    expect(gap.evidence.join("\n")).toContain("matched: demo-core 3, demo-partner-api 2");
  }, 120_000);
});
