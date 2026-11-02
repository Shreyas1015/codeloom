import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { formatCheckText } from "../src/check/format.js";
import { readOtlpFile, type TraceSpan } from "../src/check/traces/otlp.js";
import { compareTraces } from "../src/check/traces/compare.js";
import { runTraces } from "../src/check/traces/run.js";
import { buildReport, runCheck } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { readJson } from "../src/store/json.js";
import { loadWorkspaceData, type WorkspaceData } from "../src/store/read.js";
import { type Chain, ChainsFileSchema, CheckReportSchema, type StopKind, TracesReportSchema } from "../src/store/schemas.js";
import type { RepoData } from "../src/store/read.js";
import { materializeFixture } from "./helpers.js";

const TRAFFIC = fileURLToPath(new URL("./fixtures/otlp/demo-shop-traffic.json", import.meta.url));
const MALFORMED = fileURLToPath(new URL("./fixtures/otlp/malformed.json", import.meta.url));
const REPOS = [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }];

function writeWorkspace(root: string, traces?: unknown): void {
  writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "demo-shop", repos: REPOS, links: [], ...(traces ? { traces } : {}) }));
}

let root: string;
let ws: WorkspaceData;
let chains: Chain[];

beforeAll(async () => {
  root = materializeFixture("demo-shop");
  writeWorkspace(root);
  await runIndex(root);
  ws = loadWorkspaceData(root);
  chains = readJson(join(root, ".codeloom", "chains.json"), ChainsFileSchema)!.chains;
}, 60_000);

describe("compareTraces on demo-shop", () => {
  it("confirms routes, finds missing routes and stores, never-hit routes and unknown services", () => {
    const spans = readOtlpFile(TRAFFIC);
    const report = compareTraces(chains, ws, spans, "otlp-file");
    expect(TracesReportSchema.parse(report)).toEqual(report);
    expect(report).toEqual({
      source: "otlp-file",
      spans: 15,
      serverSpans: 7,
      confirmed: [
        { routeKey: "api:GET /api/customers/:id", hits: 2, stores: ["table:customers read"] },
        { routeKey: "api:POST /api/customers", hits: 1, stores: ["table:audit_logs insert", "table:customers insert"] },
        { routeKey: "billing:POST /billing/invoices", hits: 1, stores: ["queue:invoice.created publish", "table:invoices insert"] },
      ],
      missingInMap: [
        { repo: "api", kind: "store", method: "POST", route: "/api/customers", store: "table:sessions read", hits: 1, detail: "no chain from this route reaches it" },
        { repo: "billing", kind: "route", method: "DELETE", route: "/billing/invoices/:id", hits: 2, detail: "served in traffic, but the map has no matching route" },
      ],
      neverHit: ["billing:GET /health", "billing:POST /billing/invoices/:id/pay"],
      unmatchedServices: ["checkout"],
    });
  });

  it("maps a service name to a repo through traces.services", () => {
    const spans: TraceSpan[] = [
      { traceId: "a".repeat(32), spanId: "1".repeat(16), service: "billing-svc", kind: "server", http: { method: "GET", route: "/health" } },
    ];
    const mapped: WorkspaceData = { ...ws, traces: { kind: "tempo", url: "http://tempo", services: { "billing-svc": "billing" } } };
    const report = compareTraces(chains, mapped, spans, "tempo");
    expect(report.confirmed).toEqual([{ routeKey: "billing:GET /health", hits: 1, stores: [] }]);
    expect(report.unmatchedServices).toEqual([]);
    expect(compareTraces(chains, ws, spans, "tempo").unmatchedServices).toEqual(["billing-svc"]);
  });

  it("matches [param] route templates and ignores server spans with no http info", () => {
    const spans: TraceSpan[] = [
      { traceId: "b".repeat(32), spanId: "1".repeat(16), service: "billing", kind: "server", http: { method: "POST", route: "/billing/invoices/[id]/pay" } },
      { traceId: "b".repeat(32), spanId: "2".repeat(16), service: "billing", kind: "server" },
    ];
    const report = compareTraces(chains, ws, spans, "otlp-file");
    expect(report.confirmed).toEqual([{ routeKey: "billing:POST /billing/invoices/:id/pay", hits: 1, stores: [] }]);
    expect(report.missingInMap).toEqual([]);
    expect(report.serverSpans).toBe(2);
  });

  it("is deterministic whatever the span order", () => {
    const spans = readOtlpFile(TRAFFIC);
    expect(compareTraces(chains, ws, [...spans].reverse(), "otlp-file")).toEqual(compareTraces(chains, ws, spans, "otlp-file"));
  });
});

describe("runTraces", () => {
  it("skips when the workspace has no trace source", async () => {
    expect(await runTraces(ws, chains, { traces: true })).toEqual({ skipped: "no trace source in codeloom.workspace.json" });
  });

  it("reads an otlp-file path relative to the workspace root", async () => {
    const withFile: WorkspaceData = { ...ws, traces: { kind: "otlp-file", path: "traffic.json" } };
    copyFileSync(TRAFFIC, join(root, "traffic.json"));
    const out = await runTraces(withFile, chains, { traces: true });
    expect(out).toMatchObject({ source: "otlp-file", spans: 15 });
  });

  it("throws a dataError (exit 2) when the otlp file is missing", async () => {
    const missing: WorkspaceData = { ...ws, traces: { kind: "otlp-file", path: "nope.json" } };
    const err = await runTraces(missing, chains, { traces: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeloomError);
    expect((err as CodeloomError).exitCode).toBe(2);
  });
});

describe("check --traces", () => {
  it("leaves traces out of the report unless asked", async () => {
    const report = await buildReport(root);
    expect(report.traces).toBeUndefined();
  });

  it("adds a skipped line when there is no trace source, and keeps the exit code", async () => {
    const { report, output, exitCode } = await runCheck(root, { traces: true });
    expect(report.traces).toEqual({ skipped: "no trace source in codeloom.workspace.json" });
    expect(output).toContain("Traces: skipped — no trace source in codeloom.workspace.json");
    expect(exitCode).toBe(0);
    expect(CheckReportSchema.parse(report)).toEqual(report);
  });

  it("prints the traces section from the otlp file and never changes the exit code", async () => {
    copyFileSync(TRAFFIC, join(root, "traffic.json"));
    writeWorkspace(root, { kind: "otlp-file", path: "traffic.json" });
    try {
      const plain = await runCheck(root, { failUnder: "0" });
      const { report, output, exitCode } = await runCheck(root, { traces: true, failUnder: "0" });
      expect(exitCode).toBe(plain.exitCode);
      expect(CheckReportSchema.parse(report)).toEqual(report);
      expect(output).toContain(
        "Traces (otlp-file, 15 spans): 3 routes confirmed, 2 links seen in traffic but missing from the map, 2 routes never hit",
      );
      expect(output).toContain("  billing DELETE /billing/invoices/:id — served in traffic, but the map has no matching route (2 hits)");
      expect(output).toContain("  billing:GET /health");
      expect(output).toContain("  checkout");
      const failing = await runCheck(root, { traces: true, failUnder: "100" });
      expect(failing.exitCode).toBe((await runCheck(root, { failUnder: "100" })).exitCode);
      const json = await runCheck(root, { traces: true, json: true });
      expect(JSON.parse(json.output).traces.confirmed).toHaveLength(3);
    } finally {
      writeWorkspace(root);
    }
  });

  it("exits 2 when the configured otlp file is missing", async () => {
    writeWorkspace(root, { kind: "otlp-file", path: "missing.json" });
    try {
      const err = await runCheck(root, { traces: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).exitCode).toBe(2);
    } finally {
      writeWorkspace(root);
    }
  });

  it("exits 2 when the configured otlp file is malformed", async () => {
    copyFileSync(MALFORMED, join(root, "malformed.json"));
    writeWorkspace(root, { kind: "otlp-file", path: "malformed.json" });
    try {
      const err = await runCheck(root, { traces: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).exitCode).toBe(2);
    } finally {
      writeWorkspace(root);
    }
  });

  it("prints a store item without repeating the route in its detail", async () => {
    copyFileSync(TRAFFIC, join(root, "traffic.json"));
    writeWorkspace(root, { kind: "otlp-file", path: "traffic.json" });
    try {
      const { output } = await runCheck(root, { traces: true, failUnder: "0" });
      expect(output).toContain("  api POST /api/customers → table:sessions read — no chain from this route reaches it (1 hit)");
    } finally {
      writeWorkspace(root);
    }
  });

  it("formats a report without traces exactly as before", async () => {
    const report = await buildReport(root);
    expect(formatCheckText(report)).not.toContain("Traces");
  });
});

// ---- Unit cases on hand-built chains: every matching guard has a case that fails without it. ----------

type StopSpec = [kind: StopKind, repo: string, label?: string, op?: string];
function mkChain(routeKey: string, stops: StopSpec[]): Chain {
  return {
    id: "ch_000000000000", entry: `route:${routeKey}`, routeKey, name: routeKey, unresolved: [], confidence: "exact", complete: true,
    stops: stops.map(([kind, repo, label, op]) => ({
      lane: "api" as const, kind, repo, file: "f.ts", line: 1, symbol: "s", hop: { confidence: "exact" as const },
      ...(label !== undefined ? { label } : {}), ...(op !== undefined ? { op } : {}),
    })),
  };
}
const routeChain = (repo: string, label: string, more: StopSpec[] = [], key = `${repo}:${label}`) =>
  mkChain(key, [["route", repo, label], ...more]);
function fakeWs(traces?: WorkspaceData["traces"]): WorkspaceData {
  const repos = ["a", "api", "billing"].map((id) => ({ ref: { id, path: id } }) as unknown as RepoData);
  return { root: "/nowhere", name: "t", repos, links: [], ...(traces ? { traces } : {}) };
}
let nextId = 0;
function span(service: string, kind: TraceSpan["kind"], extra: Partial<TraceSpan> = {}): TraceSpan {
  nextId += 1;
  return { traceId: "c".repeat(32), spanId: nextId.toString(16).padStart(16, "0"), service, kind, ...extra };
}
const server = (service: string, method: string, route: string, extra: Partial<TraceSpan> = {}) =>
  span(service, "server", { http: { method, route }, ...extra });
const child = (parent: TraceSpan, service: string, kind: TraceSpan["kind"], extra: Partial<TraceSpan> = {}) =>
  span(service, kind, { parentSpanId: parent.spanId, ...extra });
const run = (chainsIn: Chain[], spans: TraceSpan[], w = fakeWs()) => compareTraces(chainsIn, w, spans, "otlp-file");

describe("compareTraces route ranking", () => {
  it("prefers the route with the exact method over an ANY route", () => {
    const r = run([routeChain("a", "ANY /x"), routeChain("a", "GET /x")], [server("a", "GET", "/x")]);
    expect(r.confirmed.map((c) => c.routeKey)).toEqual(["a:GET /x"]);
    expect(r.missingInMap).toEqual([]);
  });

  it("an ANY route still matches when it is the only one", () => {
    const r = run([routeChain("a", "ANY /x")], [server("a", "DELETE", "/x")]);
    expect(r.confirmed.map((c) => c.routeKey)).toEqual(["a:ANY /x"]);
  });

  it("rejects a method mismatch", () => {
    const r = run([routeChain("a", "POST /x")], [server("a", "GET", "/x")]);
    expect(r.confirmed).toEqual([]);
    expect(r.missingInMap).toEqual([{ repo: "a", kind: "route", method: "GET", route: "/x", hits: 1, detail: "served in traffic, but the map has no matching route" }]);
  });

  it("a literal segment beats a param", () => {
    const chainsIn = [routeChain("a", "GET /x/:id"), routeChain("a", "GET /x/new")];
    expect(run(chainsIn, [server("a", "GET", "/x/new")]).confirmed.map((c) => c.routeKey)).toEqual(["a:GET /x/new"]);
    expect(run(chainsIn, [server("a", "GET", "/x/7")]).confirmed.map((c) => c.routeKey)).toEqual(["a:GET /x/:id"]);
  });

  it("more literal segments win at equal confidence", () => {
    const r = run([routeChain("a", "GET /:a/y/:c"), routeChain("a", "GET /x/:id/z")], [server("a", "GET", "/x/y/z")]);
    expect(r.confirmed.map((c) => c.routeKey)).toEqual(["a:GET /x/:id/z"]);
  });

  it("on equal literals, the better match confidence wins", () => {
    const r = run([routeChain("a", "GET /:rest*"), routeChain("a", "GET /:a")], [server("a", "GET", "/:id")]);
    expect(r.confirmed.map((c) => c.routeKey)).toEqual(["a:GET /:a"]);
  });

  it("rejects a span param set against a map literal", () => {
    const r = run([routeChain("a", "GET /x/new")], [server("a", "GET", "/x/:id")]);
    expect(r.confirmed).toEqual([]);
    expect(r.missingInMap.map((m) => m.route)).toEqual(["/x/:id"]);
  });

  it("a true tie confirms nothing and is reported as ambiguous", () => {
    const r = run([routeChain("a", "GET /p/:a/z"), routeChain("a", "GET /p/y/:b")], [server("a", "GET", "/p/y/z")]);
    expect(r.confirmed).toEqual([]);
    expect(r.missingInMap).toEqual([
      { repo: "a", kind: "route", method: "GET", route: "/p/y/z", hits: 1, detail: "ambiguous: matches a:GET /p/:a/z, a:GET /p/y/:b" },
    ]);
  });

  it("two routes with one method and path (@file#n keys) are a tie; neverHit keeps the chain's routeKey", () => {
    const chainsIn = [
      routeChain("a", "GET /d", [], "a:GET /d@r1.ts#1"),
      routeChain("a", "GET /d", [], "a:GET /d@r2.ts#2"),
    ];
    const r = run(chainsIn, [server("a", "GET", "/d")]);
    expect(r.confirmed).toEqual([]);
    expect(r.missingInMap[0]!.detail).toBe("ambiguous: matches a:GET /d@r1.ts#1, a:GET /d@r2.ts#2");
    expect(run(chainsIn, []).neverHit).toEqual(["a:GET /d@r1.ts#1", "a:GET /d@r2.ts#2"]);
  });
});

describe("compareTraces route keys", () => {
  it("a route stop inside another chain whose plain key belongs to suffixed routes is not a route of its own", () => {
    const chainsIn = [
      routeChain("billing", "GET /d", [], "billing:GET /d@r1.ts#1"),
      routeChain("billing", "GET /d", [], "billing:GET /d@r2.ts#2"),
      routeChain("api", "GET /a", [["call", "api"], ["route", "billing", "GET /d"]]),
    ];
    expect(run(chainsIn, []).neverHit).toEqual(["api:GET /a", "billing:GET /d@r1.ts#1", "billing:GET /d@r2.ts#2"]);
  });

  it("a route stop in a chain with no routeKey (a consumer) is keyed by its repo and label", () => {
    const chainsIn = [mkChain("", [["consume", "api", "jobs"], ["call", "api"], ["route", "billing", "GET /x"]])];
    expect(run(chainsIn, []).neverHit).toEqual(["billing:GET /x"]);
  });
});

describe("compareTraces stores per route", () => {
  it("counts a store once per server span", () => {
    const chainsIn = [routeChain("api", "POST /pay")];
    const s = server("api", "POST", "/pay");
    const db = { db: { table: "t", op: "insert" } };
    const r = run(chainsIn, [s, child(s, "api", "client", db), child(s, "api", "client", db)]);
    expect(r.missingInMap.map((m) => m.hits)).toEqual([1]);
  });

  it("a table reached only by a later route's stops is missing for the first route", () => {
    const chainsIn = [
      routeChain("api", "POST /pay", [["handler", "api"], ["call", "api"], ["route", "billing", "POST /invoices"], ["db", "billing", "invoices", "insert"]]),
      routeChain("billing", "POST /invoices", [["db", "billing", "invoices", "insert"]]),
    ];
    const s = server("api", "POST", "/pay");
    const r = run(chainsIn, [s, child(s, "api", "client", { db: { table: "invoices", op: "INSERT" } })]);
    expect(r.confirmed).toEqual([{ routeKey: "api:POST /pay", hits: 1, stores: [] }]);
    expect(r.missingInMap).toEqual([{ repo: "api", kind: "store", method: "POST", route: "/pay", store: "table:invoices insert", hits: 1, detail: "no chain from this route reaches it" }]);
  });

  it("stores after the next route stop in the same repo belong to that route", () => {
    const chainsIn = [routeChain("api", "POST /pay", [["call", "api"], ["route", "api", "POST /inner"], ["db", "api", "t", "insert"]])];
    const s = server("api", "POST", "/pay");
    const r = run(chainsIn, [s, child(s, "api", "client", { db: { table: "t", op: "insert" } })]);
    expect(r.missingInMap.map((m) => m.store)).toEqual(["table:t insert"]);
  });

  it("a table name must agree with the map", () => {
    const chainsIn = [routeChain("api", "POST /pay", [["db", "api", "a", "insert"]])];
    const s = server("api", "POST", "/pay");
    const r = run(chainsIn, [s, child(s, "api", "client", { db: { table: "b", op: "insert" } })]);
    expect(r.missingInMap.map((m) => m.store)).toEqual(["table:b insert"]);
  });

  it("the later route still gets its own stores from the same chain", () => {
    const chainsIn = [routeChain("api", "POST /pay", [["call", "api"], ["route", "billing", "POST /invoices"], ["db", "billing", "invoices", "insert"]])];
    const s = server("billing", "POST", "/invoices");
    const r = run(chainsIn, [s, child(s, "billing", "client", { db: { table: "invoices", op: "insert" } })]);
    expect(r.confirmed).toEqual([{ routeKey: "billing:POST /invoices", hits: 1, stores: ["table:invoices insert"] }]);
  });

  it("only stops in the route's own repo count", () => {
    const chainsIn = [routeChain("api", "POST /pay", [["db", "billing", "invoices", "insert"]])];
    const s = server("api", "POST", "/pay");
    const r = run(chainsIn, [s, child(s, "api", "client", { db: { table: "invoices", op: "insert" } })]);
    expect(r.missingInMap.map((m) => m.store)).toEqual(["table:invoices insert"]);
  });

  it("a paired consumer's stops (after a consume stop) do not belong to the route", () => {
    const chainsIn = [routeChain("api", "POST /pay", [["publish", "api", "jobs"], ["consume", "api", "jobs"], ["db", "api", "audit", "insert"]])];
    const s = server("api", "POST", "/pay");
    const r = run(chainsIn, [s, child(s, "api", "client", { db: { table: "audit", op: "insert" } })]);
    expect(r.missingInMap.map((m) => m.store)).toEqual(["table:audit insert"]);
  });

  it("a table op must agree with the map op", () => {
    const chainsIn = [routeChain("api", "POST /pay", [["db", "api", "invoices", "read"]])];
    const s = server("api", "POST", "/pay");
    const r = run(chainsIn, [s, child(s, "api", "client", { db: { table: "invoices", op: "INSERT" } })]);
    expect(r.missingInMap.map((m) => m.store)).toEqual(["table:invoices insert"]);
  });
});

describe("compareTraces span walk boundaries", () => {
  const chainsIn = [routeChain("api", "POST /pay", [["db", "api", "invoices", "insert"]])];
  const expectNothingBelow = (r: ReturnType<typeof run>) => {
    expect(r.confirmed).toEqual([{ routeKey: "api:POST /pay", hits: 1, stores: [] }]);
    expect(r.missingInMap).toEqual([]);
  };

  it("stops at a nested server span", () => {
    const s = server("api", "POST", "/pay");
    const nested = child(s, "api", "server");
    expectNothingBelow(run(chainsIn, [s, nested, child(nested, "api", "client", { db: { table: "invoices", op: "insert" } })]));
  });

  it("stops at a consumer span", () => {
    const s = server("api", "POST", "/pay");
    const consumer = child(s, "api", "consumer");
    expectNothingBelow(run(chainsIn, [s, consumer, child(consumer, "api", "client", { db: { table: "invoices", op: "insert" } })]));
  });

  it("stops at a span of another service", () => {
    const s = server("api", "POST", "/pay");
    const other = child(s, "billing", "client");
    expectNothingBelow(run(chainsIn, [s, other, child(other, "billing", "client", { db: { table: "invoices", op: "insert" } })]));
  });

  it("walks through same-service internal spans", () => {
    const s = server("api", "POST", "/pay");
    const mid = child(s, "api", "internal");
    const r = run(chainsIn, [s, mid, child(mid, "api", "client", { db: { table: "invoices", op: "insert" } })]);
    expect(r.confirmed).toEqual([{ routeKey: "api:POST /pay", hits: 1, stores: ["table:invoices insert"] }]);
  });
});

describe("compareTraces queue matching", () => {
  const publishing = (...labels: string[]) => [routeChain("api", "POST /q", labels.map((l): StopSpec => ["publish", "api", l]))];
  const send = (chainsIn: Chain[], dest: string) => {
    const s = server("api", "POST", "/q");
    return run(chainsIn, [s, child(s, "api", "producer", { messaging: { destination: dest } })]);
  };
  const storesOf = (r: ReturnType<typeof run>) => r.confirmed[0]?.stores ?? [];

  it("matches an exact label", () => {
    expect(storesOf(send(publishing("billing:invoice.paid"), "billing:invoice.paid"))).toEqual(["queue:billing:invoice.paid publish"]);
  });

  it("matches the routing-key side of an exchange:key label", () => {
    expect(storesOf(send(publishing("billing:invoice.paid"), "invoice.paid"))).toEqual(["queue:billing:invoice.paid publish"]);
  });

  it("matches the exchange side of an exchange:key label", () => {
    expect(storesOf(send(publishing("billing:invoice.paid"), "billing"))).toEqual(["queue:billing:invoice.paid publish"]);
  });

  it("does not match part of a name", () => {
    const r = send(publishing("billing:invoice.paid"), "invoice");
    expect(storesOf(r)).toEqual([]);
    expect(r.missingInMap.map((m) => m.store)).toEqual(["queue:invoice publish"]);
  });

  it("does not match a prefix of the exchange", () => {
    expect(storesOf(send(publishing("billing"), "billin"))).toEqual([]);
    expect(storesOf(send(publishing("billing:k"), "billin"))).toEqual([]);
  });

  it("prefers an exact label over a routing key", () => {
    expect(storesOf(send(publishing("billing", "x:billing"), "billing"))).toEqual(["queue:billing publish"]);
  });

  it("prefers a routing key over an exchange", () => {
    expect(storesOf(send(publishing("ex:billing", "billing:k"), "billing"))).toEqual(["queue:ex:billing publish"]);
  });

  it("an exchange-only destination with two different keys confirms neither", () => {
    const r = send(publishing("billing:invoice.created", "billing:invoice.paid"), "billing");
    expect(storesOf(r)).toEqual([]);
    expect(r.missingInMap).toEqual([{
      repo: "api", kind: "store", method: "POST", route: "/q", store: "queue:billing publish", hits: 1,
      detail: "ambiguous: matches queue:billing:invoice.created, queue:billing:invoice.paid",
    }]);
  });
});

describe("compareTraces services", () => {
  it("remaps a service through an otlp-file services map", () => {
    const w = fakeWs({ kind: "otlp-file", path: "x.json", services: { "billing-svc": "billing" } } as WorkspaceData["traces"]);
    const r = run([routeChain("billing", "GET /health")], [server("billing-svc", "GET", "/health")], w);
    expect(r.confirmed.map((c) => c.routeKey)).toEqual(["billing:GET /health"]);
    expect(r.unmatchedServices).toEqual([]);
  });

  it("skips an empty service name in unmatchedServices", () => {
    const r = run([], [span("", "internal"), span("nope", "internal")]);
    expect(r.unmatchedServices).toEqual(["nope"]);
  });
});
