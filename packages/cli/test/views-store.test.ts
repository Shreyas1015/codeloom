import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import {
  deleteView,
  homeView,
  listViews,
  readView,
  saveView,
  VIEW_LIMITS,
  ViewDraftSchema,
  viewPath,
  viewSummaries,
  WidgetSchema,
} from "../src/store/views.js";

const root = () => mkdtempSync(join(tmpdir(), "codeloom-views-"));

const AUDIT = {
  id: "no-spec-audit",
  title: "No-spec audit",
  description: "Customer journeys without a spec.",
  widgets: [
    { type: "counts", show: ["journeys", "specLinked"] },
    { type: "journeys", title: "No spec", filter: { area: "Customers", spec: "none" }, sort: "name", limit: 50 },
    { type: "note", markdown: "Run **match-specs** on these." },
  ],
};

describe("view schema", () => {
  it("accepts every widget type", () => {
    const widgets = [
      { type: "counts" },
      { type: "counts", show: ["files", "pages", "routes", "tables", "queues", "journeys", "understood", "specLinked"] },
      { type: "journeys" },
      { type: "journeys", filter: { repo: "shop-api", level: "rewalk", confidence: "exact", complete: true, spec: "candidates" }, sort: "progress", limit: 200 },
      { type: "map", repo: "shop-api" },
      { type: "map", repo: "shop-api", overlay: "layer", dir: "app" },
      { type: "map", repo: "shop-api", overlay: "journey:j_0000000000a1" },
      { type: "progress", by: "area" },
      { type: "checks", limit: 50 },
      { type: "specCoverage", by: "repo" },
      { type: "note", markdown: "hello" },
    ];
    for (const w of widgets) expect(WidgetSchema.safeParse(w).success, JSON.stringify(w)).toBe(true);
    // the spec filter takes the four Home marks (final review §10); anything else is refused
    for (const spec of ["linked", "candidates", "none", "unchecked"]) expect(WidgetSchema.safeParse({ type: "journeys", filter: { spec } }).success, spec).toBe(true);
    expect(WidgetSchema.safeParse({ type: "journeys", filter: { spec: "missing" } }).success).toBe(false);
  });

  it("rejects unknown widget types, unknown keys and out-of-range values", () => {
    const bad = [
      { type: "chart" },
      { type: "html", html: "<b>x</b>" },
      { type: "counts", show: ["galaxies"] },
      { type: "journeys", limit: 0 },
      { type: "journeys", limit: 201 },
      { type: "journeys", filter: { level: "expert" } },
      { type: "journeys", sort: "random" },
      { type: "map" },
      { type: "map", repo: "a", overlay: "journey:nope" },
      { type: "checks", limit: 51 },
      { type: "note", markdown: "x".repeat(VIEW_LIMITS.markdown + 1) },
      { type: "note", markdown: "x", html: "<script>" },
    ];
    for (const w of bad) expect(WidgetSchema.safeParse(w).success, JSON.stringify(w)).toBe(false);
  });

  it("checks the id and the widget count", () => {
    expect(ViewDraftSchema.safeParse(AUDIT).success).toBe(true);
    for (const id of ["", "Home", "a_b", "a".repeat(41), "../x"]) expect(ViewDraftSchema.safeParse({ ...AUDIT, id }).success, id).toBe(false);
    const many = Array.from({ length: VIEW_LIMITS.widgets + 1 }, () => ({ type: "counts" }));
    expect(ViewDraftSchema.safeParse({ ...AUDIT, widgets: many }).success).toBe(false);
  });
});

describe("views store", () => {
  it("saves, reads, lists and deletes a view", () => {
    const r = root();
    expect(listViews(r)).toEqual([]);
    const saved = saveView(r, AUDIT);
    expect(saved.replaced).toBe(false);
    expect(saved.view).toMatchObject({ version: 1, id: "no-spec-audit", title: "No-spec audit" });
    expect(readView(r, "no-spec-audit")).toEqual(saved.view);
    // widgets keep their order; the file is deterministic
    expect(saved.view.widgets.map((w) => w.type)).toEqual(["counts", "journeys", "note"]);
    const text = readFileSync(viewPath(r, "no-spec-audit"), "utf8");
    saveView(r, AUDIT);
    expect(readFileSync(viewPath(r, "no-spec-audit"), "utf8")).toBe(text);
    expect(saveView(r, AUDIT).replaced).toBe(true);
    expect(listViews(r)).toEqual(["no-spec-audit"]);
    deleteView(r, "no-spec-audit");
    expect(listViews(r)).toEqual([]);
    expect(() => deleteView(r, "no-spec-audit")).toThrow(/No view/);
  });

  it("an agent-sent version is ignored; a bad draft writes nothing", () => {
    const r = root();
    expect(saveView(r, { ...AUDIT, version: 7 }).view.version).toBe(1);
    expect(() => saveView(r, { ...AUDIT, id: "other", widgets: [{ type: "chart" }] })).toThrow(CodeloomError);
    expect(existsSync(viewPath(r, "other"))).toBe(false);
  });

  it("rejects a bad id when reading or deleting", () => {
    const r = root();
    expect(() => readView(r, "../x")).toThrow(/view id/);
    expect(() => deleteView(r, "A")).toThrow(/view id/);
  });

  it("summaries: title and widget count, or the error of a broken file", () => {
    const r = root();
    saveView(r, AUDIT);
    mkdirSync(join(r, ".codeloom", "views"), { recursive: true });
    writeFileSync(join(r, ".codeloom", "views", "broken.json"), "{}");
    writeFileSync(join(r, ".codeloom", "views", "Not_A_View.json"), "{}");
    const s = viewSummaries(r);
    expect(s.map((v) => v.id)).toEqual(["broken", "no-spec-audit"]);
    expect(s[0]).toMatchObject({ id: "broken", error: expect.stringMatching(/unexpected shape/) });
    expect(s[1]).toEqual({ id: "no-spec-audit", title: "No-spec audit", description: "Customer journeys without a spec.", widgets: 3 });
  });

  it("home fallback: valid home view, missing, or broken (with the reason)", () => {
    const r = root();
    expect(homeView(r)).toEqual({ view: null });
    saveView(r, { ...AUDIT, id: "home", title: "Home" });
    expect(homeView(r).view?.title).toBe("Home");
    writeFileSync(viewPath(r, "home"), "{ broken");
    const h = homeView(r);
    expect(h.view).toBeNull();
    expect(h.error).toMatch(/not valid JSON/);
  });
});
