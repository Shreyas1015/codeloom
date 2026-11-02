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
import { type Chain, ChainsFileSchema, CheckReportSchema, TracesReportSchema } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

const TRAFFIC = fileURLToPath(new URL("./fixtures/otlp/demo-shop-traffic.json", import.meta.url));
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
        { repo: "api", kind: "store", method: "POST", route: "/api/customers", store: "table:sessions read", hits: 1, detail: "seen under api:POST /api/customers, but no chain from that route reaches it" },
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

  it("skips the tempo source until it is implemented", async () => {
    const tempo: WorkspaceData = { ...ws, traces: { kind: "tempo", url: "http://localhost:3200" } };
    expect(await runTraces(tempo, chains, { traces: true })).toEqual({ skipped: "tempo source not implemented yet" });
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

  it("formats a report without traces exactly as before", async () => {
    const report = await buildReport(root);
    expect(formatCheckText(report)).not.toContain("Traces");
  });
});
