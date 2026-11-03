import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentHash, type KnowledgeGraph } from "@codeloom/core";
import { JS_EXT, parseSource } from "../adapters/ast.js";
import { finalizeEndpoints, loadContext, runAdapters } from "../adapters/run.js";
import type { EndpointsPart, ParsedFile } from "../adapters/types.js";
import { CodeloomError } from "../errors.js";
import { buildFileCodeIndex, type FileCodeIndex, type RepoCodeIndex } from "../linker/code-index.js";
import { readJson, writeJsonAtomic, writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import {
  defaultRepoConfig, type EndpointsFile, type Fingerprints, FingerprintsSchema, RepoConfigSchema,
} from "../store/schemas.js";
import { VERSION } from "../version.js";
import { listFiles } from "../workspace/files.js";
import { git } from "../workspace/git.js";
import { gitHead } from "../workspace/repos.js";
import { buildGraph } from "./build-graph.js";
import { type Alias, loadAliases, resolveImport } from "./resolve-imports.js";
import { analyzeStructure, EMPTY_STRUCTURE, type FileEntry, getPlugin, isSourceFile } from "./structure.js";

const MAX_BYTES = 1_000_000;

// Bump this whenever a cached record's shape changes (e.g. new fields on FileRecord,
// a different endpoints/structure format) so stale cache entries get invalidated.
export const CACHE_FORMAT = 22;

/** The key a fingerprints cache must carry to be reused: CACHE_FORMAT, the codeloom version and the
 * repo's dependency context (loadContext(...).key). A cache with any other key is discarded. */
export function cacheContextKey(depsKey: string, codeloomVersion: string = VERSION): string {
  return contentHash([`format:${CACHE_FORMAT}`, `codeloom:${codeloomVersion}`, `deps:${depsKey}`].join(","));
}

/** The cache is disposable: a corrupt, wrong-shape or old-format file is discarded and rebuilt. */
function readCache(path: string): Fingerprints | null {
  try {
    return readJson(path, FingerprintsSchema);
  } catch {
    return null;
  }
}

function checkRepo(repoAbs: string, repoId: string): void {
  if (!existsSync(repoAbs) || !statSync(repoAbs).isDirectory()) {
    throw new CodeloomError(
      `Repo "${repoId}" was not found at ${repoAbs}. Fix its path in codeloom.workspace.json, or run "codeloom init" again.`,
    );
  }
  // A ".git" entry (folder or worktree file) can exist yet point nowhere (e.g. a worktree whose
  // main checkout was removed), so ask git itself rather than trust the entry's presence.
  let inWorkTree = false;
  try {
    inWorkTree = git(repoAbs, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch (err) {
    if (err instanceof CodeloomError) throw err; // git missing from PATH: a different, clearer error
    inWorkTree = false;
  }
  if (!inWorkTree) {
    throw new CodeloomError(
      `Repo "${repoId}" at ${repoAbs} is not a git repo. Run "git init" there, or run "codeloom init" in the right folder.`,
    );
  }
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
  codeIndex: RepoCodeIndex;
  files: Set<string>;
  aliases: Alias[];
}

type FileRecord = Fingerprints["files"][string] & FileEntry & { endpoints: EndpointsPart; codeIndex: FileCodeIndex };

/** The same shape adapters build internally (adapters/run.ts), so the linker's own AST pass sees
 * exactly what the adapters saw. */
function toParsedFile(rel: string, content: string): ParsedFile {
  const isJs = JS_EXT.test(rel) && !rel.endsWith(".d.ts");
  return { rel, content, sf: isJs ? parseSource(rel, content) : undefined };
}

export async function indexRepo(
  repoAbs: string,
  repoId: string,
  opts?: { codeloomVersion?: string },
): Promise<IndexResult> {
  checkRepo(repoAbs, repoId);
  const dir = join(repoAbs, CODELOOM_DIR);
  const config = readJson(join(dir, FILES.config), RepoConfigSchema) ?? defaultRepoConfig();
  const files = listFiles(repoAbs, config.ignore);
  const ctx = loadContext(repoAbs, files);
  const contextKey = cacheContextKey(ctx.key, opts?.codeloomVersion ?? VERSION);
  const cachePath = join(dir, FILES.fingerprints);
  const old = readCache(cachePath);
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
    let record: FileRecord;
    try {
      // Read inside the try: a file deleted or unreadable mid-run is skipped, not fatal.
      const size = statSync(abs).size;
      if (size > MAX_BYTES) {
        stats.skipped.push({ file: rel, reason: `larger than 1 MB (${size} bytes)` });
        empty(rel);
        continue;
      }
      const content = readFileSync(abs, "utf8");
      const hash = contentHash(content);
      const hit = oldFiles[rel] as FileRecord | undefined;
      // A record without a codeIndex (shape drift) is treated as a miss and rebuilt.
      if (hit && hit.hash === hash && hit.codeIndex) {
        record = hit;
        stats.reused++;
      } else {
        record = {
          hash,
          ...analyzeStructure(plugin, rel, content),
          endpoints: runAdapters(rel, content, ctx.contextFor(rel)),
          codeIndex: buildFileCodeIndex(toParsedFile(rel, content)),
        };
        stats.parsed++;
      }
    } catch (err) {
      stats.skipped.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
      empty(rel);
      continue;
    }
    next[rel] = record;
    entries.set(rel, { structure: record.structure, calls: record.calls });
    parts.push(record.endpoints);
  }

  const head = gitHead(repoAbs);
  const aliases = loadAliases(repoAbs, files);
  const fileSet = new Set(files);
  const graph = buildGraph(repoId, head, entries, aliases);
  // graph.json and endpoints.json are committed: keep them a pure function of the code, so
  // re-indexing unchanged code leaves git clean. Time and commit go to the git-ignored cache.
  graph.project.analyzedAt = "";
  graph.project.gitCommitHash = "";
  const endpoints = finalizeEndpoints(repoId, parts, (from, spec) => resolveImport(from, spec, fileSet, aliases));
  writeJsonIfChanged(join(dir, FILES.graph), graph);
  writeJsonIfChanged(join(dir, FILES.endpoints), endpoints);
  writeJsonAtomic(cachePath, {
    version: 2,
    contextKey,
    indexedAt: new Date().toISOString(),
    gitCommitHash: head,
    files: next,
  } satisfies Fingerprints);

  const codeIndex: RepoCodeIndex = new Map();
  for (const [rel, record] of Object.entries(next)) {
    if (JS_EXT.test(rel) && !rel.endsWith(".d.ts")) codeIndex.set(rel, record.codeIndex);
  }

  return { graph, endpoints, stats, codeIndex, files: fileSet, aliases };
}
