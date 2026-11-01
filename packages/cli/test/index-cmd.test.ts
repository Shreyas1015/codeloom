import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatIndexSummary, runIndex } from "../src/commands/index-cmd.js";
import { commitAll, makeRepo, materializeFixture } from "./helpers.js";

function workspace() {
  const root = materializeFixture("demo-shop");
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  return root;
}

describe("codeloom index on demo-shop", () => {
  it("finds pages, calls, routes, tables, DB access and queues in every repo", async () => {
    const result = await runIndex(workspace());
    const ep = Object.fromEntries(result.repos.map((r) => [r.id, r.endpoints]));

    expect(ep.web!.pages.map((p) => p.route)).toEqual(["/customers/:id", "/customers/new", "/invoices/new"]);
    expect(ep.web!.httpCalls).toHaveLength(3);
    expect(ep.web!.httpCalls.map((c) => `${c.method} ${c.path} @${c.at.symbol}`)).toEqual(expect.arrayContaining([
      "GET /api/customers/:id @getCustomer",
      "POST /api/customers @useCreateCustomer",
      "POST /billing/invoices @createInvoice",
    ]));

    expect(ep.api!.routes.map((r) => `${r.method} ${r.path} -> ${r.handler}`)).toEqual([
      "POST /api/customers -> CustomersController.store",
      "GET /api/customers/:id -> CustomersController.show",
    ]);
    expect(ep.api!.dbAccess.map((a) => `${a.op} ${a.table} @${a.at.symbol}`)).toEqual([
      "insert customers @CustomerService.create",
      "insert audit_logs @CustomerService.create",
      "read customers @CustomerService.find",
    ]);
    expect(ep.api!.tables.map((t) => t.name)).toEqual(["audit_logs", "customers"]);

    expect(ep.billing!.routes.map((r) => `${r.method} ${r.path} -> ${r.handler}`)).toEqual([
      "POST /invoices -> createInvoice",
      "POST /invoices/:id/pay -> payInvoice",
      "GET /health -> GET /health",
    ]);
    expect(ep.billing!.dbAccess).toHaveLength(3);
    expect(ep.billing!.dbAccess.map((a) => `${a.op} ${a.table} @${a.at.symbol}`)).toEqual(expect.arrayContaining([
      "insert invoices @invoiceService.create",
      "update invoices @invoiceService.markPaid",
      "insert email_logs @handleEmail",
    ]));
    expect(ep.billing!.queues).toHaveLength(5);
    expect(ep.billing!.queues.map((q) => `${q.op} ${q.queue}`)).toEqual(expect.arrayContaining([
      "publish invoice.created",
      "consume invoice.created",
      "publish billing:invoice.paid",
      "bind emails",
      "consume emails",
    ]));
    // Plain code-point order (not locale order): uppercase ASCII, then lowercase "e", then lowercase "i".
    expect(ep.billing!.tables.map((t) => t.name)).toEqual(["Payment", "email_logs", "invoices"]);
  });

  it("links files through package.json import aliases", async () => {
    const root = workspace();
    const result = await runIndex(root);
    const api = result.repos.find((r) => r.id === "api")!;
    expect(api.stats.skipped).toEqual([]);
    const { readFileSync } = await import("node:fs");
    const graph = JSON.parse(readFileSync(join(root, "api/.codeloom/graph.json"), "utf8"));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "imports", source: "file:app/controllers/customers_controller.ts", target: "file:app/services/customer_service.ts" }),
    ]));
  });

  it("locates route handlers in their files", async () => {
    const result = await runIndex(workspace());
    const routes = Object.fromEntries(result.repos.map((r) => [r.id, r.endpoints.routes]));
    const store = routes.api!.find((r) => r.handler === "CustomersController.store")!;
    expect(store.handlerFile).toBe("app/controllers/customers_controller.ts");
    expect(routes.api!.find((r) => r.handler === "CustomersController.show")!.handlerFile).toBe("app/controllers/customers_controller.ts");
    const invoice = routes.billing!.find((r) => r.handler === "createInvoice")!;
    expect(invoice.handlerFile).toBe("src/invoices.ts");
    expect(invoice.handlerLines).toBeUndefined();
    const pay = routes.billing!.find((r) => r.handler === "payInvoice")!;
    expect(pay.handlerFile).toBe("src/invoices.ts");
    const health = routes.billing!.find((r) => r.path === "/health")!;
    expect(health).toMatchObject({ inline: true, handlerFile: "src/server.ts", handlerLines: [10, 12] });
    for (const r of [...routes.api!, ...routes.billing!]) expect(r).not.toHaveProperty("handlerImport");
  });

  it("prints a readable summary, including the linker's chain count", async () => {
    const result = await runIndex(workspace());
    const text = formatIndexSummary(result);
    expect(text).toContain("api");
    expect(text).toMatch(/routes/);
    expect(text).toMatch(/3 repos indexed/);
    expect(text).toMatch(/7 chains \(\d+ complete\) written to \.codeloom\/chains\.json/);
  });

  it("returns a linker summary alongside each repo's stats", async () => {
    const result = await runIndex(workspace());
    expect(result.linker.chains).toBe(7);
    expect(result.linker.wrote).toBe(true);
    expect(result.linker.orphanedJourneys).toBe(0);
  });
});

describe("stable repo ids across clones (final review batch 2, item C)", () => {
  it("the same code in shop/ and shop-worktree/ (package.json name 'shop') gives identical chains.json", async () => {
    const billing = fileURLToPath(new URL("../../../fixtures/demo-shop/billing", import.meta.url));
    const parent = mkdtempSync(join(tmpdir(), "codeloom-clone-"));
    const out: string[] = [];
    for (const folder of ["shop", "shop-worktree"]) {
      const repo = makeRepo({}, join(parent, folder));
      cpSync(billing, repo, { recursive: true });
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, name: "shop" }));
      commitAll(repo);
      await runIndex(repo);
      out.push(readFileSync(join(repo, ".codeloom", "chains.json"), "utf8"));
    }
    expect(out[0]).toContain('"route:shop:');
    expect(out[1]).toBe(out[0]);
  });
});
