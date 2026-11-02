import { describe, expect, it } from "vitest";
import type { GraphLevel, JourneyResult, StopView } from "@/api/types";
import {
  MAX_LEVEL_NODES,
  dirOf,
  edgeWidth,
  fileOfRef,
  functionStops,
  isOffscreen,
  journeyStops,
  laneOfLayer,
  layoutLevel,
  levelEdges,
  levelItems,
} from "@/screens/map/layout";

const level: GraphLevel = {
  repo: "api",
  dir: "app",
  folders: [
    { path: "app/models", name: "models", files: 4, layer: "data" },
    { path: "app/controllers", name: "controllers", files: 3, layer: "api" },
  ],
  files: [
    {
      ref: "api::file:app/kernel.ts",
      path: "app/kernel.ts",
      name: "kernel.ts",
      functions: [],
      journeys: [],
    },
    {
      ref: "api::file:app/customer_service.ts",
      path: "app/customer_service.ts",
      name: "customer_service.ts",
      layer: "api",
      functions: [
        { ref: "api::function:app/customer_service.ts:create", name: "create", type: "function", line: 4 },
        { ref: "api::function:app/customer_service.ts:update", name: "update", type: "function", line: 20 },
      ],
      journeys: ["j_create_customer"],
    },
  ],
  edges: [
    { from: "app/controllers", to: "app/customer_service.ts", type: "calls", count: 3 },
    { from: "app/customer_service.ts", to: "app/models", type: "imports", count: 40 },
  ],
};

function manyFiles(n: number): GraphLevel {
  return {
    repo: "api",
    dir: "",
    folders: [{ path: "app", name: "app", files: 9 }],
    files: Array.from({ length: n }, (_, i) => {
      const name = `invoice_${String(i).padStart(3, "0")}.ts`;
      return { ref: `api::file:${name}`, path: name, name, functions: [], journeys: [] };
    }),
    edges: [],
  };
}

describe("levelItems", () => {
  it("lists folders first, then files, each by name", () => {
    const { items, hidden } = levelItems(level);
    expect(items.map((i) => i.id)).toEqual(["app/controllers", "app/models", "app/customer_service.ts", "app/kernel.ts"]);
    expect(hidden).toBe(0);
  });

  it(`keeps at most ${MAX_LEVEL_NODES} cards and groups the rest into one "+ N more files" card`, () => {
    const { items, hidden } = levelItems(manyFiles(200));
    expect(items).toHaveLength(MAX_LEVEL_NODES);
    expect(hidden).toBe(52); // 1 folder + 200 files, 149 shown
    const last = items.at(-1)!;
    expect(last.kind).toBe("more");
    expect(last.kind === "more" && last.label).toBe("+ 52 more files");
  });

  it("always keeps the card for the selected path, even past the cap", () => {
    const { items } = levelItems(manyFiles(200), "invoice_199.ts");
    expect(items).toHaveLength(MAX_LEVEL_NODES);
    expect(items.some((i) => i.id === "invoice_199.ts")).toBe(true);
  });
});

describe("layoutLevel", () => {
  it("is deterministic: columns by layer (unlayered last), then by name, with no overlaps", () => {
    const { items } = levelItems(level);
    const a = layoutLevel(items, new Set());
    const b = layoutLevel(items, new Set());
    expect(a).toEqual(b);
    const byId = new Map(a.map((p) => [p.id, p]));
    // layer "api" column first, then "data", then the unlayered column
    expect(byId.get("app/controllers")!.x).toBe(byId.get("app/customer_service.ts")!.x);
    expect(byId.get("app/controllers")!.x).toBeLessThan(byId.get("app/models")!.x);
    expect(byId.get("app/models")!.x).toBeLessThan(byId.get("app/kernel.ts")!.x);
    expect(byId.get("app/controllers")!.y).toBeLessThan(byId.get("app/customer_service.ts")!.y);
  });

  it("makes room below an expanded file for its functions", () => {
    const { items } = levelItems({ ...level, folders: [], files: [...level.files, { ...level.files[0]!, ref: "x", path: "app/z.ts", name: "z.ts", layer: "api" }] });
    const closed = layoutLevel(items, new Set());
    const open = layoutLevel(items, new Set(["app/customer_service.ts"]));
    const y = (ps: typeof closed) => ps.find((p) => p.id === "app/z.ts")!.y;
    expect(y(open)).toBeGreaterThan(y(closed));
  });
});

describe("edges", () => {
  it("keeps only edges between visible cards, with width growing with count and capped", () => {
    const edges = levelEdges(level, new Set(["app/controllers", "app/customer_service.ts"]));
    expect(edges).toEqual([
      expect.objectContaining({ source: "app/controllers", target: "app/customer_service.ts", count: 3, type: "calls" }),
    ]);
    expect(edgeWidth(1)).toBeLessThan(edgeWidth(3));
    expect(edgeWidth(40)).toBe(edgeWidth(1000));
    expect(edgeWidth(1000)).toBeLessThanOrEqual(6);
  });
});

describe("helpers", () => {
  it("maps layer names onto lane hues", () => {
    expect(laneOfLayer("ui")).toBe("ui");
    expect(laneOfLayer("api")).toBe("api");
    expect(laneOfLayer("data")).toBe("db");
    expect(laneOfLayer("worker")).toBe("queue");
    expect(laneOfLayer("utils")).toBe("code");
  });

  it("reads the file of a node ref and the folder of a path", () => {
    expect(fileOfRef("api::file:app/customer_service.ts")).toBe("app/customer_service.ts");
    expect(fileOfRef("api::function:app/customer_service.ts:create")).toBe("app/customer_service.ts");
    expect(fileOfRef("api::table:customers")).toBeUndefined();
    expect(dirOf("app/models/customer.ts")).toBe("app/models");
    expect(dirOf("kernel.ts")).toBe("");
  });

  it("numbers a journey's stops in chain order, once each, and keeps those in this repo", () => {
    const stop = (file: string, line: number, symbol: string, repo = "api", ref?: string): StopView => ({
      lane: "api",
      kind: "function",
      repo,
      file,
      line,
      symbol,
      confidence: "exact",
      ...(ref ? { ref } : {}),
    });
    const s1 = stop("src/pages/customers.tsx", 3, "CustomersPage", "web");
    const s2 = stop("app/controllers/customers_controller.ts", 8, "store");
    const s3 = stop("app/customer_service.ts", 4, "create", "api", "api::function:app/customer_service.ts:create");
    const journey = {
      chains: [
        { id: "ch_1", stops: [s1, s2, s3] },
        { id: "ch_2", stops: [s1, s2, stop("app/customer_service.ts", 20, "update")] },
      ],
    } as unknown as JourneyResult;
    const stops = journeyStops(journey, "api");
    expect([...stops.keys()].sort()).toEqual(["app/controllers/customers_controller.ts", "app/customer_service.ts"]);
    expect(stops.get("app/customer_service.ts")!.map((s) => [s.n, s.symbol])).toEqual([
      [3, "create"],
      [4, "update"],
    ]);
    expect(stops.get("app/controllers/customers_controller.ts")![0]!.n).toBe(2);
  });

  it("gives two stops that differ only by lane two numbers (identity is lane, repo, file, line, symbol)", () => {
    const base = { kind: "function" as const, repo: "api", file: "app/customer_service.ts", line: 4, symbol: "create", confidence: "exact" as const };
    const journey = {
      chains: [
        { id: "ch_1", stops: [{ ...base, lane: "api" }, { ...base, lane: "code" }] },
        { id: "ch_2", stops: [{ ...base, lane: "code" }] },
      ],
    } as unknown as JourneyResult;
    expect(journeyStops(journey, "api").get("app/customer_service.ts")!.map((s) => s.n)).toEqual([1, 2]);
  });
});

describe("functionStops", () => {
  const fns = [
    { ref: "api::function:app/invoice.ts:total", name: "total", type: "function" as const, line: 4 },
    { ref: "api::function:app/invoice.ts:Invoice.total", name: "total", type: "function" as const, line: 30 },
    { ref: "api::function:app/invoice.ts:send", name: "send", type: "function" as const, line: 50 },
  ];
  const st = (n: number, symbol: string, line: number, ref?: string) => ({ n, symbol, line, ...(ref ? { ref } : {}) });

  it("matches by ref first, then by line, and by name only when the name is unique in the file", () => {
    const m = functionStops(fns, [
      st(1, "total", 99, "api::function:app/invoice.ts:Invoice.total"), // ref wins over name and line
      st(2, "total", 4), // line
      st(3, "total", 70), // name is not unique: no match
      st(4, "send", 77), // unique name
    ]);
    expect(m.get(fns[0]!.ref)!.map((s) => s.n)).toEqual([2]);
    expect(m.get(fns[1]!.ref)!.map((s) => s.n)).toEqual([1]);
    expect(m.get(fns[2]!.ref)!.map((s) => s.n)).toEqual([4]);
    expect([...m.values()].flat().some((s) => s.n === 3)).toBe(false);
  });
});

describe("isOffscreen", () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  it("is false for a card fully inside the visible canvas and true when any part is outside", () => {
    expect(isOffscreen({ x: 10, y: 10, width: 100, height: 50 }, vp, { width: 800, height: 600 })).toBe(false);
    expect(isOffscreen({ x: 750, y: 10, width: 100, height: 50 }, vp, { width: 800, height: 600 })).toBe(true);
    expect(isOffscreen({ x: 10, y: 10, width: 100, height: 50 }, { x: -200, y: 0, zoom: 1 }, { width: 800, height: 600 })).toBe(true);
    expect(isOffscreen({ x: 500, y: 10, width: 100, height: 50 }, { x: 0, y: 0, zoom: 2 }, { width: 800, height: 600 })).toBe(true);
  });
});
