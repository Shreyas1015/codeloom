import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ts from "typescript";
import { z } from "zod";
import { JS_EXT, parseSource, walk } from "../../adapters/ast.js";
import { buildReport } from "../../commands/check.js";
import { CodeloomError } from "../../errors.js";
import { readJson } from "../../store/json.js";
import { CODELOOM_DIR, FILES } from "../../store/paths.js";
import { type ChainStop, FingerprintsSchema } from "../../store/schemas.js";
import { compare } from "../../util.js";
import { type ChangedFile, changedLinesAtBase, EMPTY_TREE, isGitRepo, resolveCommit, resolveRange } from "../../workspace/diff.js";
import { git } from "../../workspace/git.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { formatNodeRef, journeysForChains, loadMapState } from "../state.js";

/** Caps on impact_of_diff lists; each capped list has its own `…Truncated` flag beside it. */
const MAX_FILES = 500;
const MAX_NODES = 500;
const MAX_CHAINS = 500;

// ---- check_chains -----------------------------------------------------------------------------

export async function checkChains(opts: ServerOptions, traces: boolean): Promise<Record<string, unknown>> {
  // `traces` is passed through to buildReport, which adds the trace comparison (check/traces/run.ts).
  const report = await buildReport(opts.start, { traces, fetchImpl: opts.fetchImpl, now: opts.now });
  return report as unknown as Record<string, unknown>;
}

// ---- impact_of_diff ---------------------------------------------------------------------------

type Range = [number, number];
const overlaps = (a: Range, b: Range): boolean => a[0] <= b[1] && b[0] <= a[1];

/** Line extents of every function-like node in a JS/TS file as it was at commit `base` (the map's line
 * space), keyed by start line (the widest one starting there). A non-JS file, or one absent at `base`
 * (its change is "all" anyway) → empty map. */
function functionExtents(repoAbs: string, base: string, file: string): Map<number, number> {
  const out = new Map<number, number>();
  if (!JS_EXT.test(file) || base === EMPTY_TREE) return out;
  let text: string;
  try {
    // "./" makes the path relative to the repo folder, which may be a subfolder of the git repo.
    text = git(repoAbs, ["show", "--end-of-options", `${base}:./${file}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return out;
  }
  const sf = parseSource(file, text);
  walk(sf, (n) => {
    if (!ts.isFunctionLike(n) || !("body" in n) || !n.body) return;
    const start = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
    if ((out.get(start) ?? 0) < end) out.set(start, end);
  });
  return out;
}

/** The commit a repo's map was indexed at (the git-ignored fingerprints cache), or undefined when unknown.
 * A corrupt or missing cache is the same as unknown. */
function indexedCommit(repoAbs: string): string | undefined {
  try {
    return readJson(join(repoAbs, CODELOOM_DIR, FILES.fingerprints), FingerprintsSchema)?.gitCommitHash || undefined;
  } catch {
    return undefined;
  }
}

const short = (sha: string) => sha.slice(0, 7);

/** True when a stop is touched by the change. A stop at the first line of a function (a handler or code
 * stop) spans that function's body, so an edit anywhere inside the function counts; other stops (a
 * route, a db call, a publish) are their own line. */
function stopTouched(stop: ChainStop, change: ChangedFile, extents: () => Map<number, number>): boolean {
  if (change.lines === "all") return true;
  const end = extents().get(stop.line) ?? stop.line;
  const span: Range = [stop.line, Math.max(end, stop.line)];
  return change.lines.some((r) => overlaps(r, span));
}

/** Changed lines → graph nodes, chains, journeys, tables and queues. Lines are compared in the map's own
 * line space: the old side of the diff, and function extents read at the base commit.
 * `range` absent = the repo's indexed commit (else HEAD) vs the working tree, plus untracked files; a repo
 * that is not a git repo is skipped. With a range, base = its base commit; when the map was indexed at a
 * different commit, `notes` says line matches are approximate. A range that resolves in some repos but not
 * others skips the others (listed in `skippedRepos`); one that resolves in none, or is option-like, is a
 * data error. */
export function impactOfDiff(start: string, range?: string): Record<string, unknown> {
  const state = loadMapState(start);
  const repos: Array<Record<string, unknown>> = [];
  const skippedRepos: Array<{ id: string; reason: string }> = [];
  const notes: string[] = [];
  const changesByRepo = new Map<string, Map<string, ChangedFile>>();
  const baseByRepo = new Map<string, string>();
  let firstError: CodeloomError | undefined;
  let truncated = false;

  for (const repo of [...state.ws.repos].sort((a, b) => compare(a.ref.id, b.ref.id))) {
    const indexed = indexedCommit(repo.abs);
    let changed: ChangedFile[];
    let base: string;
    if (range === undefined) {
      if (!isGitRepo(repo.abs)) {
        skippedRepos.push({ id: repo.ref.id, reason: `${repo.abs} is not a git repository` });
        continue;
      }
      const at = indexed === undefined ? undefined : resolveCommit(repo.abs, indexed);
      if (indexed !== undefined && at === undefined) {
        notes.push(`${repo.ref.id}: map indexed at ${short(indexed)}, which git cannot find; compared with HEAD, line matches are approximate`);
      }
      base = at ?? resolveCommit(repo.abs, "HEAD") ?? EMPTY_TREE;
      changed = changedLinesAtBase(repo.abs, base);
    } else {
      let head: string;
      try {
        ({ base, head } = resolveRange(repo.abs, range));
      } catch (err) {
        if (!(err instanceof CodeloomError)) throw err;
        firstError ??= err;
        skippedRepos.push({ id: repo.ref.id, reason: err.message });
        continue;
      }
      if (indexed !== base) {
        notes.push(`${repo.ref.id}: map indexed at ${indexed ? short(indexed) : "unknown"}, not at ${short(base)}; line matches are approximate`);
      }
      changed = changedLinesAtBase(repo.abs, base, head);
    }
    // .codeloom/ holds the map itself, not code.
    changed = changed.filter((f) => !f.file.startsWith(".codeloom/"));
    baseByRepo.set(repo.ref.id, base);
    if (changed.length === 0) continue;
    changesByRepo.set(repo.ref.id, new Map(changed.map((f) => [f.file, f])));

    const nodes: string[] = [];
    for (const node of repo.graph.nodes) {
      const change = node.filePath === undefined ? undefined : changesByRepo.get(repo.ref.id)!.get(node.filePath);
      if (!change) continue;
      const hit =
        change.lines === "all"
          ? node.type === "file"
          : node.lineRange !== undefined && node.lineRange !== null && change.lines.some((r) => overlaps(r, node.lineRange as Range));
      if (hit) nodes.push(formatNodeRef({ repo: repo.ref.id, nodeId: node.id }));
    }
    nodes.sort(compare);
    const files = changed.map((f) => f.file);
    const filesCut = files.length > MAX_FILES;
    const nodesCut = nodes.length > MAX_NODES;
    truncated ||= filesCut || nodesCut;
    repos.push({
      id: repo.ref.id,
      changedFiles: files.slice(0, MAX_FILES),
      changedFilesTruncated: filesCut,
      changedNodes: nodes.slice(0, MAX_NODES),
      changedNodesTruncated: nodesCut,
    });
  }
  if (range !== undefined && skippedRepos.length === state.ws.repos.length && firstError) throw firstError;

  const extentCache = new Map<string, Map<number, number>>();
  const extentsFor = (repoId: string, file: string) => () => {
    const key = `${repoId}\0${file}`;
    let e = extentCache.get(key);
    if (!e) {
      const abs = state.ws.repos.find((r) => r.ref.id === repoId)!.abs;
      e = functionExtents(abs, baseByRepo.get(repoId)!, file);
      extentCache.set(key, e);
    }
    return e;
  };

  const chainIds = new Set<string>();
  const tables = new Set<string>();
  const queues = new Set<string>();
  for (const chain of state.chains) {
    const touched = chain.stops.some((s) => {
      const change = changesByRepo.get(s.repo)?.get(s.file);
      return change !== undefined && stopTouched(s, change, extentsFor(s.repo, s.file));
    });
    if (!touched) continue;
    chainIds.add(chain.id);
    for (const s of chain.stops) {
      if (s.lane === "db" && s.label) tables.add(s.label);
      if (s.lane === "queue" && s.label) queues.add(s.label);
    }
  }
  const chains = [...chainIds].sort(compare);
  const chainsCut = chains.length > MAX_CHAINS;
  truncated ||= chainsCut;

  return {
    range: range ?? null,
    repos,
    chains: chains.slice(0, MAX_CHAINS),
    chainsTruncated: chainsCut,
    journeys: journeysForChains(state, chainIds).map((j) => ({ id: j.id, name: j.name })),
    tables: [...tables].sort(compare),
    queues: [...queues].sort(compare),
    skippedRepos,
    notes: notes.sort(compare),
    truncated,
  };
}

// ---- registrar --------------------------------------------------------------------------------

export function registerCheckTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "check_chains",
    {
      title: "Check the map",
      description:
        "The same report as `codeloom check --json`: how many request chains run complete UI → API → DB, which " +
        "miss the DB step or break between UI and API, unresolved calls, routes no UI calls, and guessed links.",
      inputSchema: {
        // Accepted now so agents can pass it; ignored until runtime-trace comparison lands (Plan 2b Task 9).
        traces: z.boolean().default(false),
      },
    },
    withErrors((args: { traces?: boolean }) => checkChains(opts, args.traces ?? false)),
  );

  server.registerTool(
    "impact_of_diff",
    {
      title: "Impact of a diff",
      description:
        "What a code change touches in the map. Without `range`: everything since the map was indexed (commits " +
        'since, staged, unstaged and untracked files). With `range`: "base..head", or one commit/branch meaning base..HEAD. Returns the changed ' +
        "files and graph nodes per repo, the request chains with a stop in a changed line (an edit anywhere in a " +
        "handler's body counts), the journeys holding those chains, and the tables and queues those chains reach. " +
        "`notes` flags repos whose map was indexed at another commit than the range's base.",
      inputSchema: { range: z.string().max(200).optional() },
    },
    withErrors((args: { range?: string }) => impactOfDiff(opts.start, args.range)),
  );
}
