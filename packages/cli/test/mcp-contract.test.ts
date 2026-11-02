// End-to-end MCP contract: every tool in the v0.1 catalogue, called over InMemoryTransport against a
// freshly indexed demo-shop. Each tool is called once with valid input (the result must validate
// against a strict zod schema of the documented result object, and structuredContent must equal the
// parsed text) and once with invalid input (isError, and no file under the workspace changes).
// tools/list must equal the catalogue exactly, so a new tool has to be documented here first.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runIndex } from "../src/commands/index-cmd.js";
import { runInit } from "../src/commands/init.js";
import { createServer } from "../src/mcp/server.js";
import {
  CheckReportSchema,
  ConfidenceSchema,
  EndpointsFileSchema,
  JourneySchema,
  LaneSchema,
  StopKindSchema,
  UnresolvedSchema,
} from "../src/store/schemas.js";
import { commitAll, materializeFixture } from "./helpers.js";
import { CATALOGUE } from "./mcp-catalogue.js";

const REPOS = ["api", "billing", "web"];

// ---- result schemas (strict: an undocumented field fails the contract) --------------------------

const int = z.number().int();
const str = z.string();

const StopView = z
  .object({
    lane: LaneSchema,
    kind: StopKindSchema,
    repo: str,
    file: str,
    line: int.positive(),
    symbol: str,
    label: str.optional(),
    op: str.optional(),
    confidence: ConfidenceSchema,
    reason: str.optional(),
    ref: str.regex(/^[^:]+::.+$/).optional(),
    from: int.nonnegative().optional(),
  })
  .strict();

const ChainView = z
  .object({
    id: str.regex(/^ch_[0-9a-f]{12}$/),
    name: str,
    entry: str,
    routeKey: str,
    confidence: ConfidenceSchema,
    complete: z.boolean(),
    journeys: z.array(str),
    stops: z.array(StopView),
    unresolved: z.array(UnresolvedSchema.strict()),
  })
  .strict();

const JourneyRef = z.object({ id: str.regex(/^j_[0-9a-f]{12}$/), name: str }).strict();
const NodeView = z
  .object({ type: str, name: str, filePath: str.optional(), lineRange: z.tuple([int, int]).optional(), layer: str.optional() })
  .strict();
const Neighbor = z
  .object({
    ref: str,
    name: str,
    type: str,
    depth: int.min(1).max(3),
    via: z.object({ type: str, direction: z.enum(["in", "out"]) }).strict(),
  })
  .strict();

const Schemas: Record<string, z.ZodType> = {
  workspace_overview: z
    .object({
      name: str,
      repos: z.array(
        z
          .object({
            id: str,
            path: str,
            role: str.optional(),
            files: int,
            nodes: int,
            edges: int,
            pages: int,
            routes: int,
            calls: int,
            tables: int,
            queues: int,
          })
          .strict(),
      ),
      chains: z.object({ total: int, complete: int, byConfidence: z.object({ exact: int, param: int, guess: int }).strict() }).strict(),
      journeys: z.object({ total: int, orphaned: int }).strict(),
      unnamedChains: int,
    })
    .strict(),
  index_status: z
    .object({
      repos: z.array(
        z
          .object({ id: str, head: str, indexedCommit: str.nullable(), stale: z.boolean(), changedFiles: z.array(str).max(50), truncated: z.boolean() })
          .strict(),
      ),
    })
    .strict(),
  reindex: z
    .object({
      root: str,
      repos: z.array(
        z
          .object({
            id: str,
            stats: z
              .object({ files: int, parsed: int, reused: int, skipped: z.array(z.object({ file: str, reason: str }).strict()) })
              .strict(),
            endpoints: EndpointsFileSchema,
          })
          .strict(),
      ),
      linker: z.object({ chains: int, complete: int, orphanedJourneys: int, wrote: z.boolean() }).strict(),
    })
    .strict(),
  get_layers: z
    .object({
      repos: z.array(
        z
          .object({ id: str, layers: z.array(z.object({ id: str, name: str, description: str, nodeCount: int }).strict()) })
          .strict(),
      ),
    })
    .strict(),
  search: z
    .object({
      results: z.array(
        z
          .object({
            kind: z.enum(["file", "function", "class", "route", "page", "table", "queue", "journey", "chain"]),
            ref: str,
            name: str,
            repo: str.optional(),
            file: str.optional(),
            line: int.optional(),
            score: z.number(),
          })
          .strict(),
      ),
      truncated: z.boolean(),
    })
    .strict(),
  get_node: z
    .object({
      ref: str,
      node: NodeView,
      summary: str.nullable(),
      edges: z
        .object({
          out: z.array(z.object({ type: str, target: str }).strict()).max(100),
          in: z.array(z.object({ type: str, source: str }).strict()).max(100),
          truncated: z.boolean(),
        })
        .strict(),
      chains: z.array(str),
      journeys: z.array(JourneyRef),
    })
    .strict(),
  get_neighbors: z.object({ root: str, neighbors: z.array(Neighbor), truncated: z.boolean() }).strict(),
  explain_context: z
    .object({
      ref: str,
      node: NodeView,
      summary: str.nullable(),
      layer: str.nullable(),
      code: z.object({ file: str, startLine: int, endLine: int, text: str, truncated: z.boolean() }).strict().nullable(),
      codeUnavailable: str.optional(),
      neighbors: z.array(Neighbor).max(30),
      neighborsTruncated: z.boolean(),
      chains: z.array(str),
      journeys: z.array(JourneyRef),
    })
    .strict(),
  save_summary: z.object({ ref: str, saved: z.boolean(), removed: z.boolean() }).strict(),
  list_chains: z.object({ total: int, chains: z.array(ChainView), truncated: z.boolean() }).strict(),
  get_journey: z
    .object({
      journey: JourneySchema.strict().nullable(),
      chains: z.array(ChainView),
      lanes: z.object({ ui: z.array(StopView), api: z.array(StopView), code: z.array(StopView), db: z.array(StopView), queue: z.array(StopView) }).strict(),
      files: z.array(str),
      tables: z.array(str),
      queues: z.array(str),
      unresolved: z.array(UnresolvedSchema.extend({ chainId: str }).strict()),
      missingChainIds: z.array(str),
    })
    .strict(),
  trace_route: z
    .object({
      from: str,
      matches: z.array(z.object({ chainId: str, name: str, stops: z.array(StopView) }).strict()).max(50),
      truncated: z.boolean(),
    })
    .strict(),
  save_journeys: z
    .object({ journeys: z.array(JourneySchema.strict()), created: z.array(str), updated: z.array(str), deleted: z.array(str) })
    .strict(),
  check_chains: CheckReportSchema.strict(),
  impact_of_diff: z
    .object({
      range: str.nullable(),
      repos: z.array(
        z
          .object({
            id: str,
            changedFiles: z.array(str),
            changedFilesTruncated: z.boolean(),
            changedNodes: z.array(str),
            changedNodesTruncated: z.boolean(),
          })
          .strict(),
      ),
      chains: z.array(str),
      chainsTruncated: z.boolean(),
      journeys: z.array(JourneyRef),
      tables: z.array(str),
      queues: z.array(str),
      skippedRepos: z.array(z.object({ id: str, reason: str }).strict()),
      notes: z.array(str),
      truncated: z.boolean(),
    })
    .strict(),
};

// ---- fixture helpers -----------------------------------------------------------------------------

/** demo-shop, set up and indexed with every repo committed (nothing stale). */
async function indexedShop(): Promise<string> {
  const root = materializeFixture("demo-shop");
  runInit(root);
  for (const r of REPOS) commitAll(join(root, r));
  await runIndex(root);
  return root;
}

/** A fresh copy of the shop for a test that writes. Hooks are re-pointed at the copy. */
function copyShop(src: string): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-contract-"));
  cpSync(src, root, { recursive: true });
  for (const r of REPOS) {
    const hook = join(root, r, ".git", "hooks", "post-commit");
    if (existsSync(hook)) writeFileSync(hook, readFileSync(hook, "utf8").split(src).join(root));
  }
  return root;
}

/** sha1 + mode of every file under root (including .git), keyed by relative path. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[p.slice(root.length)] = createHash("sha1").update(readFileSync(p)).digest("hex") + statSync(p).mode;
    }
  };
  walk(root);
  return out;
}

async function connect(start: string): Promise<Client> {
  const server = createServer({ start });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "contract", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function textOf(r: CallToolResult): string {
  expect(r.content).toHaveLength(1);
  const item = r.content[0];
  if (item?.type !== "text") throw new Error("expected one text item");
  return item.text;
}

/** Call a tool, require success, check the contract, return the result object. */
async function valid(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  const parsed = JSON.parse(textOf(r)) as Record<string, unknown>;
  expect(r.structuredContent).toEqual(parsed);
  const check = Schemas[name]!.safeParse(parsed);
  if (!check.success) throw new Error(`${name} result breaks the contract: ${JSON.stringify(check.error.issues, null, 2)}`);
  return parsed;
}

/** Call a tool with bad input on `root`: isError with a message, and no file under `root` changes. */
async function invalid(client: Client, root: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const before = hashTree(root);
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(r.isError, `${name} ${JSON.stringify(args)} should fail`).toBe(true);
  const msg = textOf(r);
  expect(msg.length).toBeGreaterThan(0);
  expect(r.structuredContent).toBeUndefined();
  expect(hashTree(root)).toEqual(before);
  return msg;
}

// ---- tests -----------------------------------------------------------------------------------------

describe("MCP contract on demo-shop", { timeout: 90_000 }, () => {
  let shop: string;
  let client: Client;
  let empty: string;
  let emptyClient: Client;
  /** One chain id, one graph node ref (a function on a chain), one file ref. */
  let chainId: string;
  let fnRef: string;
  let fileRef: string;

  beforeAll(async () => {
    shop = await indexedShop();
    client = await connect(shop);
    empty = mkdtempSync(join(tmpdir(), "codeloom-contract-empty-"));
    writeFileSync(join(empty, "README.md"), "not a workspace\n");
    emptyClient = await connect(empty);
    const chains = (await valid(client, "list_chains", {})) as { chains: Array<{ id: string; stops: Array<{ ref?: string }> }> };
    const withRef = chains.chains.find((c) => c.stops.some((s) => s.ref?.includes("::function:")))!;
    chainId = withRef.id;
    fnRef = withRef.stops.find((s) => s.ref?.includes("::function:"))!.ref!;
    fileRef = `${fnRef.split("::")[0]}::file:${fnRef.split("::")[1]!.split(":")[1]}`;
  }, 90_000);

  it("tools/list is exactly the catalogue, each with a title and description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CATALOGUE].sort());
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.description, t.name).toBeTruthy();
    }
    expect(Object.keys(Schemas).sort()).toEqual([...CATALOGUE].sort());
  });

  it("valid calls to read-only tools return the documented shape and change no file", async () => {
    const before = hashTree(shop);
    const overview = await valid(client, "workspace_overview");
    expect((overview.repos as unknown[]).length).toBe(3);
    const status = (await valid(client, "index_status")) as { repos: Array<{ stale: boolean; indexedCommit: string | null }> };
    expect(status.repos.map((r) => r.stale)).toEqual([false, false, false]);
    expect((await valid(client, "get_layers")).repos).toHaveLength(3);
    expect((await valid(client, "get_layers", { repo: "demo-api" })).repos).toHaveLength(1);
    expect(((await valid(client, "search", { query: "customer" })).results as unknown[]).length).toBeGreaterThan(0);
    await valid(client, "search", { query: "orders", kinds: ["route", "table", "chain"], limit: 5 });
    const node = (await valid(client, "get_node", { node: fnRef })) as { chains: string[] };
    expect(node.chains).toContain(chainId);
    await valid(client, "get_node", { node: fileRef });
    await valid(client, "get_neighbors", { node: fileRef, direction: "out", depth: 2, limit: 5 });
    const explained = (await valid(client, "explain_context", { node: fnRef })) as { code: { text: string } | null };
    expect(explained.code?.text.length).toBeGreaterThan(0);
    await valid(client, "list_chains", { complete: true, confidence: "exact", unnamed: true, limit: 2, offset: 1 });
    const journey = (await valid(client, "get_journey", { id: chainId })) as { journey: unknown; chains: unknown[] };
    expect(journey.journey).toBeNull();
    expect(journey.chains).toHaveLength(1);
    const traced = (await valid(client, "trace_route", { from: fnRef })) as { matches: Array<{ chainId: string }> };
    expect(traced.matches.map((m) => m.chainId)).toContain(chainId);
    await valid(client, "trace_route", { from: "GET /api/customers" });
    await valid(client, "check_chains");
    await valid(client, "check_chains", { traces: true }); // no trace source → { skipped }
    const impact = (await valid(client, "impact_of_diff")) as { chains: string[] };
    expect(impact.chains).toEqual([]);
    await valid(client, "impact_of_diff", { range: "HEAD" });
    expect(hashTree(shop)).toEqual(before);
  });

  it("reindex: valid call returns the IndexRunResult; un-indexed folder is an error and writes nothing", async () => {
    const root = copyShop(shop);
    const c = await connect(root);
    const r = (await valid(c, "reindex")) as { repos: unknown[] };
    expect(r.repos).toHaveLength(3);
    await invalid(emptyClient, empty, "reindex");
  });

  it("save_summary: valid call writes summaries.json; invalid input writes nothing", async () => {
    const root = copyShop(shop);
    const c = await connect(root);
    expect(await valid(c, "save_summary", { node: fnRef, summary: "Handles it." })).toEqual({ ref: fnRef, saved: true, removed: false });
    expect(((await valid(c, "get_node", { node: fnRef })) as { summary: string }).summary).toBe("Handles it.");
    expect(await valid(c, "save_summary", { node: fnRef, summary: "" })).toEqual({ ref: fnRef, saved: false, removed: true });
    const [repo] = fnRef.split("::");
    await invalid(c, root, "save_summary", { node: `${repo}::function:nope.ts:ghost`, summary: "x" });
    await invalid(c, root, "save_summary", { node: fnRef, summary: "x".repeat(4001) });
    await invalid(c, root, "save_summary", { node: "no-separator", summary: "x" });
  });

  it("save_journeys: valid ops write journeys.json; invalid ops write nothing", async () => {
    const root = copyShop(shop);
    const c = await connect(root);
    const saved = (await valid(c, "save_journeys", { ops: [{ op: "create", name: "Browse customers", area: "Customers", chainIds: [chainId] }] })) as {
      created: string[];
    };
    expect(saved.created).toHaveLength(1);
    const jid = saved.created[0]!;
    const j = (await valid(c, "get_journey", { id: jid })) as { journey: { name: string } };
    expect(j.journey.name).toBe("Browse customers");
    await invalid(c, root, "save_journeys", { ops: [{ op: "create", name: "Ghost", chainIds: ["ch_000000000000"] }] });
    await invalid(c, root, "save_journeys", { ops: [{ op: "update", id: jid, name: "ok" }, { op: "delete", id: "j_000000000000" }] });
    await invalid(c, root, "save_journeys", { ops: [] });
    await invalid(c, root, "save_journeys", { ops: [{ op: "rename", id: jid }] });
  });

  it("every tool rejects invalid input with isError and changes no file", async () => {
    // tools with no input: point them at a folder that is not an indexed workspace
    expect(await invalid(emptyClient, empty, "workspace_overview")).toMatch(/codeloom/i);
    await invalid(emptyClient, empty, "index_status");
    // tools with input
    await invalid(client, shop, "get_layers", { repo: "nope" });
    await invalid(client, shop, "get_layers", { repo: 5 });
    await invalid(client, shop, "search", { query: "" });
    await invalid(client, shop, "search", { query: "x", kinds: ["galaxy"] });
    await invalid(client, shop, "get_node", { node: "no-separator" });
    await invalid(client, shop, "get_node", { node: "nope::file:x.ts" });
    await invalid(client, shop, "get_neighbors", { node: fnRef, depth: 4 });
    await invalid(client, shop, "explain_context", { node: fnRef, maxChars: 10 });
    await invalid(client, shop, "list_chains", { limit: 0 });
    await invalid(client, shop, "list_chains", { repo: "nope" });
    await invalid(client, shop, "get_journey", { id: "x" });
    await invalid(client, shop, "get_journey", { id: "j_000000000000" });
    await invalid(client, shop, "trace_route", { from: "not a route" });
    await invalid(client, shop, "trace_route", { from: "table:" });
    await invalid(client, shop, "check_chains", { traces: "yes" });
    await invalid(client, shop, "impact_of_diff", { range: "no-such-ref..HEAD" });
    await invalid(client, shop, "impact_of_diff", { range: "--output=/tmp/x" });
    // the writers, against the shared shop too: nothing may be written on bad input
    await invalid(client, shop, "save_summary", { node: fnRef });
    await invalid(client, shop, "save_journeys", { ops: [{ op: "create", name: "", chainIds: [chainId] }] });
  });

  it("prompts/list and getPrompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["name-journeys", "verify-journey"]);
    expect(prompts.find((p) => p.name === "verify-journey")!.arguments).toEqual([
      expect.objectContaining({ name: "journey", required: true }),
    ]);
    const PromptResult = z.object({
      messages: z.array(z.object({ role: z.literal("user"), content: z.object({ type: z.literal("text"), text: str.min(1) }).strict() }).strict()).length(1),
    });
    const named = PromptResult.parse(await client.getPrompt({ name: "name-journeys" }));
    expect(named.messages[0]!.content.text).toMatch(/list_chains/);
    const verify = PromptResult.parse(await client.getPrompt({ name: "verify-journey", arguments: { journey: chainId } }));
    expect(verify.messages[0]!.content.text).toContain(chainId);
    await expect(client.getPrompt({ name: "verify-journey", arguments: {} })).rejects.toThrow();
  });
});
