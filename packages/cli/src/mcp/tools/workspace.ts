import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runIndex } from "../../commands/index-cmd.js";
import { dataError } from "../../errors.js";
import { readJson } from "../../store/json.js";
import { CODELOOM_DIR, FILES } from "../../store/paths.js";
import { type Fingerprints, FingerprintsSchema } from "../../store/schemas.js";
import { compare } from "../../util.js";
import { listFiles, listFilesAsync } from "../../workspace/files.js";
import { git, gitAsync } from "../../workspace/git.js";
import { gitHead, gitHeadAsync, loadWorkspace } from "../../workspace/repos.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { journeysByChain, loadMapState } from "../state.js";

const distinct = (xs: string[]) => new Set(xs).size;

/** workspace_overview: repos with their counts, chain totals, journey totals, chains in no journey. */
export function workspaceOverview(start: string): Record<string, unknown> {
  const state = loadMapState(start);
  const repos = state.ws.repos.map((r) => ({
    id: r.ref.id,
    path: r.ref.path,
    ...(r.ref.role ? { role: r.ref.role } : {}),
    files: r.graph.nodes.filter((n) => n.type === "file").length,
    nodes: r.graph.nodes.length,
    edges: r.graph.edges.length,
    pages: r.endpoints.pages.length,
    routes: r.endpoints.routes.length,
    calls: r.endpoints.httpCalls.length,
    tables: distinct(r.endpoints.tables.map((t) => t.name)),
    queues: distinct(r.endpoints.queues.map((q) => q.queue)),
  }));
  repos.sort((a, b) => compare(a.id, b.id));
  const byConfidence = { exact: 0, param: 0, guess: 0 };
  for (const c of state.chains) byConfidence[c.confidence]++;
  const named = journeysByChain(state);
  return {
    name: state.ws.name,
    repos,
    chains: { total: state.chains.length, complete: state.chains.filter((c) => c.complete).length, byConfidence },
    journeys: { total: state.journeys.length, orphaned: state.journeys.filter((j) => j.status === "orphaned").length },
    unnamedChains: state.chains.filter((c) => !named.has(c.id)).length,
  };
}

/** fingerprints.json is a disposable cache (git-ignored): a corrupt or unreadable one is treated the
 * same as a missing one, never a tool error. */
function readFingerprints(repoAbs: string): Fingerprints | null {
  try {
    return readJson(join(repoAbs, CODELOOM_DIR, FILES.fingerprints), FingerprintsSchema);
  } catch {
    return null;
  }
}

const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain", "-z", "-uall", "--", "."];
const diffArgs = (from: string, to: string) => ["--no-optional-locks", "diff", "--relative", "--name-only", "-z", `${from}..${to}`];

/** Repo-relative paths with uncommitted changes (staged, unstaged or untracked), parsed from
 * `git status --porcelain -z -uall -- .` (STATUS_ARGS): NUL-separated "XY path" entries, so non-ASCII
 * names are not C-quoted, and every untracked file is listed (not just its new folder). A rename/copy
 * entry is followed by an extra entry holding the old path, which is skipped. Porcelain paths are
 * relative to the git top level, so for a repo in a subfolder of a bigger git repo the `git rev-parse
 * --show-prefix` prefix (`prefixOut`) is stripped (and `-- .` keeps the listing to this folder).
 * `--no-optional-locks`: a read-only check must not refresh (rewrite) .git/index when stat info is stale. */
export function parseStatusZ(prefixOut: string, statusOut: string): string[] {
  const prefix = prefixOut.trim();
  const entries = statusOut.split("\0");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    if (path.startsWith(prefix)) files.push(path.slice(prefix.length));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

/** The repo's index status from the facts git gave: the indexed commit (from the git-ignored fingerprints
 * cache), whether it is stale (HEAD moved since indexing, or the working tree has uncommitted changes
 * to indexed files), and which indexed files changed (capped at 50). `diffFiles` is the
 * `git diff --relative --name-only -z indexed..HEAD` list (`-z`: never C-quoted; `--relative`: only
 * files under this folder), or [] when not needed or when `from` is no longer reachable. */
function buildRepoIndexStatus(f: {
  id: string; head: string; indexedCommit: string | null; indexable: string[]; statusFiles: string[]; diffFiles: string[];
}): RepoIndexStatus {
  const indexable = new Set(f.indexable);
  const statusFiles = f.statusFiles.filter((x) => indexable.has(x));
  const diffFiles = f.diffFiles.filter((x) => indexable.has(x));
  const changed = [...new Set([...diffFiles, ...statusFiles])].sort(compare);
  return {
    id: f.id,
    head: f.head,
    indexedCommit: f.indexedCommit,
    stale: f.indexedCommit !== f.head || statusFiles.length > 0,
    changedFiles: changed.slice(0, 50),
    truncated: changed.length > 50,
  };
}

const needsDiff = (indexedCommit: string | null, head: string): indexedCommit is string =>
  indexedCommit !== null && indexedCommit !== head;
const splitZ = (out: string) => out.split("\0").filter(Boolean);

export interface RepoIndexStatus {
  id: string;
  head: string;
  indexedCommit: string | null;
  stale: boolean;
  changedFiles: string[];
  truncated: boolean;
}

/** One repo's index status (see buildRepoIndexStatus). Shared by index_status and `codeloom doctor`.
 * A diff `from` no longer reachable locally (e.g. a pruned commit) is reported as no diff. */
export function repoIndexStatus(repoAbs: string, id: string): RepoIndexStatus {
  const head = gitHead(repoAbs);
  const indexedCommit = readFingerprints(repoAbs)?.gitCommitHash ?? null;
  const statusFiles = parseStatusZ(git(repoAbs, ["rev-parse", "--show-prefix"]), git(repoAbs, STATUS_ARGS));
  let diffFiles: string[] = [];
  if (needsDiff(indexedCommit, head)) {
    try {
      diffFiles = splitZ(git(repoAbs, diffArgs(indexedCommit, head)));
    } catch {
      diffFiles = [];
    }
  }
  return buildRepoIndexStatus({ id, head, indexedCommit, indexable: listFiles(repoAbs), statusFiles, diffFiles });
}

/** repoIndexStatus without blocking the event loop (the dashboard server): same result. */
export async function repoIndexStatusAsync(repoAbs: string, id: string): Promise<RepoIndexStatus> {
  const head = await gitHeadAsync(repoAbs);
  const indexedCommit = readFingerprints(repoAbs)?.gitCommitHash ?? null;
  const [prefixOut, statusOut, indexable, diffFiles] = await Promise.all([
    gitAsync(repoAbs, ["rev-parse", "--show-prefix"]),
    gitAsync(repoAbs, STATUS_ARGS),
    listFilesAsync(repoAbs),
    needsDiff(indexedCommit, head)
      ? gitAsync(repoAbs, diffArgs(indexedCommit, head)).then(splitZ, () => [] as string[])
      : Promise.resolve([] as string[]),
  ]);
  return buildRepoIndexStatus({ id, head, indexedCommit, indexable, statusFiles: parseStatusZ(prefixOut, statusOut), diffFiles });
}

/** indexStatus without blocking the event loop (the dashboard server): same result, repos in parallel. */
export async function indexStatusAsync(start: string): Promise<{ repos: RepoIndexStatus[] }> {
  const ws = loadWorkspace(start);
  const repos = await Promise.all(ws.repos.map((ref) => repoIndexStatusAsync(join(ws.root, ref.path), ref.id)));
  repos.sort((a, b) => compare(a.id, b.id));
  return { repos };
}

/** index_status: repoIndexStatus for every repo in the workspace, sorted by id. */
export function indexStatus(start: string): Record<string, unknown> {
  const ws = loadWorkspace(start);
  const repos = ws.repos.map((ref) => repoIndexStatus(join(ws.root, ref.path), ref.id));
  repos.sort((a, b) => compare(a.id, b.id));
  return { repos };
}

/** reindex: re-run the indexer (opts.reindex, defaulting to runIndex) over every repo in the
 * workspace. The result is IndexRunResult's own fields, already plain JSON. */
export async function reindex(opts: ServerOptions): Promise<Record<string, unknown>> {
  const run = opts.reindex ?? runIndex;
  const result = await run(opts.start);
  return result as unknown as Record<string, unknown>;
}

/** get_layers: the architectural layers codeloom detected, per repo (or one repo, via `repo`). */
export function getLayers(start: string, repo?: string): Record<string, unknown> {
  const state = loadMapState(start);
  let repos = state.ws.repos;
  if (repo !== undefined) {
    const found = repos.find((r) => r.ref.id === repo);
    if (!found) {
      const ids = repos.map((r) => r.ref.id).join(", ");
      throw dataError(`Unknown repo "${repo}". Repos in this workspace: ${ids}.`);
    }
    repos = [found];
  }
  return {
    repos: repos.map((r) => ({
      id: r.ref.id,
      layers: r.graph.layers.map((l) => ({ id: l.id, name: l.name, description: l.description, nodeCount: l.nodeIds.length })),
    })),
  };
}

export function registerWorkspaceTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "workspace_overview",
    {
      title: "Workspace overview",
      description:
        "Start here. Lists the repos in this codeloom workspace with their size (files, nodes, pages, routes, " +
        "HTTP calls, tables, queues), how many request chains the map holds and how complete they are, how many " +
        "journeys are named, and how many chains belong to no journey yet.",
    },
    withErrors(() => workspaceOverview(opts.start)),
  );

  server.registerTool(
    "index_status",
    {
      title: "Index status",
      description:
        "Per repo: the git commit it was last indexed at, whether the index is stale (HEAD has moved or the " +
        "working tree has uncommitted changes to indexed files), and which indexed files changed.",
    },
    withErrors(() => indexStatus(opts.start)),
  );

  server.registerTool(
    "reindex",
    {
      title: "Reindex",
      description:
        "Re-run codeloom's indexer and linker over every repo in the workspace, rewriting graph.json, " +
        "endpoints.json and chains.json. Use after code changes so the map reflects them.",
    },
    withErrors(() => reindex(opts)),
  );

  server.registerTool(
    "get_layers",
    {
      title: "Get layers",
      description: "The architectural layers codeloom detected for a repo (or every repo), with how many nodes fall in each.",
      inputSchema: { repo: z.string().optional() },
    },
    withErrors((args: { repo?: string }) => getLayers(opts.start, args.repo)),
  );
}
