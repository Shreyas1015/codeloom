import { describe, expect, it } from "vitest";
import type { JourneyRow } from "@/api/types";
import { facets, filterJourneys, sortJourneys, totalStops } from "@/screens/home/filter";

function row(p: Partial<JourneyRow> & { id: string; name: string }): JourneyRow {
  return {
    area: "",
    note: "",
    status: "ok",
    chainIds: [],
    repos: [],
    stops: { ui: 0, api: 0, code: 0, db: 0, queue: 0 },
    confidence: "exact",
    complete: true,
    tables: [],
    ...p,
  };
}

const rows: JourneyRow[] = [
  row({
    id: "j_1",
    name: "Customer signs up",
    area: "Customers",
    note: "creates the customer row",
    repos: ["api", "web"],
    stops: { ui: 2, api: 2, code: 1, db: 1, queue: 0 },
    tables: ["customers"],
  }),
  row({
    id: "j_2",
    name: "Admin voids an invoice",
    area: "Invoices",
    note: "soft delete",
    repos: ["admin", "api"],
    stops: { ui: 1, api: 1, code: 0, db: 1, queue: 0 },
    confidence: "guess",
    complete: false,
    tables: ["invoices"],
  }),
  row({
    id: "j_3",
    name: "Invoice is emailed",
    area: "Invoices",
    note: "worker sends PDF",
    repos: ["worker"],
    stops: { ui: 0, api: 1, code: 3, db: 1, queue: 2 },
    confidence: "param",
    tables: ["invoice_emails", "invoices"],
  }),
];

const all = { q: "", area: "", repo: "", confidence: "", complete: "" } as const;

describe("home filter", () => {
  it("collects sorted facets", () => {
    expect(facets(rows)).toEqual({ areas: ["Customers", "Invoices"], repos: ["admin", "api", "web", "worker"] });
  });

  it("totals stops over lanes", () => {
    expect(totalStops(rows[2]!)).toBe(7);
  });

  it("passes everything with no filter", () => {
    expect(filterJourneys(rows, all).map((r) => r.id)).toEqual(["j_1", "j_2", "j_3"]);
  });

  it.each([
    ["area", { area: "Invoices" }, ["j_2", "j_3"]],
    ["repo", { repo: "api" }, ["j_1", "j_2"]],
    ["confidence", { confidence: "guess" }, ["j_2"]],
    ["complete", { complete: "complete" }, ["j_1", "j_3"]],
    ["incomplete", { complete: "incomplete" }, ["j_2"]],
  ] as const)("filters by %s", (_n, f, ids) => {
    expect(filterJourneys(rows, { ...all, ...f }).map((r) => r.id)).toEqual(ids);
  });

  it.each([
    ["name", "SIGNS", ["j_1"]],
    ["area", "customers", ["j_1"]],
    ["note", "soft delete", ["j_2"]],
    ["table", "invoice_emails", ["j_3"]],
    ["two words in any field", "invoice worker", ["j_3"]],
  ])("searches by %s", (_n, q, ids) => {
    expect(filterJourneys(rows, { ...all, q }).map((r) => r.id)).toEqual(ids);
  });

  it("sorts by name, area, stops (most first) and confidence (surest first), ties by name", () => {
    expect(sortJourneys(rows, "name").map((r) => r.id)).toEqual(["j_2", "j_1", "j_3"]);
    expect(sortJourneys(rows, "area").map((r) => r.id)).toEqual(["j_1", "j_2", "j_3"]);
    expect(sortJourneys(rows, "stops").map((r) => r.id)).toEqual(["j_3", "j_1", "j_2"]);
    expect(sortJourneys(rows, "confidence").map((r) => r.id)).toEqual(["j_1", "j_3", "j_2"]);
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    sortJourneys(rows, "stops");
    expect(rows).toEqual(copy);
  });
});
