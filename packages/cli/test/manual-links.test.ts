import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { hopKey, hopsFromChains } from "../src/evals/score.js";
import { ChainsFileSchema, type Chain, type ChainsFile } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

// Final review batch 2, item B: workspace `links` add hops to chains.

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** demo-shop plus: a page whose call matches no route, and a billing route whose handler can't be found. */
function workspace(links: Array<{ from: string; to: string }>, legacyBody?: string): string {
  const root = materializeFixture("demo-shop");
  write(root, "web/app/legacy/page.tsx", `"use client";
import { saveLegacy } from "../../lib/legacy";

export default function LegacyPage() {
  return <button onClick={() => void saveLegacy()}>Save</button>;
}
`);
  write(root, "web/lib/legacy.ts", legacyBody ?? `export async function saveLegacy() {
  return fetch("/api/v0/customers", { method: "POST", body: "{}" });
}
`);
  const server = readFileSync(join(root, "billing/src/server.ts"), "utf8");
  write(root, "billing/src/server.ts", server.replace(
    'app.listen(4000);',
    'import { legacy } from "legacy-billing";\napp.post("/legacy/refund", legacy.refund);\napp.listen(4000);',
  ));
  write(root, "billing/src/refunds.ts", `import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
export async function refund(id: number) {
  await prisma.payment.create({ data: { id } });
}
`);
  writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
    version: 1, name: "demo-shop",
    repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }],
    links,
  }));
  return root;
}

function chainsFile(root: string): ChainsFile {
  return ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")));
}

const brief = (c: Chain) => c.stops.map((s) => `${s.kind}:${s.label ?? s.symbol}:${s.hop.confidence}${s.hop.reason === "manual link" ? "(manual)" : ""}`);

describe("manual links into chains", () => {
  it("without links: the legacy page is broken at UI -> API and the refund route has no handler", async () => {
    const root = workspace([]);
    await runIndex(root);
    const { chains, manualLinks } = chainsFile(root);
    expect(manualLinks).toBeUndefined();
    expect(chains.find((c) => c.entry === "page:web:/legacy")).toMatchObject({ routeKey: "", complete: false });
    const refund = chains.find((c) => c.entry === "route:billing:POST /legacy/refund")!;
    expect(refund.complete).toBe(false);
    expect(refund.stops.some((s) => s.kind === "db")).toBe(false);
  });

  it("symbol -> route completes an otherwise unresolved UI call chain", async () => {
    const root = workspace([{ from: "web:lib/legacy.ts#saveLegacy", to: "route:api:POST /api/customers" }]);
    await runIndex(root);
    const { chains, manualLinks } = chainsFile(root);
    expect(chains.find((c) => c.entry === "page:web:/legacy" && c.routeKey === "")).toBeUndefined();
    const legacy = chains.find((c) => c.entry === "page:web:/legacy")!;
    expect(legacy).toMatchObject({ routeKey: "api:POST /api/customers", complete: true, confidence: "exact" });
    expect(legacy.unresolved.some((u) => /no matching route/.test(u.reason))).toBe(false);
    expect(brief(legacy).slice(0, 4)).toEqual([
      "page:LegacyPage:exact",
      "function:saveLegacy:exact",
      "call:/api/v0/customers:exact",
      "route:POST /api/customers:exact(manual)",
    ]);
    expect(legacy.stops.filter((s) => s.kind === "db").map((s) => s.label)).toEqual(["customers", "audit_logs"]);
    expect(manualLinks).toEqual([{ from: "web:lib/legacy.ts#saveLegacy", to: "route:api:POST /api/customers", status: "used" }]);
  });

  it("route -> symbol adds a handler and walks it to its store", async () => {
    const root = workspace([{ from: "route:billing:POST /legacy/refund", to: "billing:src/refunds.ts#refund" }]);
    await runIndex(root);
    const { chains } = chainsFile(root);
    const refund = chains.find((c) => c.entry === "route:billing:POST /legacy/refund")!;
    const at = refund.stops.findIndex((s) => s.hop.reason === "manual link");
    expect(refund.stops[at - 1]!.kind).toBe("route");
    expect(brief(refund).slice(at)).toEqual(["handler:refund:exact(manual)", "db:Payment:exact"]);
    expect(refund.complete).toBe(false); // H3: reaches a store but no UI stop: API → DB only
  });

  it("route -> route appends the linked route and its backend half", async () => {
    const root = workspace([{ from: "route:billing:GET /health", to: "route:api:GET /api/customers/:id" }]);
    await runIndex(root);
    const { chains } = chainsFile(root);
    const health = chains.find((c) => c.entry === "route:billing:GET /health")!;
    const at = health.stops.findIndex((s) => s.hop.reason === "manual link");
    expect(brief(health).slice(at)).toEqual([
      "route:GET /api/customers/:id:exact(manual)",
      "handler:CustomersController.show:exact",
      "function:CustomerService.find:exact",
      "db:customers:exact",
    ]);
    // the scorer keys the appended route's hops to that route, never to /health
    const keys = hopsFromChains([health]).map((f) => hopKey(f.hop));
    expect(keys).toEqual(expect.arrayContaining([
      "route-handler|api:GET /api/customers/:id|app/controllers/customers_controller.ts|CustomersController.show",
      "handler-store|api:GET /api/customers/:id|customers||read",
    ]));
    expect(keys.filter((k) => k.includes("billing:GET /health"))).toEqual(["route-handler|billing:GET /health|src/server.ts|GET /health"]);
  });

  it("route -> queue appends the queue's consumers", async () => {
    const root = workspace([{ from: "route:billing:GET /health", to: "queue:billing:emails" }]);
    await runIndex(root);
    const health = chainsFile(root).chains.find((c) => c.entry === "route:billing:GET /health")!;
    const at = health.stops.findIndex((s) => s.hop.reason === "manual link");
    expect(brief(health).slice(at)).toEqual(["consume:emails:exact(manual)", "handler:handleEmail:exact(manual)", "db:email_logs:exact"]);
    expect(health.complete).toBe(false); // H3: reaches a store but no UI stop: API → DB only
  });

  it("broken links are check items (text + --json); a link whose from matches no stop is an info item", async () => {
    const root = workspace([
      { from: "web:lib/nope.ts#missing", to: "route:api:POST /api/customers" },
      { from: "not a ref", to: "route:api:POST /api/customers" },
      { from: "billing:src/refunds.ts#refund", to: "route:api:POST /api/customers" },
    ]);
    await runIndex(root);
    expect(chainsFile(root).manualLinks).toEqual([
      { from: "web:lib/nope.ts#missing", to: "route:api:POST /api/customers", status: "broken", reason: '"web:lib/nope.ts#missing" was not found' },
      { from: "not a ref", to: "route:api:POST /api/customers", status: "broken", reason: "could not parse link reference" },
      { from: "billing:src/refunds.ts#refund", to: "route:api:POST /api/customers", status: "unused" },
    ]);
    const json = await runCheck(root, { json: true });
    expect(json.exitCode).toBe(0);
    const items = json.report.items.filter((i) => i.kind.startsWith("manual-link"));
    expect(items.map((i) => `${i.kind} ${i.detail}`)).toEqual([
      'manual-link-broken not a ref -> route:api:POST /api/customers: could not parse link reference',
      'manual-link-broken web:lib/nope.ts#missing -> route:api:POST /api/customers: "web:lib/nope.ts#missing" was not found',
      "manual-link-unused billing:src/refunds.ts#refund -> route:api:POST /api/customers: its from matches no chain stop",
    ]);
    expect(JSON.parse(json.output).items).toEqual(json.report.items);
    const text = (await runCheck(root, {})).output;
    expect(text).toContain("Manual links that could not be resolved (2):");
    expect(text).toContain("  codeloom.workspace.json not a ref — not a ref -> route:api:POST /api/customers: could not parse link reference");
    expect(text).toContain("Manual links that match no chain, info only (1):");
    // buckets are not changed by manual-link items
    const plain = workspace([]);
    await runIndex(plain);
    expect((await runCheck(plain, { json: true })).report.summary).toEqual(json.report.summary);
  });

  // Re-review: a symbol -> route link is exact only for the one unmatched call it can mean.
  const LINK = { from: "web:lib/legacy.ts#saveLegacy", to: "route:api:POST /api/customers" };
  const legacyBody = (withOther: boolean) => `import { billingApi } from "./billing-api";

export async function saveLegacy() {
  await fetch("https://api.stripe.com/v1/charges", { method: "POST", body: "{}" });
${withOther ? '  await fetch("/api/v0/other", { method: "DELETE" });\n' : ""}  await billingApi.post("/billing/invoices", { customerId: 1 });
  return fetch("/api/v0/customers", { method: "POST", body: "{}" });
}
`;
  const legacyChains = (cs: Chain[]) => cs.filter((c) => c.entry === "page:web:/legacy");
  const invoices = (cs: Chain[]) => legacyChains(cs).find((c) => c.routeKey === "billing:POST /billing/invoices");

  it("two unmatched calls in the linked function: the link is broken (ambiguous) and nothing is linked", async () => {
    const plain = workspace([], legacyBody(true));
    await runIndex(plain);
    const root = workspace([LINK], legacyBody(true));
    await runIndex(root);
    const { chains, manualLinks } = chainsFile(root);
    expect(manualLinks).toEqual([{ ...LINK, status: "broken", reason: "ambiguous: 2 unmatched calls in saveLegacy" }]);
    expect(chains.flatMap((c) => c.stops).some((s) => s.hop.reason === "manual link")).toBe(false);
    const unmatched = legacyChains(chains).find((c) => c.routeKey === "")!;
    expect(unmatched.unresolved.map((u) => u.reason)).toEqual([
      "no matching route for DELETE /api/v0/other",
      "no matching route for POST /api/v0/customers",
    ]);
    expect(invoices(chains)).toEqual(invoices(chainsFile(plain).chains));
    const json = (await runCheck(root, { json: true })).report.items.filter((i) => i.kind.startsWith("manual-link"));
    expect(json.map((i) => `${i.kind} ${i.detail}`)).toEqual([
      `manual-link-broken ${LINK.from} -> ${LINK.to}: ambiguous: 2 unmatched calls in saveLegacy`,
    ]);
    expect((await runCheck(root, {})).output).toContain(`${LINK.from} -> ${LINK.to}: ambiguous: 2 unmatched calls in saveLegacy`);
  });

  it("one unmatched call (plus a third-party and a matched call): linked exact, route appears once", async () => {
    const plain = workspace([], legacyBody(false));
    await runIndex(plain);
    const root = workspace([LINK], legacyBody(false));
    await runIndex(root);
    const { chains, manualLinks } = chainsFile(root);
    expect(manualLinks).toEqual([{ ...LINK, status: "used" }]);
    const legacy = legacyChains(chains);
    expect(legacy.map((c) => c.routeKey).sort()).toEqual(["api:POST /api/customers", "billing:POST /billing/invoices"]);
    const routes = legacy.flatMap((c) => c.stops).filter((s) => s.kind === "route" && s.label === "POST /api/customers");
    expect(routes).toHaveLength(1);
    expect(routes[0]!.hop).toEqual({ confidence: "exact", reason: "manual link" });
    // the matched /billing/invoices chain is untouched
    expect(invoices(chains)).toEqual(invoices(chainsFile(plain).chains));
    // no ui-api hop from saveLegacy other than its two real targets
    const uiApi = hopsFromChains(chains).map((f) => hopKey(f.hop)).filter((k) => k.startsWith("ui-api|web|lib/legacy.ts|saveLegacy"));
    expect(uiApi.length).toBe(2);
    expect(uiApi.some((k) => k.includes("/api/customers"))).toBe(true);
    expect(uiApi.some((k) => k.includes("/billing/invoices"))).toBe(true);
  });

  it("a symbol -> route link never matches a call stop of a matched chain or a page/function stop", async () => {
    const root = workspace([
      { from: "web:lib/billing.ts#createInvoice", to: "route:api:POST /api/customers" },
      { from: "web:app/legacy/page.tsx#LegacyPage", to: "route:api:POST /api/customers" },
    ]);
    await runIndex(root);
    const { chains, manualLinks } = chainsFile(root);
    expect(manualLinks!.map((l) => l.status)).toEqual(["unused", "unused"]);
    expect(chains.flatMap((c) => c.stops).some((s) => s.hop.reason === "manual link")).toBe(false);
    const legacy = legacyChains(chains);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.stops.some((s) => s.kind === "route")).toBe(false);
    expect(hopsFromChains(chains).some((f) => f.hop.type === "ui-api" && "from" in f.hop && f.hop.from.file === "lib/legacy.ts")).toBe(false);
  });

  it("an unreadable-URL call resolved by a link is no longer listed as unresolved-url", async () => {
    const body = `export async function saveLegacy(u: string) {
  return fetch(u, { method: "POST", body: "{}" });
}
`;
    const plain = workspace([], body);
    await runIndex(plain);
    const at = async (r: string) => (await runCheck(r, { json: true })).report.items.filter((i) => i.kind === "unresolved-url" && i.file === "lib/legacy.ts");
    expect(await at(plain)).toHaveLength(1);
    const root = workspace([LINK], body);
    await runIndex(root);
    expect(chainsFile(root).manualLinks).toEqual([{ ...LINK, status: "used" }]);
    expect(await at(root)).toEqual([]);
  });
});

