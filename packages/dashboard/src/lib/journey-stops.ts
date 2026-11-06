import type { JourneyResult, StopView } from "@/api/types";

/** A stop's identity, the one get_journey uses to dedupe lane stops: lane, repo, file, line, symbol.
 * The Journey screen and the Map both number stops by it, so a stop has one number everywhere; tours and
 * progress key stops by it too. A copy of the cli's `packages/cli/src/store/stop-key.ts` (no runtime code
 * crosses into the bundle); test/journey-stops.test.ts checks the two agree. */
export function stopKey(s: Pick<StopView, "lane" | "repo" | "file" | "line" | "symbol">): string {
  return JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
}

/** A stop's line-free identity: lane, repo, file, symbol. Saved stops (a tour's, a re-walk's) are matched
 * to the journey as it is now by it, so a line added above a stop does not make it look removed. A copy of
 * the cli's `stopIdentity`; test/journey-stops.test.ts checks the two agree. */
export function stopIdentity(s: Pick<StopView, "lane" | "repo" | "file" | "symbol">): string {
  return JSON.stringify([s.lane, s.repo, s.file, s.symbol]);
}

/** The line-free identity of a stopKey; null when the string is not one. */
export function keyIdentity(key: string): string | null {
  try {
    const v: unknown = JSON.parse(key);
    if (!Array.isArray(v) || v.length !== 5) return null;
    const [lane, repo, file, line, symbol] = v as unknown[];
    if (typeof lane !== "string" || typeof repo !== "string" || typeof file !== "string" || typeof symbol !== "string") return null;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
    return stopIdentity({ lane: lane as StopView["lane"], repo, file, symbol });
  } catch {
    return null;
  }
}

/** Where a stop sits in its journey: its chain, its index there, and its stopKey. */
export interface PlacedStop {
  chainId: string;
  stopIndex: number;
  key: string;
}

/** Finds a saved stop among the journey's current stops and returns its current stopKey, or undefined when
 * it is gone: the exact key; else the one current stop with the same identity; when two or more share it,
 * the stop now at the saved (chainId, stopIndex), if its identity still matches. A copy of the cli's. */
export function stopMatcher(current: readonly PlacedStop[]): (key: string, at?: Omit<PlacedStop, "key">) => string | undefined {
  const keys = new Set(current.map((s) => s.key));
  const byIdentity = new Map<string, Set<string>>();
  const byPlace = new Map<string, string>();
  for (const s of current) {
    const id = keyIdentity(s.key);
    if (id !== null) byIdentity.set(id, (byIdentity.get(id) ?? new Set()).add(s.key));
    byPlace.set(JSON.stringify([s.chainId, s.stopIndex]), s.key);
  }
  return (key, at) => {
    if (keys.has(key)) return key;
    const id = keyIdentity(key);
    const same = id === null ? undefined : byIdentity.get(id);
    if (!same) return undefined;
    if (same.size === 1) return [...same][0];
    if (!at) return undefined;
    const there = byPlace.get(JSON.stringify([at.chainId, at.stopIndex]));
    return there !== undefined && keyIdentity(there) === id ? there : undefined;
  };
}

/** Stop numbers by `stopKey`: 1-based, in chain order across the whole journey; a stop shared by
 * chains keeps its first number. */
export function numberStops(journey: Pick<JourneyResult, "chains">): Map<string, number> {
  const nums = new Map<string, number>();
  for (const c of journey.chains) {
    for (const s of c.stops) {
      const key = stopKey(s);
      if (!nums.has(key)) nums.set(key, nums.size + 1);
    }
  }
  return nums;
}

/** Index, within the same chain's stops, of the stop this one was reached from (undefined when the
 * linker did not record one). */
export function stopFrom(s: StopView): number | undefined {
  const { from } = s;
  return typeof from === "number" && Number.isInteger(from) ? from : undefined;
}
