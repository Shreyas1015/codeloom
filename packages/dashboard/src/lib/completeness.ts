import type { StopView } from "@/api/types";

/** Tooltip for the "API → DB" mark: codeloom check's "API → DB only (no UI caller)". */
export const API_ONLY_TITLE = "Reaches the database, but no UI code calls it";

/** Same rule as codeloom's linker/completeness.ts: reaches a db or publish stop, with no page or call stop. */
export function isApiOnly(stops: Pick<StopView, "kind">[]): boolean {
  const store = stops.some((s) => s.kind === "db" || s.kind === "publish");
  const ui = stops.some((s) => s.kind === "page" || s.kind === "call");
  return store && !ui;
}

/** Same rule as codeloom's linker/completeness.ts journeyReach (hG): a journey is API → DB only when NONE
 * of its chains has a UI stop (and every chain reaches a store); when any chain has a UI stop it is judged
 * on its UI chains alone — complete when all of them are complete. */
export function journeyReach(
  chains: ReadonlyArray<{ complete: boolean; stops: Pick<StopView, "kind">[] }>,
  allPresent: boolean,
): { complete: boolean; apiOnly: boolean } {
  if (!allPresent || chains.length === 0) return { complete: false, apiOnly: false };
  const ui = chains.filter((c) => c.stops.some((s) => s.kind === "page" || s.kind === "call"));
  if (ui.length > 0) return { complete: ui.every((c) => c.complete), apiOnly: false };
  return { complete: false, apiOnly: chains.every((c) => isApiOnly(c.stops)) };
}
