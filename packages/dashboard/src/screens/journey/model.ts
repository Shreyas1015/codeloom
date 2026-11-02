import type { Confidence, JourneyResult, Lane, StopView } from "@/api/types";

/** One distinct stop of the journey, numbered in chain order (1-based; a stop shared by chains keeps its first number). */
export interface JourneyStop {
  n: number;
  view: StopView;
  /** Chains that pass through it, in chain order. */
  chainIds: string[];
  /** An unresolved item sits on this stop: the trail stops here. */
  unresolved: boolean;
}

/** A hop between two consecutive stops of one chain. Its confidence is the arriving stop's. */
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

/** Same identity get_journey uses to dedupe lane stops. */
export function stopKey(s: Pick<StopView, "lane" | "repo" | "file" | "line" | "symbol">): string {
  return JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
}

export function stopTitle(s: StopView): string {
  return s.label ?? s.symbol;
}

export function buildJourneyModel(r: JourneyResult): JourneyModel {
  const byKey = new Map<string, JourneyStop>();
  const stops: JourneyStop[] = [];
  const hops: JourneyHop[] = [];
  const hopSeen = new Set<string>();
  const chainStops = new Map<string, number[]>();
  const unresolvedAt = new Set(r.chains.flatMap((c) => c.unresolved.map((u) => `${u.at.repo}\0${u.at.file}\0${u.at.line}`)));

  for (const c of r.chains) {
    const nums: number[] = [];
    let prev: JourneyStop | undefined;
    for (const s of c.stops) {
      const key = stopKey(s);
      let stop = byKey.get(key);
      if (!stop) {
        stop = { n: stops.length + 1, view: s, chainIds: [], unresolved: unresolvedAt.has(`${s.repo}\0${s.file}\0${s.line}`) };
        byKey.set(key, stop);
        stops.push(stop);
      }
      if (!stop.chainIds.includes(c.id)) stop.chainIds.push(c.id);
      nums.push(stop.n);
      if (prev && prev.n !== stop.n) {
        const hk = `${prev.n}>${stop.n}`;
        if (!hopSeen.has(hk)) {
          hopSeen.add(hk);
          hops.push({ from: prev.n, to: stop.n, confidence: s.confidence, ...(s.reason ? { reason: s.reason } : {}) });
        }
      }
      prev = stop;
    }
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
