import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { ChainsFileSchema, type Chain, type ChainStop } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

// Each chain stop records the stop it was reached from (`from`, an index into the same chain's stops).

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function workspace(links: Array<{ from: string; to: string }> = []): string {
  const root = materializeFixture("demo-shop");
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

async function chains(links: Array<{ from: string; to: string }> = []): Promise<Chain[]> {
  const root = workspace(links);
  await runIndex(root);
  return ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8"))).chains;
}

const parent = (c: Chain, s: ChainStop): ChainStop => c.stops[s.from!]!;

function expectWellFormed(all: Chain[]): void {
  for (const c of all) {
    c.stops.forEach((s, i) => {
      if (i === 0) expect(s.from, `${c.entry} stop 0`).toBeUndefined();
      else {
        expect(s.from, `${c.entry} stop ${i}`).toBeTypeOf("number");
        expect(s.from!, `${c.entry} stop ${i}`).toBeLessThan(i);
      }
    });
  }
}

describe("chain stops record the stop they were reached from", () => {
  it("every stop past the first has from < its own index", async () => {
    expectWellFormed(await chains());
  });

  it("a store's from is the code stop where the access happens, never a sibling store", async () => {
    const all = await chains();
    const create = all.find((c) => c.entry === "page:web:/customers/new")!;
    const svc = create.stops.findIndex((s) => s.kind === "function" && s.symbol === "CustomerService.create");
    const stores = create.stops.filter((s) => s.kind === "db");
    expect(stores.map((s) => s.label)).toEqual(["customers", "audit_logs"]);
    for (const s of stores) expect(s.from).toBe(svc);
    // UI side and backend spine are linear
    const kinds = create.stops.map((s) => s.kind);
    expect(create.stops[kinds.indexOf("route")]!.from).toBe(kinds.indexOf("call"));
    expect(create.stops[kinds.indexOf("handler")]!.from).toBe(kinds.indexOf("route"));
    expect(create.stops[svc]!.from).toBe(kinds.indexOf("handler"));
    // in every chain, a store hangs off the handler/function stop of the symbol that holds the access
    for (const c of all) {
      for (const s of c.stops.filter((x) => x.kind === "db" || x.kind === "publish")) {
        const p = parent(c, s);
        expect(["handler", "function"], `${c.entry} ${s.label}`).toContain(p.kind);
        expect(p.file, `${c.entry} ${s.label}`).toBe(s.file);
      }
    }
  });

  it("a paired consumer's consume stop comes from the publish stop", async () => {
    const all = await chains();
    const pay = all.find((c) => c.entry === "route:billing:POST /billing/invoices/:id/pay")!;
    const consume = pay.stops.find((s) => s.kind === "consume")!;
    expect(parent(pay, consume)).toMatchObject({ kind: "publish", label: "billing:invoice.paid" });
    const handler = pay.stops.find((s) => s.kind === "handler" && s.symbol === "handleEmail")!;
    expect(parent(pay, handler)).toBe(consume);
    const logs = pay.stops.find((s) => s.label === "email_logs")!;
    expect(parent(pay, logs)).toBe(handler);
    // pay publishes then updates invoices: the update is not reached from the publish
    const update = pay.stops.find((s) => s.kind === "db" && s.label === "invoices")!;
    expect(parent(pay, update).kind).not.toBe("publish");
  });

  it("manual link stops come from the link's source stop", async () => {
    const all = await chains([
      { from: "route:billing:GET /health", to: "route:api:GET /api/customers/:id" },
      { from: "route:billing:GET /health", to: "queue:billing:emails" },
      { from: "route:billing:POST /billing/invoices", to: "billing:src/refunds.ts#refund" },
    ]);
    expectWellFormed(all);
    const health = all.find((c) => c.entry === "route:billing:GET /health")!;
    const manual = health.stops.filter((s) => s.hop.reason === "manual link" && s.kind !== "handler");
    expect(manual.map((s) => s.kind)).toEqual(["route", "consume"]);
    for (const s of manual) expect(s.from).toBe(0);
    const invoices = all.find((c) => c.entry === "page:web:/invoices/new")!;
    const refund = invoices.stops.find((s) => s.kind === "handler" && s.symbol === "refund")!;
    expect(parent(invoices, refund)).toMatchObject({ kind: "route", label: "POST /billing/invoices" });
    expect(parent(invoices, invoices.stops.find((s) => s.label === "Payment")!)).toBe(refund);
  });

  it("chains.json files without from still parse", () => {
    const file = {
      version: 1,
      chains: [{
        id: "ch_000000000001", entry: "route:api:GET /x", routeKey: "api:GET /x", name: "GET /x", unresolved: [],
        confidence: "exact", complete: false,
        stops: [{ lane: "api", kind: "route", repo: "api", file: "a.ts", line: 1, symbol: "x", hop: { confidence: "exact" } },
          { lane: "code", kind: "handler", repo: "api", file: "a.ts", line: 2, symbol: "x", hop: { confidence: "exact" } }],
      }],
    };
    expect(() => ChainsFileSchema.parse(file)).not.toThrow();
    const bad = structuredClone(file);
    (bad.chains[0]!.stops[1] as Record<string, unknown>).from = -1;
    expect(() => ChainsFileSchema.parse(bad)).toThrow();
  });
});
