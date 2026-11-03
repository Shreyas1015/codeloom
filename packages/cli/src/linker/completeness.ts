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
