import { describe, expect, it } from "vitest";
import type { ChainView, JourneyResult } from "@/api/types";
import { buildJourneyModel } from "@/screens/journey/model";
import { chainA, chainResult, journeyResult, lanesOf, orphanedResult, page, postCall } from "./fixtures/journey";

describe("buildJourneyModel", () => {
  it("numbers distinct stops in chain order, first appearance wins", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.stops.map((s) => `${s.n}:${s.view.label ?? s.view.symbol}`)).toEqual([
      "1:/invoices/new",
      "2:POST /api/invoices",
      "3:POST /api/invoices",
      "4:InvoicesController.store",
      "5:invoices",
      "6:invoice_lines",
      "7:GET /api/customers",
      "8:GET /api/customers",
      "9:CustomersController.index",
    ]);
    expect(m.stops[0]!.chainIds).toEqual(["ch_aaaa", "ch_bbbb"]);
  });

  it("puts each stop in its lane, keeping the numbers; handlers are in the Code lane", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.lanes.ui.map((s) => s.n)).toEqual([1, 2, 7]);
    expect(m.lanes.api.map((s) => s.n)).toEqual([3, 8]);
    expect(m.lanes.code.map((s) => s.n)).toEqual([4, 9]);
    expect(m.lanes.db.map((s) => s.n)).toEqual([5, 6]);
    expect(m.showQueue).toBe(false);
  });

  it("makes a hop only from stops[from] to the stop, with that stop's confidence and reason", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.hops.map((h) => `${h.from}>${h.to}:${h.confidence}`)).toEqual([
      "1>2:exact", "2>3:param", "3>4:exact", "4>5:exact", "4>6:exact", "1>7:guess", "7>8:guess",
    ]);
    expect(m.hops.find((h) => h.to === 8)!.reason).toBe("URL built at runtime; matched by prefix");
  });

  it("a handler with two stores gives two hops from the handler and none between the stores", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.hops.filter((h) => h.from === 4).map((h) => h.to)).toEqual([5, 6]);
    expect(m.hops.some((h) => (h.from === 5 && h.to === 6) || (h.from === 6 && h.to === 5))).toBe(false);
  });

  it("never infers a hop from list order: a stop without `from` gets no hop", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.hops.some((h) => h.to === 9)).toBe(false);
  });

  it("two chains making the same hop keep the worse confidence", () => {
    const guessed: ChainView = {
      ...chainA, id: "ch_cccc", name: "POST /api/invoices (draft)",
      stops: [page, { ...postCall, confidence: "guess", reason: "Matched by name" } as typeof postCall],
    };
    const r: JourneyResult = { ...journeyResult, chains: [chainA, guessed], lanes: lanesOf([chainA, guessed]), unresolved: [] };
    const hop = buildJourneyModel(r).hops.find((h) => h.from === 1 && h.to === 2)!;
    expect(hop.confidence).toBe("guess");
    expect(hop.reason).toBe("Matched by name");
  });

  it("does not mark stops unresolved from unresolved items (they only go in the list)", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.stops.some((s) => "unresolved" in s)).toBe(false);
  });

  it("sums the nameplate facts: worst confidence, completeness, repos", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.confidence).toBe("guess");
    expect(m.complete).toBe(false);
    expect(m.repos).toEqual(["api", "web"]);
    expect(buildJourneyModel(chainResult).confidence).toBe("param");
    expect(buildJourneyModel(chainResult).complete).toBe(true);
  });

  it("an orphaned journey with no chains is empty and not complete", () => {
    const m = buildJourneyModel(orphanedResult);
    expect(m.stops).toEqual([]);
    expect(m.complete).toBe(false);
    expect(m.confidence).toBeNull();
  });
});

describe("buildJourneyModel completeness (H3)", () => {
  const routeOnly = (c: ChainView): ChainView => ({ ...c, complete: false, stops: c.stops.filter((s) => s.lane !== "ui").map((s) => ({ ...s, from: undefined })) });

  it("a journey whose chains reach the DB with no UI stop is API → DB, not complete", () => {
    const c = routeOnly(chainA);
    const m = buildJourneyModel({ ...chainResult, chains: [c], lanes: lanesOf([c]) });
    expect(m.complete).toBe(false);
    expect(m.apiOnly).toBe(true);
  });

  it("hG: one page chain + one route-only chain is not API → DB, and complete when the page chain is", () => {
    const r = { ...routeOnly(chainA), id: "ch_rrrr", name: "GET /api/invoices/export" };
    const m = buildJourneyModel({ ...journeyResult, chains: [chainA, r], lanes: lanesOf([chainA, r]) });
    expect(m.apiOnly).toBe(false);
    expect(m.complete).toBe(true);
    const open = { ...chainA, complete: false };
    const m2 = buildJourneyModel({ ...journeyResult, chains: [open, r], lanes: lanesOf([open, r]) });
    expect(m2.apiOnly).toBe(false);
    expect(m2.complete).toBe(false);
  });

  it("a complete journey and an incomplete one are not API → DB", () => {
    expect(buildJourneyModel(chainResult).apiOnly).toBe(false);
    expect(buildJourneyModel(journeyResult).apiOnly).toBe(false);
    expect(buildJourneyModel(orphanedResult).apiOnly).toBe(false);
  });
});
