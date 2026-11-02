/** The journey this viewer opened last, per workspace, kept in this browser only. Storage may be blocked
 * (private window, cleared site data), so every access is wrapped and a failure means "none". */

export function lastJourneyKey(workspace: string): string {
  return `codeloom:last-journey:${workspace}`;
}

/** The stored journey or chain id (j_… / ch_…), or undefined. */
export function readLastJourney(workspace: string): string | undefined {
  try {
    const v = localStorage.getItem(lastJourneyKey(workspace));
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Called by the Journey screen when a journey opens. */
export function rememberLastJourney(workspace: string, id: string): void {
  try {
    localStorage.setItem(lastJourneyKey(workspace), id);
  } catch {
    /* storage blocked: nothing to remember */
  }
}
