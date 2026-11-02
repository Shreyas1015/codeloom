import type { Confidence, JourneyRow, Lane } from "@/api/types";

export const LANES: Lane[] = ["ui", "api", "code", "db", "queue"];

export type SortKey = "name" | "area" | "stops" | "confidence";
export type CompleteFilter = "" | "complete" | "incomplete";

export interface JourneyFilter {
  /** Free text: every word must appear in the name, area, note or a table. */
  q: string;
  area: string;
  repo: string;
  confidence: "" | Confidence;
  complete: CompleteFilter;
}

export const NO_FILTER: JourneyFilter = { q: "", area: "", repo: "", confidence: "", complete: "" };

const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, param: 1, guess: 2 };

export function totalStops(r: JourneyRow): number {
  return LANES.reduce((n, l) => n + (r.stops[l] ?? 0), 0);
}

/** The distinct areas and repos across `rows`, sorted, for the filter menus. */
export function facets(rows: JourneyRow[]): { areas: string[]; repos: string[] } {
  const areas = new Set<string>();
  const repos = new Set<string>();
  for (const r of rows) {
    if (r.area) areas.add(r.area);
    for (const repo of r.repos) repos.add(repo);
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { areas: sorted(areas), repos: sorted(repos) };
}

export function filterJourneys(rows: JourneyRow[], f: JourneyFilter): JourneyRow[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.area && r.area !== f.area) return false;
    if (f.repo && !r.repos.includes(f.repo)) return false;
    if (f.confidence && r.confidence !== f.confidence) return false;
    if (f.complete === "complete" && !r.complete) return false;
    if (f.complete === "incomplete" && r.complete) return false;
    if (words.length) {
      const hay = [r.name, r.area, r.note, ...r.tables].join("\n").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const byName = (a: JourneyRow, b: JourneyRow) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** A sorted copy. Stops: most first. Confidence: surest first. Ties fall back to the name. */
export function sortJourneys(rows: JourneyRow[], key: SortKey): JourneyRow[] {
  const cmp: Record<SortKey, (a: JourneyRow, b: JourneyRow) => number> = {
    name: byName,
    area: (a, b) => a.area.localeCompare(b.area) || byName(a, b),
    stops: (a, b) => totalStops(b) - totalStops(a) || byName(a, b),
    confidence: (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || byName(a, b),
  };
  return [...rows].sort(cmp[key]);
}
