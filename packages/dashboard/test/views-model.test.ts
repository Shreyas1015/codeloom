import { describe, expect, it } from "vitest";
import type { JourneyProgressView, JourneyRow, Overview } from "@/api/types";
import { countCells, filterViewJourneys, sortViewJourneys, viewLevel } from "@/screens/views/model";

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
    apiOnly: false,
    tables: [],
    ...p,
  };
}

const rows = [
  row({ id: "j_signup", name: "Customer signs up", area: "Customers", repos: ["api", "web"], stops: { ui: 2, api: 1, code: 1, db: 1, queue: 0 } }),
  row({ id: "j_void", name: "Admin voids an invoice", area: "Invoices", repos: ["api", "web"], confidence: "guess", complete: false }),
  row({ id: "j_email", name: "Invoice is emailed", area: "Invoices", repos: ["api"], confidence: "param", stops: { ui: 0, api: 1, code: 2, db: 1, queue: 1 } }),
];

const level = (journeyId: string, p: Partial<JourneyProgressView>): JourneyProgressView => ({
  journeyId,
  name: journeyId,
  area: "",
  repos: [],
  level: "none",
  needsReWalk: [],
  lastCheck: null,
  ...p,
});
const levels = new Map([
  ["j_signup", level("j_signup", { level: "understood", needsReWalk: ["k"] })],
  ["j_void", level("j_void", { level: "toured" })],
]);
const specs = new Map<string, "linked" | "candidates" | "none">([
  ["j_signup", "none"],
  ["j_void", "linked"],
  ["j_email", "candidates"],
]);

describe("views model", () => {
  it("maps a progress entry to a view level (rewalk for understood journeys whose code changed)", () => {
    expect(viewLevel(levels.get("j_signup"))).toBe("rewalk");
    expect(viewLevel(levels.get("j_void"))).toBe("toured");
    expect(viewLevel(undefined)).toBe("none");
  });

  it("filters journeys by area, repo, confidence, complete, level and spec", () => {
    const ids = (f: Parameters<typeof filterViewJourneys>[1]) => filterViewJourneys(rows, f, { levels, specs }).map((r) => r.id);
    expect(ids({ area: "Invoices" })).toEqual(["j_void", "j_email"]);
    expect(ids({ repo: "web" })).toEqual(["j_signup", "j_void"]);
    expect(ids({ confidence: "param" })).toEqual(["j_email"]);
    expect(ids({ complete: false })).toEqual(["j_void"]);
    expect(ids({ complete: true })).toEqual(["j_signup", "j_email"]);
    expect(ids({ level: "rewalk" })).toEqual(["j_signup"]);
    expect(ids({ level: "none" })).toEqual(["j_email"]);
    expect(ids({ spec: "candidates" })).toEqual(["j_email"]);
    expect(ids({ area: "Invoices", spec: "linked" })).toEqual(["j_void"]);
    expect(ids(undefined)).toEqual(["j_signup", "j_void", "j_email"]);
  });

  it("a level or spec filter matches nothing while that data is missing", () => {
    expect(filterViewJourneys(rows, { spec: "linked" }, {})).toEqual([]);
    expect(filterViewJourneys(rows, { level: "seen" }, {})).toEqual([]);
  });

  it("sorts by name, area, stops, confidence, progress (furthest first) and spec (linked first)", () => {
    const ids = (s: Parameters<typeof sortViewJourneys>[1]) => sortViewJourneys(rows, s, { levels, specs }).map((r) => r.id);
    expect(ids("name")).toEqual(["j_void", "j_signup", "j_email"]);
    expect(ids(undefined)).toEqual(["j_void", "j_signup", "j_email"]);
    expect(ids("stops")).toEqual(["j_signup", "j_email", "j_void"]);
    expect(ids("confidence")).toEqual(["j_signup", "j_email", "j_void"]);
    expect(ids("progress")).toEqual(["j_signup", "j_void", "j_email"]);
    expect(ids("spec")).toEqual(["j_void", "j_email", "j_signup"]);
  });

  it("builds count cells in the order asked, with the defaults when none are", () => {
    const overview = {
      repos: [
        { id: "api", files: 10, pages: 0, routes: 4, tables: 2, queues: 1 },
        { id: "web", files: 5, pages: 3, routes: 0, tables: 0, queues: 0 },
      ],
      journeys: { total: 3, orphaned: 0 },
    } as unknown as Overview;
    const cells = countCells(overview, ["specLinked", "files", "understood"], { understood: 1, specLinked: 2 });
    expect(cells.map((c) => [c.key, c.value])).toEqual([
      ["specLinked", 2],
      ["files", 15],
      ["understood", 1],
    ]);
    expect(countCells(overview, undefined, {}).map((c) => c.key)).toEqual(["files", "pages", "routes", "tables", "queues", "journeys"]);
    expect(countCells(overview, ["understood"], {})[0]!.value).toBeUndefined();
  });
});
