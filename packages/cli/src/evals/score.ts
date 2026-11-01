import type { Chain, ChainStop, Confidence, ExpectedHop, ExpectedJourneys, HttpMethod } from "../store/schemas.js";
import { compare } from "../util.js";

/** A hop the linker produced, in answer-key shape, with the confidence it was found at. */
export interface FoundHop {
  hop: ExpectedHop;
  confidence: Confidence;
}

/** A stable string for a hop: same fields, same key, whatever the property order. */
export function hopKey(h: ExpectedHop): string {
  switch (h.type) {
    case "ui-api":
      return `ui-api|${h.from.repo}|${h.from.file}|${h.from.symbol}|${h.to.repo}|${h.to.method}|${h.to.path}`;
    case "route-handler":
      return `route-handler|${h.route}|${h.handler.file}|${h.handler.symbol}`;
    case "handler-store":
      return `handler-store|${h.route}|${h.table ?? ""}|${h.queue ?? ""}|${h.op}`;
  }
}

const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, param: 1, guess: 2 };

function lowerConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** Route/call stops store the HTTP method twice: `op` is the bare method, `label` is `"<METHOD> <path>"`.
 * This strips the method back off `label` to recover the path alone. */
function pathFromLabel(stop: ChainStop): string {
  const method = stop.op ?? "";
  return (stop.label ?? "").slice(method.length + 1);
}

/**
 * Turn chains into answer-key hops. Chains are walked in id order and a hop seen twice keeps its first
 * confidence. `handler-store` hops use `chain.routeKey || chain.entry` as `route`, so consumer chains
 * (empty routeKey) are keyed by their entry, `consumer:<repo>:<queue>#<file>#<symbol>`.
 */
export function hopsFromChains(chains: Chain[]): FoundHop[] {
  const sorted = [...chains].sort((a, b) => compare(a.id, b.id));
  const found = new Map<string, FoundHop>();
  const add = (hop: ExpectedHop, confidence: Confidence) => {
    const key = hopKey(hop);
    if (!found.has(key)) found.set(key, { hop, confidence });
  };

  for (const chain of sorted) {
    const route = chain.routeKey || chain.entry;
    for (let i = 0; i < chain.stops.length; i++) {
      const stop = chain.stops[i]!;
      const next = chain.stops[i + 1];

      if (stop.kind === "call" && next?.kind === "route") {
        add(
          {
            type: "ui-api",
            from: { repo: stop.repo, file: stop.file, symbol: stop.symbol },
            to: { repo: next.repo, method: next.op as HttpMethod, path: pathFromLabel(next) },
          },
          lowerConfidence(stop.hop.confidence, next.hop.confidence),
        );
      }
      if (stop.kind === "route" && next?.kind === "handler") {
        add(
          { type: "route-handler", route: chain.routeKey, handler: { file: next.file, symbol: next.symbol } },
          lowerConfidence(stop.hop.confidence, next.hop.confidence),
        );
      }
      if (stop.kind === "db") {
        add({ type: "handler-store", route, table: stop.label, op: stop.op! }, stop.hop.confidence);
      }
      if (stop.kind === "publish" || stop.kind === "consume") {
        add({ type: "handler-store", route, queue: stop.label, op: stop.op! }, stop.hop.confidence);
      }
    }
  }
  return [...found.values()];
}

/** Precision/recall for one hop type. `found` counts exact + param hops only; guesses are counted apart. */
export interface HopTypeScore {
  expected: number;
  found: number;
  truePositives: number;
  precision: number;
  recall: number;
  guesses: number;
  guessCorrect: number;
  /** hopKey of every expected hop not found at exact/param confidence, sorted. */
  missing: string[];
  /** hopKey of every exact/param found hop that is not in the key, sorted. */
  extra: string[];
}
export type ScoreReport = Record<ExpectedHop["type"], HopTypeScore>;

const HOP_TYPES: Array<ExpectedHop["type"]> = ["ui-api", "route-handler", "handler-store"];

/** Score the linker's chains against a hand-written answer key. A zero denominator scores 1. */
export function scoreChains(key: ExpectedJourneys, chains: Chain[]): ScoreReport {
  const allFound = hopsFromChains(chains);
  const report = {} as ScoreReport;

  for (const type of HOP_TYPES) {
    const expectedHops = key.hops.filter((h) => h.type === type);
    const expectedKeys = new Set(expectedHops.map(hopKey));
    const foundForType = allFound.filter((f) => f.hop.type === type);
    const counted = foundForType.filter((f) => f.confidence !== "guess");
    const guesses = foundForType.filter((f) => f.confidence === "guess");

    const countedKeys = counted.map((f) => hopKey(f.hop));
    const countedSet = new Set(countedKeys);
    const truePositives = countedKeys.filter((k) => expectedKeys.has(k)).length;
    const guessCorrect = guesses.filter((f) => expectedKeys.has(hopKey(f.hop))).length;

    const missing = [...expectedKeys].filter((k) => !countedSet.has(k)).sort(compare);
    const extra = countedKeys.filter((k) => !expectedKeys.has(k)).sort(compare);

    report[type] = {
      expected: expectedHops.length,
      found: counted.length,
      truePositives,
      precision: counted.length === 0 ? 1 : truePositives / counted.length,
      recall: expectedHops.length === 0 ? 1 : truePositives / expectedHops.length,
      guesses: guesses.length,
      guessCorrect,
      missing,
      extra,
    };
  }
  return report;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** A plain-text table, one row per hop type. */
export function formatScore(r: ScoreReport): string {
  const header = ["hop type", "expected", "found", "precision", "recall", "guesses"];
  const rows = HOP_TYPES.map((type) => {
    const s = r[type];
    return [type, s.expected, s.found, pct(s.precision), pct(s.recall), s.guesses].map(String);
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
