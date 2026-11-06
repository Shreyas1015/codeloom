/** Where this viewer last was in a journey's tour, per workspace, kept in this browser only. Tour mode
 * calls rememberTourStop as the viewer moves; Home's Continue band reads it to resume there. Storage may be
 * blocked (private window, cleared site data), so every access is wrapped and a failure means "none". */
import type { TourPhase } from "@/api/types";

export const TOUR_PHASES: readonly TourPhase[] = ["flow", "data-journey", "file-notes", "check"];

export interface TourStop {
  phase: TourPhase;
  /** 1-based, into the tour's stops. */
  stop: number;
}

export function tourStopKey(workspace: string, journeyId: string): string {
  return `codeloom:tour-stop:${workspace}:${journeyId}`;
}

export function readTourStop(workspace: string, journeyId: string): TourStop | undefined {
  try {
    const raw = localStorage.getItem(tourStopKey(workspace, journeyId));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Partial<TourStop>;
    if (!TOUR_PHASES.includes(v.phase as TourPhase) || !Number.isInteger(v.stop) || (v.stop as number) < 1) return undefined;
    return { phase: v.phase as TourPhase, stop: v.stop as number };
  } catch {
    return undefined;
  }
}

export function rememberTourStop(workspace: string, journeyId: string, at: TourStop): void {
  try {
    localStorage.setItem(tourStopKey(workspace, journeyId), JSON.stringify({ phase: at.phase, stop: at.stop }));
  } catch {
    /* storage blocked: nothing to remember */
  }
}
