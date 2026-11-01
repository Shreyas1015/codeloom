import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { ChainsFileSchema } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

function workspace(): string {
  const root = materializeFixture("demo-shop");
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({
      version: 1, name: "demo-shop",
      repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }],
      links: [],
    }),
  );
  return root;
}

function readChains(root: string): { version: number; chains: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8"));
}

type Stop = Record<string, unknown> & { hop: { confidence: string } };

describe("the linker on demo-shop", () => {
  it("builds every expected chain: UI -> API -> code -> DB, the /billing mount, DI, the object-literal service, queue pairing, and backend-only routes", async () => {
    const root = workspace();
    await runIndex(root);
    const file = readChains(root);
    expect(() => ChainsFileSchema.parse(file)).not.toThrow();
    const { chains } = file;
    const byEntry = Object.fromEntries(chains.map((c) => [c.entry as string, c]));
    expect(Object.keys(byEntry).sort()).toEqual([
      "consumer:billing:emails",
      "consumer:billing:invoice.created",
      "page:web:/customers/:id",
      "page:web:/customers/new",
      "page:web:/invoices/new",
      "route:billing:GET /health",
      "route:billing:POST /billing/invoices/:id/pay",
    ]);

    // UI -> API, DI hop (this.customers.create)
    expect(byEntry["page:web:/customers/new"]).toMatchObject({ routeKey: "api:POST /api/customers", complete: true, confidence: "exact" });
    // UI -> API, new-member hop (new CustomerService().find)
    expect(byEntry["page:web:/customers/:id"]).toMatchObject({ routeKey: "api:GET /api/customers/:id", complete: true, confidence: "exact" });
    // UI -> billing: only matches through the /billing mount + the billingApi axios instance
    expect(byEntry["page:web:/invoices/new"]).toMatchObject({ routeKey: "billing:POST /billing/invoices", complete: true, confidence: "exact" });

    expect(byEntry["route:billing:POST /billing/invoices/:id/pay"]).toMatchObject({ complete: true, confidence: "exact" });
    expect(byEntry["route:billing:GET /health"]).toMatchObject({ complete: false }); // no db/queue hit: check's "no-store"
    // the inline handler's stop points at its own first line, not line 1 of the file
    expect((byEntry["route:billing:GET /health"] as { stops: Stop[] }).stops[1]).toMatchObject({ kind: "handler", symbol: "GET /health", line: 10 });

    expect(byEntry["consumer:billing:invoice.created"]).toMatchObject({ complete: false }); // ack-only, no store
    expect(byEntry["consumer:billing:emails"]).toMatchObject({ complete: true, confidence: "exact" }); // named handler -> email_logs insert
  });

  it("walks the DI hop and the new-member hop down to their tables", async () => {
    const root = workspace();
    await runIndex(root);
    const { chains } = readChains(root);
    const stopsOf = (entry: string) => (chains.find((c) => c.entry === entry)! as { stops: Stop[] }).stops;
    const create = stopsOf("page:web:/customers/new");
    expect(create.map((s) => `${s.lane}/${s.kind}:${s.symbol}${s.label ? `(${s.label})` : ""}`)).toEqual([
      "ui/page:NewCustomerPage",
      "ui/function:useCreateCustomer",
      "ui/call:useCreateCustomer(/api/customers)",
      "api/route:CustomersController.store(POST /api/customers)",
      "code/handler:CustomersController.store",
      "code/function:CustomerService.create",
      "db/db:CustomerService.create(customers)",
      "db/db:CustomerService.create(audit_logs)",
    ]);
    expect(create.find((s) => s.kind === "function" && s.lane === "code")!.hop).toEqual({ confidence: "exact", reason: "via di" });
    const show = stopsOf("page:web:/customers/:id");
    expect(show.find((s) => s.kind === "function" && s.lane === "code")!.hop).toEqual({ confidence: "exact", reason: "via new" });
    expect(show.filter((s) => s.lane === "db").map((s) => `${s.op} ${s.label}`)).toEqual(["read customers"]);
  });

  it("matches the invoices chain through the /billing mount and the object-literal service", async () => {
    const root = workspace();
    await runIndex(root);
    const { chains } = readChains(root);
    const invoiceChain = chains.find((c) => c.entry === "page:web:/invoices/new")! as { stops: Stop[] };
    const route = invoiceChain.stops.find((s) => s.kind === "route")!;
    expect(route).toMatchObject({ label: "POST /billing/invoices", hop: { confidence: "exact" } });
    const db = invoiceChain.stops.filter((s) => s.lane === "db");
    expect(db).toEqual([expect.objectContaining({ label: "invoices", op: "insert" })]);
    const handler = invoiceChain.stops.find((s) => s.kind === "handler")!;
    expect(handler).toMatchObject({ symbol: "createInvoice" });
    expect(invoiceChain.stops.find((s) => s.symbol === "invoiceService.create" && s.kind === "function")!.hop).toEqual({ confidence: "exact", reason: "via object" });
    expect(invoiceChain.stops.filter((s) => s.kind === "publish").map((s) => s.label)).toEqual(["invoice.created"]);
  });

  it("the pay route publishes to the billing exchange and updates invoices", async () => {
    const root = workspace();
    await runIndex(root);
    const { chains } = readChains(root);
    const pay = chains.find((c) => c.entry === "route:billing:POST /billing/invoices/:id/pay")! as { stops: Stop[] };
    // Hits come nearest-first, then by file/line (link.ts storeHits): events.ts sorts before invoice-service.ts.
    expect(pay.stops.filter((s) => s.lane === "db" || s.kind === "publish").map((s) => `${s.op} ${s.label}`)).toEqual([
      "publish billing:invoice.paid",
      "update invoices",
    ]);
  });

  it("creates an empty journeys.json alongside chains.json", async () => {
    const root = workspace();
    await runIndex(root);
    expect(JSON.parse(readFileSync(join(root, ".codeloom", "journeys.json"), "utf8"))).toEqual({ version: 1, journeys: [] });
  });

  it("is byte-identical on a second run with no code change", async () => {
    const root = workspace();
    await runIndex(root);
    const chainsBefore = readFileSync(join(root, ".codeloom", "chains.json"), "utf8");
    const journeysBefore = readFileSync(join(root, ".codeloom", "journeys.json"), "utf8");
    const second = await runIndex(root);
    expect(second.linker.wrote).toBe(false);
    expect(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).toBe(chainsBefore);
    expect(readFileSync(join(root, ".codeloom", "journeys.json"), "utf8")).toBe(journeysBefore);
  });
});
