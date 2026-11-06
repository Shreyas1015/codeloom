import { describe, expect, it } from "vitest";
import { buildJourneyModel } from "@/screens/journey/model";
import { buildTourModel, nextPlace, phaseViewed, placeOf, prevPlace, TOUR_PHASES } from "@/screens/tour/model";
import { readTourPlace, rememberTourPlace, tourPlaceKey } from "@/screens/tour/position";
import { journeyResult } from "./fixtures/journey";
import { removedKey, storeKey, tourFile, tourResponse } from "./fixtures/tour";

const journey = buildJourneyModel(journeyResult);

describe("tour model", () => {
  it("orders the Flow stops by their journey number, removed stops last, and marks stale and removed", () => {
    const m = buildTourModel(tourResponse, journey);
    expect(m.stops.map((s) => s.n ?? null)).toEqual([1, 2, 4, 5, null]);
    expect(m.stops.map((s) => s.title)).toEqual(["/invoices/new", "POST /api/invoices", "InvoicesController.store", "invoices", "LegacyInvoice.save"]);
    const store = m.stops.find((s) => s.key === storeKey)!;
    expect(store.stale).toBe(true);
    expect(store.removed).toBe(false);
    const gone = m.stops.find((s) => s.key === removedKey)!;
    expect(gone).toMatchObject({ removed: true, stale: false, fields: { repo: "api", file: "app/services/legacy_invoice.ts", line: 3 } });
    expect(gone.view).toBeUndefined();
  });

  it("treats every stop as removed when the journey is gone", () => {
    const m = buildTourModel({ ...tourResponse, journeyExists: false, removedStops: tourFile.stops.map((s) => s.key) }, undefined);
    expect(m.stops.every((s) => s.removed && s.n === undefined)).toBe(true);
    expect(m.stops.map((s) => s.fields?.symbol)).toEqual(tourFile.stops.map((s) => JSON.parse(s.key)[4]));
  });

  it("resolves data journey steps to journey stops", () => {
    const m = buildTourModel(tourResponse, journey);
    expect(m.steps.map((s) => [s.n, s.title, s.sql ?? null])).toEqual([
      [2, "POST /api/invoices", null],
      [5, "invoices", "INSERT INTO invoices (customer_id, total) VALUES ($1, $2)"],
    ]);
  });

  it("walks one sequence: every Flow stop, then the three other phases", () => {
    const n = 5;
    expect(TOUR_PHASES.map((p) => p.id)).toEqual(["flow", "data-journey", "file-notes", "check"]);
    expect(nextPlace({ phase: "flow", stop: 1 }, n)).toEqual({ phase: "flow", stop: 2 });
    expect(nextPlace({ phase: "flow", stop: 5 }, n)).toEqual({ phase: "data-journey", stop: 1 });
    expect(nextPlace({ phase: "file-notes", stop: 1 }, n)).toEqual({ phase: "check", stop: 1 });
    expect(nextPlace({ phase: "check", stop: 1 }, n)).toBeUndefined();
    expect(prevPlace({ phase: "data-journey", stop: 1 }, n)).toEqual({ phase: "flow", stop: 5 });
    expect(prevPlace({ phase: "flow", stop: 1 }, n)).toBeUndefined();
  });

  it("clamps a place from the URL", () => {
    expect(placeOf(undefined, undefined, 5)).toEqual({ phase: "flow", stop: 1 });
    expect(placeOf("flow", 9, 5)).toEqual({ phase: "flow", stop: 5 });
    expect(placeOf("check", 3, 5)).toEqual({ phase: "check", stop: 1 });
  });

  it("counts Flow as viewed only at its last stop; other phases when opened", () => {
    expect(phaseViewed({ phase: "flow", stop: 4 }, 5)).toBeUndefined();
    expect(phaseViewed({ phase: "flow", stop: 5 }, 5)).toBe("flow");
    expect(phaseViewed({ phase: "file-notes", stop: 1 }, 5)).toBe("file-notes");
  });
});

describe("tour place storage", () => {
  it("remembers the place and viewed phases per workspace and journey", () => {
    rememberTourPlace("demo-shop", "j_invoice", { phase: "data-journey", stop: 1, viewed: ["flow", "data-journey"] });
    expect(readTourPlace("demo-shop", "j_invoice")).toEqual({ phase: "data-journey", stop: 1, viewed: ["flow", "data-journey"] });
    expect(readTourPlace("other", "j_invoice")).toBeUndefined();
    localStorage.removeItem(tourPlaceKey("demo-shop", "j_invoice"));
  });

  it("ignores junk and blocked storage", () => {
    localStorage.setItem(tourPlaceKey("demo-shop", "j_x"), "{not json");
    expect(readTourPlace("demo-shop", "j_x")).toBeUndefined();
    localStorage.setItem(tourPlaceKey("demo-shop", "j_x"), JSON.stringify({ phase: "nope", stop: -1, viewed: ["flow", "bad"] }));
    expect(readTourPlace("demo-shop", "j_x")).toEqual({ phase: "flow", stop: 1, viewed: ["flow"] });
    localStorage.removeItem(tourPlaceKey("demo-shop", "j_x"));
  });
});
