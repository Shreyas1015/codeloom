import { describe, expect, it } from "vitest";
import { buildJourneyModel } from "@/screens/journey/model";
import { chainResult, journeyResult, orphanedResult } from "./fixtures/journey";

describe("buildJourneyModel", () => {
  it("numbers distinct stops in chain order, first appearance wins", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.stops.map((s) => `${s.n}:${s.view.label ?? s.view.symbol}`)).toEqual([
      "1:/invoices/new",
      "2:POST /api/invoices",
      "3:POST /api/invoices",
      "4:InvoicesController.store",
      "5:invoices",
      "6:GET /api/customers",
      "7:GET /api/customers",
    ]);
    expect(m.stops[0]!.chainIds).toEqual(["ch_aaaa", "ch_bbbb"]);
  });

  it("puts each stop in its lane, keeping the numbers", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.lanes.ui.map((s) => s.n)).toEqual([1, 2, 6]);
    expect(m.lanes.api.map((s) => s.n)).toEqual([3, 4, 7]);
    expect(m.lanes.db.map((s) => s.n)).toEqual([5]);
    expect(m.lanes.code).toEqual([]);
    expect(m.showQueue).toBe(false);
  });

  it("lists every hop between consecutive stops of a chain with the confidence of the arriving stop", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.hops.map((h) => `${h.from}>${h.to}:${h.confidence}`)).toEqual([
      "1>2:exact", "2>3:param", "3>4:exact", "4>5:exact", "1>6:exact", "6>7:guess",
    ]);
    expect(m.hops.find((h) => h.to === 7)!.reason).toBe("URL built at runtime; matched by prefix");
  });

  it("marks the stop an unresolved item sits on", () => {
    const m = buildJourneyModel(journeyResult);
    expect(m.stops.filter((s) => s.unresolved).map((s) => s.n)).toEqual([7]);
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
