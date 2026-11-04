import { KnowledgeGraphSchema } from "@codeloom/core";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/indexer/build-graph.js";
import { enrichGraph } from "../src/indexer/enrich-graph.js";
import { analyzeStructure, type FileEntry, getPlugin } from "../src/indexer/structure.js";
import { parseSource } from "../src/adapters/ast.js";
import { buildFileCodeIndex, type RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";

const FILES: Record<string, string> = {
  "app/services/customer_service.ts": `export default class CustomerService {
  async create(payload: { name: string }) {
    return this.save(payload);
  }

  save(payload: { name: string }) {
    return payload;
  }
}
`,
  "app/controllers/customers_controller.ts": `import CustomerService from "../services/customer_service";

export default class CustomersController {
  constructor(private customers: CustomerService) {}

  async store(body: { name: string }) {
    return this.customers.create(body);
  }

  async guessy(x: any) {
    return x.markPaid(1);
  }
}
`,
  "app/services/invoice_service.ts": `export const invoiceService = {
  async create(id: number) {
    return id;
  },
  async markPaid(id: number) {
    return invoiceService.create(id);
  },
};
`,
  "app/lib/helpers.ts": `export function formatName(n: string) {
  return n.trim();
}
export function shout(n: string) {
  return formatName(n).toUpperCase();
}
`,
};

async function setup(files = FILES) {
  const plugin = await getPlugin();
  const entries = new Map<string, FileEntry>();
  const index: RepoCodeIndex = new Map();
  for (const rel of Object.keys(files).sort()) {
    entries.set(rel, analyzeStructure(plugin, rel, files[rel]!));
    index.set(rel, buildFileCodeIndex({ rel, content: files[rel]!, sf: parseSource(rel, files[rel]!) }));
  }
  const graph = buildGraph("api", "", entries, []);
  graph.project.analyzedAt = "";
  const resolver = createCallResolver({ repo: "api", index, files: new Set(Object.keys(files)), aliases: [] });
  return { graph, index, resolver };
}

const C = "app/controllers/customers_controller.ts";
const S = "app/services/customer_service.ts";
const I = "app/services/invoice_service.ts";

describe("enrichGraph", () => {
  it("adds a function node per class method and object-literal method, with contains edges", async () => {
    const { graph, index, resolver } = await setup();
    const out = enrichGraph(graph, index, resolver);
    const store = out.nodes.find((n) => n.id === `function:${C}:CustomersController.store`);
    expect(store).toMatchObject({ type: "function", name: "CustomersController.store", filePath: C, lineRange: [6, 8], summary: "", tags: ["method"], complexity: "simple" });
    expect(out.nodes.some((n) => n.id === `function:${I}:invoiceService.markPaid`)).toBe(true);
    expect(out.edges).toContainEqual({ source: `file:${C}`, target: `function:${C}:CustomersController.store`, type: "contains", direction: "forward", weight: 1 });
    expect(out.edges).toContainEqual({ source: `class:${C}:CustomersController`, target: `function:${C}:CustomersController.store`, type: "contains", direction: "forward", weight: 1 });
    // no class node for an object literal: only the file contains it
    expect(out.edges.filter((e) => e.target === `function:${I}:invoiceService.markPaid`).map((e) => e.source)).toEqual([`file:${I}`]);
  });

  it("adds exact calls edges between methods (DI, this, object) and none for a guessed call", async () => {
    const { graph, index, resolver } = await setup();
    const out = enrichGraph(graph, index, resolver);
    const calls = out.edges.filter((e) => e.type === "calls");
    expect(calls).toContainEqual({
      source: `function:${C}:CustomersController.store`, target: `function:${S}:CustomerService.create`,
      type: "calls", direction: "forward", weight: 1, description: "exact",
    });
    expect(calls).toContainEqual(expect.objectContaining({ source: `function:${S}:CustomerService.create`, target: `function:${S}:CustomerService.save`, description: "exact" }));
    expect(calls).toContainEqual(expect.objectContaining({ source: `function:${I}:invoiceService.markPaid`, target: `function:${I}:invoiceService.create` }));
    // x.markPaid(1) on an untyped receiver can only be a guess: never an edge
    const site = index.get(C)!.calls.find((s) => s.caller === "CustomersController.guessy")!;
    expect(resolver.resolve(C, site)).toMatchObject({ confidence: "guess", target: { symbol: "invoiceService.markPaid" } });
    expect(calls.some((e) => e.source === `function:${C}:CustomersController.guessy`)).toBe(false);
  });

  it("keeps existing nodes and edges, does not duplicate an existing calls edge, and parses as a KnowledgeGraph", async () => {
    const { graph, index, resolver } = await setup();
    const before = structuredClone(graph);
    const out = enrichGraph(graph, index, resolver);
    expect(out.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
    expect(out.edges.slice(0, before.edges.length)).toEqual(before.edges);
    expect(graph).toEqual(before); // input not mutated
    const H = "app/lib/helpers.ts";
    const shout = out.edges.filter((e) => e.type === "calls" && e.source === `function:${H}:shout` && e.target === `function:${H}:formatName`);
    expect(shout).toHaveLength(1);
    expect(() => KnowledgeGraphSchema.parse(out)).not.toThrow();
    expect(out.layers).toEqual(before.layers);
  });

  it("is deterministic and idempotent", async () => {
    const a = await setup();
    const b = await setup();
    const once = enrichGraph(a.graph, a.index, a.resolver);
    expect(JSON.stringify(enrichGraph(b.graph, b.index, b.resolver))).toBe(JSON.stringify(once));
    expect(JSON.stringify(enrichGraph(once, a.index, a.resolver))).toBe(JSON.stringify(once));
  });

  it("collapses duplicate pairs to the best confidence (exact over param)", async () => {
    const { graph, index, resolver } = await setup();
    const fake = {
      ...resolver,
      resolve: (file: string, site: Parameters<typeof resolver.resolve>[1]) => {
        const rc = resolver.resolve(file, site);
        return rc && site.line === 7 && file === C ? { ...rc, confidence: "param" as const } : rc;
      },
    };
    const fi = index.get(C)!;
    const dup = new Map(index);
    dup.set(C, { ...fi, calls: [...fi.calls, ...fi.calls.map((s) => ({ ...s, line: s.line === 7 ? 99 : s.line }))] });
    const out = enrichGraph(graph, dup, fake);
    const edges = out.edges.filter((e) => e.type === "calls" && e.source === `function:${C}:CustomersController.store`);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ description: "exact", weight: 1 });
  });
});
