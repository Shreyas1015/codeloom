import type { GraphNode } from "@codeloom/core";
import { dataError } from "../errors.js";
import { functionExtents, impactOfDiff } from "../mcp/tools/check.js";
import { listSpecs } from "../mcp/tools/specs.js";
import { chainLookup, formatNodeRef, journeysForChains, loadMapState, parseNodeRef } from "../mcp/state.js";
import type { RepoData } from "../store/read.js";
import type { Chain } from "../store/schemas.js";
import { compare } from "../util.js";
import { isGitRepo, resolveCommit } from "../workspace/diff.js";
import { git } from "../workspace/git.js";
import type { Review, ReviewFile, ReviewHunk, ReviewJourney, ReviewNodeChange } from "./types.js";

/** Lines of context to add around a raw (-U0) hunk, read straight from the before/after text. */
const CONTEXT = 3;

type Range = [number, number];
const overlaps = (a: Range, b: Range): boolean => a[0] <= b[1] && b[0] <= a[1];

/** The shape of `impact_of_diff`'s result this module reads (mcp/tools/check.ts impactOfDiff). */
interface ImpactRepo {
  id: string;
  changedFiles: string[];
  changedNodes: string[];
}
interface ImpactResult {
  repos: ImpactRepo[];
  chains: string[];
  journeys: Array<{ id: string; name: string }>;
  tables: string[];
  queues: string[];
  notes: string[];
  truncated: boolean;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join("\n");
}

interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removed: string[];
  added: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `git diff -U0 base head -- file`, parsed into hunks with their actual removed/added content (no
 * context lines: -U0 asks git for none, so every "-"/"+" line is a real change). */
function parseRawHunks(diffOutput: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  let current: RawHunk | undefined;
  for (const line of diffOutput.split("\n")) {
    const h = HUNK_HEADER.exec(line);
    if (h) {
      current = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        removed: [],
        added: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return hunks;
}

const oldEnd = (h: RawHunk): number => (h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : h.oldStart);
const newEndOf = (h: RawHunk): number => (h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart);

/** The new-side line matching `oldLine`, assuming `oldLine` itself is unchanged (sums the size delta of
 * every hunk that is entirely before it on the old side). */
function toNewLine(hunks: RawHunk[], oldLine: number): number {
  let delta = 0;
  for (const h of hunks) {
    const before = h.oldLines > 0 ? oldEnd(h) < oldLine : h.oldStart < oldLine;
    if (before) delta += h.newLines - h.oldLines;
  }
  return oldLine + delta;
}

function hunkOverlaps(h: RawHunk, base: Range | undefined, head: Range | undefined): boolean {
  if (base !== undefined && overlaps([h.oldStart, oldEnd(h)], base)) return true;
  return head !== undefined && overlaps([h.newStart, newEndOf(h)], head);
}

/** Groups hunks whose ±CONTEXT windows would touch into one cluster: each cluster becomes one ReviewHunk. */
function clusterHunks(hunks: RawHunk[]): RawHunk[][] {
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const clusters: RawHunk[][] = [];
  for (const h of sorted) {
    const last = clusters.at(-1);
    const prev = last?.at(-1);
    const changeStart = h.oldLines > 0 ? h.oldStart : h.oldStart + 1;
    if (prev !== undefined && changeStart - oldEnd(prev) - 1 <= 2 * CONTEXT) last!.push(h);
    else clusters.push([h]);
  }
  return clusters;
}

/** One cluster of raw (-U0) hunks → a ReviewHunk, with up to CONTEXT lines of context (read from
 * `baseLines`) before, between and after them, clamped to `base` (the node's own extent at the base
 * commit). `allHunks` is the file's full, unfiltered hunk list, so line numbers stay correct even when an
 * earlier unrelated hunk shifted the file. */
function toReviewHunk(cluster: RawHunk[], base: Range, baseLines: string[], allHunks: RawHunk[]): ReviewHunk {
  const first = cluster[0]!;
  const last = cluster.at(-1)!;
  const firstChangeStart = first.oldLines > 0 ? first.oldStart : first.oldStart + 1;
  const oldFrom = Math.max(base[0], firstChangeStart - CONTEXT);
  const oldTo = Math.min(base[1], oldEnd(last) + CONTEXT);

  const lines: string[] = [];
  let p = oldFrom;
  for (const h of cluster) {
    const contextEnd = h.oldLines > 0 ? h.oldStart - 1 : h.oldStart;
    for (; p <= contextEnd; p++) lines.push(` ${baseLines[p - 1] ?? ""}`);
    for (const r of h.removed) lines.push(`-${r}`);
    for (const a of h.added) lines.push(`+${a}`);
    if (h.oldLines > 0) p = h.oldStart + h.oldLines;
  }
  for (; p <= oldTo; p++) lines.push(` ${baseLines[p - 1] ?? ""}`);

  const newStart = toNewLine(allHunks, oldFrom);
  const newTo = toNewLine(allHunks, oldTo);
  return { oldStart: oldFrom, oldLines: oldTo - oldFrom + 1, newStart, newLines: newTo - newStart + 1, lines };
}

/** Per-repo caches, so a file touched by several changed nodes is only read/diffed/parsed once. */
interface RepoCache {
  text: Map<string, string | undefined>;
  hunks: Map<string, RawHunk[]>;
  extents: Map<string, Map<number, number>>;
}

function newCache(): RepoCache {
  return { text: new Map(), hunks: new Map(), extents: new Map() };
}

function readAt(cache: RepoCache, repoAbs: string, commit: string, file: string): string | undefined {
  const key = `${commit}\0${file}`;
  if (!cache.text.has(key)) {
    try {
      cache.text.set(key, git(repoAbs, ["show", "--end-of-options", `${commit}:./${file}`], { maxBuffer: 64 * 1024 * 1024 }));
    } catch {
      cache.text.set(key, undefined);
    }
  }
  return cache.text.get(key);
}

function hunksFor(cache: RepoCache, repoAbs: string, base: string, head: string, file: string): RawHunk[] {
  const key = file;
  if (!cache.hunks.has(key)) {
    const out = git(
      repoAbs,
      ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--end-of-options", base, head, "--", file],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    cache.hunks.set(key, parseRawHunks(out));
  }
  return cache.hunks.get(key)!;
}

function extentsAt(cache: RepoCache, repoAbs: string, commit: string, file: string): Map<number, number> {
  const key = `${commit}\0${file}`;
  if (!cache.extents.has(key)) cache.extents.set(key, functionExtents(repoAbs, commit, file));
  return cache.extents.get(key)!;
}

/** One changed function-like node's before/after code and diff hunks. `journeys` is filled by the caller
 * once every node's ref is known. null for a graph node that is not a function (a class/file wrapper that
 * merely contains a changed function; impact_of_diff reports both, review only cares about the function). */
function buildNode(cache: RepoCache, repo: RepoData, node: GraphNode, base: string, head: string): ReviewNodeChange | null {
  if (node.type !== "function" || node.filePath === undefined || !node.lineRange) return null;
  const file = node.filePath;

  const baseText = readAt(cache, repo.abs, base, file);
  const headText = readAt(cache, repo.abs, head, file);
  const baseLines = baseText !== undefined ? splitLines(baseText) : undefined;
  const headLines = headText !== undefined ? splitLines(headText) : undefined;
  const allHunks = hunksFor(cache, repo.abs, base, head, file);

  // The graph's lineRange is from whenever the repo was last indexed; approximately the base commit when
  // the map was indexed before `base` (impact_of_diff's own notes flag it otherwise).
  const baseStart = node.lineRange[0];
  const baseEndFound = baseLines !== undefined ? extentsAt(cache, repo.abs, base, file).get(baseStart) : undefined;
  const baseSpan: Range | undefined = baseLines !== undefined && baseEndFound !== undefined ? [baseStart, baseEndFound] : undefined;

  const headStart = baseSpan !== undefined ? toNewLine(allHunks, baseSpan[0]) : undefined;
  const headEndFound = headLines !== undefined && headStart !== undefined ? extentsAt(cache, repo.abs, head, file).get(headStart) : undefined;
  const headSpan: Range | undefined = headLines !== undefined && headStart !== undefined && headEndFound !== undefined ? [headStart, headEndFound] : undefined;

  const before = baseSpan !== undefined ? { start: baseSpan[0], end: baseSpan[1], text: sliceLines(baseLines!, baseSpan[0], baseSpan[1]) } : null;
  const after = headSpan !== undefined ? { start: headSpan[0], end: headSpan[1], text: sliceLines(headLines!, headSpan[0], headSpan[1]) } : null;

  const touching = allHunks.filter((h) => hunkOverlaps(h, baseSpan, headSpan));
  const hunks: ReviewHunk[] = [];
  let added = 0;
  let removed = 0;
  if (baseSpan !== undefined && baseLines !== undefined) {
    for (const cluster of clusterHunks(touching)) {
      hunks.push(toReviewHunk(cluster, baseSpan, baseLines, allHunks));
    }
  }
  for (const h of touching) {
    added += h.added.length;
    removed += h.removed.length;
  }

  return {
    ref: formatNodeRef({ repo: repo.ref.id, nodeId: node.id }),
    repo: repo.ref.id,
    file,
    symbol: node.name,
    before,
    after,
    hunks,
    added,
    removed,
    journeys: [],
  };
}

/** The Review model for `baseRef..HEAD` (PR review maps design §2, §4): built on the existing
 * `impact_of_diff`, re-reading each changed function's code at base and head for its before/after text and
 * diff hunks, and the journeys/spec state of whatever it touches.
 * Throws a CodeloomError (exit 2, via dataError) when the workspace root is not a git repository or
 * `baseRef`/HEAD cannot be resolved there. */
export function buildReview(start: string, baseRef: string): Review {
  const state = loadMapState(start);
  const root = state.ws.root;
  if (!isGitRepo(root)) throw dataError(`${root} is not a git repository. "codeloom review" needs the workspace's own git history.`);
  const baseCommit = resolveCommit(root, baseRef);
  if (baseCommit === undefined) throw dataError(`Bad base "${baseRef}": git cannot resolve it in ${root}.`);
  const head = resolveCommit(root, "HEAD");
  if (head === undefined) throw dataError(`The repo at ${root} has no HEAD commit.`);
  const base = git(root, ["merge-base", "--end-of-options", baseCommit, head]).trim();

  const impact = impactOfDiff(start, `${base}..${head}`) as unknown as ImpactResult;
  const touchedChainIds = new Set(impact.chains);
  const chainsById = new Map(state.chains.map((c) => [c.id, c]));
  const touchedChains = impact.chains.map((id) => chainsById.get(id)).filter((c): c is Chain => c !== undefined);

  const stopFiles = new Set<string>();
  for (const c of touchedChains) for (const s of c.stops) stopFiles.add(`${s.repo}\0${s.file}`);

  const cachesByRepo = new Map<string, RepoCache>();
  const cacheFor = (repoId: string): RepoCache => {
    let c = cachesByRepo.get(repoId);
    if (!c) {
      c = newCache();
      cachesByRepo.set(repoId, c);
    }
    return c;
  };

  const files: ReviewFile[] = [];
  const nodes: ReviewNodeChange[] = [];

  for (const repoImpact of impact.repos) {
    const repo = state.ws.repos.find((r) => r.ref.id === repoImpact.id);
    if (!repo) continue;
    const cache = cacheFor(repo.ref.id);

    for (const file of repoImpact.changedFiles) {
      const h = hunksFor(cache, repo.abs, base, head, file);
      const added = h.reduce((n, x) => n + x.added.length, 0);
      const removed = h.reduce((n, x) => n + x.removed.length, 0);
      files.push({ repo: repo.ref.id, file, added, removed, onJourney: stopFiles.has(`${repo.ref.id}\0${file}`) });
    }

    for (const ref of repoImpact.changedNodes) {
      const { nodeId } = parseNodeRef(ref);
      const node = repo.graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const built = buildNode(cache, repo, node, base, head);
      if (built) nodes.push(built);
    }
  }
  nodes.sort((a, b) => compare(a.ref, b.ref));
  const nodeRefSet = new Set(nodes.map((n) => n.ref));

  // Journeys: for each one touched, which of its stops are among the changed nodes, and its spec state.
  const specEntries = new Map(
    (listSpecs(start, {}).journeys as Array<{ journeyId: string; state: "linked" | "candidates" | "none"; checked: boolean }>).map((j) => [
      j.journeyId,
      j,
    ]),
  );
  const nodeJourneys = new Map<string, Set<string>>();
  const journeys: ReviewJourney[] = journeysForChains(state, touchedChainIds).map((j) => {
    const resolved = chainLookup(state.chains).resolve(j.chainIds).chains.filter((c) => touchedChainIds.has(c.id));
    const changedStops = new Set<string>();
    for (const c of resolved) {
      for (const s of c.stops) {
        if (s.nodeId === undefined) continue;
        const ref = formatNodeRef({ repo: s.repo, nodeId: s.nodeId });
        if (nodeRefSet.has(ref)) changedStops.add(ref);
      }
    }
    for (const ref of changedStops) {
      const set = nodeJourneys.get(ref) ?? new Set<string>();
      set.add(j.id);
      nodeJourneys.set(ref, set);
    }
    const entry = specEntries.get(j.id);
    const spec = entry === undefined || (entry.state === "none" && !entry.checked) ? "unchecked" : entry.state;
    return { id: j.id, name: j.name, changedStops: [...changedStops].sort(compare), spec, chains: resolved.map((c) => c.id).sort(compare) };
  });
  for (const n of nodes) n.journeys = [...(nodeJourneys.get(n.ref) ?? new Set<string>())].sort(compare);

  return {
    version: 1,
    base,
    head,
    baseRef,
    files,
    nodes,
    journeys,
    chains: impact.chains,
    tables: impact.tables,
    queues: impact.queues,
    truncated: impact.truncated,
    notes: impact.notes,
  };
}
