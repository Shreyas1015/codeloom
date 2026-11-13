import type { GraphNode } from "@codeloom/core";
import { dataError } from "../errors.js";
import { functionExtents, impactOfDiff, indexedCommit, type Range, overlaps } from "../mcp/tools/check.js";
import { listSpecs } from "../mcp/tools/specs.js";
import { chainLookup, formatNodeRef, journeysForChains, loadMapState, parseNodeRef } from "../mcp/state.js";
import type { RepoData } from "../store/read.js";
import type { Chain, ChainStop } from "../store/schemas.js";
import { compare } from "../util.js";
import { type DiffHunk, diffHunks, isGitRepo, resolveCommit } from "../workspace/diff.js";
import { git } from "../workspace/git.js";
import type { Review, ReviewFile, ReviewHunk, ReviewJourney, ReviewNodeChange, ReviewStop } from "./types.js";

/** Lines of context to add around a raw (-U0) hunk, read straight from the before/after text. */
const CONTEXT = 3;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join("\n");
}

const oldEnd = (h: DiffHunk): number => (h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : h.oldStart);
const newEndOf = (h: DiffHunk): number => (h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart);

interface Shift {
  value: number;
  /** `line` itself falls inside some hunk's own changed span on the `from` side — using it as an
   * "unchanged anchor" would be meaningless (there is no 1:1 counterpart on the other side). */
  inside: boolean;
}

/** Maps `line` from the old side to the new side (`from: "old"`) or back (`from: "new"`), summing the size
 * delta of every hunk entirely before it on that side. `inside` tells the caller whether `line` was itself
 * part of a hunk's own change, where the mapping is not a real "this line, unchanged, moved here". */
function shiftAcross(hunks: DiffHunk[], line: number, from: "old" | "new"): Shift {
  let delta = 0;
  let inside = false;
  for (const h of hunks) {
    const lines = from === "old" ? h.oldLines : h.newLines;
    const start = from === "old" ? h.oldStart : h.newStart;
    if (lines > 0) {
      const end = start + lines - 1;
      if (line >= start && line <= end) inside = true;
      else if (end < line) delta += h.newLines - h.oldLines;
    } else if (start < line) {
      delta += h.newLines - h.oldLines;
    }
  }
  return { value: from === "old" ? line + delta : line - delta, inside };
}

/** The new-side (head) line matching `oldLine` — used to place a ReviewHunk's own boundaries (toReviewHunk
 * below), which are always a real position (a hunk's own start/end, even with zero spare context) whether
 * or not `oldLine` is itself inside that very hunk; unlike anchorAcross, never returns undefined. */
function toNewLine(hunks: DiffHunk[], oldLine: number): number {
  return shiftAcross(hunks, oldLine, "old").value;
}

/** The line across the diff matching `line`, or undefined when `line` itself is part of a hunk's own
 * change (review/build.ts's node line-space translation: a node whose recorded line sits inside an
 * insertion/deletion has no counterpart on the other side at all — a brand-new or deleted function). */
function anchorAcross(hunks: DiffHunk[], line: number, from: "old" | "new"): number | undefined {
  const r = shiftAcross(hunks, line, from);
  return r.inside ? undefined : r.value;
}

function hunkOverlaps(h: DiffHunk, base: Range | undefined, head: Range | undefined): boolean {
  if (base !== undefined && overlaps([h.oldStart, oldEnd(h)], base)) return true;
  return head !== undefined && overlaps([h.newStart, newEndOf(h)], head);
}

/** Groups hunks whose ±CONTEXT windows would touch into one cluster: each cluster becomes one ReviewHunk. */
function clusterHunks(hunks: DiffHunk[]): DiffHunk[][] {
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const clusters: DiffHunk[][] = [];
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
 * `baseLines`) before, between and after them. `base` (the node's own extent at the base commit) only
 * trims the discretionary extra context: oldFrom/oldTo never cut into the cluster's own change, so
 * oldLines/newLines always match what `lines` actually emits. `allHunks` is the file's full, unfiltered
 * hunk list, so line numbers stay correct even when an earlier unrelated hunk shifted the file. */
function toReviewHunk(cluster: DiffHunk[], base: Range, baseLines: string[], allHunks: DiffHunk[]): ReviewHunk {
  const first = cluster[0]!;
  const last = cluster.at(-1)!;
  const firstChangeStart = first.oldLines > 0 ? first.oldStart : first.oldStart + 1;
  const lastChangeEnd = oldEnd(last);
  const oldFrom = Math.min(firstChangeStart, Math.max(base[0], firstChangeStart - CONTEXT));
  const oldTo = Math.max(lastChangeEnd, Math.min(base[1], lastChangeEnd + CONTEXT));

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
  hunks: Map<string, DiffHunk[]>;
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

function hunksFor(cache: RepoCache, repoAbs: string, base: string, head: string, file: string): DiffHunk[] {
  if (!cache.hunks.has(file)) cache.hunks.set(file, diffHunks(repoAbs, [base, head], file));
  return cache.hunks.get(file)!;
}

function extentsAt(cache: RepoCache, repoAbs: string, commit: string, file: string): Map<number, number> {
  const key = `${commit}\0${file}`;
  if (!cache.extents.has(key)) cache.extents.set(key, functionExtents(repoAbs, commit, file));
  return cache.extents.get(key)!;
}

/** One changed function-like node's before/after code and diff hunks. `journeys` is filled by the caller
 * once every node's ref is known. null for a graph node that is not a function (a class/file wrapper that
 * merely contains a changed function; impact_of_diff reports both, review only cares about the function).
 *
 * `indexedAtHead`: when the repo was reindexed at the PR's head (the real CI flow — checkout PR head,
 * `codeloom index`, then review against a merge-base), the graph's own `node.lineRange` is already a HEAD
 * line, so `after` is anchored there directly and `before` is found by mapping that line BACK to the base
 * commit (toOldLine) — a function the mapped-back line finds nothing at base simply didn't exist yet
 * (`before: null`, a brand-new function). Otherwise (today's default), `node.lineRange` is treated as a
 * BASE line as before, and `after` is found by mapping forward (toNewLine). */
function buildNode(cache: RepoCache, repo: RepoData, node: GraphNode, base: string, head: string, indexedAtHead: boolean): ReviewNodeChange | null {
  if (node.type !== "function" || node.filePath === undefined || !node.lineRange) return null;
  const file = node.filePath;

  const baseText = readAt(cache, repo.abs, base, file);
  const headText = readAt(cache, repo.abs, head, file);
  const baseLines = baseText !== undefined ? splitLines(baseText) : undefined;
  const headLines = headText !== undefined ? splitLines(headText) : undefined;
  const allHunks = hunksFor(cache, repo.abs, base, head, file);

  // The graph's own lineRange is a head line when the repo was reindexed there (indexedAtHead), else a
  // base line as before; either way, the OTHER side is found by mapping across the diff — undefined when
  // that line sits inside a hunk's own change (no 1:1 counterpart: a brand-new or deleted function).
  const baseStart = indexedAtHead ? anchorAcross(allHunks, node.lineRange[0], "new") : node.lineRange[0];
  const headStart = indexedAtHead ? node.lineRange[0] : anchorAcross(allHunks, node.lineRange[0], "old");

  const baseEndFound = baseLines !== undefined && baseStart !== undefined ? extentsAt(cache, repo.abs, base, file).get(baseStart) : undefined;
  const baseSpan: Range | undefined = baseStart !== undefined && baseEndFound !== undefined ? [baseStart, baseEndFound] : undefined;

  const headEndFound = headLines !== undefined && headStart !== undefined ? extentsAt(cache, repo.abs, head, file).get(headStart) : undefined;
  const headSpan: Range | undefined = headStart !== undefined && headEndFound !== undefined ? [headStart, headEndFound] : undefined;

  const before = baseSpan !== undefined ? { start: baseSpan[0], end: baseSpan[1], text: sliceLines(baseLines!, baseSpan[0], baseSpan[1]) } : null;
  const after = headSpan !== undefined ? { start: headSpan[0], end: headSpan[1], text: sliceLines(headLines!, headSpan[0], headSpan[1]) } : null;

  const touching = allHunks.filter((h) => hunkOverlaps(h, baseSpan, headSpan));
  const hunks: ReviewHunk[] = [];
  let added = 0;
  let removed = 0;
  if (baseSpan !== undefined && baseLines !== undefined) {
    for (const cluster of clusterHunks(touching)) hunks.push(toReviewHunk(cluster, baseSpan, baseLines, allHunks));
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

/** A stable identity for a chain stop (ReviewStop.ref): a graph node's own ref, or (db/queue, no nodeId)
 * repo + lane + label — shared by every chain that reaches the same stop. */
function stopRef(s: ChainStop): string {
  return s.nodeId !== undefined ? formatNodeRef({ repo: s.repo, nodeId: s.nodeId }) : `${s.repo}::${s.lane}:${s.label ?? s.symbol}`;
}

function stopLabel(s: ChainStop): string {
  const base = s.label ?? s.symbol;
  return s.op !== undefined && (s.lane === "db" || s.lane === "queue") ? `${base} (${s.op})` : base;
}

/** The Review model for `baseRef..HEAD` (PR review maps design §2, §4): built on the existing
 * `impact_of_diff`, re-reading each changed function's code at base and head for its before/after text and
 * diff hunks, and the journeys/spec state of whatever it touches. Self-contained (§5): `chainStops` carries
 * every affected chain's full stop layout, so the renderers (mermaid.ts, markdown.ts) need nothing beyond
 * this Review — no live MapState, as the publish step (Task 3) only ever has data/review.json.
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

  const impact = impactOfDiff(start, `${base}..${head}`, { lineSpaceAware: true, state });
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
    const indexedAtHead = indexedCommit(repo.abs) === head;

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
      const built = buildNode(cache, repo, node, base, head, indexedAtHead);
      if (built) nodes.push(built);
    }
  }
  nodes.sort((a, b) => compare(a.ref, b.ref));
  const nodeRefSet = new Set(nodes.map((n) => n.ref));

  // Every stop of every touched chain (not just the changed ones): Review needs to be self-contained.
  const chainStops: Record<string, ReviewStop[]> = {};
  for (const chain of touchedChains) {
    chainStops[chain.id] = chain.stops.map((s) => {
      const ref = stopRef(s);
      return { ref, repo: s.repo, lane: s.lane, label: stopLabel(s), file: s.file, changed: nodeRefSet.has(ref) };
    });
  }

  // Journeys: for each one touched, which of its stops are among the changed nodes, and its spec state.
  const specEntries = new Map(listSpecs(start, {}, state).journeys.map((j) => [j.journeyId, j]));
  const chains = chainLookup(state.chains);
  const nodeJourneys = new Map<string, Set<string>>();
  const journeys: ReviewJourney[] = journeysForChains(state, touchedChainIds).map((j) => {
    const resolved = chains.resolve(j.chainIds).chains.filter((c) => touchedChainIds.has(c.id));
    const changedStops = new Set<string>();
    for (const c of resolved) for (const stop of chainStops[c.id] ?? []) if (stop.changed) changedStops.add(stop.ref);
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
    chainStops,
    tables: impact.tables,
    queues: impact.queues,
    truncated: impact.truncated,
    notes: impact.notes,
  };
}
