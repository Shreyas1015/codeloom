import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("builds every expected chain: UI -> API -> code -> DB, the /billing mount, DI, the object-literal service, consumers, and backend-only routes", async () => {
    const root = workspace();
    await runIndex(root);
    const file = readChains(root);
    expect(() => ChainsFileSchema.parse(file)).not.toThrow();
    const { chains } = file;
    const byEntry = Object.fromEntries(chains.map((c) => [c.entry as string, c]));
    expect(Object.keys(byEntry).sort()).toEqual([
      "consumer:billing:emails#src/notify-consumer.ts#handleEmail",
      "consumer:billing:invoice.created#src/events.ts#startConsumer",
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

    // param: the pay route's publish continues into the "emails" consumer through the invoice.* wildcard binding
    expect(byEntry["route:billing:POST /billing/invoices/:id/pay"]).toMatchObject({ complete: false, confidence: "param" }); // H3: no UI caller, so API → DB only
    expect(byEntry["route:billing:GET /health"]).toMatchObject({ complete: false }); // no db/queue hit: check's "no-store"
    // the inline handler's stop points at its own first line, not line 1 of the file
    expect((byEntry["route:billing:GET /health"] as { stops: Stop[] }).stops[1]).toMatchObject({ kind: "handler", symbol: "GET /health", line: 10 });

    expect(byEntry["consumer:billing:invoice.created#src/events.ts#startConsumer"]).toMatchObject({ complete: false, name: "consume invoice.created · startConsumer" }); // ack-only, no store
    const emails = byEntry["consumer:billing:emails#src/notify-consumer.ts#handleEmail"] as { stops: Stop[] };
    expect(emails).toMatchObject({ complete: false, confidence: "exact", name: "consume emails · handleEmail" }); // named handler -> email_logs insert; H3: no UI stop, so API → DB only
    // Only the guessed hops at store sites are dropped: no false invoices hit through a same-named method.
    expect(emails.stops.filter((s) => s.lane === "db" || s.kind === "publish").map((s) => `${s.op} ${s.label}`)).toEqual(["insert email_logs"]);
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
    // Method stops point at the method itself, not at its class (the graph has no method nodes).
    const ctrl = readFileSync(join(root, "api", "app", "controllers", "customers_controller.ts"), "utf8").split("\n");
    expect(create.find((s) => s.kind === "handler")!.line).toBe(ctrl.findIndex((l) => l.includes("async store(")) + 1);
    const svc = readFileSync(join(root, "api", "app", "services", "customer_service.ts"), "utf8").split("\n");
    expect(create.find((s) => s.kind === "function" && s.lane === "code")!.line).toBe(svc.findIndex((l) => l.includes("async create(")) + 1);
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
      "insert email_logs", // the paired consumer's store (final review batch 2, item A)
    ]);
  });

  it("publish stops continue into their paired consumers (final review batch 2, item A)", async () => {
    const root = workspace();
    await runIndex(root);
    const { chains } = readChains(root);
    const stopsOf = (entry: string) => (chains.find((c) => c.entry === entry)! as { stops: Stop[] }).stops;
    const brief = (stops: Stop[]) => stops.map((s) => `${s.kind}:${(s.label as string | undefined) ?? s.symbol}:${s.hop.confidence}`);
    // topic wildcard: billing/invoice.paid -> bind(emails, billing, "invoice.*") -> consume emails = param
    const pay = stopsOf("route:billing:POST /billing/invoices/:id/pay");
    expect(brief(pay.slice(pay.findIndex((s) => s.kind === "consume")))).toEqual([
      "consume:emails:param",
      "handler:handleEmail:param",
      "db:email_logs:param",
    ]);
    expect(pay.find((s) => s.kind === "consume")!.hop.reason).toBe("topic wildcard binding");
    // exact: sendToQueue("invoice.created") -> consume("invoice.created", inline ack) — no handler stop, no store
    const invoices = stopsOf("page:web:/invoices/new");
    expect(brief(invoices.slice(invoices.findIndex((s) => s.kind === "consume")))).toEqual(["consume:invoice.created:exact"]);
    expect(chains.find((c) => c.entry === "page:web:/invoices/new")).toMatchObject({ confidence: "exact", complete: true });
  });

  it("creates an empty journeys.json alongside chains.json", async () => {
    const root = workspace();
    await runIndex(root);
    expect(JSON.parse(readFileSync(join(root, ".codeloom", "journeys.json"), "utf8"))).toEqual({ version: 1, journeys: [] });
  });

  it("is byte-identical on a second run with a cold cache (fingerprints.json deleted)", async () => {
    const root = workspace();
    await runIndex(root);
    const chainsBefore = readFileSync(join(root, ".codeloom", "chains.json"), "utf8");
    const journeysBefore = readFileSync(join(root, ".codeloom", "journeys.json"), "utf8");
    const repoFiles = (repo: string) => readdirSync(join(root, repo, ".codeloom")).filter((f) => f !== "fingerprints.json").sort();
    const before = Object.fromEntries(["api", "billing", "web"].flatMap((r) => repoFiles(r).map((f) => [`${r}/${f}`, readFileSync(join(root, r, ".codeloom", f), "utf8")])));
    for (const repo of ["api", "billing", "web"]) rmSync(join(root, repo, ".codeloom", "fingerprints.json"));
    const second = await runIndex(root);
    expect(second.linker.wrote).toBe(false);
    expect(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).toBe(chainsBefore);
    expect(readFileSync(join(root, ".codeloom", "journeys.json"), "utf8")).toBe(journeysBefore);
    for (const [key, text] of Object.entries(before)) {
      const [repo, f] = key.split("/");
      expect(readFileSync(join(root, repo!, ".codeloom", f!), "utf8")).toBe(text);
    }
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
