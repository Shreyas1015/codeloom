/** Pure helpers behind the view widgets: journey filters and sorts that also know your progress and spec
 * state, count cells, and spec coverage rows. */
import type { JourneyProgressView, JourneyRow, Overview, SpecState, ViewCountKey, ViewLevel, Widget } from "@/api/types";
import { displayLevel } from "@/lib/progress";
import { sortJourneys } from "@/screens/home/filter";

export type JourneysWidget = Extract<Widget, { type: "journeys" }>;
export type JourneysFilter = NonNullable<JourneysWidget["filter"]>;
export type JourneysSort = NonNullable<JourneysWidget["sort"]>;

/** What the journey widget knows besides the rows. Missing maps mean that data has not loaded (or failed). */
export interface JourneyFacts {
  levels?: ReadonlyMap<string, JourneyProgressView>;
  specs?: ReadonlyMap<string, SpecState>;
}

/** A progress entry as a view filter level: "rewalk" for an understood journey whose code changed since. */
export function viewLevel(v: JourneyProgressView | undefined): ViewLevel {
  if (!v) return "none";
  const l = displayLevel(v);
  return l === "re-walk" ? "rewalk" : l;
}

export function filterViewJourneys(rows: JourneyRow[], f: JourneysFilter | undefined, facts: JourneyFacts): JourneyRow[] {
  if (!f) return rows;
  return rows.filter((r) => {
    if (f.area !== undefined && r.area !== f.area) return false;
    if (f.repo !== undefined && !r.repos.includes(f.repo)) return false;
    if (f.confidence !== undefined && r.confidence !== f.confidence) return false;
    if (f.complete !== undefined && r.complete !== f.complete) return false;
    if (f.level !== undefined && (!facts.levels || viewLevel(facts.levels.get(r.id)) !== f.level)) return false;
    if (f.spec !== undefined && (!facts.specs || facts.specs.get(r.id) !== f.spec)) return false;
    return true;
  });
}

/** Furthest along first; a journey that needs a re-walk sits just under understood. */
const LEVEL_RANK: Record<ViewLevel, number> = { understood: 4, rewalk: 3, toured: 2, seen: 1, none: 0 };
const SPEC_RANK: Record<SpecState, number> = { linked: 0, candidates: 1, none: 2 };
const byName = (a: JourneyRow, b: JourneyRow) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** A sorted copy (name by default). Progress: furthest along first. Spec: linked, then candidates, then none. */
export function sortViewJourneys(rows: JourneyRow[], sort: JourneysSort | undefined, facts: JourneyFacts): JourneyRow[] {
  if (sort === "progress") {
    const rank = (r: JourneyRow) => LEVEL_RANK[viewLevel(facts.levels?.get(r.id))];
    return [...rows].sort((a, b) => rank(b) - rank(a) || byName(a, b));
  }
  if (sort === "spec") {
    const rank = (r: JourneyRow) => SPEC_RANK[facts.specs?.get(r.id) ?? "none"];
    return [...rows].sort((a, b) => rank(a) - rank(b) || byName(a, b));
  }
  return sortJourneys(rows, sort ?? "name");
}

export const COUNT_CAPTION: Record<ViewCountKey, string> = {
  files: "Files",
  pages: "UI pages",
  routes: "API routes",
  tables: "DB tables",
  queues: "Queues",
  journeys: "User journeys",
  understood: "Understood",
  specLinked: "With a spec",
};

export const DEFAULT_COUNTS: ViewCountKey[] = ["files", "pages", "routes", "tables", "queues", "journeys"];

export interface CountCell {
  key: ViewCountKey;
  caption: string;
  /** Undefined while the data behind it is not there (progress or specs not loaded). */
  value: number | undefined;
}

/** The cells a counts widget shows, in the order asked (the Home six when none are). */
export function countCells(o: Overview, show: ViewCountKey[] | undefined, extra: { understood?: number; specLinked?: number }): CountCell[] {
  const sum = (k: "files" | "pages" | "routes" | "tables" | "queues") => o.repos.reduce((n, r) => n + r[k], 0);
  const value = (k: ViewCountKey): number | undefined => {
    if (k === "journeys") return o.journeys.total;
    if (k === "understood" || k === "specLinked") return extra[k];
    return sum(k);
  };
  return [...new Set(show?.length ? show : DEFAULT_COUNTS)].map((key) => ({ key, caption: COUNT_CAPTION[key], value: value(key) }));
}
