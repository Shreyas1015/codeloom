/** A stop's identity: lane, repo, file, line, symbol (JSON-encoded). get_journey dedupes lane stops by it,
 * the dashboard numbers stops by it, tours key their stops by it and progress keys `stopHashes` by it.
 * Matching a saved stop to the journey as it is now goes by the line-free `stopIdentity` (`stopMatcher`).
 *
 * Pure and import-free on purpose: the dashboard keeps its own copy (`packages/dashboard/src/lib/
 * journey-stops.ts`), because no runtime code crosses from the cli into the dashboard bundle, and the
 * dashboard test `journey-stops.test.ts` checks the two agree. */
export interface StopKeyFields {
  lane: string;
  repo: string;
  file: string;
  line: number;
  symbol: string;
}

export function stopKey(s: StopKeyFields): string {
  return JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
}

/** A stop's line-free identity: lane, repo, file, symbol (JSON-encoded). A saved stop (a tour stop, a
 * `stopHashes` entry) is matched to the journey as it is now by this, so a line added above a stop does
 * not make it look removed. */
export function stopIdentity(s: Omit<StopKeyFields, "line">): string {
  return JSON.stringify([s.lane, s.repo, s.file, s.symbol]);
}

/** The line-free identity of a stopKey; null when the string is not one. */
export function keyIdentity(key: string): string | null {
  const k = parseStopKey(key);
  return k ? stopIdentity(k) : null;
}

/** Where a stop sits in its journey: its chain, its index there, and its stopKey. */
export interface PlacedStop {
  chainId: string;
  stopIndex: number;
  key: string;
}

/** Finds a saved stop among the journey's current stops and returns its current stopKey, or undefined when
 * it is gone: the exact key; else the one current stop with the same identity; when two or more share it,
 * the stop now at the saved (chainId, stopIndex), if its identity still matches. */
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

/** The fields back from a stopKey; null when the string is not one. */
export function parseStopKey(key: string): StopKeyFields | null {
  let v: unknown;
  try {
    v = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 5) return null;
  const [lane, repo, file, line, symbol] = v as unknown[];
  if (typeof lane !== "string" || typeof repo !== "string" || typeof file !== "string" || typeof symbol !== "string") return null;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  return { lane, repo, file, line, symbol };
}
