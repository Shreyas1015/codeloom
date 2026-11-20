import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { applyAnswers } from "../src/map/answers.js";
import { capGaps, computeGaps, MAX_GAPS_CHARS } from "../src/map/gaps.js";
import type { MapState } from "../src/mcp/state.js";
import type { RepoData } from "../src/store/read.js";
import type { EndpointsFile } from "../src/store/schemas.js";

// 0.6 Task E (acceptance): on a real group map_gaps showed only 14 gaps within 12,000 characters. Each gap must be
// compact (at most 2 sample sites, no repeated text) so at least 30 fit. A big group built in memory: 40 services,
// each with uncalled routes and a call through a base no repo is known for.

const graph = (): KnowledgeGraph => ({
  version: "1",
  project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
  nodes: [], edges: [], layers: [], tour: [],
});

function service(i: number): RepoData {
  const id = `demo-service-number-${i}`;
  const route = (method: "GET" | "POST", path: string, handler: string, line: number) => ({
    method, path, handler, inline: false, framework: "express" as const,
    at: { file: "app/controllers/customer_accounts_controller.ts", line, symbol: handler },
  });
  const call = (line: number, path: string) => ({
    method: "GET" as const, path, raw: `\${process.env.LEGACY_PARTNER_${i}_URL}${path}`, resolved: true, client: "fetch",
    kind: "template" as const, base: `process.env.LEGACY_PARTNER_${i}_URL`,
    at: { file: "app/services/partner_accounts_service.ts", line, symbol: "PartnerAccountsService.refreshAccount" },
  });
  const endpoints: EndpointsFile = {
    version: 2, repo: id, pages: [], httpClients: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [],
    routes: [
      route("GET", `/v1/customer-accounts-${i}/:accountId/statements`, "CustomerAccountsController.statements", 10),
      route("POST", `/v1/customer-accounts-${i}/:accountId/refresh`, "CustomerAccountsController.refresh", 20),
      route("GET", `/v1/customer-accounts-${i}/:accountId/history`, "CustomerAccountsController.history", 30),
      route("GET", `/v1/customer-accounts-${i}/:accountId/limits`, "CustomerAccountsController.limits", 40),
    ],
    httpCalls: [call(12, `/partner-accounts/:id/balance`), call(18, `/partner-accounts/:id/limits`), call(24, `/partner-accounts/:id/owner`)],
  };
  return { ref: { id, path: `/tmp/x/${id}` }, abs: `/tmp/x/${id}`, graph: graph(), endpoints };
}

describe("map_gaps fits at least 30 gaps in 12,000 characters (0.6 Task E)", () => {
  it("on a 40-service group", () => {
    const repos = Array.from({ length: 40 }, (_, i) => service(i));
    const state = {
      ws: { root: "/tmp/x", name: "x", repos, links: [], group: "github.com/demo-shop" },
      chains: [], uiReach: [], manualLinks: [], external: [], unresolvedBases: [], wrapperCalls: [], journeys: [],
      chainsPath: "/tmp/x/chains.json", journeysPath: "/tmp/x/journeys.json",
    } as unknown as MapState;
    const cfg = applyAnswers({ repos: repos.map((r) => r.ref), links: [] }, []);
    const all = computeGaps({ state, cfg });
    expect(all.length).toBeGreaterThan(60);
    const r = capGaps(all);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(MAX_GAPS_CHARS);
    expect(r.shown).toBeGreaterThanOrEqual(30);
    for (const g of r.gaps) expect(g.evidence.length).toBeLessThanOrEqual(2);
  });
});
