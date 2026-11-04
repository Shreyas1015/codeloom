import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runIndex } from "../src/commands/index-cmd.js";
import { type DashboardServer, startDashboardServer } from "../src/web/server.js";
import { materializeFixture } from "./helpers.js";

/** A temp dashboard dist (the API tests never read it). */
function makeAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-dash-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  return dir;
}

// ---- zod schemas mirroring src/web/api-types.ts (strict: an extra or missing key fails) ---------

const confidence = z.enum(["exact", "param", "guess"]);
const lane = z.enum(["ui", "api", "code", "db", "queue"]);
const laneCounts = z.strictObject({ ui: z.number(), api: z.number(), code: z.number(), db: z.number(), queue: z.number() });

const OverviewResponse = z.strictObject({
  name: z.string(),
  repos: z.array(z.strictObject({
    id: z.string(), path: z.string(), role: z.enum(["ui", "api", "worker", "lib"]).optional(),
    files: z.number(), nodes: z.number(), edges: z.number(), pages: z.number(), routes: z.number(), calls: z.number(), tables: z.number(), queues: z.number(),
  })),
  chains: z.strictObject({ total: z.number(), complete: z.number(), byConfidence: z.strictObject({ exact: z.number(), param: z.number(), guess: z.number() }) }),
  journeys: z.strictObject({ total: z.number(), orphaned: z.number() }),
  unnamedChains: z.number(),
  indexStatus: z.strictObject({
    repos: z.array(z.strictObject({ id: z.string(), head: z.string(), indexedCommit: z.string().nullable(), stale: z.boolean(), changedFiles: z.array(z.string()), truncated: z.boolean() })),
  }),
  mcpConnected: z.boolean(),
});

const JourneyRow = z.strictObject({
  id: z.string(), name: z.string(), area: z.string(), note: z.string(), status: z.enum(["ok", "orphaned"]),
  chainIds: z.array(z.string()), repos: z.array(z.string()), stops: laneCounts, confidence, complete: z.boolean(), apiOnly: z.boolean(), tables: z.array(z.string()),
  external: z.array(z.string()).optional(),
});
const ChainRow = z.strictObject({ id: z.string(), name: z.string(), entry: z.string(), confidence, complete: z.boolean(), apiOnly: z.boolean(), repos: z.array(z.string()) });
const JourneysResponse = z.strictObject({ journeys: z.array(JourneyRow), unnamedChains: z.array(ChainRow) });

const StopView = z.strictObject({
  lane, kind: z.enum(["page", "call", "route", "handler", "function", "db", "publish", "consume"]), repo: z.string(), file: z.string(),
  line: z.number(), symbol: z.string(), label: z.string().optional(), op: z.string().optional(), confidence, reason: z.string().optional(), ref: z.string().optional(),
  from: z.number().int().nonnegative().optional(),
});
const Unresolved = z.strictObject({ at: z.strictObject({ file: z.string(), line: z.number(), symbol: z.string(), repo: z.string() }), reason: z.string() });
const ChainView = z.strictObject({
  id: z.string(), name: z.string(), entry: z.string(), routeKey: z.string(), confidence, complete: z.boolean(),
  journeys: z.array(z.string()), stopCount: z.number().int(), lanes: laneCounts, tables: z.array(z.string()),
  stops: z.array(StopView), unresolved: z.array(Unresolved),
});
const ChainsResult = z.strictObject({ total: z.number(), chains: z.array(ChainView), truncated: z.boolean() });
const Journey = z.strictObject({ id: z.string(), name: z.string(), area: z.string(), note: z.string(), chainIds: z.array(z.string()), status: z.enum(["ok", "orphaned"]) });
const JourneyResult = z.strictObject({
  journey: Journey.nullable(), chains: z.array(ChainView),
  lanes: z.strictObject({ ui: z.array(StopView), api: z.array(StopView), code: z.array(StopView), db: z.array(StopView), queue: z.array(StopView) }),
  files: z.array(z.string()), tables: z.array(z.string()), queues: z.array(z.string()),
  unresolved: z.array(Unresolved.extend({ chainId: z.string() })), missingChainIds: z.array(z.string()),
  movedChainIds: z.array(z.strictObject({ from: z.string(), to: z.array(z.string()) })),
  external: z.array(z.strictObject({ name: z.string(), repo: z.string(), file: z.string(), line: z.number(), symbol: z.string(), method: z.string(), path: z.string() })).optional(),
});

const GraphLevel = z.strictObject({
  repo: z.string(), dir: z.string(),
  folders: z.array(z.strictObject({ path: z.string(), name: z.string(), files: z.number(), layer: z.string().optional() })),
  files: z.array(z.strictObject({
    ref: z.string(), path: z.string(), name: z.string(), layer: z.string().optional(),
    functions: z.array(z.strictObject({ ref: z.string(), name: z.string(), type: z.enum(["function", "class"]), line: z.number().optional() })),
    journeys: z.array(z.string()),
  })),
  edges: z.array(z.strictObject({ from: z.string(), to: z.string(), type: z.string(), count: z.number() })),
});

const NodeResult = z.strictObject({
  ref: z.string(),
  node: z.strictObject({ type: z.string(), name: z.string(), filePath: z.string().optional(), lineRange: z.tuple([z.number(), z.number()]).optional(), layer: z.string().optional() }),
  summary: z.string().nullable(),
  edges: z.strictObject({
    out: z.array(z.strictObject({ type: z.string(), target: z.string() })),
    in: z.array(z.strictObject({ type: z.string(), source: z.string() })),
    truncated: z.boolean(),
  }),
  chains: z.array(z.string()),
  journeys: z.array(z.strictObject({ id: z.string(), name: z.string() })),
});
const NeighborsResult = z.strictObject({
  root: z.string(),
  neighbors: z.array(z.strictObject({ ref: z.string(), name: z.string(), type: z.string(), depth: z.number(), via: z.strictObject({ type: z.string(), direction: z.enum(["in", "out"]) }) })),
  truncated: z.boolean(),
});
const LayersResult = z.strictObject({
  repos: z.array(z.strictObject({ id: z.string(), layers: z.array(z.strictObject({ id: z.string(), name: z.string(), description: z.string(), nodeCount: z.number() })) })),
});
const SearchResult = z.strictObject({
  results: z.array(z.strictObject({
    kind: z.enum(["file", "function", "class", "route", "page", "table", "queue", "journey", "chain"]), ref: z.string(), name: z.string(),
    repo: z.string().optional(), file: z.string().optional(), line: z.number().optional(), score: z.number(),
  })),
  truncated: z.boolean(),
});
const CodeResponse = z.strictObject({ file: z.string(), startLine: z.number(), endLine: z.number(), text: z.string(), truncated: z.boolean() });
const ErrorBody = z.strictObject({ error: z.string(), code: z.enum(["not-indexed", "no-workspace", "bad-data"]).optional() });

// ---- server -------------------------------------------------------------------------------------

const TOKEN = "b".repeat(64);
const JOURNEY_ID = "j_000000000001";

interface Res { status: number; body: unknown }

function request(s: DashboardServer, path: string, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: s.port, path, method, agent: false,
        headers: { host: `127.0.0.1:${s.port}`, cookie: `codeloom_session_${s.port}=${TOKEN}` },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let demo: string;
let server: DashboardServer;
let createChainId: string;
const get = (path: string) => request(server, path);
const ok = async <T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> => {
  const res = await get(path);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return schema.parse(res.body);
};
const fail = async (path: string, status: number) => {
  const res = await get(path);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return ErrorBody.parse(res.body);
};

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string }>;
  createChainId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({ version: 1, journeys: [{ id: JOURNEY_ID, name: "Sign up a customer", area: "customers", note: "", chainIds: [createChainId], status: "ok" }] }),
  );
  server = await startDashboardServer({ start: demo, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, watch: false });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe("dashboard JSON API on demo-shop", () => {
  it("/api/overview", async () => {
    const o = await ok("/api/overview", OverviewResponse);
    expect(o.repos.map((r) => r.id)).toEqual(["api", "billing", "web"]);
  });

  it("/api/journeys lists the named journey and the unnamed chains", async () => {
    const j = await ok("/api/journeys", JourneysResponse);
    expect(j.journeys).toHaveLength(1);
    expect(j.journeys[0]).toMatchObject({ id: JOURNEY_ID, chainIds: [createChainId], repos: ["api", "web"], tables: ["audit_logs", "customers"], complete: true });
    expect(j.unnamedChains.map((c) => c.id)).not.toContain(createChainId);
    expect(j.unnamedChains.length).toBeGreaterThan(0);
  });

  it("/api/journeys/:id for a journey and a chain; unknown → 404", async () => {
    const j = await ok(`/api/journeys/${JOURNEY_ID}`, JourneyResult);
    expect(j.journey?.name).toBe("Sign up a customer");
    const c = await ok(`/api/journeys/${createChainId}`, JourneyResult);
    expect(c.journey).toBeNull();
    await fail("/api/journeys/j_ffffffffffff", 404);
    await fail("/api/journeys/nope", 404);
  });

  it("/api/chains with filters; bad params → 400", async () => {
    const all = await ok("/api/chains", ChainsResult);
    expect(all.total).toBeGreaterThan(1);
    const page = await ok("/api/chains?limit=1&offset=1", ChainsResult);
    expect(page.chains).toHaveLength(1);
    expect(page.chains[0]!.id).toBe(all.chains[1]!.id);
    const unnamed = await ok("/api/chains?unnamed=true&repo=api", ChainsResult);
    expect(unnamed.chains.map((c) => c.id)).not.toContain(createChainId);
    const exact = await ok("/api/chains?confidence=param&complete=true", ChainsResult);
    expect(exact.chains.every((c) => c.confidence === "param" && c.complete)).toBe(true);
    await fail("/api/chains?limit=0", 400);
    await fail("/api/chains?limit=abc", 400);
    await fail("/api/chains?complete=maybe", 400);
    await fail("/api/chains?confidence=sure", 400);
    await fail("/api/chains?repo=nope", 404);
  });

  it("/api/graph: the root level of api lists its top folders", async () => {
    const g = await ok("/api/graph?repo=api", GraphLevel);
    expect(g.dir).toBe("");
    expect(g.folders.map((f) => f.path)).toEqual(["app", "database", "start"]);
    expect(g.folders.find((f) => f.path === "app")!.files).toBe(3);
    expect(g.files.map((f) => f.path)).toEqual(["package.json"]);
    expect(g.edges).toEqual([]); // demo-shop's api imports all stay inside app/
  });

  it("/api/graph: a folder level lists files with their functions and journeys", async () => {
    const g = await ok("/api/graph?repo=api&dir=app/controllers", GraphLevel);
    expect(g.folders).toEqual([]);
    expect(g.files).toHaveLength(1);
    expect(g.files[0]).toMatchObject({
      ref: "api::file:app/controllers/customers_controller.ts",
      path: "app/controllers/customers_controller.ts",
      name: "customers_controller.ts",
      layer: "layer:api-layer",
      functions: [
        { ref: "api::class:app/controllers/customers_controller.ts:CustomersController", name: "CustomersController", type: "class", line: 6 },
        // v0.2a §1: methods are listed on the file card
        { ref: "api::function:app/controllers/customers_controller.ts:CustomersController.store", name: "CustomersController.store", type: "function", line: 9 },
        { ref: "api::function:app/controllers/customers_controller.ts:CustomersController.show", name: "CustomersController.show", type: "function", line: 14 },
      ],
      journeys: [JOURNEY_ID],
    });
    const app = await ok("/api/graph?repo=api&dir=app", GraphLevel);
    expect(app.edges).toEqual([
      { from: "app/controllers", to: "app/services", type: "calls", count: 2 }, // v0.2a §1: store→create, show→find
      { from: "app/controllers", to: "app/services", type: "imports", count: 1 },
      { from: "app/services", to: "app/models", type: "imports", count: 1 },
    ]);
    await fail("/api/graph", 400);
    await fail("/api/graph?repo=nope", 404);
    await fail("/api/graph?repo=api&dir=nope", 404);
  });

  it("/api/node/:ref and /api/neighbors/:ref", async () => {
    const ref = encodeURIComponent("api::file:app/controllers/customers_controller.ts");
    const n = await ok(`/api/node/${ref}`, NodeResult);
    expect(n.node.type).toBe("file");
    expect(n.journeys).toEqual([{ id: JOURNEY_ID, name: "Sign up a customer" }]);
    const nb = await ok(`/api/neighbors/${ref}?depth=2&direction=out`, NeighborsResult);
    expect(nb.neighbors.map((x) => x.ref)).toContain("api::file:app/models/customer.ts");
    const only = await ok(`/api/neighbors/${ref}?edgeTypes=contains`, NeighborsResult);
    expect(only.neighbors.every((x) => x.via.type === "contains")).toBe(true);
    await fail(`/api/node/${encodeURIComponent("api::file:nope.ts")}`, 404);
    await fail(`/api/node/${encodeURIComponent("nope::file:x.ts")}`, 404);
    await fail("/api/node/no-separator", 400);
    await fail(`/api/neighbors/${ref}?depth=4`, 400);
    await fail(`/api/neighbors/${ref}?direction=up`, 400);
  });

  it("/api/layers and /api/search", async () => {
    const l = await ok("/api/layers", LayersResult);
    expect(l.repos.map((r) => r.id)).toEqual(["api", "billing", "web"]);
    const one = await ok("/api/layers?repo=api", LayersResult);
    expect(one.repos.map((r) => r.id)).toEqual(["api"]);
    await fail("/api/layers?repo=nope", 404);
    const s = await ok("/api/search?q=customer&kinds=class,table&limit=5", SearchResult);
    expect(s.results.length).toBeGreaterThan(0);
    expect(s.results.length).toBeLessThanOrEqual(5);
    expect(s.results.every((r) => r.kind === "class" || r.kind === "table")).toBe(true);
    await fail("/api/search", 400);
    await fail("/api/search?q=x&kinds=bogus", 400);
    await fail("/api/search?q=x&limit=101", 400);
  });

  it("/api/code returns the customers controller lines", async () => {
    const file = "app/controllers/customers_controller.ts";
    const c = await ok(`/api/code?repo=api&file=${encodeURIComponent(file)}&start=6&end=8`, CodeResponse);
    const lines = readFileSync(join(demo, "api", file), "utf8").split("\n");
    expect(c).toEqual({ file, startLine: 6, endLine: 8, text: lines.slice(5, 8).join("\n"), truncated: false });
    const whole = await ok(`/api/code?repo=api&file=${encodeURIComponent(file)}`, CodeResponse);
    expect(whole.startLine).toBe(1);
    expect(whole.text).toContain("CustomersController");
  });

  it("/api/code refuses paths outside the repo (400) and missing files (404)", async () => {
    await fail("/api/code?repo=api&file=../billing/src/server.ts", 400);
    await fail(`/api/code?repo=api&file=${encodeURIComponent("/etc/passwd")}`, 400);
    await fail("/api/code?repo=api&file=..%2F..%2F..%2Fetc%2Fpasswd", 400);
    const outside = mkdtempSync(join(tmpdir(), "codeloom-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(demo, "api", "link.txt"));
    await fail("/api/code?repo=api&file=link.txt", 400);
    await fail("/api/code?repo=api&file=nope.ts", 404);
    await fail("/api/code?repo=api", 400);
    await fail("/api/code?repo=nope&file=a.ts", 404);
    await fail("/api/code?repo=api&file=start/routes.ts&start=0", 400);
    await fail("/api/code?repo=api&file=start/routes.ts&start=9999", 400);
  });

  it("/api/code never serves git internals or env files, but allows names that merely start with ..", async () => {
    writeFileSync(join(demo, "api", ".env"), "SECRET=1\n");
    writeFileSync(join(demo, "api", ".env.local"), "SECRET=1\n");
    writeFileSync(join(demo, "api", "..notes.ts"), "export const n = 1;\n");
    await fail("/api/code?repo=api&file=.git/config", 400);
    await fail("/api/code?repo=api&file=start/../.git/HEAD", 400);
    await fail("/api/code?repo=api&file=.env", 400);
    await fail("/api/code?repo=api&file=.env.local", 400);
    const c = await ok("/api/code?repo=api&file=..notes.ts", CodeResponse);
    expect(c.text).toContain("export const n");
  });

  it("no endpoint accepts POST, PUT or DELETE (405)", async () => {
    const paths = [
      "/api/overview", "/api/journeys", `/api/journeys/${JOURNEY_ID}`, "/api/chains", "/api/graph?repo=api",
      `/api/node/${encodeURIComponent("api::file:start/routes.ts")}`, `/api/neighbors/${encodeURIComponent("api::file:start/routes.ts")}`,
      "/api/layers", "/api/search?q=x", "/api/code?repo=api&file=start/routes.ts",
    ];
    for (const p of paths) {
      for (const m of ["POST", "PUT", "DELETE"]) expect((await request(server, p, m)).status, `${m} ${p}`).toBe(405);
    }
  });
});

describe("dashboard JSON API on an un-indexed workspace", () => {
  let raw: DashboardServer;

  beforeAll(async () => {
    const ws = materializeFixture("demo-shop");
    writeFileSync(join(ws, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "raw", repos: [{ id: "api", path: "api" }], links: [] }));
    raw = await startDashboardServer({ start: ws, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, watch: false });
  }, 60_000);

  afterAll(async () => {
    await raw?.close();
  });

  it("every map endpoint answers 409 not-indexed", async () => {
    for (const p of ["/api/journeys", `/api/journeys/${JOURNEY_ID}`, "/api/chains", "/api/graph?repo=api", "/api/layers", "/api/search?q=x"]) {
      const res = await request(raw, p);
      expect(res.status, p).toBe(409);
      expect(ErrorBody.parse(res.body).code, p).toBe("not-indexed");
    }
  });
});
