import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, type KnowledgeGraph } from "@codeloom/core";
import { finalizeEndpoints, loadContext, runAdapters } from "../adapters/run.js";
import type { EndpointsPart } from "../adapters/types.js";
import { readJson, writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import {
  defaultRepoConfig, type EndpointsFile, type Fingerprints, FingerprintsSchema, RepoConfigSchema,
} from "../store/schemas.js";
import { listFiles } from "../workspace/files.js";
import { gitHead } from "../workspace/repos.js";
import { buildGraph } from "./build-graph.js";
import { loadAliases } from "./resolve-imports.js";
import { analyzeStructure, EMPTY_STRUCTURE, type FileEntry, getPlugin, isSourceFile } from "./structure.js";

const MAX_BYTES = 1_000_000;

// Bump this whenever a cached record's shape changes (e.g. new fields on FileRecord,
// a different endpoints/structure format) so stale cache entries get invalidated.
export const CACHE_FORMAT = 1;

let cachedCodeloomVersion: string | undefined;

function readCodeloomVersion(): string {
  if (cachedCodeloomVersion !== undefined) return cachedCodeloomVersion;
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedCodeloomVersion = pkg.version ?? "unknown";
  } catch {
    cachedCodeloomVersion = "unknown";
  }
  return cachedCodeloomVersion;
}

export interface IndexStats {
  files: number;
  parsed: number;
  reused: number;
  skipped: Array<{ file: string; reason: string }>;
}

export interface IndexResult {
  graph: KnowledgeGraph;
  endpoints: EndpointsFile;
  stats: IndexStats;
}

type FileRecord = Fingerprints["files"][string] & FileEntry & { endpoints: EndpointsPart };

export async function indexRepo(
  repoAbs: string,
  repoId: string,
  opts?: { codeloomVersion?: string },
): Promise<IndexResult> {
  const dir = join(repoAbs, CODELOOM_DIR);
  const config = readJson(join(dir, FILES.config), RepoConfigSchema) ?? defaultRepoConfig();
  const files = listFiles(repoAbs, config.ignore);
  const ctx = loadContext(repoAbs, files);
  const codeloomVersion = opts?.codeloomVersion ?? readCodeloomVersion();
  const contextKey = contentHash(
    [`format:${CACHE_FORMAT}`, `codeloom:${codeloomVersion}`, ...[...ctx.deps].sort()].join(","),
  );
  const cachePath = join(dir, FILES.fingerprints);
  const old = readJson(cachePath, FingerprintsSchema);
  const oldFiles = old && old.contextKey === contextKey ? old.files : {};

  const plugin = await getPlugin();
  const entries = new Map<string, FileEntry>();
  const parts: EndpointsPart[] = [];
  const next: Record<string, FileRecord> = {};
  const stats: IndexStats = { files: files.length, parsed: 0, reused: 0, skipped: [] };
  const empty = (rel: string) => entries.set(rel, { structure: EMPTY_STRUCTURE, calls: [] });

  for (const rel of files) {
    if (!isSourceFile(rel)) {
      empty(rel);
      continue;
    }
    const abs = join(repoAbs, rel);
    const size = statSync(abs).size;
    if (size > MAX_BYTES) {
      stats.skipped.push({ file: rel, reason: `larger than 1 MB (${size} bytes)` });
      empty(rel);
      continue;
    }
    const content = readFileSync(abs, "utf8");
    const hash = contentHash(content);
    const hit = oldFiles[rel] as FileRecord | undefined;
    let record: FileRecord;
    if (hit && hit.hash === hash) {
      record = hit;
      stats.reused++;
    } else {
      try {
        record = { hash, ...analyzeStructure(plugin, rel, content), endpoints: runAdapters(rel, content, ctx) };
        stats.parsed++;
      } catch (err) {
        stats.skipped.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
        empty(rel);
        continue;
      }
    }
    next[rel] = record;
    entries.set(rel, { structure: record.structure, calls: record.calls });
    parts.push(record.endpoints);
  }

  const graph = buildGraph(repoId, gitHead(repoAbs), entries, loadAliases(repoAbs, files));
  const endpoints = finalizeEndpoints(repoId, parts);
  writeJsonAtomic(join(dir, FILES.graph), graph);
  writeJsonAtomic(join(dir, FILES.endpoints), endpoints);
  writeJsonAtomic(cachePath, { version: 1, contextKey, files: next } satisfies Fingerprints);
  return { graph, endpoints, stats };
}
