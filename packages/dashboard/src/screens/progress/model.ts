/** The Progress screen's lists, derived from GET /api/progress. */
import type { JourneyProgressView, LevelCounts, ProgressResponse } from "@/api/types";
import { displayLevel, LEVEL_STEPS, stripCounts } from "@/lib/progress";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en") || 0;
/** Areas by name; journeys with no area last. */
const areaOrder = (a: string, b: string) => (a === "" ? 1 : 0) - (b === "" ? 1 : 0) || a.localeCompare(b, "en");

export interface RepoRow {
  repo: string;
  counts: LevelCounts;
  understood: number;
  /** Toured or further (understood journeys that need a re-walk count here). */
  touredOrMore: number;
  left: number;
}

export function repoRows(p: ProgressResponse): RepoRow[] {
  return Object.keys(p.totals.byRepo)
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((repo) => {
      const counts = p.totals.byRepo[repo]!;
      const s = stripCounts(counts);
      return { repo, counts, understood: s.understood, touredOrMore: s.understood + s.toured, left: counts.total - s.understood };
    });
}

export function areaRows(p: ProgressResponse): Array<{ area: string; counts: LevelCounts }> {
  return Object.keys(p.totals.byArea)
    .sort(areaOrder)
    .map((area) => ({ area, counts: p.totals.byArea[area]! }));
}

/** Understood journeys whose code changed since, by name. */
export function reWalks(p: ProgressResponse): JourneyProgressView[] {
  return p.journeys.filter((v) => displayLevel(v) === "re-walk").sort(byName);
}

/** The latest check of each journey that has one, newest first. */
export function recentChecks(p: ProgressResponse, limit = 8): JourneyProgressView[] {
  return p.journeys
    .filter((v) => v.lastCheck)
    .sort((a, b) => b.lastCheck!.at.localeCompare(a.lastCheck!.at) || byName(a, b))
    .slice(0, limit);
}

/** Every journey not understood now, grouped by area (areas by name, no area last; journeys by name). */
export function whatsLeft(p: ProgressResponse): Array<{ area: string; journeys: JourneyProgressView[] }> {
  const groups = new Map<string, JourneyProgressView[]>();
  for (const v of p.journeys) {
    if (displayLevel(v) === "understood") continue;
    groups.set(v.area, [...(groups.get(v.area) ?? []), v]);
  }
  return [...groups.keys()].sort(areaOrder).map((area) => ({ area, journeys: groups.get(area)!.sort(byName) }));
}

/** The unfinished journey furthest along (toured before seen before not started), by name. Journeys that
 * need a re-walk have their own list, so they are not suggested here. */
export function nextSuggested(p: ProgressResponse): JourneyProgressView | undefined {
  return p.journeys
    .filter((v) => {
      const l = displayLevel(v);
      return l !== "understood" && l !== "re-walk";
    })
    .sort((a, b) => LEVEL_STEPS[displayLevel(b)] - LEVEL_STEPS[displayLevel(a)] || byName(a, b))[0];
}
