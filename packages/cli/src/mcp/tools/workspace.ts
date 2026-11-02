import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runIndex } from "../../commands/index-cmd.js";
import { dataError } from "../../errors.js";
import { readJson } from "../../store/json.js";
import { CODELOOM_DIR, FILES } from "../../store/paths.js";
import { FingerprintsSchema } from "../../store/schemas.js";
import { compare } from "../../util.js";
import { listFiles } from "../../workspace/files.js";
import { git } from "../../workspace/git.js";
import { gitHead, loadWorkspace } from "../../workspace/repos.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { loadMapState } from "../state.js";

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
  const named = new Set(state.journeys.flatMap((j) => j.chainIds));
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
function readFingerprints(repoAbs: string): { gitCommitHash: string } | null {
  try {
    return readJson(join(repoAbs, CODELOOM_DIR, FILES.fingerprints), FingerprintsSchema);
  } catch {
    return null;
  }
}

/** Repo-relative paths with uncommitted changes (staged, unstaged or untracked), parsed from
 * `git status --porcelain` ("XY path" or "XY old -> new" for a rename/copy). */
function statusChangedFiles(repoAbs: string): string[] {
  const out = git(repoAbs, ["status", "--porcelain"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      return arrow >= 0 ? rest.slice(arrow + 4) : rest;
    });
}

/** Files that differ between two commits. A `from` no longer reachable locally (e.g. a pruned
 * commit) is reported as no diff rather than a tool crash. */
function diffChangedFiles(repoAbs: string, from: string, to: string): string[] {
  try {
    return git(repoAbs, ["diff", "--name-only", `${from}..${to}`])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** index_status: per repo, the indexed commit (from the git-ignored fingerprints cache), whether it
 * is stale (HEAD moved since indexing, or the working tree has uncommitted changes to indexed
 * files), and which indexed files changed (capped at 50). */
export function indexStatus(start: string): Record<string, unknown> {
  const ws = loadWorkspace(start);
  const repos = ws.repos.map((ref) => {
    const abs = join(ws.root, ref.path);
    const head = gitHead(abs);
    const indexedCommit = readFingerprints(abs)?.gitCommitHash ?? null;
    const indexable = new Set(listFiles(abs));
    const statusFiles = statusChangedFiles(abs).filter((f) => indexable.has(f));
    const diffFiles =
      indexedCommit && indexedCommit !== head
        ? diffChangedFiles(abs, indexedCommit, head).filter((f) => indexable.has(f))
        : [];
    const changed = [...new Set([...diffFiles, ...statusFiles])].sort(compare);
    return {
      id: ref.id,
      head,
      indexedCommit,
      stale: indexedCommit !== head || statusFiles.length > 0,
      changedFiles: changed.slice(0, 50),
      truncated: changed.length > 50,
    };
  });
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
