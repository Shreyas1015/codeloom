/** A stop's identity: lane, repo, file, line, symbol (JSON-encoded). get_journey dedupes lane stops by it,
 * the dashboard numbers stops by it, tours key their stops by it and progress keys `stopHashes` by it.
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
