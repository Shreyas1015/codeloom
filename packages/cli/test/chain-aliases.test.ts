import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildChains, chainId, sortChains, syncJourneys } from "../src/linker/chains.js";
import type { BackendLink, LinkResult, UiLink } from "../src/linker/link.js";
import { chainLookup } from "../src/mcp/state.js";
import { getJourney, listChains, saveJourneysTool } from "../src/mcp/tools/journeys.js";
import { workspaceOverview } from "../src/mcp/tools/workspace.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import { type Chain, ChainsFileSchema, type DbAccess, type EndpointsFile, type HttpCall, type Route, type UiPage } from "../src/store/schemas.js";
import { journeyRows } from "../src/web/api.js";
import { materializeFixture } from "./helpers.js";

const graph: KnowledgeGraph = {
  version: "1",
  project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
  nodes: [], edges: [], layers: [], tour: [],
};

function endpoints(repo: string, partial: Partial<EndpointsFile>): EndpointsFile {
  return { version: 2, repo, pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [], ...partial };
}

const RK = "api:POST /api/invoices";
const ROUTE_ID = chainId(`route:${RK}`, RK);
const CALL_ID = chainId("call:web:lib/use-create-invoice.ts#useCreateInvoice", RK);
const PAGE_ID = chainId("page:web:/invoices/new", RK);

/** One API route (POST /api/invoices -> invoices insert), and optionally a UI caller: a page reaching it
 * (`ui: "page"`) or a call no page reaches (`ui: "call"`). */
function flow(ui: "none" | "page" | "call"): { ws: WorkspaceData; links: LinkResult } {
  const call: HttpCall = { method: "POST", path: "/api/invoices", raw: '"/api/invoices"', resolved: true, client: "api", at: { file: "lib/use-create-invoice.ts", line: 3, symbol: "useCreateInvoice" }, kind: "literal" };
  const page: UiPage = { route: "/invoices/new", file: "app/invoices/new/page.tsx", line: 2, framework: "next-app" };
  const route: Route = { method: "POST", path: "/api/invoices", handler: "InvoicesController.store", inline: false, framework: "adonis", at: { file: "start/routes.ts", line: 1, symbol: "<module>" }, handlerFile: "app/controllers/invoices_controller.ts" };
  const effRoute = { repo: "api", route, effectivePath: "/api/invoices", mountsKnown: true, mounts: [] };
  const handler = { repo: "api", file: "app/controllers/invoices_controller.ts", symbol: "InvoicesController.store" };
  const access: DbAccess = { table: "invoices", op: "insert", via: "lucid", at: { file: handler.file, line: 4, symbol: handler.symbol } };
  const backend: BackendLink = {
    repo: "api", route: effRoute, handler, handlerConfidence: "exact",
    hits: [{ kind: "db", access, viaPath: [{ ref: handler, depth: 0 }] }], unresolved: [],
  };
  const uiLink: UiLink = {
    repo: "web", call,
    pages: ui === "page" ? [{
      page,
      path: [
        { repo: "web", file: page.file, symbol: "NewInvoicePage", confidence: "exact" },
        { repo: "web", file: call.at.file, symbol: "useCreateInvoice", confidence: "exact" },
      ],
      confidence: "exact",
    }] : [],
    target: { kind: "route", route: effRoute, confidence: "exact" },
  };
  const web: RepoData = { ref: { id: "web", path: "web" }, abs: "/ws/web", graph, endpoints: endpoints("web", { pages: [page], httpCalls: [call] }) };
  const api: RepoData = { ref: { id: "api", path: "api" }, abs: "/ws/api", graph, endpoints: endpoints("api", { routes: [route], dbAccess: [access] }) };
  const ws: WorkspaceData = { root: "/ws", name: "ws", repos: [api, web], links: [] };
  const uiReach = ui === "none" ? [] : [{ repo: "web", file: call.at.file, line: call.at.line, symbol: call.at.symbol, method: call.method, path: call.path, reached: ui === "page" }];
  return { ws, links: { ui: ui === "none" ? [] : [uiLink], backend: [backend], consumers: [], queuePairs: [], manual: [], uiReach } };
}

const chainsOf = (ui: "none" | "page" | "call"): Chain[] => {
  const { ws, links } = flow(ui);
  return sortChains(buildChains(ws, links));
};

describe("H11: chain aliases", () => {
  it("a route-only chain has no aliases (its route id is its own id)", () => {
    const [route] = chainsOf("none");
    expect(route!.id).toBe(ROUTE_ID);
    expect(route!.aliases).toBeUndefined();
  });

  it("a call-entry chain aliases its route-only id; a page chain also aliases its call stops' call-entry ids", () => {
    const [call] = chainsOf("call");
    expect(call!.id).toBe(CALL_ID);
    expect(call!.aliases).toEqual([ROUTE_ID]);
    const [page] = chainsOf("page");
    expect(page!.id).toBe(PAGE_ID);
    expect(page!.aliases).toEqual([CALL_ID, ROUTE_ID].sort());
    expect(page!.aliases).not.toContain(page!.id);
  });

  it("is deterministic, and chains.json without aliases still loads", () => {
    expect(JSON.stringify(chainsOf("page"))).toBe(JSON.stringify(chainsOf("page")));
    const old = chainsOf("page").map(({ aliases: _drop, ...c }) => c);
    expect(ChainsFileSchema.parse({ version: 1, chains: old }).chains[0]!.aliases).toBeUndefined();
  });

  it("chainLookup resolves ids first, then aliases; missing only when neither resolves", () => {
    const lookup = chainLookup(chainsOf("page"));
    expect(lookup.resolve([ROUTE_ID, "ch_000000000000", PAGE_ID])).toEqual({
      chains: chainsOf("page"),
      missing: ["ch_000000000000"],
      moved: [{ from: ROUTE_ID, to: [PAGE_ID] }],
    });
    expect(lookup.resolve([CALL_ID]).moved).toEqual([{ from: CALL_ID, to: [PAGE_ID] }]);
  });
});

describe("H11: a journey named on a route-only chain survives a UI caller being added", () => {
  function wsRoot(journeyChainIds: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "codeloom-aliases-"));
    mkdirSync(join(root, ".codeloom"));
    writeFileSync(join(root, ".codeloom", "journeys.json"), JSON.stringify({
      version: 1,
      journeys: [{ id: "j_000000000001", name: "Create an invoice", area: "", note: "", chainIds: journeyChainIds, status: "ok" }],
    }));
    return root;
  }
  const statusOf = (root: string) => JSON.parse(readFileSync(join(root, ".codeloom", "journeys.json"), "utf8")).journeys[0].status;

  it("stays ok when the route gains a call-entry chain, then a page chain", () => {
    const root = wsRoot([ROUTE_ID]);
    expect(syncJourneys(root, chainsOf("none"))).toEqual({ created: false, orphaned: 0, changed: false });
    expect(syncJourneys(root, chainsOf("call"))).toEqual({ created: false, orphaned: 0, changed: false });
    expect(syncJourneys(root, chainsOf("page"))).toEqual({ created: false, orphaned: 0, changed: false });
    expect(statusOf(root)).toBe("ok");
  });

  it("a journey named on the call-entry chain stays ok once a page reaches the call", () => {
    const root = wsRoot([CALL_ID]);
    expect(syncJourneys(root, chainsOf("page")).orphaned).toBe(0);
    expect(statusOf(root)).toBe("ok");
  });

  it("is orphaned only when no id resolves either way", () => {
    const root = wsRoot([PAGE_ID]);
    expect(syncJourneys(root, chainsOf("none"))).toEqual({ created: false, orphaned: 1, changed: true });
    expect(statusOf(root)).toBe("orphaned");
    expect(syncJourneys(root, chainsOf("page"))).toEqual({ created: false, orphaned: 0, changed: true });
  });
});

describe("H11: readers resolve journey chain ids through aliases (demo-shop)", () => {
  let demo: string;
  let createId: string;
  let aliasId: string;
  const J = "j_00000000a11a";

  beforeAll(async () => {
    demo = materializeFixture("demo-shop");
    writeFileSync(join(demo, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [],
    }));
    await runIndex(demo);
    const chains = ChainsFileSchema.parse(JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8"))).chains;
    const create = chains.find((c) => c.routeKey === "api:POST /api/customers" && c.entry.startsWith("page:"))!;
    createId = create.id;
    aliasId = chainId(`route:${create.routeKey}`, create.routeKey);
    expect(create.aliases).toContain(aliasId);
    // As if the journey was named while POST /api/customers had no UI caller (a route-only chain).
    writeFileSync(join(demo, ".codeloom", "journeys.json"), JSON.stringify({
      version: 1,
      journeys: [{ id: J, name: "Sign up a customer", area: "customers", note: "", chainIds: [aliasId], status: "ok" }],
    }));
  }, 60_000);

  it("get_journey lays out the current chain and reports the move, not a missing id", () => {
    const r = getJourney(demo, J);
    expect((r.chains as Array<{ id: string }>).map((c) => c.id)).toEqual([createId]);
    expect(r.missingChainIds).toEqual([]);
    expect(r.movedChainIds).toEqual([{ from: aliasId, to: [createId] }]);
    expect((r.lanes as Record<string, unknown[]>).ui!.length).toBeGreaterThan(0);
  });

  it("list_chains shows the journey on the current chain, so it is not unnamed", () => {
    const rows = listChains(demo, {}).chains as Array<{ id: string; journeys: string[] }>;
    expect(rows.find((c) => c.id === createId)!.journeys).toEqual([J]);
    expect((listChains(demo, { unnamed: true }).chains as Array<{ id: string }>).map((c) => c.id)).not.toContain(createId);
  });

  it("workspace_overview does not count the current chain as unnamed", () => {
    const o = workspaceOverview(demo) as { unnamedChains: number; chains: { total: number } };
    expect(o.unnamedChains).toBe(o.chains.total - 1);
  });

  it("the dashboard's journey rows count the moved chain as present", () => {
    const chains = ChainsFileSchema.parse(JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8"))).chains;
    const r = journeyRows({ chains, journeys: [{ id: J, name: "Sign up a customer", area: "", note: "", chainIds: [aliasId], status: "ok" }] });
    expect(r.journeys[0]!.complete).toBe(true);
    expect(r.journeys[0]!.stops.ui).toBeGreaterThan(0);
    expect(r.unnamedChains.map((c) => c.id)).not.toContain(createId);
  });

  it("save_journeys create with an alias-only id stores the current id", () => {
    const res = saveJourneysTool(demo, [{ op: "create", name: "Create a customer", chainIds: [aliasId] }]) as { created: string[] };
    expect(res.created).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(demo, ".codeloom", "journeys.json"), "utf8")).journeys
      .find((j: { id: string }) => j.id === res.created[0]);
    expect(saved.chainIds).toEqual([createId]);
  });
});
