import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { fail, ok, withErrors } from "../src/mcp/result.js";
import { createServer, type ServerOptions } from "../src/mcp/server.js";
import { chainsTouchingNode, findNode, formatNodeRef, journeysForChains, loadMapState, parseNodeRef } from "../src/mcp/state.js";
import { gitHead } from "../src/workspace/repos.js";
import { commitAll, materializeFixture, makeRepo } from "./helpers.js";

async function connect(opts: ServerOptions): Promise<Client> {
  const server = createServer(opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function text(r: CallToolResult): string {
  const item = r.content[0];
  if (item?.type !== "text") throw new Error("expected a text item");
  return item.text;
}

let demo: string;
beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
});

afterEach(() => vi.restoreAllMocks());

describe("mcp/result", () => {
  it("ok returns pretty JSON text and the same object as structuredContent", () => {
    const r = ok({ a: 1, b: [2] });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(JSON.stringify({ a: 1, b: [2] }, null, 2));
    expect(r.structuredContent).toEqual({ a: 1, b: [2] });
  });

  it("fail maps CodeloomError, ZodError and other errors to messages", () => {
    expect(text(fail(new CodeloomError("bad data")))).toBe("bad data");
    expect(fail(new CodeloomError("x")).isError).toBe(true);
    const zerr = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } }).error;
    expect(text(fail(zerr))).toMatch(/^Invalid input: a\.b: /);
    expect(text(fail(new Error("boom")))).toBe("Unexpected error: boom");
    expect(text(fail("str"))).toBe("Unexpected error: str");
  });

  it("withErrors never throws", async () => {
    const h = withErrors(async (_a: { x: number }) => {
      throw new CodeloomError("nope");
    });
    const r = await h({ x: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("nope");
    expect((await withErrors((a: { x: number }) => ({ x: a.x }))({ x: 3 })).structuredContent).toEqual({ x: 3 });
  });
});

describe("mcp/state", () => {
  it("parseNodeRef / formatNodeRef", () => {
    expect(parseNodeRef("api::function:src/a.ts:f")).toEqual({ repo: "api", nodeId: "function:src/a.ts:f" });
    expect(parseNodeRef("web::file:src/x::y.ts")).toEqual({ repo: "web", nodeId: "file:src/x::y.ts" });
    expect(formatNodeRef({ repo: "api", nodeId: "file:src/a.ts" })).toBe("api::file:src/a.ts");
    expect(() => parseNodeRef("function:src/a.ts:f")).toThrow(CodeloomError);
    expect(() => parseNodeRef("::file:a.ts")).toThrow(CodeloomError);
    expect(() => parseNodeRef("api::")).toThrow(CodeloomError);
  });

  it("loadMapState reads chains and journeys; findNode names unknown repo/node", () => {
    const state = loadMapState(demo);
    expect(state.ws.repos.length).toBe(3);
    expect(state.chains.length).toBeGreaterThan(0);
    expect(state.chainsPath).toBe(join(state.ws.root, ".codeloom", "chains.json"));
    expect(state.journeysPath).toBe(join(state.ws.root, ".codeloom", "journeys.json"));
    expect(() => findNode(state, { repo: "nope", nodeId: "x" })).toThrow(/nope/);
    const repo = state.ws.repos[0]!;
    expect(() => findNode(state, { repo: repo.ref.id, nodeId: "file:missing.ts" })).toThrow(/file:missing\.ts/);
    const node = repo.graph.nodes[0]!;
    expect(findNode(state, { repo: repo.ref.id, nodeId: node.id }).node.id).toBe(node.id);
  });

  it("chainsTouchingNode matches stops by nodeId or by file for a file node; journeysForChains sorts", () => {
    const state = loadMapState(demo);
    const stop = state.chains.flatMap((c) => c.stops).find((s) => s.nodeId)!;
    const byNode = chainsTouchingNode(state, { repo: stop.repo, nodeId: stop.nodeId! });
    expect(byNode.length).toBeGreaterThan(0);
    const byFile = chainsTouchingNode(state, { repo: stop.repo, nodeId: `file:${stop.file}` });
    expect(byFile.length).toBeGreaterThanOrEqual(byNode.length);
    expect(byFile.map((c) => c.id)).toEqual([...byFile.map((c) => c.id)].sort());
    const j = (id: string, chainIds: string[]) => ({ id, name: id, area: "", note: "", chainIds, status: "ok" as const });
    state.journeys = [j("j_bbbbbbbbbbbb", [byNode[0]!.id]), j("j_aaaaaaaaaaaa", [byNode[0]!.id]), j("j_cccccccccccc", ["ch_000000000000"])];
    expect(journeysForChains(state, new Set([byNode[0]!.id])).map((x) => x.id)).toEqual(["j_aaaaaaaaaaaa", "j_bbbbbbbbbbbb"]);
  });
});

describe("mcp server", () => {
  it("lists workspace_overview", async () => {
    const client = await connect({ start: demo });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("workspace_overview");
  });

  it("workspace_overview on demo-shop returns 3 repos with counts", async () => {
    const client = await connect({ start: demo });
    const r = (await client.callTool({ name: "workspace_overview", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const o = r.structuredContent as {
      name: string;
      repos: Array<Record<string, number | string>>;
      chains: { total: number; complete: number; byConfidence: Record<string, number> };
      journeys: { total: number; orphaned: number };
      unnamedChains: number;
    };
    expect(JSON.parse(text(r))).toEqual(o);
    expect(o.repos).toHaveLength(3);
    for (const repo of o.repos) {
      expect(repo.files).toBeGreaterThan(0);
      expect(repo.nodes).toBeGreaterThan(0);
    }
    expect(o.repos.map((x) => x.id)).toEqual([...o.repos.map((x) => x.id)].sort());
    expect(o.chains.total).toBeGreaterThan(0);
    const b = o.chains.byConfidence;
    expect(b.exact! + b.param! + b.guess!).toBe(o.chains.total);
    expect(o.journeys).toEqual({ total: 0, orphaned: 0 });
    expect(o.unnamedChains).toBe(o.chains.total);
  });

  it("reads files fresh on every call (journeys added later show up)", async () => {
    const client = await connect({ start: demo });
    const state = loadMapState(demo);
    const before = (await client.callTool({ name: "workspace_overview", arguments: {} })) as CallToolResult;
    const jpath = state.journeysPath;
    const original = readFileSync(jpath, "utf8");
    try {
      const chainId = state.chains[0]!.id;
      writeFileSync(
        jpath,
        JSON.stringify({ version: 1, journeys: [{ id: "j_aaaaaaaaaaaa", name: "x", area: "", note: "", chainIds: [chainId], status: "ok" }] }),
      );
      const after = (await client.callTool({ name: "workspace_overview", arguments: {} })) as CallToolResult;
      const o = after.structuredContent as { journeys: { total: number }; unnamedChains: number };
      expect(o.journeys.total).toBe(1);
      expect(o.unnamedChains).toBe((before.structuredContent as { unnamedChains: number }).unnamedChains - 1);
    } finally {
      writeFileSync(jpath, original);
    }
  });

  it("an un-indexed folder returns isError with the run-index message", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const client = await connect({ start: repo });
    const r = (await client.callTool({ name: "workspace_overview", arguments: {} })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Run "codeloom index" first');
  });

  it("an empty non-repo folder also returns a tool error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-empty-"));
    const client = await connect({ start: dir });
    const r = (await client.callTool({ name: "workspace_overview", arguments: {} })) as CallToolResult;
    expect(r.isError).toBe(true);
  });

  it("writes nothing to stdout during a tool call", async () => {
    const client = await connect({ start: demo });
    const spy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log");
    await client.callTool({ name: "workspace_overview", arguments: {} });
    const repo = makeRepo({ "a.ts": "x" });
    const c2 = await connect({ start: repo });
    await c2.callTool({ name: "workspace_overview", arguments: {} });
    expect(spy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("lists index_status, reindex and get_layers", async () => {
    const client = await connect({ start: demo });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["index_status", "reindex", "get_layers"]),
    );
  });
});

interface IndexStatusRepo {
  id: string;
  head: string;
  indexedCommit: string | null;
  stale: boolean;
  changedFiles: string[];
  truncated: boolean;
}

describe("mcp server: index_status / reindex", () => {
  it("is not stale right after indexing, goes stale on a commit (naming the file) and on an " +
    "untracked file, and clears again after reindex", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    await runIndex(repo);
    const client = await connect({ start: repo });

    const head0 = gitHead(repo);
    const r1 = (await client.callTool({ name: "index_status", arguments: {} })) as CallToolResult;
    expect(r1.isError).toBeFalsy();
    const s1 = r1.structuredContent as { repos: IndexStatusRepo[] };
    expect(s1.repos).toHaveLength(1);
    const repoId = s1.repos[0]!.id;
    expect(s1.repos[0]).toEqual({ id: repoId, head: head0, indexedCommit: head0, stale: false, changedFiles: [], truncated: false });

    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commitAll(repo);
    const head1 = gitHead(repo);
    const r2 = (await client.callTool({ name: "index_status", arguments: {} })) as CallToolResult;
    const s2 = (r2.structuredContent as { repos: IndexStatusRepo[] }).repos[0]!;
    expect(s2.head).toBe(head1);
    expect(s2.indexedCommit).toBe(head0);
    expect(s2.stale).toBe(true);
    expect(s2.changedFiles).toContain("src/a.ts");

    writeFileSync(join(repo, "src/b.ts"), "export const b = 1;\n");
    const r3 = (await client.callTool({ name: "index_status", arguments: {} })) as CallToolResult;
    const s3 = (r3.structuredContent as { repos: IndexStatusRepo[] }).repos[0]!;
    expect(s3.stale).toBe(true);
    expect(s3.changedFiles).toContain("src/b.ts");

    commitAll(repo);
    const head2 = gitHead(repo);
    const r4 = (await client.callTool({ name: "reindex", arguments: {} })) as CallToolResult;
    expect(r4.isError).toBeFalsy();
    const reindexResult = r4.structuredContent as { root: string; repos: Array<{ id: string }>; linker: Record<string, unknown> };
    expect(reindexResult.repos.map((x) => x.id)).toEqual([repoId]);
    expect(realpathSync(reindexResult.root)).toBe(realpathSync(repo));

    const r5 = (await client.callTool({ name: "index_status", arguments: {} })) as CallToolResult;
    const s5 = (r5.structuredContent as { repos: IndexStatusRepo[] }).repos[0]!;
    expect(s5.head).toBe(head2);
    expect(s5.indexedCommit).toBe(head2);
    expect(s5.stale).toBe(false);
    expect(s5.changedFiles).toEqual([]);
  });

  it("an un-indexed repo reports indexedCommit: null and stale: true", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const client = await connect({ start: repo });
    const r = (await client.callTool({ name: "index_status", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const s = (r.structuredContent as { repos: IndexStatusRepo[] }).repos[0]!;
    expect(s.indexedCommit).toBeNull();
    expect(s.stale).toBe(true);
  });
});

describe("mcp server: get_layers", () => {
  it("lists layers per repo, filters by repo, and errors on an unknown repo", async () => {
    const client = await connect({ start: demo });
    const all = (await client.callTool({ name: "get_layers", arguments: {} })) as CallToolResult;
    expect(all.isError).toBeFalsy();
    const o = all.structuredContent as {
      repos: Array<{ id: string; layers: Array<{ id: string; name: string; description: string; nodeCount: number }> }>;
    };
    expect(o.repos.map((r) => r.id)).toEqual(["api", "billing", "web"]);
    for (const r of o.repos) {
      expect(r.layers.length).toBeGreaterThan(0);
      for (const l of r.layers) {
        expect(l.nodeCount).toBeGreaterThan(0);
        expect(typeof l.name).toBe("string");
        expect(typeof l.description).toBe("string");
      }
    }

    const apiOnly = (await client.callTool({ name: "get_layers", arguments: { repo: "api" } })) as CallToolResult;
    const apiOut = apiOnly.structuredContent as typeof o;
    expect(apiOut.repos).toHaveLength(1);
    expect(apiOut.repos[0]!.id).toBe("api");
    expect(apiOut.repos[0]!.layers).toEqual(o.repos.find((r) => r.id === "api")!.layers);

    const bad = (await client.callTool({ name: "get_layers", arguments: { repo: "nope" } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("nope");
  });
});
