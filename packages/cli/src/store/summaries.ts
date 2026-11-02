import { join } from "node:path";
import { compare } from "../util.js";
import { readJson, writeJsonIfChanged } from "./json.js";
import { CODELOOM_DIR, FILES } from "./paths.js";
import { SummariesFileSchema } from "./schemas.js";

function summariesPath(repoAbs: string): string {
  return join(repoAbs, CODELOOM_DIR, FILES.summaries);
}

/** Node summaries for one repo, keyed by graph node id. Missing file → {}. A bad file → CodeloomError
 * (exit 2); it holds agent work that cannot be regenerated, so the message says to fix it by hand. */
export function readSummaries(repoAbs: string): Record<string, string> {
  return readJson(summariesPath(repoAbs), SummariesFileSchema, { handWritten: true })?.summaries ?? {};
}

/** Set (or, with empty text, delete) one node's summary. Keys are written sorted with compare, via
 * writeJsonIfChanged. Returns whether the file changed. Deleting a key that is not there writes nothing. */
export function writeSummary(repoAbs: string, nodeId: string, text: string): boolean {
  const current = readSummaries(repoAbs);
  if (text === "") {
    if (!Object.hasOwn(current, nodeId)) return false;
    delete current[nodeId];
  } else {
    current[nodeId] = text;
  }
  const summaries: Record<string, string> = {};
  for (const key of Object.keys(current).sort(compare)) summaries[key] = current[key]!;
  return writeJsonIfChanged(summariesPath(repoAbs), { version: 1, summaries });
}
