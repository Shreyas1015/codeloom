import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatIndexSummary, runIndex } from "../src/commands/index-cmd.js";
import { materializeFixture } from "./helpers.js";

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

    expect(ep.web!.pages.map((p) => p.route)).toEqual(["/customers/:id", "/customers/new"]);
    expect(ep.web!.httpCalls.map((c) => `${c.method} ${c.path} @${c.at.symbol}`)).toEqual([
      "GET /api/customers/:id @getCustomer",
      "POST /api/customers @useCreateCustomer",
    ]);

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
      "GET /health -> GET /health",
    ]);
    expect(ep.billing!.dbAccess.map((a) => `${a.op} ${a.table} @${a.at.symbol}`)).toEqual(["insert invoices @createInvoice"]);
    expect(ep.billing!.queues.map((q) => `${q.op} ${q.queue}`)).toEqual(["publish invoice.created", "consume invoice.created"]);
    expect(ep.billing!.tables.map((t) => t.name)).toEqual(["invoices", "Payment"]);
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

  it("prints a readable summary", async () => {
    const text = formatIndexSummary(await runIndex(workspace()));
    expect(text).toContain("api");
    expect(text).toMatch(/routes/);
    expect(text).toMatch(/3 repos indexed/);
  });
});
