import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runTraces } from "../src/check/traces/run.js";
import type { BuildReportOptions } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { readJson } from "../src/store/json.js";
import { loadWorkspaceData, type WorkspaceData } from "../src/store/read.js";
import { type Chain, ChainsFileSchema } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

/** `runTraces`'s Tempo wiring (Task 10): fetchTempoSpans is exercised in full in test/tempo.test.ts
 * (URLs, headers, concurrency, timeouts). Here we only check that runTraces plugs it in correctly: a
 * successful fetch is compared with the map, and a TraceSourceError (unreachable / 401 / timeout)
 * becomes a `skipped` reason rather than a thrown error — same as "no trace source". No real network:
 * every test passes a stub fetchImpl. */

const REPOS = [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }];

let root: string;
let ws: WorkspaceData;
let chains: Chain[];

beforeAll(async () => {
  root = materializeFixture("demo-shop");
  writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "demo-shop", repos: REPOS, links: [] }));
  await runIndex(root);
  ws = loadWorkspaceData(root);
  chains = readJson(join(root, ".codeloom", "chains.json"), ChainsFileSchema)!.chains;
}, 60_000);

describe("runTraces (tempo)", () => {
  it("fetches from Tempo and compares with the map, using a stub fetchImpl", async () => {
    const tempo: WorkspaceData = {
      ...ws,
      traces: { kind: "tempo", url: "http://localhost:3200", services: { "billing-svc": "billing" } },
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify({ traces: [{ traceID: "t1" }] }), { status: 200 });
      }
      if (url.includes("/api/traces/t1")) {
        return new Response(
          JSON.stringify({
            resourceSpans: [
              {
                resource: { attributes: [{ key: "service.name", value: { stringValue: "billing-svc" } }] },
                scopeSpans: [
                  {
                    spans: [
                      {
                        traceId: "a".repeat(32),
                        spanId: "1".repeat(16),
                        kind: 2,
                        attributes: [
                          { key: "http.request.method", value: { stringValue: "GET" } },
                          { key: "http.route", value: { stringValue: "/health" } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const opts: BuildReportOptions = { traces: true, fetchImpl, now: () => new Date("2024-01-01T00:00:00Z") };
    const out = await runTraces(tempo, chains, opts);
    expect(out).toMatchObject({ source: "tempo", confirmed: [{ routeKey: "billing:GET /health", hits: 1, stores: [] }] });
  });

  it("turns a Tempo failure (401) into a skipped reason, not a thrown error", async () => {
    const tempo: WorkspaceData = { ...ws, traces: { kind: "tempo", url: "http://localhost:3200" } };
    const fetchImpl = (async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
    const out = await runTraces(tempo, chains, { traces: true, fetchImpl, now: () => new Date() });
    expect(out).toMatchObject({ skipped: expect.stringContaining("tempo unreachable") });
    expect((out as { skipped: string }).skipped).toContain("401");
  });

  it("turns a Tempo timeout into a skipped reason", async () => {
    const tempo: WorkspaceData = { ...ws, traces: { kind: "tempo", url: "http://localhost:3200" } };
    const fetchImpl = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    const out = await runTraces(tempo, chains, { traces: true, fetchImpl, now: () => new Date() });
    expect(out).toMatchObject({ skipped: expect.stringContaining("tempo unreachable") });
    expect((out as { skipped: string }).skipped.toLowerCase()).toContain("timed out");
  });
});
