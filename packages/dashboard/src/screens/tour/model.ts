import type { StopView, TourPhase, TourResponse } from "@/api/types";
import { type PlacedStop, stopKey, stopMatcher } from "@/lib/journey-stops";
import { type JourneyModel, type JourneyStop, stopTitle } from "@/screens/journey/model";

/** The four phases, in walking order (the server's TourPhase ids). */
export const TOUR_PHASES: ReadonlyArray<{ id: TourPhase; name: string }> = [
  { id: "flow", name: "Flow" },
  { id: "data-journey", name: "Data journey" },
  { id: "file-notes", name: "File notes" },
  { id: "check", name: "Check yourself" },
];
export const PHASE_IDS: readonly TourPhase[] = TOUR_PHASES.map((p) => p.id);
export const phaseName = (id: TourPhase) => TOUR_PHASES.find((p) => p.id === id)!.name;
export const isPhase = (v: unknown): v is TourPhase => typeof v === "string" && (PHASE_IDS as readonly string[]).includes(v);

/** The fields a stopKey encodes: [lane, repo, file, line, symbol]. */
export interface KeyFields {
  lane: string;
  repo: string;
  file: string;
  line: number;
  symbol: string;
}

export function parseKey(key: string): KeyFields | null {
  try {
    const v: unknown = JSON.parse(key);
    if (!Array.isArray(v) || v.length !== 5) return null;
    const [lane, repo, file, line, symbol] = v as unknown[];
    if (typeof lane !== "string" || typeof repo !== "string" || typeof file !== "string" || typeof symbol !== "string") return null;
    if (typeof line !== "number" || !Number.isInteger(line)) return null;
    return { lane, repo, file, line, symbol };
  } catch {
    return null;
  }
}

/** Where a tour or data-journey stop sits now: its journey number and view, or only its key's fields when
 * the journey no longer has it. */
interface Placed {
  key: string;
  /** The stop's number on the Journey screen; undefined when removed. */
  n?: number;
  view?: StopView;
  fields: KeyFields | null;
  removed: boolean;
  title: string;
}

export interface TourStopItem extends Placed {
  explanation: string;
  /** Its file changed since the tour was written ("may be out of date"). */
  stale: boolean;
}

export interface DataStepItem extends Placed {
  note: string;
  sql?: string;
}

export interface TourModel {
  /** Flow, in journey stop order; removed stops last, in file order. */
  stops: TourStopItem[];
  steps: DataStepItem[];
}

/** Every journey stop with its place (chain id, index in that chain), for matching saved stops. */
function placedStops(journey: JourneyModel | undefined): PlacedStop[] {
  if (!journey) return [];
  const byN = new Map(journey.stops.map((s) => [s.n, s]));
  return [...journey.chainStops].flatMap(([chainId, nums]) => nums.map((n, stopIndex) => ({ chainId, stopIndex, key: stopKey(byN.get(n)!.view) })));
}

/** Places a saved stop key in the journey as it is now: matched by its line-free identity (a line added
 * above it is not a removal), by its tour place when two stops share one. */
function placer(r: TourResponse, journey: JourneyModel | undefined) {
  const byKey = new Map<string, JourneyStop>();
  for (const s of journey?.stops ?? []) byKey.set(stopKey(s.view), s);
  const match = stopMatcher(placedStops(journey));
  const removed = new Set(r.removedStops);
  // a data journey step has no place of its own: it borrows the tour stop's with the same key
  const tourPlace = new Map((r.tour?.stops ?? []).map((s) => [s.key, { chainId: s.chainId, stopIndex: s.stopIndex }]));
  return (key: string, place?: { chainId: string; stopIndex: number }): Placed => {
    const fields = parseKey(key);
    const now = removed.has(key) ? undefined : match(key, place ?? tourPlace.get(key));
    const at = now === undefined ? undefined : byKey.get(now);
    if (!at) return { key, fields, removed: true, title: fields?.symbol ?? "Unknown stop" };
    return { key, n: at.n, view: at.view, fields, removed: false, title: stopTitle(at.view) };
  };
}

export function buildTourModel(r: TourResponse, journey: JourneyModel | undefined): TourModel {
  const place = placer(r, journey);
  const stale = new Set(r.staleStops);
  const tour = r.tour;
  if (!tour) return { stops: [], steps: [] };
  const stops = tour.stops
    .map((s, i) => ({ ...place(s.key, s), explanation: s.explanation, stale: stale.has(s.key), i }))
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.i - b.i)
    .map(({ i: _i, ...s }) => s);
  const steps = tour.dataJourney.steps.map((s) => ({ ...place(s.stopKey), note: s.note, ...(s.sql ? { sql: s.sql } : {}) }));
  return { stops, steps };
}

/** One place in the walk: a Flow stop (1-based position in `stops`), or one of the other phases (stop 1). */
export interface TourPlace {
  phase: TourPhase;
  stop: number;
}

/** The place the URL asks for, clamped to the tour. */
export function placeOf(phase: TourPhase | undefined, stop: number | undefined, stopCount: number): TourPlace {
  const p = phase ?? "flow";
  if (p !== "flow") return { phase: p, stop: 1 };
  return { phase: p, stop: Math.min(Math.max(1, stop ?? 1), Math.max(1, stopCount)) };
}

/** The walk is one sequence: Flow stop 1…n, then Data journey, File notes, Check yourself. */
function sequence(stopCount: number): TourPlace[] {
  const flow = Array.from({ length: Math.max(1, stopCount) }, (_, i) => ({ phase: "flow" as const, stop: i + 1 }));
  return [...flow, ...PHASE_IDS.slice(1).map((phase) => ({ phase, stop: 1 }))];
}

function step(at: TourPlace, stopCount: number, by: 1 | -1): TourPlace | undefined {
  const seq = sequence(stopCount);
  const i = seq.findIndex((p) => p.phase === at.phase && p.stop === at.stop);
  return i < 0 ? undefined : seq[i + by];
}

export const nextPlace = (at: TourPlace, stopCount: number) => step(at, stopCount, 1);
export const prevPlace = (at: TourPlace, stopCount: number) => step(at, stopCount, -1);

/** The phase that being at `at` counts as viewed: Flow at its last stop, any other phase once opened. */
export function phaseViewed(at: TourPlace, stopCount: number): TourPhase | undefined {
  if (at.phase !== "flow") return at.phase;
  return at.stop >= stopCount ? "flow" : undefined;
}
