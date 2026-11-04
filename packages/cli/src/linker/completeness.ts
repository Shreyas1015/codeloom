import type { ChainStop } from "../store/schemas.js";

/** How far a chain gets (H3):
 * - "complete": it has a UI stop (a page or a call) and reaches a database table or queue — UI → API → DB;
 * - "api-only": it reaches a store but has no UI stop (a route or consumer no UI code calls) — API → DB only;
 * - "incomplete": it reaches no store.
 * Unresolved calls (often framework calls such as `res.json(...)`) never affect this. */
export type ChainReach = "complete" | "api-only" | "incomplete";

type StopLike = Pick<ChainStop, "kind">;

export function hasUiStop(stops: readonly StopLike[]): boolean {
  return stops.some((s) => s.kind === "page" || s.kind === "call");
}

export function reachesStore(stops: readonly StopLike[]): boolean {
  return stops.some((s) => s.kind === "db" || s.kind === "publish");
}

export function chainReach(stops: readonly StopLike[]): ChainReach {
  if (!reachesStore(stops)) return "incomplete";
  return hasUiStop(stops) ? "complete" : "api-only";
}

/** Complete = a UI stop and a store stop. A route-only chain that reaches a store is "api-only". */
export function isComplete(stops: readonly StopLike[]): boolean {
  return chainReach(stops) === "complete";
}

/** A journey's completeness over its resolved chains (hG). A journey is "API → DB only" only when NONE of
 * its chains has a UI stop and every chain reaches a store. When any chain has a UI stop, the journey is
 * judged on its UI chains alone: complete when every one of them is complete (route-only or consumer
 * chains beside them never make it API → DB). `allPresent`: every chain id the journey names resolved. */
export function journeyReach(
  chains: ReadonlyArray<{ complete: boolean; stops: readonly StopLike[] }>,
  allPresent: boolean,
): { complete: boolean; apiOnly: boolean } {
  if (!allPresent || chains.length === 0) return { complete: false, apiOnly: false };
  const ui = chains.filter((c) => hasUiStop(c.stops));
  if (ui.length > 0) return { complete: ui.every((c) => c.complete), apiOnly: false };
  return { complete: false, apiOnly: chains.every((c) => chainReach(c.stops) === "api-only") };
}
