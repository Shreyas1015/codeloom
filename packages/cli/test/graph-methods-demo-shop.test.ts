import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeGraphSchema } from "@codeloom/core";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { graphLevel } from "../src/web/api.js";
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

const C = "app/controllers/customers_controller.ts";
const S = "app/services/customer_service.ts";
const read = (root: string, repo: string) => readFileSync(join(root, repo, ".codeloom", "graph.json"), "utf8");

describe("graph.json method nodes on demo-shop (v0.2a §1)", () => {
  it("has the controller method node with an exact calls edge to the service method, and parses as a KnowledgeGraph", async () => {
    const root = workspace();
    await runIndex(root);
    const graph = KnowledgeGraphSchema.parse(JSON.parse(read(root, "api")));
    expect(graph.nodes.find((n) => n.id === `function:${C}:CustomersController.store`)).toMatchObject({ type: "function", tags: ["method"] });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: `function:${C}:CustomersController.store`, target: `function:${S}:CustomerService.create`, type: "calls", description: "exact", weight: 1,
    }));
    // new-member hop: new CustomerService().find
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: `function:${C}:CustomersController.show`, target: `function:${S}:CustomerService.find`, type: "calls",
    }));
    for (const repo of ["billing", "web"]) expect(() => KnowledgeGraphSchema.parse(JSON.parse(read(root, repo)))).not.toThrow();
    // no edge from a guess anywhere
    for (const repo of ["api", "billing", "web"]) {
      const g = JSON.parse(read(root, repo)) as { edges: Array<{ type: string; description?: string }> };
      expect(g.edges.filter((e) => e.type === "calls" && e.description === "guess")).toEqual([]);
    }
    // every JS/TS calls edge carries the resolver's confidence (tree-sitter edges included)
    for (const repo of ["api", "billing", "web"]) {
      const g = JSON.parse(read(root, repo)) as { edges: Array<{ type: string; source: string; description?: string }> };
      const js = g.edges.filter((e) => e.type === "calls" && /\.(m|c)?(t|j)sx?:/.test(e.source));
      for (const e of js) expect(["exact", "param"], `${repo} ${e.source}`).toContain(e.description);
    }
  });

  it("lists methods on the Map's file cards (GraphLevel.files[].functions)", async () => {
    const root = workspace();
    await runIndex(root);
    const graph = KnowledgeGraphSchema.parse(JSON.parse(read(root, "api")));
    const level = graphLevel({ id: "api", graph }, { chains: [], journeys: [] }, "app/services");
    const card = level.files.find((f) => f.path === S)!;
    expect(card.functions.map((f) => f.name)).toEqual(["CustomerService", "CustomerService.create", "CustomerService.find"]);
    expect(card.functions.find((f) => f.name === "CustomerService.create")).toMatchObject({ type: "function", ref: `api::function:${S}:CustomerService.create`, line: 5 });
  });

  it("points the handler chain stop at the method node", async () => {
    const root = workspace();
    await runIndex(root);
    const { chains } = JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")) as {
      chains: Array<{ entry: string; stops: Array<{ kind: string; repo: string; symbol: string; nodeId?: string }> }>;
    };
    const chain = chains.find((c) => c.entry === "page:web:/customers/new")!;
    const handler = chain.stops.find((s) => s.kind === "handler" && s.repo === "api")!;
    expect(handler).toMatchObject({ symbol: "CustomersController.store", nodeId: `function:${C}:CustomersController.store` });
    const service = chain.stops.find((s) => s.repo === "api" && s.symbol === "CustomerService.create");
    if (service) expect(service.nodeId).toBe(`function:${S}:CustomerService.create`);
  });

  it("writes byte-identical graph.json warm and cold", async () => {
    const root = workspace();
    await runIndex(root);
    const cold = ["api", "billing", "web"].map((r) => read(root, r));
    await runIndex(root); // warm: every file from the cache
    expect(["api", "billing", "web"].map((r) => read(root, r))).toEqual(cold);
    for (const r of ["api", "billing", "web"]) rmSync(join(root, r, ".codeloom", "fingerprints.json"));
    await runIndex(root); // cold again
    expect(["api", "billing", "web"].map((r) => read(root, r))).toEqual(cold);
  });
});
