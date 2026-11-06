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
  CheckItemKindSchema,
  CheckItemSchema,
  CheckReportSchema,
  ConfidenceSchema,
  EndpointsFileSchema,
  JourneySchema,
  LaneSchema,
  StopKindSchema,
  UnresolvedSchema,
} from "../src/store/schemas.js";
import { CheckRecordSchema } from "../src/store/progress.js";
import { stopKey } from "../src/store/stop-key.js";
import { CheckQuestionSchema } from "../src/store/tours.js";
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

const LaneCounts = z.object({ ui: int, api: int, code: int, db: int, queue: int }).strict();

/** list_chains' default compact row. */
const ChainRow = z
  .object({
    id: str.regex(/^ch_[0-9a-f]{12}$/),
    name: str,
    entry: str,
    routeKey: str,
    confidence: ConfidenceSchema,
    complete: z.boolean(),
    journeys: z.array(str),
    stopCount: int.nonnegative(),
    lanes: LaneCounts,
    tables: z.array(str),
  })
  .strict();

/** One stop in a cut get_journey's compact lanes summary (hG). */
const LaneRow = z.object({ label: str, repo: str, at: str.regex(/:\d+$/) }).strict();
const LaneRows = z.array(LaneRow).max(50);

/** The full row: list_chains `detail: true`, get_journey's chains. */
const ChainView = ChainRow.extend({ stops: z.array(StopView), unresolved: z.array(UnresolvedSchema.strict()) }).strict();

const JourneyRef = z.object({ id: str.regex(/^j_[0-9a-f]{12}$/), name: str }).strict();
const NodeView = z
  .object({ type: str, name: str, filePath: str.optional(), lineRange: z.tuple([int, int]).optional(), layer: str.optional() })
  .strict();
const CallConfidence = z.enum(["exact", "param"]);
const Neighbor = z
  .object({
    ref: str,
    name: str,
    type: str,
    depth: int.min(1).max(3),
    // v0.2a: a resolved `calls` edge carries its confidence (never guess: guesses are not edges)
    via: z.object({ type: str, direction: z.enum(["in", "out"]), confidence: CallConfidence.optional() }).strict(),
  })
  .strict();

const Sha = str.regex(/^[0-9a-f]{64}$/);
const TypeRef = z.object({ name: str, file: str.optional(), line: int.positive().optional(), text: str.optional(), from: str.optional() }).strict();
const Shape = z.object({ kind: z.enum(["schema", "validator", "request", "response", "type"]), line: int.positive(), text: str }).strict();
const DbDetail = z
  .object({
    table: str.optional(),
    model: str.optional(),
    op: str,
    via: str,
    statement: str,
    tableDef: z.object({ file: str, line: int.positive(), source: str, text: str }).strict().nullable(),
    modelDef: z.object({ file: str, source: str }).strict().nullable(),
  })
  .strict();
/** One stop in build_tour_context: the chain stop, its file hash, and (unless `sameAs`) its context. */
const TourContextStop = StopView.omit({ from: true })
  .extend({
    chainId: str,
    stopIndex: int.nonnegative(),
    key: str,
    from: int.nonnegative().optional(),
    fileHash: Sha.nullable(),
    sameAs: z.object({ chainId: str, stopIndex: int.nonnegative() }).strict().optional(),
    code: z.object({ startLine: int.positive(), endLine: int.positive(), text: str, truncated: z.boolean() }).strict().nullable().optional(),
    codeUnavailable: str.optional(),
    types: z.array(TypeRef).max(15).optional(),
    shapes: z.array(Shape).max(12).optional(),
    db: DbDetail.optional(),
    neighbors: z.array(Neighbor).max(20).optional(),
  })
  .strict();
const Levels = z.object({ total: int, none: int, seen: int, toured: int, understood: int, needsReWalk: int }).strict();
const Level = z.enum(["none", "seen", "toured", "understood"]);

/** Any tool result may be cut to fit 1 MB (mcp/result.ts fitResponse): it then carries `truncated: true`
 * and a `truncatedNote`. */
function cuttable(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodObject)) return schema;
  const extra: Record<string, z.ZodType> = { truncatedNote: str.optional() };
  if (!("truncated" in schema.shape)) extra.truncated = z.literal(true).optional();
  return schema.extend(extra).strict();
}

const RawSchemas: Record<string, z.ZodObject> = {
  build_tour_context: z
    .object({
      journey: z.object({ id: str.regex(/^j_[0-9a-f]{12}$/), name: str, area: str, note: str }).strict(),
      chains: z.array(z.object({ id: str, name: str, entry: str, routeKey: str, stopCount: int.nonnegative() }).strict()),
      stops: z.array(TourContextStop),
      files: z.array(z.object({ repo: str, file: str, fileHash: Sha.nullable() }).strict()),
      tour: z
        .object({
          writtenAt: str,
          stops: int.nonnegative(),
          staleStops: z.array(str),
          removedStops: z.array(str),
          check: z.array(CheckQuestionSchema.strict()).length(3),
        })
        .strict()
        .nullable(),
      notes: z.array(str),
    })
    .strict(),
  save_tour: z
    .object({
      journeyId: str,
      path: str.regex(/^\.codeloom\/tours\/j_[0-9a-f]{12}\.json$/),
      replaced: z.boolean(),
      writtenAt: str,
      writtenAtCommit: z.record(str, str),
      stops: int.positive(),
      uncoveredStops: z.array(str),
    })
    .strict(),
  get_progress: z
    .object({
      workspaceId: str.regex(/^[0-9a-f]{16}$/),
      journeys: z.array(
        z
          .object({
            journeyId: str,
            name: str,
            area: str,
            repos: z.array(str),
            level: Level,
            needsReWalk: z.array(str),
            lastCheck: CheckRecordSchema.strict().nullable(),
            seenAt: str.optional(),
            touredAt: str.optional(),
            understoodAt: str.optional(),
          })
          .strict(),
      ),
      totals: z.object({ all: Levels, byRepo: z.record(str, Levels), byArea: z.record(str, Levels) }).strict(),
      left: z.array(z.object({ journeyId: str, name: str, area: str, level: Level, reWalkStops: int.nonnegative() }).strict()),
      olderJourneys: z.array(str),
    })
    .strict(),
  record_check: z
    .object({ journeyId: str, verdict: z.enum(["pass", "fail"]), understood: z.boolean(), understoodAt: str.optional(), checks: int.positive() })
    .strict(),
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
          out: z.array(z.object({ type: str, target: str, confidence: CallConfidence.optional() }).strict()).max(100),
          in: z.array(z.object({ type: str, source: str, confidence: CallConfidence.optional() }).strict()).max(100),
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
  // compact rows by default, full rows with `detail: true` (never a mix)
  list_chains: z.object({ total: int, chains: z.union([z.array(ChainRow), z.array(ChainView)]), truncated: z.boolean() }).strict(),
  get_journey: z
    .object({
      journey: JourneySchema.strict().nullable(),
      chains: z.array(ChainView),
      lanes: z.union([
        z.object({ ui: z.array(StopView), api: z.array(StopView), code: z.array(StopView), db: z.array(StopView), queue: z.array(StopView) }).strict(),
        // hG: a cut journey keeps a compact summary of ALL chains' stops, at most 50 per lane
        z.object({ ui: LaneRows, api: LaneRows, code: LaneRows, db: LaneRows, queue: LaneRows }).strict(),
      ]),
      laneTotals: LaneCounts.optional(),
      omittedChainIds: z.array(str).optional(),
      files: z.array(str),
      tables: z.array(str),
      queues: z.array(str),
      unresolved: z.array(UnresolvedSchema.extend({ chainId: str }).strict()),
      missingChainIds: z.array(str),
      movedChainIds: z.array(z.object({ from: str, to: z.array(str) }).strict()),
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
  check_chains: z
    .object({
      version: z.literal(1),
      summary: CheckReportSchema.shape.summary,
      itemTotals: z.partialRecord(CheckItemKindSchema, int.positive()),
      itemsTotal: int.nonnegative(),
      kinds: z.array(CheckItemKindSchema).nullable(),
      perKind: int.positive().nullable(),
      offset: int.nonnegative(),
      limit: int.min(1).max(500).nullable(),
      items: z.array(CheckItemSchema.strict()),
      truncated: z.boolean(),
      next: str.optional(),
      traces: CheckReportSchema.shape.traces,
    })
    .strict(),
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

const Schemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(RawSchemas).map(([name, schema]) => [name, cuttable(schema)]),
);

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
    await valid(client, "list_chains", {});
    const chains = (await valid(client, "list_chains", { detail: true })) as { chains: Array<{ id: string; stops: Array<{ ref?: string }> }> };
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
    // v0.2a: a controller method node's resolved calls carry a confidence
    const methodRef = "demo-api::function:app/controllers/customers_controller.ts:CustomersController.store";
    const method = (await valid(client, "get_node", { node: methodRef })) as { edges: { out: Array<{ type: string; confidence?: string }> } };
    expect(method.edges.out.filter((e) => e.type === "calls").every((e) => e.confidence === "exact" || e.confidence === "param")).toBe(true);
    expect(method.edges.out.some((e) => e.type === "calls")).toBe(true);
    const calls = (await valid(client, "get_neighbors", { node: methodRef, direction: "out", edgeTypes: ["calls"] })) as {
      neighbors: Array<{ type: string; via: { confidence?: string } }>;
    };
    expect(calls.neighbors.length).toBeGreaterThan(0);
    expect(calls.neighbors.every((n) => n.type === "function" && n.via.confidence !== undefined)).toBe(true);
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
    await valid(client, "check_chains", { kinds: ["no-store", "route-no-caller"], limit: 1, offset: 1 });
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

  it("tours and progress: valid calls return the documented shape; invalid input writes nothing", async () => {
    const root = copyShop(shop);
    const c = await connect(root);
    const saved = (await valid(c, "save_journeys", { ops: [{ op: "create", name: "Add a customer", area: "Customers", chainIds: [chainId] }] })) as {
      created: string[];
    };
    const jid = saved.created[0]!;
    // reading context and progress, and recording a check, write nothing under the workspace
    const before = hashTree(root);
    const ctx = (await valid(c, "build_tour_context", { journey: jid })) as { stops: Array<{ chainId: string; stopIndex: number; key: string }>; tour: unknown };
    expect(ctx.stops.length).toBeGreaterThan(0);
    expect(ctx.tour).toBeNull();
    await valid(c, "build_tour_context", { journey: jid, chain: chainId });
    expect(((await valid(c, "get_progress")) as { journeys: Array<{ level: string }> }).journeys.map((j) => j.level)).toEqual(["none"]);
    await valid(c, "get_progress", { repo: "demo-api", area: "Customers" });
    const qa = { questions: ["a?", "b?", "c?"], answers: ["a", "b", "c"], notes: "" };
    expect(await valid(c, "record_check", { journey: jid, ...qa, verdict: "fail" })).toMatchObject({ understood: false });
    expect(await valid(c, "record_check", { journey: jid, ...qa, verdict: "pass" })).toMatchObject({ understood: true, checks: 2 });
    expect(hashTree(root)).toEqual(before);
    const tour = {
      stops: ctx.stops.map((s) => ({ chainId: s.chainId, stopIndex: s.stopIndex, key: s.key, explanation: "What happens here." })),
      dataJourney: { input: '{ "name": "Ada" }', steps: [{ stopKey: ctx.stops[0]!.key, note: "starts here" }], output: '{ "id": 1 }' },
      fileNotes: [],
      check: [1, 2, 3].map((n) => ({ question: `Question ${n}?`, expected: ["a key point"] })),
    };
    expect(await valid(c, "save_tour", { journey: jid, tour })).toMatchObject({ journeyId: jid, replaced: false, uncoveredStops: [] });
    expect(((await valid(c, "build_tour_context", { journey: jid })) as { tour: { staleStops: string[] } }).tour.staleStops).toEqual([]);

    await invalid(c, root, "build_tour_context", { journey: "j_000000000000" });
    await invalid(c, root, "build_tour_context", {});
    await invalid(c, root, "save_tour", { journey: jid, tour: { ...tour, check: tour.check.slice(0, 2) } });
    await invalid(c, root, "save_tour", { journey: jid, tour: { ...tour, stops: [{ ...tour.stops[0]!, stopIndex: 999 }] } });
    await invalid(c, root, "save_tour", { journey: jid, tour: { ...tour, stops: [{ ...tour.stops[0]!, key: stopKey({ lane: "db", repo: "demo-api", file: "x.ts", line: 1, symbol: "x" }) }] } });
    await invalid(c, root, "save_tour", { journey: "j_000000000000", tour });
    await invalid(c, root, "get_progress", { repo: "nope" });
    await invalid(c, root, "record_check", { journey: jid, questions: ["a?"], answers: ["a"], verdict: "pass", notes: "" });
    await invalid(c, root, "record_check", { journey: jid, ...qa, verdict: "maybe" });
    await invalid(c, root, "record_check", { journey: "j_000000000000", ...qa, verdict: "fail" });
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
    await invalid(client, shop, "check_chains", { kinds: ["galaxy"] });
    await invalid(client, shop, "check_chains", { limit: 501 });
    await invalid(client, shop, "impact_of_diff", { range: "no-such-ref..HEAD" });
    await invalid(client, shop, "impact_of_diff", { range: "--output=/tmp/x" });
    // the writers, against the shared shop too: nothing may be written on bad input
    await invalid(client, shop, "save_summary", { node: fnRef });
    await invalid(client, shop, "save_journeys", { ops: [{ op: "create", name: "", chainIds: [chainId] }] });
  });

  it("prompts/list and getPrompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["check-me", "name-journeys", "verify-journey", "write-tour"]);
    for (const name of ["verify-journey", "write-tour", "check-me"]) {
      expect(prompts.find((p) => p.name === name)!.arguments, name).toEqual([expect.objectContaining({ name: "journey", required: true })]);
    }
    const PromptResult = z.object({
      messages: z.array(z.object({ role: z.literal("user"), content: z.object({ type: z.literal("text"), text: str.min(1) }).strict() }).strict()).length(1),
    });
    const named = PromptResult.parse(await client.getPrompt({ name: "name-journeys" }));
    expect(named.messages[0]!.content.text).toMatch(/list_chains/);
    const verify = PromptResult.parse(await client.getPrompt({ name: "verify-journey", arguments: { journey: chainId } }));
    expect(verify.messages[0]!.content.text).toContain(chainId);
    await expect(client.getPrompt({ name: "verify-journey", arguments: {} })).rejects.toThrow();
    const tour = PromptResult.parse(await client.getPrompt({ name: "write-tour", arguments: { journey: "j_0000000000aa" } }));
    expect(tour.messages[0]!.content.text).toMatch(/build_tour_context[\s\S]*save_tour/);
    const check = PromptResult.parse(await client.getPrompt({ name: "check-me", arguments: { journey: "j_0000000000aa" } }));
    expect(check.messages[0]!.content.text).toMatch(/record_check/);
    await expect(client.getPrompt({ name: "write-tour", arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: "check-me", arguments: {} })).rejects.toThrow();
  });
});

// ---- H5: bounded responses on a synthetic 5000-chain map ----------------------------------------------

const MB = 1_000_000;
const BIG_JOURNEY = "j_00000000b16b";

describe("H5: every tool response stays under 1 MB on a 5000-chain map", { timeout: 180_000 }, () => {
  let root: string;
  let client: Client;
  let fnRef: string;
  /** Tool name + args → bytes of the whole tool result as JSON. */
  const sizes: Record<string, number> = {};

  async function bounded(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
    const bytes = Buffer.byteLength(JSON.stringify(r));
    sizes[`${name} ${JSON.stringify(args)}`] = bytes;
    expect(bytes, `${name} ${JSON.stringify(args)}`).toBeLessThan(MB);
    return valid(client, name, args);
  }

  beforeAll(async () => {
    root = await indexedShop();
    const chainsPath = join(root, ".codeloom", "chains.json");
    const file = JSON.parse(readFileSync(chainsPath, "utf8")) as { chains: Array<Record<string, unknown> & { stops: Array<Record<string, unknown>> }> };
    const template = file.chains.find((c) => String(c.routeKey).endsWith(":POST /api/customers"))!;
    const stops = [...template.stops, ...template.stops.slice(1)]; // a long chain: ~2x the real one
    fnRef = `${(stops.find((s) => String(s.nodeId ?? "").startsWith("function:")) as { repo: string }).repo}::${
      stops.find((s) => String(s.nodeId ?? "").startsWith("function:"))!.nodeId as string
    }`;
    const chains = Array.from({ length: 5000 }, (_, i) => ({
      ...template,
      id: `ch_${i.toString(16).padStart(12, "0")}`,
      name: `${template.name as string} #${i}`,
      // every other chain guessed at each hop: thousands of guess-link items for check_chains
      stops: i % 2 ? stops.map((s) => ({ ...s, hop: { confidence: "guess", reason: `guessed hop ${i}` } })) : stops,
      confidence: i % 2 ? "guess" : template.confidence,
    }));
    writeFileSync(chainsPath, JSON.stringify({ ...file, chains }));
    writeFileSync(
      join(root, ".codeloom", "journeys.json"),
      JSON.stringify({
        version: 1,
        journeys: [{ id: BIG_JOURNEY, name: "Every customer chain", area: "Customers", note: "", chainIds: chains.map((c) => c.id), status: "ok" }],
      }),
    );
    client = await connect(root);
  }, 180_000);

  it("list_chains: compact by default, detail pages are cut to fit", async () => {
    const compact = (await bounded("list_chains", { limit: 500 })) as { chains: unknown[]; truncated: boolean };
    expect(compact.chains).toHaveLength(500);
    const detail = (await bounded("list_chains", { detail: true, limit: 500 })) as { chains: unknown[]; truncated: boolean; truncatedNote?: string };
    expect(detail.truncated).toBe(true);
    if (detail.chains.length < 500) expect(detail.truncatedNote).toMatch(/limit/);
  });

  it("get_journey of a 5000-chain journey is cut with a note on how to narrow it", async () => {
    const j = (await bounded("get_journey", { id: BIG_JOURNEY })) as { chains: unknown[]; truncated?: boolean; truncatedNote?: string };
    expect(j.truncated).toBe(true);
    expect(j.chains.length).toBeLessThan(5000);
    expect(j.truncatedNote).toMatch(/get_journey/);
    // hG: the cut keeps the lanes summary and names every left-out chain
    const cut = j as unknown as { lanes: Record<string, unknown[]>; omittedChainIds: string[] };
    expect(j.chains.length + cut.omittedChainIds.length).toBeGreaterThanOrEqual(5000);
    expect(Object.values(cut.lanes).some((l) => l.length > 0)).toBe(true);
  });

  it("build_tour_context of a 5000-chain journey is cut with a note on how to narrow it", async () => {
    const r = (await bounded("build_tour_context", { journey: BIG_JOURNEY })) as { stops: unknown[]; truncated?: boolean; truncatedNote?: string };
    expect(r.truncated).toBe(true);
    expect(r.truncatedNote).toMatch(/chain/);
    await bounded("build_tour_context", { journey: BIG_JOURNEY, chain: "ch_000000000000" });
  });

  it("check_chains: 20 items per kind by default; kinds + limit + offset page the rest", async () => {
    const r = (await bounded("check_chains")) as { items: Array<{ kind: string }>; itemTotals: Record<string, number>; truncated: boolean; next?: string };
    expect(r.itemTotals["guess-link"]).toBeGreaterThan(10_000);
    expect(r.items.filter((i) => i.kind === "guess-link")).toHaveLength(20);
    expect(r.truncated).toBe(true);
    expect(r.next).toMatch(/kinds/);
    const page = (await bounded("check_chains", { kinds: ["guess-link"], limit: 500, offset: 1000 })) as { items: unknown[]; itemsTotal: number };
    expect(page.items).toHaveLength(500);
    expect(page.itemsTotal).toBe(r.itemTotals["guess-link"]);
  });

  it("every other read tool stays under 1 MB", async () => {
    await bounded("workspace_overview");
    await bounded("index_status");
    await bounded("get_layers");
    await bounded("search", { query: "customer", limit: 100 });
    await bounded("get_node", { node: fnRef });
    await bounded("get_neighbors", { node: fnRef, depth: 3, limit: 500 });
    await bounded("explain_context", { node: fnRef, maxChars: 60000 });
    await bounded("trace_route", { from: "table:customers" });
    await bounded("trace_route", { from: fnRef });
    await bounded("impact_of_diff");
    await bounded("list_chains", { unnamed: false, detail: true, limit: 500, offset: 4500 });
    await bounded("get_progress");
    if (process.env.CODELOOM_SIZES) process.stderr.write(`${JSON.stringify(sizes, null, 2)}\n`);
  });
});
