/** Reading your progress for display: levels, the three strip segments, understood %, and where to resume. */
import type { JourneyProgressView, LevelCounts, TourFile, TourPhase } from "@/api/types";
import { PHASE_IDS } from "@/screens/tour/model";
import type { StoredTourPlace } from "@/screens/tour/position";

/** What a journey shows: its level, or "re-walk" for an understood journey whose code changed since. */
export type DisplayLevel = "none" | "seen" | "toured" | "understood" | "re-walk";

export function displayLevel(v: Pick<JourneyProgressView, "level" | "needsReWalk">): DisplayLevel {
  return v.level === "understood" && v.needsReWalk.length > 0 ? "re-walk" : v.level;
}

export const LEVEL_WORD: Record<DisplayLevel, string> = {
  none: "Not started",
  seen: "Seen",
  toured: "Toured",
  understood: "Understood",
  "re-walk": "Needs re-walk",
};

/** How many of the three strip segments are filled: seen 1, toured 2, understood 3. A journey that needs
 * a re-walk no longer counts as understood, so it fills two. */
export const LEVEL_STEPS: Record<DisplayLevel, number> = { none: 0, seen: 1, toured: 2, understood: 3, "re-walk": 2 };

export interface StripCounts {
  total: number;
  understood: number;
  toured: number;
  seen: number;
}

/** The strip's three segments. Journeys that need a re-walk count as toured until they are re-checked. */
export function stripCounts(c: LevelCounts): StripCounts {
  return { total: c.total, understood: c.understood - c.needsReWalk, toured: c.toured + c.needsReWalk, seen: c.seen };
}

/** Understood journeys as a whole percent, rounded down (100 only when all are), or undefined with none. */
export function understoodPercent(c: LevelCounts): number | undefined {
  if (c.total === 0) return undefined;
  return Math.floor((stripCounts(c).understood / c.total) * 100);
}

export interface NextStop {
  phase: TourPhase;
  /** 1-based, into the tour's stops (Tour mode's `?stop=`). */
  stop: number;
  /** True when this is where the viewer left off (not the start, not a changed stop). */
  resumed: boolean;
}

/** Where to pick a tour up: the first changed stop when the journey needs a re-walk; else the place Tour mode
 * remembered (`readTourPlace`) while a phase is unviewed, or Check yourself once all four were viewed; else
 * stop 1 of Flow. Undefined when the journey has no tour. */
export function nextTourStop(tour: TourFile | null | undefined, v: JourneyProgressView | undefined, saved: StoredTourPlace | undefined): NextStop | undefined {
  if (!tour || tour.stops.length === 0) return undefined;
  if (v && displayLevel(v) === "re-walk") {
    const changed = new Set(v.needsReWalk);
    const i = tour.stops.findIndex((s) => changed.has(s.key));
    return { phase: "flow", stop: i < 0 ? 1 : i + 1, resumed: false };
  }
  if (saved && PHASE_IDS.every((p) => saved.viewed.includes(p))) return { phase: "check", stop: 1, resumed: true };
  if (saved && (saved.phase !== "flow" || saved.stop <= tour.stops.length)) return { phase: saved.phase, stop: saved.stop, resumed: true };
  return { phase: "flow", stop: 1, resumed: false };
}

const touched = (v: JourneyProgressView) => [v.seenAt, v.touredAt, v.understoodAt].reduce<string>((m, t) => (t && t > m ? t : m), "");

/** The journey Home's Continue band offers: the last opened one while it is unfinished (seen, toured or
 * needs a re-walk), else the unfinished one touched most recently. Undefined when none is in progress. */
export function pickContinue(journeys: JourneyProgressView[], lastId: string | undefined): string | undefined {
  const unfinished = journeys.filter((v) => {
    const l = displayLevel(v);
    return l === "seen" || l === "toured" || l === "re-walk";
  });
  if (lastId && unfinished.some((v) => v.journeyId === lastId)) return lastId;
  let best: JourneyProgressView | undefined;
  for (const v of unfinished) if (!best || touched(v) > touched(best)) best = v;
  return best?.journeyId;
}
