import { describe, expect, it } from "vitest";
import type { ChainView, JourneyResult, StopView } from "@/api/types";
import { numberStops, stopFrom, stopKey } from "@/lib/journey-stops";
import { buildJourneyModel } from "@/screens/journey/model";
import { journeyStops } from "@/screens/map/layout";
import { parseStopKey as cliParseStopKey, stopKey as cliStopKey } from "codeloom/src/store/stop-key.js";
import { chainCounts } from "./fixtures/journey";

const stop = (s: Partial<StopView> & Pick<StopView, "lane" | "repo" | "file" | "line" | "symbol">): StopView => ({
  kind: "function",
  confidence: "exact",
  ...s,
});

const page = stop({ lane: "ui", kind: "page", repo: "web", file: "app/page.tsx", line: 3, symbol: "Page" });
const call = stop({ lane: "ui", kind: "call", repo: "web", file: "lib/api.ts", line: 9, symbol: "save" });
// the same file, line and symbol in two lanes: two different stops
const handler = stop({ lane: "code", kind: "handler", repo: "api", file: "app/c.ts", line: 40, symbol: "C.store" });
const write = stop({ lane: "db", kind: "db", repo: "api", file: "app/c.ts", line: 40, symbol: "C.store", op: "insert" });
const route = stop({ lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 5, symbol: "routes" });
const read = stop({ lane: "db", kind: "db", repo: "api", file: "app/c.ts", line: 12, symbol: "C.index", op: "select" });

const chain = (id: string, stops: StopView[]): ChainView => ({
  id, name: id, entry: id, routeKey: id, confidence: "exact", complete: true, journeys: ["j_x"], ...chainCounts(stops), stops, unresolved: [],
});

const journey: JourneyResult = {
  journey: null,
  // chain 2 shares the page and the handler (cross-lane twin of `write`) with chain 1
  chains: [chain("ch_a", [page, call, route, handler, write]), chain("ch_b", [page, route, handler, read])],
  lanes: { ui: [], api: [], code: [], db: [], queue: [] },
  files: [], tables: [], queues: [], unresolved: [], missingChainIds: [], movedChainIds: [],
};

describe("journey stop numbering (shared by Journey and Map)", () => {
  it("keys a stop by lane, repo, file, line and symbol", () => {
    expect(stopKey(handler)).not.toBe(stopKey(write));
    const relabelled: StopView = { ...handler, kind: "function", label: "other" };
    expect(stopKey(handler)).toBe(stopKey(relabelled));
  });

  it("numbers stops 1-based in chain order; a shared stop keeps its first number", () => {
    const nums = numberStops(journey);
    expect(journey.chains.map((c) => c.stops.map((s) => nums.get(stopKey(s))))).toEqual([
      [1, 2, 3, 4, 5],
      [1, 3, 4, 6],
    ]);
  });

  it("gives every stop the same number on the Journey screen and on the Map", () => {
    const nums = numberStops(journey);
    const model = buildJourneyModel(journey);
    for (const s of model.stops) expect(s.n).toBe(nums.get(stopKey(s.view)));

    // the Map stop with number n is the very stop (same lane, repo, file, line, symbol) the Journey numbers n
    const onMap = ["api", "web"].flatMap((repo) =>
      [...journeyStops(journey, repo)].flatMap(([file, list]) => list.map((m) => ({ ...m, repo, file }))),
    );
    for (const m of onMap) {
      const j = model.stops.find((s) => s.n === m.n)!;
      expect(stopKey(m)).toBe(stopKey(j.view));
    }
    expect(onMap.map((m) => m.n).sort((a, b) => a - b)).toEqual(model.stops.map((s) => s.n));
  });

  it("keys stops exactly like the cli's shared stopKey (tours and progress key stops by it)", () => {
    for (const s of [page, call, handler, write, route, read, { ...page, file: 'a "quoted"\\path.ts' }]) {
      expect(stopKey(s)).toBe(cliStopKey(s));
      expect(cliParseStopKey(stopKey(s))).toEqual({ lane: s.lane, repo: s.repo, file: s.file, line: s.line, symbol: s.symbol });
    }
  });

  it("reads a stop's `from` only when it is a whole number", () => {
    expect(stopFrom({ ...call, from: 0 } as StopView)).toBe(0);
    expect(stopFrom({ ...call, from: 1.5 } as StopView)).toBeUndefined();
    expect(stopFrom(call)).toBeUndefined();
  });
});
