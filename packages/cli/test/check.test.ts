import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCheckJson, formatCheckText } from "../src/check/format.js";
import { belowFailUnder, buildCheckReport, completePercent } from "../src/check/report.js";
import { buildReport, runCheck } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import { type Chain, CheckReportSchema, type EndpointsFile } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

function fakeGraph() {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "2024-01-01T00:00:00Z", gitCommitHash: "abc" },
    nodes: [],
    edges: [],
    layers: [],
    tour: [],
  };
}

function fakeEndpoints(repo: string, overrides: Partial<EndpointsFile> = {}): EndpointsFile {
  return {
    version: 2,
    repo,
    pages: [],
    httpCalls: [],
    httpClients: [],
    routes: [],
    mounts: [],
    dbAccess: [],
    tables: [],
    models: [],
    queues: [],
    ...overrides,
  };
}

function fakeRepoData(ref: RepoData["ref"], endpoints: EndpointsFile): RepoData {
  return { ref, abs: `/tmp/${ref.id}`, graph: fakeGraph() as unknown as RepoData["graph"], endpoints };
}

function fakeWorkspace(repos: RepoData[]): WorkspaceData {
  return { root: "/tmp/ws", name: "ws", repos, links: [] };
}

function fakeChain(overrides: Partial<Chain>): Chain {
  return {
    id: "ch_000000000001",
    entry: "page:web:/x",
    routeKey: "api:POST /api/x",
    name: "POST /api/x",
    stops: [],
    unresolved: [],
    confidence: "exact",
    complete: true,
    ...overrides,
  };
}

describe("buildCheckReport", () => {
  it("reports an unresolved-url item for a call with no literal path", () => {
    const api = fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"));
    const web = fakeRepoData(
      { id: "web", path: "web" },
      fakeEndpoints("web", {
        httpCalls: [{ method: "GET", path: "", raw: "fetch(url)", resolved: false, client: "fetch", kind: "unknown", at: { file: "lib/x.ts", line: 3, symbol: "getX" } }],
      }),
    );
    const report = buildCheckReport([], fakeWorkspace([api, web]));
    expect(report.items).toEqual([
      { kind: "unresolved-url", repo: "web", file: "lib/x.ts", line: 3, symbol: "getX", detail: "cannot read URL from fetch(url)" },
    ]);
    // Per call, not per chain: counted in unresolvedCalls, never in the chain buckets.
    expect(report.summary).toMatchObject({ chains: 0, brokenUiApi: 0, unresolvedCalls: 1 });
  });

  it("an unreadable-URL call is routed only when a route stop is reached from it (from), else the next stop (legacy)", () => {
    const api = fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"));
    const web = fakeRepoData(
      { id: "web", path: "web" },
      fakeEndpoints("web", {
        httpCalls: [{ method: "GET", path: "", raw: "fetch(url)", resolved: false, client: "fetch", kind: "unknown", at: { file: "lib/x.ts", line: 3, symbol: "getX" } }],
      }),
    );
    const page = { lane: "ui" as const, kind: "page" as const, repo: "web", file: "app/x/page.tsx", line: 1, symbol: "XPage", hop: { confidence: "exact" as const } };
    const call = { lane: "ui" as const, kind: "call" as const, repo: "web", file: "lib/x.ts", line: 3, symbol: "getX", hop: { confidence: "exact" as const } };
    const fn = { lane: "ui" as const, kind: "function" as const, repo: "web", file: "lib/y.ts", line: 1, symbol: "other", hop: { confidence: "exact" as const } };
    const route = { lane: "api" as const, kind: "route" as const, repo: "api", file: "r.ts", line: 1, symbol: "h", op: "GET", label: "GET /api/x", hop: { confidence: "exact" as const, reason: "manual link" } };
    const urlItems = (chain: Chain) => buildCheckReport([chain], fakeWorkspace([api, web])).items.filter((i) => i.kind === "unresolved-url");
    // route reached from the call, with another stop listed in between: routed
    expect(urlItems(fakeChain({ stops: [page, { ...call, from: 0 }, { ...fn, from: 0 }, { ...route, from: 1 }] }))).toEqual([]);
    // route listed right after the call but reached from the page: not routed
    expect(urlItems(fakeChain({ stops: [page, { ...call, from: 0 }, { ...route, from: 0 }] }))).toHaveLength(1);
    // legacy chain without from: the next stop decides
    expect(urlItems(fakeChain({ stops: [page, call, route] }))).toEqual([]);
    expect(urlItems(fakeChain({ stops: [page, call, fn, route] }))).toHaveLength(1);
  });

  it("reports route-no-caller for a route no page chain targets", () => {
    const api = fakeRepoData(
      { id: "api", path: "api" },
      fakeEndpoints("api", {
        routes: [{ method: "DELETE", path: "/customers/:id", handler: "CustomersController.destroy", inline: false, framework: "adonis", at: { file: "start/routes.ts", line: 10, symbol: "<module>" } }],
      }),
    );
    const report = buildCheckReport([], fakeWorkspace([api]));
    expect(report.items).toEqual([
      { kind: "route-no-caller", repo: "api", file: "start/routes.ts", line: 10, symbol: "CustomersController.destroy", detail: "DELETE /customers/:id has no UI caller" },
    ]);
    expect(report.summary.uncalledRoutes).toBe(1);
  });

  it("does not report route-no-caller when a page chain's routeKey matches", () => {
    const api = fakeRepoData(
      { id: "api", path: "api" },
      fakeEndpoints("api", {
        routes: [{ method: "POST", path: "/api/x", handler: "X.store", inline: false, framework: "adonis", at: { file: "start/routes.ts", line: 1, symbol: "<module>" } }],
      }),
    );
    const chain = fakeChain({ entry: "page:web:/new", routeKey: "api:POST /api/x" });
    const report = buildCheckReport([chain], fakeWorkspace([api]));
    expect(report.items.filter((i) => i.kind === "route-no-caller")).toEqual([]);
  });

  // The linker suffixes colliding route keys with `@<file>#<n>`, so a plain routeKey compare would miss
  // them. The page chain's route stop (repo, file, line, method, label) identifies the route instead.
  it("matches a collision-suffixed page chain to its route by the route stop, and still flags the other route", () => {
    const route = (file: string, handler: string) =>
      ({ method: "GET" as const, path: "/:id", handler, inline: false, framework: "express" as const, at: { file, line: 4, symbol: "<module>" } });
    const api = fakeRepoData(
      { id: "api", path: "api" },
      fakeEndpoints("api", { routes: [route("src/a.ts", "getA"), route("src/b.ts", "getB")] }),
    );
    const chain = fakeChain({
      entry: "page:web:/a",
      routeKey: "api:GET /:id@src/a.ts#1",
      stops: [
        { lane: "api", kind: "route", repo: "api", file: "src/a.ts", line: 4, symbol: "getA", op: "GET", label: "GET /:id", hop: { confidence: "exact" } },
      ],
    });
    const report = buildCheckReport([chain], fakeWorkspace([api]));
    expect(report.items.filter((i) => i.kind === "route-no-caller")).toEqual([
      { kind: "route-no-caller", repo: "api", file: "src/b.ts", line: 4, symbol: "getB", detail: "GET /:id has no UI caller" },
    ]);
  });

  it("reports handler-not-found when a chain's walk stops at the route", () => {
    const chain = fakeChain({
      entry: "route:api:POST /api/x",
      complete: false,
      stops: [
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.store", op: "POST", label: "POST /api/x", hop: { confidence: "exact" } },
      ],
    });
    const report = buildCheckReport([chain], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"))]));
    expect(report.items).toEqual(
      expect.arrayContaining([
        { kind: "handler-not-found", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.store", detail: `${chain.name}: handler could not be located` },
      ]),
    );
    expect(report.summary.brokenUiApi).toBe(1);
  });

  it("reports no-store when a handler is reached but no db/queue stop follows", () => {
    const chain = fakeChain({
      entry: "route:api:GET /health",
      complete: false,
      stops: [
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 5, symbol: "GET /health", op: "GET", label: "GET /health", hop: { confidence: "exact" } },
        { lane: "code", kind: "function", repo: "api", file: "start/routes.ts", line: 5, symbol: "GET /health", hop: { confidence: "exact" } },
      ],
    });
    const report = buildCheckReport([chain], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"))]));
    expect(report.items).toEqual(
      expect.arrayContaining([
        { kind: "no-store", repo: "api", file: "start/routes.ts", line: 5, symbol: "GET /health", detail: `${chain.name} reaches no database table or queue` },
      ]),
    );
    expect(report.summary.missingDb).toBe(1);
  });

  it("reports unmatched-call from a chain's unresolved entries, and guess-link from guess hops", () => {
    const chain = fakeChain({
      confidence: "guess",
      unresolved: [{ at: { repo: "api", file: "app/x.ts", line: 9, symbol: "X.y" }, reason: "unresolved call: obj.m()" }],
      stops: [
        { lane: "ui", kind: "call", repo: "web", file: "lib/x.ts", line: 2, symbol: "getX", op: "GET", hop: { confidence: "exact" } },
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.show", op: "GET", label: "GET /api/x", hop: { confidence: "guess", reason: "suffix match" } },
      ],
    });
    const report = buildCheckReport([chain], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"))]));
    expect(report.items).toEqual(
      expect.arrayContaining([
        { kind: "unmatched-call", repo: "api", file: "app/x.ts", line: 9, symbol: "X.y", detail: "unresolved call: obj.m()" },
        { kind: "guess-link", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.show", detail: `suffix match (${chain.name})` },
      ]),
    );
    // unresolvedCalls counts unreadable URLs (unresolved-url) only; unmatched-call items are info only.
    expect(report.summary.unresolvedCalls).toBe(0);
    expect(report.summary.byConfidence).toEqual({ exact: 1, param: 0, guess: 1 });
  });

  it("items are sorted by kind, repo, file, line, detail", () => {
    const chainA = fakeChain({ id: "ch_00000000000a", unresolved: [{ at: { repo: "api", file: "b.ts", line: 2, symbol: "f" }, reason: "r2" }] });
    const chainB = fakeChain({ id: "ch_00000000000b", unresolved: [{ at: { repo: "api", file: "a.ts", line: 1, symbol: "f" }, reason: "r1" }] });
    const report = buildCheckReport([chainA, chainB], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"))]));
    expect(report.items.map((i) => i.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("framework calls listed as unresolved never make a complete chain count as broken or missing the DB", () => {
    const chain = fakeChain({
      complete: true,
      unresolved: [
        { at: { repo: "api", file: "app/c.ts", line: 3, symbol: "C.store" }, reason: 'could not resolve "res.json(...)"' },
        { at: { repo: "api", file: "app/c.ts", line: 4, symbol: "C.store" }, reason: 'could not resolve "logger.info(...)"' },
      ],
      stops: [
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "C.store", op: "POST", label: "POST /api/x", hop: { confidence: "exact" } },
        { lane: "code", kind: "handler", repo: "api", file: "app/c.ts", line: 2, symbol: "C.store", hop: { confidence: "exact" } },
        { lane: "db", kind: "db", repo: "api", file: "app/c.ts", line: 5, symbol: "C.store", op: "insert", label: "customers", hop: { confidence: "exact" } },
      ],
    });
    const report = buildCheckReport([chain], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"))]));
    expect(report.summary).toMatchObject({ chains: 1, complete: 1, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0 });
    expect(report.items.map((i) => i.kind)).toEqual(["unmatched-call", "unmatched-call"]);
    expect(formatCheckText(report)).toContain("1 journey: 1 complete UI → API → DB");
  });

  it("counts a page chain whose UI call matched no route (routeKey \"\") as broken at UI → API", () => {
    const chain = fakeChain({
      entry: "page:web:/x",
      routeKey: "",
      name: "POST /api/nope (unmatched) · XPage",
      complete: false,
      unresolved: [{ at: { repo: "web", file: "lib/x.ts", line: 2, symbol: "postX" }, reason: "no matching route for POST /api/nope" }],
      stops: [
        { lane: "ui", kind: "page", repo: "web", file: "app/x/page.tsx", line: 1, symbol: "XPage", hop: { confidence: "exact" } },
        { lane: "ui", kind: "call", repo: "web", file: "lib/x.ts", line: 2, symbol: "postX", op: "POST", label: "/api/nope", hop: { confidence: "exact" } },
      ],
    });
    const report = buildCheckReport([chain], fakeWorkspace([fakeRepoData({ id: "web", path: "web" }, fakeEndpoints("web"))]));
    expect(report.summary).toMatchObject({ chains: 1, complete: 0, missingDb: 0, brokenUiApi: 1, unresolvedCalls: 0 });
    expect(report.items).toEqual([
      { kind: "ui-no-route", repo: "web", file: "lib/x.ts", line: 2, symbol: "postX", detail: "no matching route for POST /api/nope" },
    ]);
    const text = formatCheckText(report);
    expect(text).toContain("1 journey: 0 complete UI → API → DB, 1 broken at UI → API");
    expect(text).toContain("UI calls that match no route (1):");
  });

  it("an unreadable URL elsewhere is a separate trailer, not a journey bucket", () => {
    const chain = fakeChain({
      stops: [
        { lane: "ui", kind: "page", repo: "web", file: "app/x/page.tsx", line: 1, symbol: "XPage", hop: { confidence: "exact" } },
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.store", op: "POST", label: "POST /api/x", hop: { confidence: "exact" } },
        { lane: "code", kind: "handler", repo: "api", file: "app/x.ts", line: 2, symbol: "X.store", hop: { confidence: "exact" } },
        { lane: "db", kind: "db", repo: "api", file: "app/x.ts", line: 3, symbol: "X.store", op: "insert", label: "xs", hop: { confidence: "exact" } },
      ],
    });
    const web = fakeRepoData(
      { id: "web", path: "web" },
      fakeEndpoints("web", {
        httpCalls: [{ method: "GET", path: "", raw: "fetch(url)", resolved: false, client: "fetch", kind: "unknown", at: { file: "lib/other.ts", line: 7, symbol: "getOther" } }],
      }),
    );
    const report = buildCheckReport([chain], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api")), web]));
    expect(report.summary).toMatchObject({ chains: 1, complete: 1, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 1 });
    expect(completePercent(report)).toBe(100);
    const lines = formatCheckText(report).split("\n");
    expect(lines[0]).toBe("1 journey: 1 complete UI → API → DB");
    expect(lines).toContain("1 call with a URL codeloom could not read");
    expect(lines).toContain("complete: 100%");
  });

  it("produces a report that passes CheckReportSchema", () => {
    const report = buildCheckReport([fakeChain({})], fakeWorkspace([fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api"))]));
    expect(CheckReportSchema.parse(report)).toEqual(report);
  });
});

describe("completePercent", () => {
  it("is 100 when there are no chains", () => {
    expect(completePercent({ version: 1, summary: { chains: 0, complete: 0, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 0, param: 0, guess: 0 } }, items: [] })).toBe(100);
  });

  it("rounds complete/chains to a whole percent", () => {
    expect(completePercent({ version: 1, summary: { chains: 3, complete: 2, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 0, param: 0, guess: 0 } }, items: [] })).toBe(67);
  });
});

describe("formatCheckText", () => {
  it("prints the §7a summary line, complete %, and groups items by kind", () => {
    const report = {
      version: 1 as const,
      summary: { chains: 3, complete: 1, missingDb: 1, brokenUiApi: 1, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 2, param: 1, guess: 0 } },
      items: [
        { kind: "no-store" as const, repo: "billing", file: "src/server.ts", line: 9, symbol: "GET /health", detail: "GET /health reaches no database table or queue" },
        { kind: "unresolved-url" as const, repo: "web", file: "lib/x.ts", line: 3, symbol: "getX", detail: "cannot read URL from fetch(url)" },
      ],
    };
    const text = formatCheckText(report);
    expect(text).toContain("3 journeys: 1 complete UI → API → DB, 1 missing the DB step, 1 broken at UI → API");
    expect(text).toContain("complete: 33%");
    expect(text).toContain("URLs that could not be read (1):");
    expect(text).toContain("  web/lib/x.ts:3 getX — cannot read URL from fetch(url)");
    expect(text).toContain("Routes or consumers that reach no database table or queue (1):");
    expect(text.indexOf("Routes or consumers")).toBeLessThan(text.indexOf("URLs that could not be read"));
  });

  it("says so when there are no issues", () => {
    const report = { version: 1 as const, summary: { chains: 1, complete: 1, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 1, param: 0, guess: 0 } }, items: [] };
    expect(formatCheckText(report)).toContain("No issues found.");
  });

  it("handles zero chains", () => {
    const report = { version: 1 as const, summary: { chains: 0, complete: 0, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 0, param: 0, guess: 0 } }, items: [] };
    expect(formatCheckText(report)).toContain("0 journeys: nothing indexed yet.");
  });

  it("lists unresolved calls last, marked as info that does not affect completeness", () => {
    const report = {
      version: 1 as const,
      summary: { chains: 1, complete: 1, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 1, uncalledRoutes: 1, byConfidence: { exact: 1, param: 0, guess: 0 } },
      items: [
        { kind: "route-no-caller" as const, repo: "api", file: "r.ts", line: 1, symbol: "h", detail: "GET /x has no UI caller" },
        { kind: "unmatched-call" as const, repo: "api", file: "c.ts", line: 2, symbol: "C.s", detail: 'could not resolve "res.json(...)"' },
      ],
    };
    const text = formatCheckText(report);
    expect(text).toContain("Calls that could not be resolved, info only — they do not affect completeness (1):");
    expect(text.indexOf("Routes with no UI caller")).toBeLessThan(text.indexOf("Calls that could not be resolved"));
    expect(text).not.toContain("UI calls that match no route");
  });
});

describe("formatCheckText grouping", () => {
  it("groups a ui-no-route item by kind, whatever the linker's reason text says", () => {
    const report = {
      version: 1 as const,
      summary: { chains: 1, complete: 0, missingDb: 0, brokenUiApi: 1, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 2, param: 0, guess: 0 } },
      items: [{ kind: "ui-no-route" as const, repo: "web", file: "lib/x.ts", line: 2, symbol: "postX", detail: "some other wording entirely" }],
    };
    const text = formatCheckText(report);
    expect(text).toContain("UI calls that match no route (1):\n  web/lib/x.ts:2 postX — some other wording entirely");
    expect(text).not.toContain("Calls that could not be resolved");
  });

  it("puts an unmatched-call worded like a missing route in the info group (kind decides, not text)", () => {
    const report = {
      version: 1 as const,
      summary: { chains: 1, complete: 1, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 1, param: 0, guess: 0 } },
      items: [{ kind: "unmatched-call" as const, repo: "api", file: "c.ts", line: 2, symbol: "C.s", detail: "no matching route for GET /x" }],
    };
    const text = formatCheckText(report);
    expect(text).not.toContain("UI calls that match no route");
    expect(text).toContain("Calls that could not be resolved, info only — they do not affect completeness (1):");
  });
});

describe("formatCheckJson", () => {
  it("round-trips through JSON.parse", () => {
    const report = { version: 1 as const, summary: { chains: 0, complete: 0, missingDb: 0, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 0, param: 0, guess: 0 } }, items: [] };
    expect(JSON.parse(formatCheckJson(report))).toEqual(report);
  });
});

function demoShopWorkspace() {
  const root = materializeFixture("demo-shop");
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  return root;
}

describe("buildReport", () => {
  it("is the report runCheck prints with --json; traces only add a traces section", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    const report = await buildReport(root);
    expect(report.summary.chains).toBe(7);
    const { output } = await runCheck(root, { json: true });
    expect(JSON.parse(output)).toEqual(report);
    expect(await buildReport(root, { traces: true })).toEqual({ ...report, traces: { skipped: "no trace source in codeloom.workspace.json" } });
  });

  it("throws exit 2 when chains.json is missing", async () => {
    const root = demoShopWorkspace();
    await expect(buildReport(root)).rejects.toThrow(/Run "codeloom index" first/);
  });
});

describe("runCheck", () => {
  it("reports exit code 0 on demo-shop with no --fail-under", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    const { output, exitCode, report } = await runCheck(root, {});
    expect(exitCode).toBe(0);
    expect(output).toMatch(/journeys?:/);
    expect(report.summary.chains).toBe(7);
    // Registry "Fixture changes" snapshot: no guess links; the pay route and /health have no UI caller.
    expect(report.items.filter((i) => i.kind === "guess-link")).toEqual([]);
    expect(report.items.filter((i) => i.kind === "route-no-caller").map((i) => i.detail)).toEqual([
      "POST /billing/invoices/:id/pay has no UI caller",
      "GET /health has no UI caller",
    ]);
    // The two incomplete chains are /health and the inline invoice.created consumer: neither reaches a
    // store. Framework calls (res.json, amqp.connect, ...) are listed but never counted as broken.
    expect(output.split("\n")[0]).toBe("7 journeys: 5 complete UI → API → DB, 2 missing the DB step");
    expect(report.summary).toMatchObject({ complete: 5, missingDb: 2, brokenUiApi: 0 });
  });

  it("splits every demo-shop chain into exactly one bucket (the buckets add up to the chains)", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    const { report } = await runCheck(root, {});
    const { chains, complete, missingDb, brokenUiApi } = report.summary;
    expect(chains).toBeGreaterThan(0);
    expect(complete + missingDb + brokenUiApi).toBe(chains);
    expect([complete, missingDb, brokenUiApi].every((n) => n >= 0)).toBe(true);
    expect(report.summary.unresolvedCalls).toBe(report.items.filter((i) => i.kind === "unresolved-url").length);
  });

  it("prints JSON with --json", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    const { output } = await runCheck(root, { json: true });
    expect(JSON.parse(output).version).toBe(1);
    expect(CheckReportSchema.safeParse(JSON.parse(output)).success).toBe(true);
  });

  it("exits 1 when complete% is below --fail-under", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    const { exitCode } = await runCheck(root, { failUnder: "100" });
    expect(exitCode).toBe(1);
    expect((await runCheck(root, { failUnder: "71" })).exitCode).toBe(0); // 5/7 = 71%
  });

  it("rejects an out-of-range --fail-under with a data error (exit 2)", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    for (const bad of ["101", "-1", "abc", "50.5"]) {
      try {
        await runCheck(root, { failUnder: bad });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CodeloomError);
        expect((err as CodeloomError).exitCode).toBe(2);
      }
    }
  });

  it("fails with exit 2 when chains.json is missing", async () => {
    const root = demoShopWorkspace();
    await expect(runCheck(root, {})).rejects.toThrow(/Run "codeloom index" first/);
    try {
      await runCheck(root, {});
    } catch (err) {
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });

  it("fails with exit 2 and a re-index message on a v1 endpoints.json", async () => {
    const root = demoShopWorkspace();
    await runIndex(root);
    const epPath = join(root, "api/.codeloom/endpoints.json");
    const ep = JSON.parse(readFileSync(epPath, "utf8"));
    ep.version = 1;
    writeFileSync(epPath, JSON.stringify(ep));
    await expect(runCheck(root, {})).rejects.toThrow(/endpoints version 1/);
    try {
      await runCheck(root, {});
    } catch (err) {
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });
});

describe("buildCheckReport — ui-unreached from reach facts (H3/H3b)", () => {
  const fact = (file: string, line: number, symbol: string, reached: boolean) => ({
    repo: "app", file, line, symbol, method: "POST" as const, path: "/api/post", reached,
  });
  const app = () => fakeRepoData({ id: "app", path: "app" }, fakeEndpoints("app", {}));

  it("lists every call the linker recorded as unreached, without changing the chain buckets", () => {
    const chains = [fakeChain({})];
    const report = buildCheckReport(chains, fakeWorkspace([app()]), [
      fact("src/app/create/page.tsx", 3, "submitData", true), fact("src/lib/orphan.ts", 7, "send", false),
    ]);
    expect(report.items.filter((i) => i.kind === "ui-unreached")).toEqual([
      { kind: "ui-unreached", repo: "app", file: "src/lib/orphan.ts", line: 7, symbol: "send", detail: "POST /api/post: call at src/lib/orphan.ts:7 is not reached from any page" },
    ]);
    expect(report.summary).toMatchObject({ chains: 1 });
    expect(CheckReportSchema.parse(report)).toEqual(report);
  });

  it("never builds ui-unreached items from chain stops: no facts, no items (a call: chain is not backend)", () => {
    const callChain = fakeChain({
      entry: "call:app:src/lib/orphan.ts#send",
      stops: [{ lane: "ui", kind: "call", repo: "app", file: "src/lib/orphan.ts", line: 7, symbol: "send", op: "POST", label: "/api/post", hop: { confidence: "exact" } }],
    });
    const ws = fakeWorkspace([fakeRepoData({ id: "app", path: "app" }, fakeEndpoints("app", {
      httpCalls: [{ method: "POST", path: "/api/post", raw: '"/api/post"', resolved: true, client: "fetch", kind: "literal", at: { file: "src/x.ts", line: 2, symbol: "x" } }],
    }))]);
    expect(buildCheckReport([callChain], ws).items.filter((i) => i.kind === "ui-unreached")).toEqual([]);
    expect(buildCheckReport([callChain], ws, [fact("src/lib/orphan.ts", 7, "send", false)]).items.filter((i) => i.kind === "ui-unreached")).toHaveLength(1);
  });

  it("a route whose only caller is a call-entry chain is not 'no UI caller'", () => {
    const api = fakeRepoData({ id: "api", path: "api" }, fakeEndpoints("api", {
      routes: [{ method: "GET", path: "/api/x", handler: "h", inline: false, framework: "express", at: { file: "src/r.ts", line: 3, symbol: "<module>" } }],
    }));
    expect(buildCheckReport([], fakeWorkspace([api])).items.filter((i) => i.kind === "route-no-caller")).toHaveLength(1);
    const callChain = fakeChain({
      entry: "call:web:src/a.ts#a", routeKey: "api:GET /api/x",
      stops: [
        { lane: "ui", kind: "call", repo: "web", file: "src/a.ts", line: 2, symbol: "a", op: "GET", label: "/api/x", hop: { confidence: "exact" } },
        { lane: "api", kind: "route", repo: "api", file: "src/r.ts", line: 3, symbol: "h", op: "GET", label: "GET /api/x", hop: { confidence: "exact" } },
      ],
    });
    expect(buildCheckReport([callChain], fakeWorkspace([api])).items.filter((i) => i.kind === "route-no-caller")).toEqual([]);
  });

  it("prints ui-unreached items in their own group", () => {
    const text = formatCheckText(buildCheckReport([], fakeWorkspace([app()]), [fact("src/lib/orphan.ts", 7, "send", false)]));
    expect(text).toContain("Calls not reached from any page (1):");
    expect(text).toContain("  app/src/lib/orphan.ts:7 send — POST /api/post: call at src/lib/orphan.ts:7 is not reached from any page");
  });
});

describe("check exit codes (final review item 2)", () => {
  const summary = { chains: 1000, complete: 946, missingDb: 54, brokenUiApi: 0, unresolvedCalls: 0, uncalledRoutes: 0, byConfidence: { exact: 0, param: 0, guess: 0 } };

  it("--fail-under compares the unrounded ratio: 94.6% fails --fail-under 95 though it prints as 95%", () => {
    const r = { version: 1 as const, summary, items: [] };
    expect(completePercent(r)).toBe(95);
    expect(belowFailUnder(r, 95)).toBe(true);
    expect(belowFailUnder(r, 94)).toBe(false);
    expect(belowFailUnder({ ...r, summary: { ...summary, complete: 950, missingDb: 50 } }, 95)).toBe(false);
  });

  it("a folder with no workspace and no git repo is a data error (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-nows-"));
    try {
      await runCheck(dir, {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).message).toMatch(/No codeloom workspace or git repo/);
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });
});
