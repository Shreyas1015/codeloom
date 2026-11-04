import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { createServer } from "../src/mcp/server.js";
import { readSummaries, writeSummary } from "../src/store/summaries.js";
import { materializeFixture } from "./helpers.js";

let demo: string;
let client: Client;
let customerChainIds: string[];
let createChainId: string;
const JOURNEY_ID = "j_00000000c0de";

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sc(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent;
}
function text(r: CallToolResult): string {
  const item = r.content[0];
  if (item?.type !== "text") throw new Error("expected a text item");
  return item.text;
}

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string }>;
  createChainId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  customerChainIds = chains.filter((c) => c.routeKey.startsWith("api:")).map((c) => c.id).sort();
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({ version: 1, journeys: [{ id: JOURNEY_ID, name: "Sign up a customer", area: "customers", note: "", chainIds: [createChainId], status: "ok" }] }),
  );
  const server = createServer({ start: demo });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
}, 60_000);

describe("store/summaries", () => {
  it("reads {} when missing, writes sorted keys, is idempotent, and empty text deletes the key", () => {
    const repo = mkdtempSync(join(tmpdir(), "codeloom-sum-"));
    expect(readSummaries(repo)).toEqual({});
    expect(writeSummary(repo, "file:b.ts", "B")).toBe(true);
    expect(writeSummary(repo, "file:a.ts", "A")).toBe(true);
    const raw = readFileSync(join(repo, ".codeloom", "summaries.json"), "utf8");
    expect(raw).toBe(JSON.stringify({ version: 1, summaries: { "file:a.ts": "A", "file:b.ts": "B" } }, null, 2) + "\n");
    expect(writeSummary(repo, "file:a.ts", "A")).toBe(false);
    expect(writeSummary(repo, "file:a.ts", "")).toBe(true);
    expect(readSummaries(repo)).toEqual({ "file:b.ts": "B" });
  });

  it("does not create the file when deleting a key from nothing", () => {
    const repo = mkdtempSync(join(tmpdir(), "codeloom-sum-"));
    expect(writeSummary(repo, "file:a.ts", "")).toBe(false);
    expect(existsSync(join(repo, ".codeloom", "summaries.json"))).toBe(false);
  });

  it("a bad summaries.json is a CodeloomError", () => {
    const repo = mkdtempSync(join(tmpdir(), "codeloom-sum-"));
    writeSummary(repo, "file:a.ts", "A");
    writeFileSync(join(repo, ".codeloom", "summaries.json"), JSON.stringify({ version: 2, summaries: {} }));
    expect(() => readSummaries(repo)).toThrow(CodeloomError);
  });
});

describe("search", () => {
  it("one query finds a function, a page and a table", async () => {
    const r = await sc("search", { query: "customer", limit: 100 });
    const refs = r.results.map((x: { ref: string }) => x.ref);
    expect(refs).toContain("web::function:lib/get-customer.ts:getCustomer");
    expect(refs).toContain("page:web:/customers/new");
    expect(refs).toContain("table:api:customers");
    const fn = r.results.find((x: { ref: string }) => x.ref === "web::function:lib/get-customer.ts:getCustomer");
    expect(fn).toMatchObject({ kind: "function", name: "getCustomer", repo: "web", file: "lib/get-customer.ts", line: 1 });
    const page = r.results.find((x: { ref: string }) => x.ref === "page:web:/customers/new");
    expect(page).toMatchObject({ kind: "page", name: "/customers/new", repo: "web", file: "app/customers/new/page.tsx" });
    expect(r.truncated).toBe(false);
  });

  it("is sorted by score then ref", async () => {
    const r = await sc("search", { query: "customer", limit: 100 });
    for (let i = 1; i < r.results.length; i++) {
      const a = r.results[i - 1];
      const b = r.results[i];
      expect(a.score < b.score || (a.score === b.score && a.ref < b.ref)).toBe(true);
    }
  });

  it("finds routes (mounted routeKey), queues, chains and journeys", async () => {
    const routes = await sc("search", { query: "invoices", kinds: ["route"] });
    expect(routes.results.map((x: { ref: string }) => x.ref)).toContain("route:billing:POST /billing/invoices");
    const queues = await sc("search", { query: "emails", kinds: ["queue"] });
    expect(queues.results.map((x: { ref: string }) => x.ref)).toEqual(["queue:billing:emails"]);
    const journeys = await sc("search", { query: "Sign up", kinds: ["journey"] });
    expect(journeys.results.map((x: { ref: string }) => x.ref)).toEqual([JOURNEY_ID]);
    const chains = await sc("search", { query: "NewCustomerPage", kinds: ["chain"] });
    expect(chains.results.map((x: { ref: string }) => x.ref)).toContain(createChainId);
  });

  it("kinds filter keeps only those kinds; repo filter keeps only that repo", async () => {
    const r = await sc("search", { query: "customer", kinds: ["table"] });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((x: { kind: string }) => x.kind === "table")).toBe(true);
    const web = await sc("search", { query: "customer", repo: "web", limit: 100 });
    expect(web.results.length).toBeGreaterThan(0);
    expect(web.results.every((x: { repo?: string }) => x.repo === undefined || x.repo === "web")).toBe(true);
    expect(web.results.map((x: { ref: string }) => x.ref)).not.toContain("table:api:customers");
  });

  it("limit caps the list and says truncated", async () => {
    const r = await sc("search", { query: "customer", limit: 1 });
    expect(r.results).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("an unknown repo is a tool error; an empty query is rejected", async () => {
    expect((await call("search", { query: "x", repo: "nope" })).isError).toBe(true);
    expect((await call("search", { query: "" })).isError).toBe(true);
  });
});

describe("get_node", () => {
  it("a handler shows its node, edges, chains and journeys", async () => {
    const ref = "api::class:app/controllers/customers_controller.ts:CustomersController";
    const r = await sc("get_node", { node: ref });
    expect(r.ref).toBe(ref);
    expect(r.node).toMatchObject({ type: "class", name: "CustomersController", filePath: "app/controllers/customers_controller.ts", lineRange: [6, 17] });
    expect(r.node.layer).toBe("layer:api-layer");
    expect(r.summary).toBeNull();
    expect(r.edges.in).toEqual([{ type: "contains", source: "api::file:app/controllers/customers_controller.ts" }]);
    // v0.2a §1: the class contains its method nodes
    expect(r.edges.out).toEqual([
      { type: "contains", target: "api::function:app/controllers/customers_controller.ts:CustomersController.show" },
      { type: "contains", target: "api::function:app/controllers/customers_controller.ts:CustomersController.store" },
    ]);
    expect(r.chains).toEqual(customerChainIds);
    expect(r.journeys).toEqual([{ id: JOURNEY_ID, name: "Sign up a customer" }]);
  });

  it("bad or unknown refs are tool errors", async () => {
    const bad = await call("get_node", { node: "no-separator" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Bad node reference/);
    const unknown = await call("get_node", { node: "api::function:nope" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Unknown node/);
  });
});

describe("get_neighbors", () => {
  const root = "api::file:app/controllers/customers_controller.ts";

  it("depth 2 is a deterministic BFS sorted by depth then ref", async () => {
    const r = await sc("get_neighbors", { node: root, depth: 2 });
    expect(r.root).toBe(root);
    expect(r.truncated).toBe(false);
    expect(r.neighbors).toEqual([
      { ref: "api::class:app/controllers/customers_controller.ts:CustomersController", name: "CustomersController", type: "class", depth: 1, via: { type: "contains", direction: "out" } },
      { ref: "api::file:app/services/customer_service.ts", name: "customer_service.ts", type: "file", depth: 1, via: { type: "imports", direction: "out" } },
      // v0.2a §1: method nodes, and the service methods they call
      { ref: "api::function:app/controllers/customers_controller.ts:CustomersController.show", name: "CustomersController.show", type: "function", depth: 1, via: { type: "contains", direction: "out" } },
      { ref: "api::function:app/controllers/customers_controller.ts:CustomersController.store", name: "CustomersController.store", type: "function", depth: 1, via: { type: "contains", direction: "out" } },
      { ref: "api::class:app/services/customer_service.ts:CustomerService", name: "CustomerService", type: "class", depth: 2, via: { type: "contains", direction: "out" } },
      { ref: "api::file:app/models/customer.ts", name: "customer.ts", type: "file", depth: 2, via: { type: "imports", direction: "out" } },
      { ref: "api::function:app/services/customer_service.ts:CustomerService.create", name: "CustomerService.create", type: "function", depth: 2, via: { type: "contains", direction: "out" } },
      { ref: "api::function:app/services/customer_service.ts:CustomerService.find", name: "CustomerService.find", type: "function", depth: 2, via: { type: "contains", direction: "out" } },
    ]);
    expect(await sc("get_neighbors", { node: root, depth: 2 })).toEqual(r);
  });

  it("direction, edgeTypes and limit", async () => {
    const inn = await sc("get_neighbors", { node: "api::file:app/services/customer_service.ts", direction: "in" });
    expect(inn.neighbors).toEqual([
      { ref: root, name: "customers_controller.ts", type: "file", depth: 1, via: { type: "imports", direction: "in" } },
    ]);
    const imports = await sc("get_neighbors", { node: root, depth: 3, edgeTypes: ["imports"] });
    expect(imports.neighbors.map((n: { ref: string }) => n.ref)).toEqual(["api::file:app/services/customer_service.ts", "api::file:app/models/customer.ts"]);
    const capped = await sc("get_neighbors", { node: root, depth: 2, limit: 1 });
    expect(capped.neighbors).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("depth over 3 is rejected", async () => {
    expect((await call("get_neighbors", { node: root, depth: 4 })).isError).toBe(true);
  });
});

describe("explain_context", () => {
  it("returns the node's code lines with neighbors, chains and journeys", async () => {
    const ref = "api::class:app/services/customer_service.ts:CustomerService";
    const r = await sc("explain_context", { node: ref });
    expect(r.ref).toBe(ref);
    expect(r.node).toMatchObject({ type: "class", name: "CustomerService" });
    expect(r.layer).toBe("layer:service-layer");
    expect(r.code).toMatchObject({ file: "app/services/customer_service.ts", startLine: 4, endLine: 14, truncated: false });
    const lines = readFileSync(join(demo, "api", "app/services/customer_service.ts"), "utf8").split("\n");
    expect(r.code.text).toBe(lines.slice(3, 14).join("\n"));
    expect(r.code.text).toMatch(/class CustomerService/);
    expect(r.neighbors.map((n: { ref: string }) => n.ref)).toEqual([
      "api::file:app/services/customer_service.ts",
      "api::function:app/services/customer_service.ts:CustomerService.create",
      "api::function:app/services/customer_service.ts:CustomerService.find",
    ]);
    expect(r.chains).toEqual(customerChainIds);
    expect(r.journeys).toEqual([{ id: JOURNEY_ID, name: "Sign up a customer" }]);
  });

  it("a file node gives the whole file, cut at maxChars with truncated: true", async () => {
    const file = join(demo, "api", "app/models/customer.ts");
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, original + Array.from({ length: 40 }, (_, i) => `// filler line ${i} ${"x".repeat(60)}`).join("\n") + "\n");
      const r = await sc("explain_context", { node: "api::file:app/models/customer.ts", maxChars: 1000 });
      expect(r.code.startLine).toBe(1);
      expect(r.code.truncated).toBe(true);
      expect(r.code.text.length).toBeLessThanOrEqual(1000);
      expect(r.code.text.startsWith(original.slice(0, 50))).toBe(true);
      expect(r.code.endLine).toBe(r.code.text.split("\n").length);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("a missing source file gives code: null with a reason", async () => {
    const file = join(demo, "api", "app/models/customer.ts");
    renameSync(file, file + ".bak");
    try {
      const r = await sc("explain_context", { node: "api::class:app/models/customer.ts:Customer" });
      expect(r.code).toBeNull();
      expect(r.codeUnavailable).toMatch(/app\/models\/customer\.ts/);
    } finally {
      renameSync(file + ".bak", file);
    }
  });

  it("maxChars below 1000 is rejected", async () => {
    expect((await call("explain_context", { node: "api::file:app/models/customer.ts", maxChars: 10 })).isError).toBe(true);
  });
});

describe("save_summary", () => {
  const path = () => join(demo, "api", ".codeloom", "summaries.json");
  const svc = "api::class:app/services/customer_service.ts:CustomerService";
  const ctl = "api::class:app/controllers/customers_controller.ts:CustomersController";

  it("writes sorted, is idempotent, shows in get_node and search, and empty text removes", async () => {
    expect(await sc("save_summary", { node: svc, summary: "Creates and finds customers." })).toEqual({ ref: svc, saved: true, removed: false });
    expect(await sc("save_summary", { node: ctl, summary: "HTTP handlers for customers." })).toEqual({ ref: ctl, saved: true, removed: false });
    const raw = readFileSync(path(), "utf8");
    expect(raw).toBe(
      JSON.stringify(
        {
          version: 1,
          summaries: {
            "class:app/controllers/customers_controller.ts:CustomersController": "HTTP handlers for customers.",
            "class:app/services/customer_service.ts:CustomerService": "Creates and finds customers.",
          },
        },
        null,
        2,
      ) + "\n",
    );
    expect(await sc("save_summary", { node: svc, summary: "Creates and finds customers." })).toEqual({ ref: svc, saved: false, removed: false });
    expect(readFileSync(path(), "utf8")).toBe(raw);

    expect((await sc("get_node", { node: svc })).summary).toBe("Creates and finds customers.");
    expect((await sc("explain_context", { node: svc })).summary).toBe("Creates and finds customers.");
    const found = await sc("search", { query: "handlers", kinds: ["class"] });
    expect(found.results.map((x: { ref: string }) => x.ref)).toContain(ctl);

    expect(await sc("save_summary", { node: ctl, summary: "" })).toEqual({ ref: ctl, saved: false, removed: true });
    expect(Object.keys(readSummaries(join(demo, "api")))).toEqual(["class:app/services/customer_service.ts:CustomerService"]);
    expect(await sc("save_summary", { node: ctl, summary: "" })).toEqual({ ref: ctl, saved: false, removed: false });
  });

  it("an invalid node ref or an over-long summary is a tool error and leaves the file untouched", async () => {
    await sc("save_summary", { node: svc, summary: "Creates and finds customers." });
    const before = readFileSync(path(), "utf8");
    for (const args of [
      { node: "nope", summary: "x" },
      { node: "api::function:nope", summary: "x" },
      { node: "ghost::file:a.ts", summary: "x" },
      { node: svc, summary: "x".repeat(4001) },
    ]) {
      const r = await call("save_summary", args);
      expect(r.isError).toBe(true);
    }
    expect(readFileSync(path(), "utf8")).toBe(before);
    expect(existsSync(join(demo, "web", ".codeloom", "summaries.json"))).toBe(false);
  });
});
