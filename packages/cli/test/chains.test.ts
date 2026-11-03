import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import {
  buildChains, chainId, defaultChainName, journeyId, nearestNodeId, sortChains, syncJourneys, writeChains,
} from "../src/linker/chains.js";
import type { BackendLink, ConsumerLink, LinkResult, UiLink } from "../src/linker/link.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { DbAccess, EndpointsFile, HttpCall, QueueOp, Route, UiPage } from "../src/store/schemas.js";
import { ChainsFileSchema } from "../src/store/schemas.js";
import { hopsFromChains } from "../src/evals/score.js";
import { writeJsonAtomic } from "../src/store/json.js";

function graphWith(nodes: KnowledgeGraph["nodes"]): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes, edges: [], layers: [], tour: [],
  };
}

function endpoints(repo: string, partial: Partial<EndpointsFile>): EndpointsFile {
  return {
    version: 2, repo, pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [],
    dbAccess: [], tables: [], models: [], queues: [], ...partial,
  };
}

describe("chainId / journeyId", () => {
  it("is deterministic and matches the expected shape", () => {
    const id = chainId("page:web:/customers/new", "api:POST /api/customers");
    expect(id).toMatch(/^ch_[0-9a-f]{12}$/);
    expect(chainId("page:web:/customers/new", "api:POST /api/customers")).toBe(id);
    expect(chainId("page:web:/customers/new", "api:GET /api/customers/:id")).not.toBe(id);
  });

  it("journeyId is order-independent over the chain ids it hashes", () => {
    const a = journeyId(["ch_111111111111", "ch_222222222222"]);
    const b = journeyId(["ch_222222222222", "ch_111111111111"]);
    expect(a).toMatch(/^j_[0-9a-f]{12}$/);
    expect(a).toBe(b);
  });
});

describe("nearestNodeId", () => {
  const graph = graphWith([
    { id: "function:a.ts:top", type: "function", name: "top", filePath: "a.ts", lineRange: [1, 3], summary: "", tags: [], complexity: "simple" },
    { id: "class:b.ts:Widget", type: "class", name: "Widget", filePath: "b.ts", lineRange: [1, 10], summary: "", tags: [], complexity: "simple" },
    { id: "file:c.ts", type: "file", name: "c.ts", filePath: "c.ts", summary: "", tags: [], complexity: "simple" },
  ]);

  it("prefers an exact function node", () => {
    expect(nearestNodeId(graph, "a.ts", "top")).toBe("function:a.ts:top");
  });
  it("falls back to the class node for a method symbol", () => {
    expect(nearestNodeId(graph, "b.ts", "Widget.render")).toBe("class:b.ts:Widget");
  });
  it("falls back to the file node", () => {
    expect(nearestNodeId(graph, "c.ts", "anything")).toBe("file:c.ts");
  });
  it("returns undefined when nothing matches", () => {
    expect(nearestNodeId(graph, "z.ts", "nope")).toBeUndefined();
  });
});

function scenario(): { ws: WorkspaceData; links: LinkResult } {
  const call: HttpCall = { method: "POST", path: "/api/items", raw: '"/api/items"', resolved: true, client: "api", at: { file: "lib/use-create-item.ts", line: 3, symbol: "useCreateItem" }, kind: "literal" };
  const page: UiPage = { route: "/items/new", file: "app/items/new/page.tsx", line: 2, framework: "next-app" };
  const route: Route = { method: "POST", path: "/api/items", handler: "ItemsController.store", inline: false, framework: "adonis", at: { file: "start/routes.ts", line: 1, symbol: "<module>" }, handlerFile: "app/controllers/items_controller.ts" };
  const effRoute = { repo: "api", route, effectivePath: "/api/items", mountsKnown: true, mounts: [] };
  const uiLink: UiLink = {
    repo: "web", call,
    pages: [{
      page,
      path: [
        { repo: "web", file: "app/items/new/page.tsx", symbol: "NewItemPage", confidence: "exact" },
        { repo: "web", file: "lib/use-create-item.ts", symbol: "useCreateItem", confidence: "exact" },
      ],
      confidence: "exact",
    }],
    target: { kind: "route", route: effRoute, confidence: "exact" },
  };
  const dbAccess: DbAccess = { table: "items", op: "insert", via: "lucid", at: { file: "app/services/item_service.ts", line: 2, symbol: "ItemService.create" } };
  const handlerRef = { repo: "api", file: "app/controllers/items_controller.ts", symbol: "ItemsController.store" };
  const serviceRef = { repo: "api", file: "app/services/item_service.ts", symbol: "ItemService.create" };
  const backendLink: BackendLink = {
    repo: "api", route: effRoute, handler: handlerRef, handlerConfidence: "exact",
    hits: [{
      kind: "db", access: dbAccess,
      viaPath: [
        { ref: handlerRef, depth: 0 },
        { ref: serviceRef, depth: 1, parent: handlerRef, via: { site: { caller: "ItemsController.store", line: 5, callee: { kind: "new-member", className: "ItemService", prop: "create" } }, target: serviceRef, confidence: "exact", via: "new" } },
      ],
    }],
    unresolved: [],
  };
  const route2: Route = { method: "GET", path: "/health", handler: "GET /health", inline: true, framework: "express", at: { file: "src/server.ts", line: 1, symbol: "<module>" }, handlerFile: "src/server.ts", handlerLines: [1, 1] };
  const effRoute2 = { repo: "api2", route: route2, effectivePath: "/health", mountsKnown: true, mounts: [] };
  const backendLink2: BackendLink = { repo: "api2", route: effRoute2, handler: { repo: "api2", file: "src/server.ts", symbol: "GET /health" }, handlerConfidence: "exact", hits: [], unresolved: [] };
  const consumeOp: QueueOp = { queue: "jobs", op: "consume", at: { file: "src/worker.ts", line: 2, symbol: "startWorker" } };
  const jobRef = { repo: "api2", file: "src/worker.ts", symbol: "handleJob" };
  const consumerLink: ConsumerLink = {
    repo: "api2", consume: consumeOp, handler: jobRef,
    hits: [{ kind: "db", access: { table: "jobs_log", op: "insert", via: "prisma", at: { file: "src/worker.ts", line: 5, symbol: "handleJob" } }, viaPath: [{ ref: jobRef, depth: 0 }] }],
    unresolved: [],
  };
  const web: RepoData = { ref: { id: "web", path: "web" }, abs: "/ws/web", graph: graphWith([]), endpoints: endpoints("web", { pages: [page], httpCalls: [call] }) };
  const api: RepoData = {
    ref: { id: "api", path: "api" }, abs: "/ws/api",
    graph: graphWith([{ id: "class:app/controllers/items_controller.ts:ItemsController", type: "class", name: "ItemsController", filePath: "app/controllers/items_controller.ts", lineRange: [2, 10], summary: "", tags: [], complexity: "simple" }]),
    endpoints: endpoints("api", { routes: [route], dbAccess: [dbAccess] }),
  };
  const api2: RepoData = { ref: { id: "api2", path: "api2" }, abs: "/ws/api2", graph: graphWith([]), endpoints: endpoints("api2", { routes: [route2], queues: [consumeOp] }) };
  const ws: WorkspaceData = { root: "/ws", name: "ws", repos: [web, api, api2], links: [] };
  const uiReach = [{ repo: "web", file: call.at.file, line: call.at.line, symbol: call.at.symbol, method: call.method, path: call.path, reached: true }];
  const links: LinkResult = { ui: [uiLink], backend: [backendLink, backendLink2], consumers: [consumerLink], queuePairs: [], manual: [], uiReach };
  return { ws, links };
}

describe("buildChains", () => {
  it("builds a page chain, a route-entry chain and a consumer chain", () => {
    const { ws, links } = scenario();
    const chains = buildChains(ws, links);
    expect(chains).toHaveLength(3);

    const page = chains.find((c) => c.entry === "page:web:/items/new")!;
    expect(page.routeKey).toBe("api:POST /api/items");
    expect(page.id).toBe(chainId(page.entry, page.routeKey));
    expect(page.complete).toBe(true);
    expect(page.confidence).toBe("exact");
    expect(page.name).toBe("POST /api/items · NewItemPage");
    expect(page.stops.map((s) => `${s.lane}/${s.kind}`)).toEqual(["ui/page", "ui/function", "ui/call", "api/route", "code/handler", "code/function", "db/db"]);

    const health = chains.find((c) => c.entry === "route:api2:GET /health")!;
    expect(health.routeKey).toBe("api2:GET /health");
    expect(health.complete).toBe(false); // no db/queue hits: check's "no-store"
    expect(health.name).toBe("GET /health");

    const consumer = chains.find((c) => c.entry === "consumer:api2:jobs#src/worker.ts#handleJob")!;
    expect(consumer.routeKey).toBe("");
    // H3: reaches a store but has no UI stop, so it is API → DB only, not complete.
    expect(consumer.complete).toBe(false);
    expect(consumer.name).toBe("consume jobs · handleJob");
    expect(consumer.stops[0]).toMatchObject({ lane: "queue", kind: "consume", label: "jobs" });
  });

  it("every chain passes ChainsFileSchema", () => {
    const { ws, links } = scenario();
    expect(() => ChainsFileSchema.parse({ version: 1, chains: buildChains(ws, links) })).not.toThrow();
  });

  it("defaultChainName covers page, route-only and consumer chains", () => {
    expect(defaultChainName({ entry: "consumer:b:q", stops: [{ lane: "queue", kind: "consume", repo: "b", file: "f", line: 1, symbol: "s", label: "q", hop: { confidence: "exact" } }] })).toBe("consume q · s");
    expect(defaultChainName({ entry: "route:b:GET /x", stops: [{ lane: "api", kind: "route", repo: "b", file: "f", line: 1, symbol: "s", label: "GET /x", hop: { confidence: "exact" } }] })).toBe("GET /x");
  });
});

describe("buildChains — confidence folding (review fixes from Tasks 9-11)", () => {
  it("a guessed UI walk hop marks the next UI stop and the chain as guess", () => {
    const { ws, links } = scenario();
    const reach = links.ui[0]!.pages[0]!;
    reach.path[0]!.confidence = "guess"; // the page's call into useCreateItem was a unique-method guess
    reach.confidence = "guess";
    const page = buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!;
    expect(page.stops.map((s) => s.hop.confidence)).toEqual(["exact", "guess", "exact", "exact", "exact", "exact", "exact"]);
    expect(page.confidence).toBe("guess");
    expect(page.complete).toBe(true);
  });

  it("carries a guessed route target and its reason onto the route stop", () => {
    const { ws, links } = scenario();
    const target = links.ui[0]!.target as Extract<UiLink["target"], { kind: "route" }>;
    target.confidence = "guess";
    target.reason = "matched outside the hinted backends";
    const page = buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!;
    expect(page.stops.find((s) => s.kind === "route")!.hop).toEqual({ confidence: "guess", reason: "matched outside the hinted backends" });
    expect(page.confidence).toBe("guess");
  });

  it("a handler that could not be found is a guess hop with a reason", () => {
    const { ws, links } = scenario();
    links.backend[0]!.handlerConfidence = "guess";
    const page = buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!;
    expect(page.stops.find((s) => s.kind === "handler")!.hop).toMatchObject({ confidence: "guess", reason: expect.stringContaining("not found") });
    expect(page.confidence).toBe("guess");
  });

  it("a route-entry chain under an unknown mount prefix has a guess route hop", () => {
    const { ws, links } = scenario();
    links.backend[1]!.route.mountsKnown = false;
    const health = buildChains(ws, links).find((c) => c.entry === "route:api2:GET /health")!;
    expect(health.stops[0]!.hop).toEqual({ confidence: "guess", reason: "mount prefix unknown" });
    expect(health.confidence).toBe("guess");
  });

  it("a handler with no file gives a chain that stops at the route", () => {
    const { ws, links } = scenario();
    links.backend[1]!.handler = null;
    links.backend[1]!.handlerConfidence = "guess";
    const health = buildChains(ws, links).find((c) => c.entry === "route:api2:GET /health")!;
    expect(health.stops.map((s) => s.kind)).toEqual(["route"]);
    expect(health.complete).toBe(false);
  });

  it("unresolved framework calls are listed but do not break completeness or confidence", () => {
    const { ws, links } = scenario();
    links.backend[0]!.unresolved = [
      { at: { file: "app/controllers/items_controller.ts", line: 6, symbol: "ItemsController.store" }, reason: 'could not resolve "response.created(...)"' },
      { at: { file: "app/controllers/items_controller.ts", line: 4, symbol: "ItemsController.store" }, reason: 'could not resolve "request.body(...)"' },
    ];
    const page = buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!;
    expect(page.complete).toBe(true);
    expect(page.confidence).toBe("exact");
    expect(page.unresolved.map((u) => `${u.at.repo}:${u.at.line} ${u.reason}`)).toEqual([
      'api:4 could not resolve "request.body(...)"',
      'api:6 could not resolve "response.created(...)"',
    ]);
  });
});

describe("buildChains — db access with no table or model (final review item 4)", () => {
  it("is not a db stop: no empty-label hop, the chain is not complete, and the access is listed as unresolved", () => {
    const { ws, links } = scenario();
    const hit = links.backend[0]!.hits[0]!;
    if (hit.kind !== "db") throw new Error("scenario changed");
    hit.access = { op: "insert", via: "lucid", at: hit.access.at };
    const chains = buildChains(ws, links);
    const page = chains.find((c) => c.entry === "page:web:/items/new")!;
    expect(page.stops.some((s) => s.kind === "db")).toBe(false);
    expect(page.complete).toBe(false);
    expect(page.unresolved).toEqual([{
      at: { repo: "api", file: "app/services/item_service.ts", line: 2, symbol: "ItemService.create" },
      reason: "database access (insert) with no table or model",
    }]);
    expect(hopsFromChains(chains).filter((f) => f.hop.type === "handler-store" && f.hop.table === "")).toEqual([]);
  });

  it("H9: a mongoose model whose collection is unknown is not a store either (never the model name as a table)", () => {
    const { ws, links } = scenario();
    const hit = links.backend[0]!.hits[0]!;
    if (hit.kind !== "db") throw new Error("scenario changed");
    hit.access = { model: "Customer", op: "read", via: "mongoose", at: hit.access.at };
    const page = buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!;
    expect(page.stops.some((s) => s.kind === "db")).toBe(false);
    expect(page.complete).toBe(false);
    expect(page.unresolved.map((u) => u.reason)).toEqual(['mongoose model "Customer" (read): collection unknown']);
  });
});

describe("buildChains — wrapper-derived UI calls (H2)", () => {
  it("a call derived through an HTTP wrapper puts its own confidence on the call stop", () => {
    const { ws, links } = scenario();
    links.ui[0]!.call = { ...links.ui[0]!.call, via: "wrapper", wrapper: "lib/http.ts#requests.post", confidence: "param" };
    const page = buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!;
    const call = page.stops.find((s) => s.kind === "call")!;
    expect(call.hop).toEqual({ confidence: "param", reason: "via wrapper lib/http.ts#requests.post" });
    expect(page.confidence).toBe("param");
  });
});

describe("buildChains — call-entry chains (H3b)", () => {
  function unreached() {
    const { ws, links } = scenario();
    links.ui[0]!.pages = [];
    links.uiReach = links.uiReach.map((f) => ({ ...f, reached: false }));
    return { ws, links };
  }

  it("a UI call that matches a route but no page reaches gets a call: chain instead of a route: chain", () => {
    const { ws, links } = unreached();
    const chains = buildChains(ws, links);
    expect(chains.map((c) => c.entry).sort()).toEqual([
      "call:web:lib/use-create-item.ts#useCreateItem", "consumer:api2:jobs#src/worker.ts#handleJob", "route:api2:GET /health",
    ]);
    const c = chains.find((x) => x.entry.startsWith("call:"))!;
    expect(c.id).toBe(chainId(c.entry, "api:POST /api/items"));
    expect(c.routeKey).toBe("api:POST /api/items");
    expect(c.name).toBe("POST /api/items · useCreateItem");
    expect(c.stops.map((s) => `${s.lane}:${s.kind}`)).toEqual(["ui:call", "api:route", "code:handler", "code:function", "db:db"]);
    expect(c.stops.some((s) => s.kind === "page")).toBe(false);
    expect(c.complete).toBe(true);
    expect(c.confidence).toBe("exact");
    expect(defaultChainName(c)).toBe(c.name);
    expect(() => ChainsFileSchema.parse({ version: 1, chains })).not.toThrow();
  });

  it("a call-entry chain scores as a ui-api hop keyed on the call's file and symbol", () => {
    const { ws, links } = unreached();
    const hops = hopsFromChains(buildChains(ws, links)).filter((h) => h.hop.type === "ui-api");
    expect(hops).toEqual([{
      hop: { type: "ui-api", from: { repo: "web", file: "lib/use-create-item.ts", symbol: "useCreateItem" }, to: { repo: "api", method: "POST", path: "/api/items" } },
      confidence: "exact",
    }]);
  });

  it("a wrapper-derived call keeps its own (param) confidence on the call stop and the chain", () => {
    const { ws, links } = unreached();
    links.ui[0]!.call = { ...links.ui[0]!.call, via: "wrapper", wrapper: "src/agent.js#requests.post", confidence: "param" };
    const c = buildChains(ws, links).find((x) => x.entry.startsWith("call:"))!;
    expect(c.stops[0]!.hop).toEqual({ confidence: "param", reason: "via wrapper src/agent.js#requests.post" });
    expect(c.confidence).toBe("param");
    expect(hopsFromChains([c]).find((h) => h.hop.type === "ui-api")!.confidence).toBe("param");
  });

  it("a guessed route target caps the call-entry chain at guess", () => {
    const { ws, links } = unreached();
    const t = links.ui[0]!.target;
    if (t.kind === "route") links.ui[0]!.target = { ...t, confidence: "guess", reason: "tie" };
    const c = buildChains(ws, links).find((x) => x.entry.startsWith("call:"))!;
    expect(c.confidence).toBe("guess");
  });

  it("an unreached call that matches no route gets no chain", () => {
    const { ws, links } = unreached();
    links.ui[0]!.target = { kind: "unresolved", reason: "no matching route" };
    expect(buildChains(ws, links).some((c) => c.entry.startsWith("call:"))).toBe(false);
  });
});

describe("buildChains — edge cases", () => {
  it("a route whose call is backend code (no UI reach fact) still gets a route-entry chain", () => {
    const { ws, links } = scenario();
    links.ui[0]!.pages = [];
    links.uiReach = [];
    const chains = buildChains(ws, links);
    expect(chains.map((c) => c.entry).sort()).toEqual(["consumer:api2:jobs#src/worker.ts#handleJob", "route:api2:GET /health", "route:api:POST /api/items"]);
  });

  it("a UI call that matches no route becomes a partial page chain with routeKey \"\" and an unresolved entry", () => {
    const { ws, links } = scenario();
    links.ui[0]!.target = { kind: "unresolved", reason: "no matching route" };
    const chains = buildChains(ws, links);
    const partial = chains.find((c) => c.entry === "page:web:/items/new")!;
    expect(partial).toMatchObject({ routeKey: "", complete: false, id: chainId("page:web:/items/new", "") });
    expect(partial.stops.map((s) => `${s.lane}/${s.kind}`)).toEqual(["ui/page", "ui/function", "ui/call"]);
    expect(partial.unresolved).toEqual([
      { at: { repo: "web", file: "lib/use-create-item.ts", line: 3, symbol: "useCreateItem" }, reason: "no matching route for POST /api/items" },
    ]);
    expect(partial.name).toBe("POST /api/items (unmatched) · NewItemPage");
    // its route now has no page caller, so it is a route-entry chain
    expect(chains.some((c) => c.entry === "route:api:POST /api/items")).toBe(true);
  });

  it("external calls and calls whose URL has no literal text make no chain", () => {
    const { ws, links } = scenario();
    links.ui[0]!.target = { kind: "external", base: "api.stripe.com" };
    links.ui.push({ ...links.ui[0]!, call: { ...links.ui[0]!.call, kind: "unknown" }, target: { kind: "unresolved", reason: "url has no literal text" } });
    expect(buildChains(ws, links).some((c) => c.entry.startsWith("page:"))).toBe(false);
  });

  it("never emits two chains with the same id", () => {
    const { ws, links } = scenario();
    const again = structuredClone(links.ui[0]!);
    again.call = { ...again.call, at: { ...again.call.at, line: 9 } };
    links.ui.push(again); // the same page reaches a second call to the same route
    const chains = buildChains(ws, links);
    expect(new Set(chains.map((c) => c.id)).size).toBe(chains.length);
    expect(chains.find((c) => c.entry === "page:web:/items/new")!.stops.find((s) => s.kind === "call")!.line).toBe(3);
  });
});

describe("buildChains — distinct ids (Task 12 review fixes 2-4)", () => {
  it("two consumers of one queue in one repo give two chains, each with its own store", () => {
    const { ws, links } = scenario();
    const otherRef = { repo: "api2", file: "src/other-worker.ts", symbol: "handleOther" };
    links.consumers.push({
      repo: "api2", consume: { queue: "jobs", op: "consume", at: { file: "src/other-worker.ts", line: 2, symbol: "startOther" } }, handler: otherRef,
      hits: [{ kind: "db", access: { table: "other_log", op: "insert", via: "prisma", at: { file: "src/other-worker.ts", line: 6, symbol: "handleOther" } }, viaPath: [{ ref: otherRef, depth: 0 }] }],
      unresolved: [],
    });
    const consumers = buildChains(ws, links).filter((c) => c.entry.startsWith("consumer:"));
    expect(consumers.map((c) => [c.entry, c.name, c.stops.filter((s) => s.kind === "db").map((s) => s.label)])).toEqual([
      ["consumer:api2:jobs#src/worker.ts#handleJob", "consume jobs · handleJob", ["jobs_log"]],
      ["consumer:api2:jobs#src/other-worker.ts#handleOther", "consume jobs · handleOther", ["other_log"]],
    ]);
    expect(new Set(consumers.map((c) => c.id)).size).toBe(2);
  });

  it("an inline consumer (handler = the consume call's own symbol) is named after that symbol", () => {
    const { ws, links } = scenario();
    links.consumers[0]!.handler = { repo: "api2", file: "src/worker.ts", symbol: "startWorker" };
    const c = buildChains(ws, links).find((x) => x.entry.startsWith("consumer:"))!;
    expect(c.entry).toBe("consumer:api2:jobs#src/worker.ts#startWorker");
    expect(c.name).toBe("consume jobs · startWorker");
  });

  function twoRouters(): { ws: WorkspaceData; links: LinkResult } {
    const { ws, links } = scenario();
    const mk = (file: string, handler: string, table: string): BackendLink => {
      const route: Route = { method: "GET", path: "/:id", handler, inline: false, framework: "express", at: { file, line: 4, symbol: "<module>" }, handlerFile: file };
      const ref = { repo: "api", file, symbol: handler };
      return {
        repo: "api", route: { repo: "api", route, effectivePath: "/:id", mountsKnown: true, mounts: [] }, handler: ref, handlerConfidence: "exact",
        hits: [{ kind: "db", access: { table, op: "read", via: "prisma", at: { file, line: 9, symbol: handler } }, viaPath: [{ ref, depth: 0 }] }],
        unresolved: [],
      };
    };
    // linkBackend sorts by effectivePath, method, at.file: the "b" router first would still number second.
    links.backend.push(mk("src/users.ts", "getUser", "users"), mk("src/orders.ts", "getOrder", "orders"));
    return { ws, links };
  }

  it("two routers with the same METHOD path give two route chains, each with its own hits", () => {
    const { ws, links } = twoRouters();
    const routes = buildChains(ws, links).filter((c) => c.routeKey.startsWith("api:GET /:id"));
    expect(routes.map((c) => [c.entry, c.routeKey, c.stops.filter((s) => s.kind === "db").map((s) => s.label)]).sort()).toEqual([
      ["route:api:GET /:id@src/orders.ts#1", "api:GET /:id@src/orders.ts#1", ["orders"]],
      ["route:api:GET /:id@src/users.ts#2", "api:GET /:id@src/users.ts#2", ["users"]],
    ]);
    expect(routes.every((c) => c.name === "GET /:id")).toBe(true);
  });

  it("a page call to one of two colliding routes gets only that route's handler and hits", () => {
    const { ws, links } = twoRouters();
    const users = links.backend.find((b) => b.route.route.at.file === "src/users.ts")!;
    // linkUi builds its own EffectiveRoute objects: match by identity, not by object reference.
    links.ui[0]!.target = { kind: "route", route: structuredClone(users.route), confidence: "exact" };
    const chains = buildChains(ws, links);
    const page = chains.find((c) => c.entry === "page:web:/items/new")!;
    expect(page.routeKey).toBe("api:GET /:id@src/users.ts#2");
    expect(page.stops.filter((s) => s.kind === "handler").map((s) => s.symbol)).toEqual(["getUser"]);
    expect(page.stops.filter((s) => s.kind === "db").map((s) => s.label)).toEqual(["users"]);
    // users is covered by the page chain; orders still gets its route-entry chain.
    expect(chains.filter((c) => c.entry.startsWith("route:api:GET /:id")).map((c) => c.entry)).toEqual(["route:api:GET /:id@src/orders.ts#1"]);
  });

  it("function and handler stops take the symbol's own first line when a lookup is given", () => {
    const { ws, links } = scenario();
    const lines: Record<string, number> = { "api:app/controllers/items_controller.ts#ItemsController.store": 7 };
    const page = buildChains(ws, links, (repo, file, symbol) => lines[`${repo}:${file}#${symbol}`])
      .find((c) => c.entry === "page:web:/items/new")!;
    expect(page.stops.find((s) => s.kind === "handler")!.line).toBe(7);
    // no lookup hit: falls back to the nearest graph node (the class, lines [2, 10])
    expect(buildChains(ws, links).find((c) => c.entry === "page:web:/items/new")!.stops.find((s) => s.kind === "handler")!.line).toBe(2);
  });
});

describe("sortChains", () => {
  it("sorts by id", () => {
    const { ws, links } = scenario();
    const chains = buildChains(ws, links);
    const shuffled = [chains[2]!, chains[0]!, chains[1]!];
    expect(sortChains(shuffled).map((c) => c.id)).toEqual([...chains.map((c) => c.id)].sort());
  });
});

describe("writeChains / syncJourneys", () => {
  function root() {
    return mkdtempSync(join(tmpdir(), "codeloom-chains-"));
  }

  it("writes chains.json only when content changes", () => {
    const { ws, links } = scenario();
    const chains = sortChains(buildChains(ws, links));
    const wsRoot = root();
    expect(writeChains(wsRoot, chains)).toBe(true);
    const before = readFileSync(join(wsRoot, ".codeloom", "chains.json"), "utf8");
    expect(writeChains(wsRoot, chains)).toBe(false);
    expect(readFileSync(join(wsRoot, ".codeloom", "chains.json"), "utf8")).toBe(before);
  });

  it("creates journeys.json when missing", () => {
    const wsRoot = root();
    const result = syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa"]));
    expect(result).toEqual({ created: true, orphaned: 0, changed: true });
    expect(JSON.parse(readFileSync(join(wsRoot, ".codeloom", "journeys.json"), "utf8"))).toEqual({ version: 1, journeys: [] });
  });

  it("orphans a journey whose chain id disappeared, and un-orphans it when the id comes back", () => {
    const wsRoot = root();
    writeJsonAtomic(join(wsRoot, ".codeloom", "journeys.json"), {
      version: 1,
      journeys: [{ id: "j_aaaaaaaaaaaa", name: "Create item", area: "items", note: "", chainIds: ["ch_aaaaaaaaaaaa"], status: "ok" }],
    });
    const gone = syncJourneys(wsRoot, new Set());
    expect(gone).toEqual({ created: false, orphaned: 1, changed: true });
    const after = JSON.parse(readFileSync(join(wsRoot, ".codeloom", "journeys.json"), "utf8"));
    expect(after.journeys[0].status).toBe("orphaned");

    const back = syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa"]));
    expect(back).toEqual({ created: false, orphaned: 0, changed: true });

    const noChange = syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa"]));
    expect(noChange).toEqual({ created: false, orphaned: 0, changed: false });
  });

  it("changes nothing but status, and leaves the file byte-identical when no status changes", () => {
    const wsRoot = root();
    const path = join(wsRoot, ".codeloom", "journeys.json");
    const journeys = [
      { id: "j_bbbbbbbbbbbb", name: "Z last", area: "z", note: "keep me", chainIds: ["ch_bbbbbbbbbbbb", "ch_cccccccccccc"], status: "ok" },
      { id: "j_aaaaaaaaaaaa", name: "A first", area: "a", note: "", chainIds: ["ch_aaaaaaaaaaaa"], status: "ok" },
    ];
    writeJsonAtomic(path, { version: 1, journeys });
    const before = readFileSync(path, "utf8");
    expect(syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa", "ch_bbbbbbbbbbbb", "ch_cccccccccccc"])).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);

    // one of j_b's two chains is gone: j_b stays "ok" and the file is untouched
    expect(syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa", "ch_bbbbbbbbbbbb"]))).toEqual({ created: false, orphaned: 0, changed: false });
    expect(readFileSync(path, "utf8")).toBe(before);

    // both of j_b's chains are gone: only j_b's status changes
    expect(syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa"]))).toEqual({ created: false, orphaned: 1, changed: true });
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.journeys).toEqual([{ ...journeys[0], status: "orphaned" }, journeys[1]]);

    // one of them comes back: the code behind j_b exists again, so it returns to "ok"
    expect(syncJourneys(wsRoot, new Set(["ch_aaaaaaaaaaaa", "ch_cccccccccccc"]))).toEqual({ created: false, orphaned: 0, changed: true });
    expect(JSON.parse(readFileSync(path, "utf8")).journeys).toEqual(journeys);
  });

  it("never orphans a journey with no chain ids", () => {
    const wsRoot = root();
    writeJsonAtomic(join(wsRoot, ".codeloom", "journeys.json"), {
      version: 1, journeys: [{ id: "j_aaaaaaaaaaaa", name: "Empty", area: "", note: "", chainIds: [], status: "ok" }],
    });
    expect(syncJourneys(wsRoot, new Set())).toEqual({ created: false, orphaned: 0, changed: false });
  });

  it("keeps fields the schema does not know when it flips a status", () => {
    const wsRoot = root();
    const path = join(wsRoot, ".codeloom", "journeys.json");
    writeJsonAtomic(path, {
      version: 1,
      journeys: [{ id: "j_aaaaaaaaaaaa", name: "A", area: "a", note: "", chainIds: ["ch_aaaaaaaaaaaa"], status: "ok", owner: "agent" }],
      extra: { kept: true },
    });
    syncJourneys(wsRoot, new Set());
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.extra).toEqual({ kept: true });
    expect(after.journeys[0]).toMatchObject({ owner: "agent", status: "orphaned" });
  });

  it("throws on a malformed journeys.json and leaves it untouched", () => {
    const wsRoot = root();
    const path = join(wsRoot, ".codeloom", "journeys.json");
    writeJsonAtomic(path, { version: 1, journeys: [{ id: "bad" }] });
    const before = readFileSync(path, "utf8");
    expect(() => syncJourneys(wsRoot, new Set())).toThrow(/unexpected shape/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("tells the user to fix a malformed journeys.json by hand, never to delete it", () => {
    const wsRoot = root();
    const path = join(wsRoot, ".codeloom", "journeys.json");
    mkdirSync(join(wsRoot, ".codeloom"), { recursive: true });
    const messageFor = (text: string): string => {
      writeFileSync(path, text);
      try {
        syncJourneys(wsRoot, new Set());
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected syncJourneys to throw");
    };
    for (const text of ['{ "version": 1, "journeys": [{ "id": "bad" }] }', "{ not json"]) {
      const message = messageFor(text);
      expect(message).toMatch(/by hand/);
      expect(message).not.toMatch(/delete/i);
      expect(message).not.toMatch(/re-?index|run "codeloom index"/i);
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });
});
