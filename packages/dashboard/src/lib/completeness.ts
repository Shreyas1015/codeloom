import type { StopView } from "@/api/types";

/** Tooltip for the "API → DB" mark: codeloom check's "API → DB only (no UI caller)". */
export const API_ONLY_TITLE = "Reaches the database, but no UI code calls it";

type StopLike = Pick<StopView, "kind"> & { lane?: StopView["lane"] };

/** A page, or a call made by UI code (a backend's call to another service is in the code lane). */
const isUiStop = (s: StopLike) => s.kind === "page" || (s.kind === "call" && s.lane !== "code");

/** Same rule as codeloom's linker/completeness.ts: reaches a db or publish stop, with no UI stop. */
export function isApiOnly(stops: StopLike[]): boolean {
  const store = stops.some((s) => s.kind === "db" || s.kind === "publish");
  return store && !stops.some(isUiStop);
}

/** Same rule as codeloom's linker/completeness.ts journeyReach (hG): a journey is API → DB only when NONE
 * of its chains has a UI stop (and every chain reaches a store); when any chain has a UI stop it is judged
 * on its UI chains alone — complete when all of them are complete. */
export function journeyReach(
  chains: ReadonlyArray<{ complete: boolean; stops: StopLike[] }>,
  allPresent: boolean,
): { complete: boolean; apiOnly: boolean } {
  if (!allPresent || chains.length === 0) return { complete: false, apiOnly: false };
  const ui = chains.filter((c) => c.stops.some(isUiStop));
  if (ui.length > 0) return { complete: ui.every((c) => c.complete), apiOnly: false };
  return { complete: false, apiOnly: chains.every((c) => isApiOnly(c.stops)) };
}
