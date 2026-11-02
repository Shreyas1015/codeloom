import type { Confidence, JourneyResult, Lane, StopView } from "@/api/types";
import { numberStops, stopFrom, stopKey } from "@/lib/journey-stops";

/** One distinct stop of the journey, numbered in chain order (1-based; a stop shared by chains keeps its first number). */
export interface JourneyStop {
  n: number;
  view: StopView;
  /** Chains that pass through it, in chain order. */
  chainIds: string[];
}

/** A hop the linker recorded: from `stops[from]` to a stop of the same chain, with the arriving stop's
 * confidence and reason. When two chains make the same hop, the worse confidence wins. */
export interface JourneyHop {
  from: number;
  to: number;
  confidence: Confidence;
  reason?: string;
}

export interface JourneyModel {
  stops: JourneyStop[];
  lanes: Record<Lane, JourneyStop[]>;
  hops: JourneyHop[];
  showQueue: boolean;
  /** Worst over the chains; null when there are none. */
  confidence: Confidence | null;
  /** Every chain present and complete (and at least one). */
  complete: boolean;
  repos: string[];
  /** chain id → the stop numbers of its stops, in order. */
  chainStops: Map<string, number[]>;
}

export const LANE_ORDER: Lane[] = ["ui", "api", "code", "db", "queue"];
const RANK: Record<Confidence, number> = { exact: 0, param: 1, guess: 2 };

export function stopTitle(s: StopView): string {
  return s.label ?? s.symbol;
}

export function buildJourneyModel(r: JourneyResult): JourneyModel {
  const byKey = new Map<string, JourneyStop>();
  const stops: JourneyStop[] = [];
  const hops: JourneyHop[] = [];
  const hopAt = new Map<string, JourneyHop>();
  const chainStops = new Map<string, number[]>();
  const numbers = numberStops(r);

  for (const c of r.chains) {
    const nums: number[] = [];
    for (const s of c.stops) {
      const key = stopKey(s);
      let stop = byKey.get(key);
      if (!stop) {
        stop = { n: numbers.get(key)!, view: s, chainIds: [] };
        byKey.set(key, stop);
        stops.push(stop);
      }
      if (!stop.chainIds.includes(c.id)) stop.chainIds.push(c.id);
      nums.push(stop.n);
    }
    // only the hops the linker recorded: never inferred from list order
    c.stops.forEach((s, i) => {
      const from = stopFrom(s);
      if (from === undefined || from === i || from < 0 || from >= nums.length) return;
      const a = nums[from]!;
      const b = nums[i]!;
      if (a === b) return;
      const hk = `${a}>${b}`;
      const seen = hopAt.get(hk);
      if (!seen) {
        const hop: JourneyHop = { from: a, to: b, confidence: s.confidence, ...(s.reason ? { reason: s.reason } : {}) };
        hopAt.set(hk, hop);
        hops.push(hop);
      } else if (RANK[s.confidence] > RANK[seen.confidence]) {
        seen.confidence = s.confidence;
        if (s.reason) seen.reason = s.reason;
        else delete seen.reason;
      }
    });
    chainStops.set(c.id, nums);
  }

  const lanes = Object.fromEntries(LANE_ORDER.map((l) => [l, stops.filter((s) => s.view.lane === l)])) as Record<Lane, JourneyStop[]>;
  const confidence = r.chains.reduce<Confidence | null>(
    (worst, c) => (worst === null || RANK[c.confidence] > RANK[worst] ? c.confidence : worst),
    null,
  );
  return {
    stops,
    lanes,
    hops,
    showQueue: lanes.queue.length > 0,
    confidence,
    complete: r.chains.length > 0 && r.missingChainIds.length === 0 && r.chains.every((c) => c.complete),
    repos: [...new Set(stops.map((s) => s.view.repo))].sort(),
    chainStops,
  };
}
