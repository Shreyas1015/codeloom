import type { GraphEdge, GraphNode } from "@codeloom/core";
import { describe, expect, it } from "vitest";
import type { Chain, ChainStop, Journey } from "../src/store/schemas.js";
import { graphLevel, journeyRows, sliceCode } from "../src/web/api.js";

const stop = (s: Partial<ChainStop> & Pick<ChainStop, "lane" | "repo" | "file">): ChainStop => ({
  kind: "function", line: 1, symbol: "f", hop: { confidence: "exact" }, ...s,
});

const chain = (id: string, c: Partial<Chain> = {}): Chain => ({
  id, entry: `route:${id}`, routeKey: "", name: `chain ${id}`, stops: [], unresolved: [], confidence: "exact", complete: true, ...c,
});

const journey = (id: string, j: Partial<Journey> = {}): Journey => ({
  id, name: `journey ${id}`, area: "", note: "", chainIds: [], status: "ok", ...j,
});

describe("journeyRows", () => {
  const a = chain("ch_a", {
    confidence: "exact",
    stops: [
      stop({ lane: "ui", kind: "page", repo: "web", file: "page.tsx" }),
      stop({ lane: "api", repo: "api", file: "routes.ts" }),
      stop({ lane: "code", repo: "api", file: "svc.ts" }),
      stop({ lane: "db", repo: "api", file: "svc.ts", label: "users", line: 3 }),
    ],
  });
  const b = chain("ch_b", {
    confidence: "param",
    complete: false,
    stops: [
      stop({ lane: "code", repo: "api", file: "svc.ts" }), // same stop as in ch_a: counted once
      stop({ lane: "db", repo: "api", file: "svc.ts", label: "audit", line: 4 }),
      stop({ lane: "queue", repo: "billing", file: "q.ts", label: "emails" }),
    ],
  });
  const c = chain("ch_c", { confidence: "guess", stops: [stop({ lane: "api", repo: "billing", file: "s.ts" })] });
  const d = chain("ch_d");

  it("summarises each journey over its chains and lists the chains in no journey", () => {
    const out = journeyRows({
      chains: [d, c, b, a],
      journeys: [
        journey("j_2", { name: "Zeta", chainIds: ["ch_a"] }),
        journey("j_1", { name: "Alpha", area: "users", note: "n", chainIds: ["ch_b", "ch_a"] }),
      ],
    });
    expect(out.journeys.map((j) => j.id)).toEqual(["j_1", "j_2"]);
    expect(out.journeys[0]).toEqual({
      id: "j_1", name: "Alpha", area: "users", note: "n", status: "ok",
      chainIds: ["ch_a", "ch_b"],
      repos: ["api", "billing", "web"],
      stops: { ui: 1, api: 1, code: 1, db: 2, queue: 1 },
      confidence: "param",
      complete: true, // hG: judged on its UI chain (ch_a, complete); ch_b has no UI stop
      apiOnly: false,
      tables: ["audit", "users"],
    });
    expect(out.journeys[1]).toMatchObject({ confidence: "exact", complete: true, tables: ["users"], repos: ["api", "web"] });
    expect(out.unnamedChains).toEqual([
      { id: "ch_c", name: "chain ch_c", entry: "route:ch_c", confidence: "guess", complete: true, apiOnly: false, repos: ["billing"] },
      { id: "ch_d", name: "chain ch_d", entry: "route:ch_d", confidence: "exact", complete: true, apiOnly: false, repos: [] },
    ]);
  });

  // H3: a route-only chain that reaches a store is "API → DB", not complete and not plain incomplete.
  it("marks route-only chains that reach a store as API → DB (apiOnly), and journeys made only of such chains", () => {
    const page = stop({ lane: "ui", kind: "page", repo: "web", file: "app/customers/page.tsx" });
    const route = stop({ lane: "api", kind: "route", repo: "api", file: "start/routes.ts" });
    const db = stop({ lane: "db", kind: "db", repo: "api", file: "app/invoices.ts", label: "invoices", line: 5 });
    const ui = chain("ch_ui", { entry: "page:web:/customers", stops: [page, route, db] });
    const routeOnly = chain("ch_route", { complete: false, stops: [route, db] });
    const noStore = chain("ch_nostore", { complete: false, stops: [route] });
    const out = journeyRows({
      chains: [ui, routeOnly, noStore],
      journeys: [
        journey("j_a", { name: "A", chainIds: ["ch_route"] }),
        journey("j_b", { name: "B", chainIds: ["ch_route", "ch_ui"] }),
        journey("j_c", { name: "C", chainIds: ["ch_route", "ch_nostore"] }),
        journey("j_d", { name: "D", chainIds: ["ch_ui"] }),
      ],
    });
    expect(out.journeys.map((j) => [j.id, j.complete, j.apiOnly])).toEqual([
      // hG: j_b has a page chain, so it is judged on its UI chains (complete), never API → DB
      ["j_a", false, true], ["j_b", true, false], ["j_c", false, false], ["j_d", true, false],
    ]);
    const empty = journeyRows({ chains: [routeOnly, noStore, ui], journeys: [] }).unnamedChains;
    expect(empty.map((c) => [c.id, c.complete, c.apiOnly])).toEqual([
      ["ch_nostore", false, false], ["ch_route", false, true], ["ch_ui", true, false],
    ]);
  });

  it("hG: a journey with a page chain is never API → DB; it is complete when its UI chains are", () => {
    const page = stop({ lane: "ui", kind: "page", repo: "web", file: "app/invoices/page.tsx" });
    const call = stop({ lane: "ui", kind: "call", repo: "web", file: "lib/api.ts" });
    const route = stop({ lane: "api", kind: "route", repo: "api", file: "start/routes.ts" });
    const db = stop({ lane: "db", kind: "db", repo: "api", file: "app/invoices.ts", label: "invoices", line: 5 });
    const pageDone = chain("ch_page", { entry: "page:web:/invoices", stops: [page, call, route, db] });
    const pageOpen = chain("ch_open", { entry: "page:web:/invoices", complete: false, stops: [page, call] });
    const routeOnly = chain("ch_route", { complete: false, stops: [route, db] });
    const out = journeyRows({
      chains: [pageDone, pageOpen, routeOnly],
      journeys: [
        journey("j_a", { name: "A", chainIds: ["ch_page", "ch_route"] }),
        journey("j_b", { name: "B", chainIds: ["ch_open", "ch_route"] }),
        journey("j_c", { name: "C", chainIds: ["ch_page", "ch_open", "ch_route"] }),
      ],
    });
    expect(out.journeys.map((j) => [j.id, j.complete, j.apiOnly])).toEqual([
      ["j_a", true, false], ["j_b", false, false], ["j_c", false, false],
    ]);
  });

  it("a journey whose chains are gone is not complete and has no stops", () => {
    const out = journeyRows({ chains: [], journeys: [journey("j_x", { chainIds: ["ch_gone"], status: "orphaned" })] });
    expect(out.journeys[0]).toMatchObject({
      status: "orphaned", complete: false, apiOnly: false, confidence: "exact", repos: [], tables: [],
      stops: { ui: 0, api: 0, code: 0, db: 0, queue: 0 },
    });
  });
});

describe("graphLevel", () => {
  const file = (path: string): GraphNode => ({ id: `file:${path}`, type: "file", name: path.split("/").pop()!, filePath: path, summary: "", tags: [], complexity: "simple" });
  const fn = (path: string, name: string, type: "function" | "class", line: number): GraphNode => ({
    id: `${type}:${path}:${name}`, type, name, filePath: path, lineRange: [line, line + 2], summary: "", tags: [], complexity: "simple",
  });
  const edge = (type: GraphEdge["type"], source: string, target: string): GraphEdge => ({ source, target, type, direction: "forward", weight: 1 });
  const repo = {
    id: "api",
    graph: {
      nodes: [
        file("app/controllers/users.ts"),
        fn("app/controllers/users.ts", "UsersController", "class", 5),
        fn("app/controllers/users.ts", "helper", "function", 2),
        file("app/services/users.ts"),
        fn("app/services/users.ts", "UserService", "class", 1),
        file("app/models/user.ts"),
        file("start/routes.ts"),
        file("package.json"),
      ],
      edges: [
        edge("contains", "file:app/controllers/users.ts", "class:app/controllers/users.ts:UsersController"),
        edge("imports", "file:app/controllers/users.ts", "file:app/services/users.ts"),
        edge("imports", "file:app/services/users.ts", "file:app/models/user.ts"),
        edge("imports", "file:start/routes.ts", "file:app/controllers/users.ts"),
        edge("calls", "function:app/controllers/users.ts:helper", "class:app/services/users.ts:UserService"),
        edge("calls", "class:app/controllers/users.ts:UsersController", "class:app/services/users.ts:UserService"),
      ],
      layers: [
        { id: "layer:api", name: "API", description: "", nodeIds: ["file:app/controllers/users.ts"] },
        { id: "layer:core", name: "Core", description: "", nodeIds: ["file:start/routes.ts", "file:package.json"] },
      ],
    },
  };
  const state = {
    chains: [chain("ch_a", { stops: [stop({ lane: "code", repo: "api", file: "app/controllers/users.ts" })] })],
    journeys: [journey("j_1", { chainIds: ["ch_a"] })],
  };

  it("the root level lists top folders (recursive counts) and root files, with folder-level edges", () => {
    const level = graphLevel(repo, state, "");
    expect(level.repo).toBe("api");
    expect(level.dir).toBe("");
    expect(level.folders).toEqual([
      { path: "app", name: "app", files: 3 },
      { path: "start", name: "start", files: 1, layer: "layer:core" },
    ]);
    expect(level.files).toEqual([
      { ref: "api::file:package.json", path: "package.json", name: "package.json", layer: "layer:core", functions: [], journeys: [] },
    ]);
    // imports start → app (1); everything else is inside app
    expect(level.edges).toEqual([{ from: "start", to: "app", type: "imports", count: 1 }]);
  });

  it("a folder level lists its files with functions, journeys and aggregated edges", () => {
    const level = graphLevel(repo, state, "app/controllers");
    expect(level.folders).toEqual([]);
    expect(level.files).toEqual([
      {
        ref: "api::file:app/controllers/users.ts",
        path: "app/controllers/users.ts",
        name: "users.ts",
        layer: "layer:api",
        functions: [
          { ref: "api::function:app/controllers/users.ts:helper", name: "helper", type: "function", line: 2 },
          { ref: "api::class:app/controllers/users.ts:UsersController", name: "UsersController", type: "class", line: 5 },
        ],
        journeys: ["j_1"],
      },
    ]);
    expect(level.edges).toEqual([]);
    const app = graphLevel(repo, state, "app/");
    expect(app.dir).toBe("app");
    expect(app.folders.map((f) => f.path)).toEqual(["app/controllers", "app/models", "app/services"]);
    expect(app.edges).toEqual([
      { from: "app/controllers", to: "app/services", type: "calls", count: 2 },
      { from: "app/controllers", to: "app/services", type: "imports", count: 1 },
      { from: "app/services", to: "app/models", type: "imports", count: 1 },
    ]);
  });

  it("an unknown folder is a 404", () => {
    expect(() => graphLevel(repo, state, "nope")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => graphLevel(repo, state, "app/controllers/users.ts")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("sliceCode", () => {
  const src = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  it("returns the asked lines", () => {
    expect(sliceCode("a.ts", src, 3, 5)).toEqual({ file: "a.ts", startLine: 3, endLine: 5, text: "line 3\nline 4\nline 5", truncated: false });
  });

  it("caps at 400 lines and flags truncation; no end = rest of the file", () => {
    const r = sliceCode("a.ts", src, 1, undefined);
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(400);
    expect(r.truncated).toBe(true);
    expect(sliceCode("a.ts", src, 990, undefined)).toMatchObject({ startLine: 990, endLine: 1000, truncated: false });
    expect(sliceCode("a.ts", src, 990, 5000)).toMatchObject({ endLine: 1000, truncated: false });
  });

  it("caps at 60 000 chars on a line boundary", () => {
    const wide = Array.from({ length: 300 }, () => "x".repeat(299)).join("\n");
    const r = sliceCode("w.ts", wide, 1, 300);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(60_000);
    expect(r.endLine).toBe(200);
    expect(r.text.split("\n")).toHaveLength(200);
  });

  it("a start past the end of the file, or end before start, is a 400", () => {
    expect(() => sliceCode("a.ts", src, 1001, undefined)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => sliceCode("a.ts", src, 10, 5)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
