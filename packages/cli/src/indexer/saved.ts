import { join } from "node:path";
import { JS_EXT } from "../adapters/ast.js";
import type { RepoCodeIndex } from "../linker/code-index.js";
import { readJson } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { readEndpoints, readGraph } from "../store/read.js";
import { FingerprintsSchema } from "../store/schemas.js";
import { CACHE_FORMAT, type IndexResult } from "./index-repo.js";
import type { Alias } from "./resolve-imports.js";

/** A repo's last index, read back from its saved files instead of re-parsing it (0.6 §1: a group is re-linked
 * from every member's saved data when one member is indexed). `graph` is the saved graph.json — already
 * enriched by the linker, so it must not be enriched or written again. */
export interface SavedIndex {
  result: IndexResult;
  /** Set when the repo was linked with less than its full detail (old cache): a line for the user. */
  note?: string;
}

/** Null when the repo has no graph.json or endpoints.json (never indexed here, or its data was deleted), or
 * they were written under another repo id (the repo was indexed in a workspace folder since).
 * Throws (via readJson) when either is corrupt. */
export function loadSavedIndex(repoAbs: string, repoId: string): SavedIndex | null {
  const graph = readGraph(repoAbs);
  const endpoints = readEndpoints(repoAbs);
  if (!graph || !endpoints) return null;
  // Saved under another id (indexed in a workspace folder since): its stops would name the wrong repo.
  if (endpoints.repo !== repoId) return null;
  let fp = null;
  try {
    fp = readJson(join(repoAbs, CODELOOM_DIR, FILES.fingerprints), FingerprintsSchema);
  } catch {
    fp = null; // the cache is disposable: a bad one is treated as missing
  }
  const stats = { files: 0, parsed: 0, reused: 0, skipped: [] };
  const codeIndex: RepoCodeIndex = new Map();
  if (fp?.link && fp.link.format === CACHE_FORMAT) {
    for (const rel of fp.link.files) {
      const record = fp.files[rel];
      if (record?.codeIndex && JS_EXT.test(rel) && !rel.endsWith(".d.ts")) codeIndex.set(rel, record.codeIndex);
    }
    const result: IndexResult = {
      graph, endpoints, stats: { ...stats, files: fp.link.files.length }, codeIndex,
      files: new Set(fp.link.files), aliases: fp.link.aliases as Alias[],
    };
    return { result };
  }
  const files = graph.nodes.flatMap((n) => (n.type === "file" && n.filePath ? [n.filePath] : []));
  return {
    result: { graph, endpoints, stats, codeIndex, files: new Set(files), aliases: [] },
    note: `${repoId} was indexed by another codeloom version: run "codeloom index" in ${repoAbs} for its full links`,
  };
}
