/** Where this viewer is in a journey's tour, and which phases they have viewed, per workspace, kept in this
 * browser only (so "Resume tour" knows where to go back to). Storage may be blocked, so every access is
 * wrapped and a failure means "nothing stored". */
import type { TourPhase } from "@/api/types";
import { isPhase, type TourPlace } from "./model";

export interface StoredTourPlace extends TourPlace {
  viewed: TourPhase[];
}

export function tourPlaceKey(workspace: string, journeyId: string): string {
  return `codeloom:tour:${workspace}:${journeyId}`;
}

export function readTourPlace(workspace: string, journeyId: string): StoredTourPlace | undefined {
  try {
    const raw = localStorage.getItem(tourPlaceKey(workspace, journeyId));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { phase?: unknown; stop?: unknown; viewed?: unknown };
    if (!v || typeof v !== "object") return undefined;
    const phase = isPhase(v.phase) ? v.phase : "flow";
    const stop = typeof v.stop === "number" && Number.isInteger(v.stop) && v.stop >= 1 ? v.stop : 1;
    const viewed = Array.isArray(v.viewed) ? [...new Set(v.viewed.filter(isPhase))] : [];
    return { phase, stop, viewed };
  } catch {
    return undefined;
  }
}

export function rememberTourPlace(workspace: string, journeyId: string, place: StoredTourPlace): void {
  try {
    localStorage.setItem(tourPlaceKey(workspace, journeyId), JSON.stringify(place));
  } catch {
    /* storage blocked: nothing to remember */
  }
}
