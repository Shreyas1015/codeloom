import type { JourneyResult, StopView } from "@/api/types";

/** A stop's identity, the one get_journey uses to dedupe lane stops: lane, repo, file, line, symbol.
 * The Journey screen and the Map both number stops by it, so a stop has one number everywhere; tours and
 * progress key stops by it too. A copy of the cli's `packages/cli/src/store/stop-key.ts` (no runtime code
 * crosses into the bundle); test/journey-stops.test.ts checks the two agree. */
export function stopKey(s: Pick<StopView, "lane" | "repo" | "file" | "line" | "symbol">): string {
  return JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
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
