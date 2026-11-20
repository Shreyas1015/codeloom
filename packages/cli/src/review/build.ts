import { isAbsolute, relative, sep } from "node:path";
import type { GraphNode } from "@codeloom/core";
import { dataError } from "../errors.js";
import { functionExtents, functionStartBySymbol, functionsAt, impactOfDiff, indexedCommit, type Range, overlaps } from "../mcp/tools/check.js";
import { listSpecs } from "../mcp/tools/specs.js";
import { chainLookup, formatNodeRef, journeysForChains, loadMapState, parseNodeRef } from "../mcp/state.js";
import { loadWorkspaceData, type RepoData, type WorkspaceData } from "../store/read.js";
import type { Chain, ChainStop } from "../store/schemas.js";
import { compare } from "../util.js";
import { type DiffHunk, diffHunks, isGitRepo, resolveCommit } from "../workspace/diff.js";
import { git } from "../workspace/git.js";
import { realPath } from "../workspace/registry.js";
import { downstream, fileKind, isRead, isWrite } from "./paths.js";
import type { Review, ReviewEntry, ReviewFile, ReviewHunk, ReviewJourney, ReviewNodeChange, ReviewRisk, ReviewStop } from "./types.js";

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
  /** Set only when `inside` and the offending hunk has BOTH sides non-empty (a replace, not a pure
   * insert/delete): `line`'s position within the hunk's own span, carried over to the other side at the
   * same offset (clamped) — the right guess for a same-line edit like a changed function signature, where
   * `line` is "inside" the hunk only because that exact line itself was rewritten. */
  offsetCandidate?: number;
}

/** Maps `line` from the old side to the new side (`from: "old"`) or back (`from: "new"`), summing the size
 * delta of every hunk entirely before it on that side. `inside` tells the caller whether `line` was itself
 * part of a hunk's own change, where the mapping is not a real "this line, unchanged, moved here". */
function shiftAcross(hunks: DiffHunk[], line: number, from: "old" | "new"): Shift {
  let delta = 0;
  let inside = false;
  let offsetCandidate: number | undefined;
  for (const h of hunks) {
    const lines = from === "old" ? h.oldLines : h.newLines;
    const start = from === "old" ? h.oldStart : h.newStart;
    const otherLines = from === "old" ? h.newLines : h.oldLines;
    const otherStart = from === "old" ? h.newStart : h.oldStart;
    if (lines > 0) {
      const end = start + lines - 1;
      if (line >= start && line <= end) {
        inside = true;
        if (otherLines > 0) offsetCandidate = otherStart + Math.min(line - start, otherLines - 1);
      } else if (end < line) {
        delta += h.newLines - h.oldLines;
      }
    } else if (start < line) {
      delta += h.newLines - h.oldLines;
    }
  }
  return { value: from === "old" ? line + delta : line - delta, inside, offsetCandidate };
}

/** The new-side (head) line matching `oldLine` — used to place a ReviewHunk's own boundaries (toReviewHunk
 * below), which are always a real position (a hunk's own start/end, even with zero spare context) whether
 * or not `oldLine` is itself inside that very hunk; unlike resolveAnchor, never returns undefined. */
function toNewLine(hunks: DiffHunk[], oldLine: number): number {
  return shiftAcross(hunks, oldLine, "old").value;
}

/** Resolves a node's line on the OTHER side of the diff from its recorded line on the `from` side:
 * unchanged context → the straight mapping (shiftAcross); `line` itself inside a hunk's own change (e.g. a
 * signature edit — the function's own first line was rewritten) → first try the same offset within that
 * hunk, accepted only if a function extent genuinely starts there (`otherExtents`); if that also misses
 * (the hunk merged the signature edit with an unrelated shift, so the offset guess lands elsewhere). falls
 * back to `functionStartBySymbol` — finding `symbol` by name at the other commit. undefined only when none
 * of these find anything (a brand-new or deleted function). */
function resolveAnchor(
  hunks: DiffHunk[],
  line: number,
  from: "old" | "new",
  otherExtents: Map<number, number>,
  repoAbs: string,
  otherCommit: string,
  file: string,
  symbol: string,
): number | undefined {
  const r = shiftAcross(hunks, line, from);
  if (!r.inside) return r.value;
  if (r.offsetCandidate !== undefined && otherExtents.has(r.offsetCandidate)) return r.offsetCandidate;
  return functionStartBySymbol(repoAbs, otherCommit, file, symbol);
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
 * trims the discretionary extra context: oldFrom/oldTo never cut into the cluster's own change.
 * `oldLines`/`newLines` are counted directly from the emitted `lines` (every " "/"-" line is old,
 * every " "/"+" line is new) rather than re-derived through toNewLine at the window's end — which can
 * disagree with what was actually emitted there when the closing hunk itself replaces N old lines with a
 * different number of new ones and there is no trailing context left to round the window out past it.
 * `allHunks` is the file's full, unfiltered hunk list, so `newStart` (always a real, unchanged-context
 * position — see toNewLine) stays correct even when an earlier unrelated hunk shifted the file. */
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

  const oldLines = lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
  const newLines = lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
  const newStart = toNewLine(allHunks, oldFrom);
  return { oldStart: oldFrom, oldLines, newStart, newLines, lines };
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
 * commit (resolveAnchor) — a function that mapping finds nothing for at base simply didn't exist yet
 * (`before: null`, a brand-new function; M1: still gets one synthetic all-"+" hunk from the head side, so
 * `added` and `hunks` agree). Otherwise (today's default), `node.lineRange` is treated as a BASE line as
 * before, and `after` is found by mapping forward. Either way, resolveAnchor handles the node's own first
 * line itself changing (a signature edit) via same-offset-within-the-hunk, falling back to
 * functionStartBySymbol when that offset doesn't land on a real function (C1). */
function buildNode(cache: RepoCache, repo: RepoData, node: GraphNode, base: string, head: string, indexedAtHead: boolean): ReviewNodeChange | null {
  if (node.type !== "function" || node.filePath === undefined || !node.lineRange) return null;
  const file = node.filePath;

  const baseText = readAt(cache, repo.abs, base, file);
  const headText = readAt(cache, repo.abs, head, file);
  const baseLines = baseText !== undefined ? splitLines(baseText) : undefined;
  const headLines = headText !== undefined ? splitLines(headText) : undefined;
  const allHunks = hunksFor(cache, repo.abs, base, head, file);

  // The graph's own lineRange is a head line when the repo was reindexed there (indexedAtHead), else a
  // base line as before; either way, the OTHER side is resolved across the diff.
  const baseStart = indexedAtHead
    ? resolveAnchor(allHunks, node.lineRange[0], "new", extentsAt(cache, repo.abs, base, file), repo.abs, base, file, node.name)
    : node.lineRange[0];
  const headStart = indexedAtHead
    ? node.lineRange[0]
    : resolveAnchor(allHunks, node.lineRange[0], "old", extentsAt(cache, repo.abs, head, file), repo.abs, head, file, node.name);

  const baseEndFound = baseLines !== undefined && baseStart !== undefined ? extentsAt(cache, repo.abs, base, file).get(baseStart) : undefined;
  const baseSpan: Range | undefined = baseStart !== undefined && baseEndFound !== undefined ? [baseStart, baseEndFound] : undefined;

  const headEndFound = headLines !== undefined && headStart !== undefined ? extentsAt(cache, repo.abs, head, file).get(headStart) : undefined;
  const headSpan: Range | undefined = headStart !== undefined && headEndFound !== undefined ? [headStart, headEndFound] : undefined;

  const before = baseSpan !== undefined ? { start: baseSpan[0], end: baseSpan[1], text: sliceLines(baseLines!, baseSpan[0], baseSpan[1]) } : null;
  const after = headSpan !== undefined ? { start: headSpan[0], end: headSpan[1], text: sliceLines(headLines!, headSpan[0], headSpan[1]) } : null;

  const hunks: ReviewHunk[] = [];
  let added = 0;
  let removed = 0;
  if (baseSpan !== undefined && baseLines !== undefined) {
    const touching = allHunks.filter((h) => hunkOverlaps(h, baseSpan, headSpan));
    for (const cluster of clusterHunks(touching)) hunks.push(toReviewHunk(cluster, baseSpan, baseLines, allHunks));
    for (const h of touching) {
      added += h.added.length;
      removed += h.removed.length;
    }
  } else if (headSpan !== undefined && headLines !== undefined) {
    // M1: a brand-new function (no base side at all) — the whole thing is additions, not whatever subset
    // of hunks happened to overlap a headSpan with no matching base to filter against.
    const addedLines = sliceLines(headLines, headSpan[0], headSpan[1]).split("\n");
    hunks.push({
      oldStart: shiftAcross(allHunks, headSpan[0], "new").value,
      oldLines: 0,
      newStart: headSpan[0],
      newLines: addedLines.length,
      lines: addedLines.map((l) => `+${l}`),
    });
    added = addedLines.length;
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

/** A function of a brand-new or deleted file that is not a graph node (the map was indexed on the file's other
 * side): its whole text is one all-"+" (new) or all-"−" (deleted) hunk, read at `commit` (head for a new file,
 * base for a deleted one). */
function wholeFileNode(cache: RepoCache, repo: RepoData, file: string, fn: { name: string; start: number; end: number }, commit: string, isNew: boolean): ReviewNodeChange | null {
  const text = readAt(cache, repo.abs, commit, file);
  if (text === undefined) return null;
  const lines = sliceLines(splitLines(text), fn.start, fn.end).split("\n");
  const side = { start: fn.start, end: fn.end, text: lines.join("\n") };
  const hunk: ReviewHunk = isNew
    ? { oldStart: 0, oldLines: 0, newStart: fn.start, newLines: lines.length, lines: lines.map((l) => `+${l}`) }
    : { oldStart: fn.start, oldLines: lines.length, newStart: 0, newLines: 0, lines: lines.map((l) => `-${l}`) };
  return {
    ref: formatNodeRef({ repo: repo.ref.id, nodeId: `function:${file}:${fn.name}` }),
    repo: repo.ref.id,
    file,
    symbol: fn.name,
    before: isNew ? null : side,
    after: isNew ? side : null,
    hunks: [hunk],
    added: isNew ? lines.length : 0,
    removed: isNew ? 0 : lines.length,
    journeys: [],
  };
}

/** Functions of new or deleted files on no touched chain, built at most this many per review (the rest are
 * counted in a note): a big new file must not flood Code to check, the packet or review.json. */
const MAX_WHOLE_FILE_FUNCTIONS = 8;

/** A stable identity for a chain stop (ReviewStop.ref), shared by every chain that reaches the same stop —
 * but NOT by stops that merely sit at the same graph node for a different reason (I1):
 * - page/handler/function stops (a real code location on its own): the graph node's own ref.
 * - route: keyed by method + path, never by nodeId — a route's nodeId (when it has one at all) is often
 *   the whole routes FILE's node, which would otherwise collapse every route in that file into one stop.
 * - call: keyed by file + line — a call stop's nodeId is its ENCLOSING function's (for navigation), which
 *   would otherwise self-loop it onto that same function's own stop.
 * - db/queue: keyed by label + op, so e.g. an insert and a read of the same table stay distinct stops. */
function stopRef(s: ChainStop): string {
  if (s.kind === "route") return `${s.repo}::route:${s.op ?? ""} ${s.label ?? s.symbol}`;
  if (s.kind === "call") return `${s.repo}::call:${s.file}:${s.line}`;
  if (s.lane === "db" || s.lane === "queue") return `${s.repo}::${s.lane}:${s.label ?? s.symbol}:${s.op ?? ""}`;
  if (s.nodeId !== undefined) return formatNodeRef({ repo: s.repo, nodeId: s.nodeId });
  return `${s.repo}::${s.kind}:${s.file}:${s.line}`;
}

function stopLabel(s: ChainStop): string {
  const base = s.label ?? s.symbol;
  return s.op !== undefined && (s.lane === "db" || s.lane === "queue") ? `${base} (${s.op})` : base;
}

/** Functions in a file fileKind (paths.ts) classes as tests or docs never reach Code to check, the changed-
 * path diagram or the check packet's uncited facts (0.5 acceptance fix): a test helper or doc snippet is
 * never "code to check" — only the "Also changed" file count sees it (build.ts's `files` list, unfiltered). */
function isTestOrDocsFile(file: string): boolean {
  const k = fileKind(file);
  return k === "tests" || k === "docs";
}

/** Files (repo-relative) added or deleted between base and head; a rename (git's -M) is neither. */
function addedOrDeletedFiles(repoAbs: string, base: string, head: string): Set<string> {
  const out = git(repoAbs, ["diff", "--name-only", "-z", "-M", "--diff-filter=AD", "--relative", "--end-of-options", base, head], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(out.split("\0").filter(Boolean));
}

// ---- which history to diff (spec §2: folders of repos) ---------------------------------------------------

interface DiffTarget {
  /** Review.repoId: "" when the workspace root is itself the git repo holding every repo. */
  repoId: string;
  /** Where git runs: the chosen repo, or the workspace root. */
  dir: string;
  /** impactOfDiff's repo filter; undefined = every repo (the whole-workspace mode). */
  repos?: string[];
}

function gitTop(dir: string): string | undefined {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

const isWithin = (dir: string, path: string): boolean => {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** `--repo <id>` → that repo. Without it: the whole workspace when its root is the one git repo holding every
 * repo (0.4's mode); else the only repo; else the repo `start` is inside; else a usage error asking for
 * `--repo`. Every other repo is then read as it is checked out, never diffed. */
function pickTarget(start: string, ws: WorkspaceData, repoId: string | undefined, wholeWorkspaceOnly = false): DiffTarget {
  const ids = ws.repos.map((r) => r.ref.id).sort(compare);
  const one = (repo: RepoData): DiffTarget => {
    if (!isGitRepo(repo.abs)) {
      throw dataError(`${repo.abs} (repo "${repo.ref.id}") is not a git repository. "codeloom review --repo ${repo.ref.id}" needs that repo's git history.`);
    }
    return { repoId: repo.ref.id, dir: repo.abs, repos: [repo.ref.id] };
  };
  if (repoId !== undefined) {
    const repo = ws.repos.find((r) => r.ref.id === repoId);
    if (!repo) throw dataError(`No repo "${repoId}" in this workspace. Its repos: ${ids.join(", ")}.`);
    return one(repo);
  }
  const rootTop = gitTop(ws.root);
  if (rootTop !== undefined && ws.repos.every((r) => gitTop(r.abs) === rootTop)) return { repoId: "", dir: ws.root };
  if (wholeWorkspaceOnly && ws.group !== undefined) {
    // A group's data folder is no git repo: one repo's history is diffed at a time.
    throw dataError(`In a group, pass --repo <id> (${ids.join(", ")}): each repo has its own git history.`);
  }
  if (wholeWorkspaceOnly) {
    throw dataError(
      rootTop === undefined
        ? `${ws.root} is not a git repository. "codeloom snapshot" needs the workspace's own git history.`
        : `${ws.root} is a git repository, but not every repo in the workspace is part of it. "codeloom snapshot" needs one git history holding every repo.`,
    );
  }
  if (!ws.repos.some((r) => isGitRepo(r.abs))) {
    throw dataError(`${ws.root} is not a git repository, and neither is any repo in it. "codeloom review" needs git history.`);
  }
  if (ws.repos.length === 1) return one(ws.repos[0]!);
  // Real paths on both sides: a group's repo paths are real (registry), `start` may not be (/var vs /private/var).
  const startReal = realPath(start);
  const here = ws.repos
    .map((r) => ({ r, real: realPath(r.abs) }))
    .filter((x) => isWithin(x.real, startReal))
    .sort((a, b) => b.real.length - a.real.length)[0]?.r;
  if (here) return one(here);
  throw dataError(`This workspace is a folder of separate repos: pass --repo <id> to pick the one the pull request is in (${ids.join(", ")}).`);
}

/** Which git history `codeloom review` / `codeloom pr` would diff for `start` (pickTarget, without building the
 * review): the repo id ("" for the whole workspace) and the folder git runs in — e.g. to pick a default base ref
 * there. Same errors as buildReview. */
export function reviewTarget(start: string, opts: { repoId?: string } = {}): { repoId: string; dir: string } {
  const t = pickTarget(start, loadWorkspaceData(start), opts.repoId);
  return { repoId: t.repoId, dir: t.dir };
}

// ---- Where it matters / what it writes ---------------------------------------------------------------------

/** A path's tail (after a proxy's `from`) that is one catch-all parameter: `/:path*` (how Next.js `[...path]`
 * and `[[...path]]` routes are recorded), `/:path+`, `/*`, `/*path` / `/{*path}` (Express 5) or
 * `/(.*)`. */
const CATCH_ALL_TAIL = /^\/(?::[A-Za-z_$][\w$]*[*+]|\*(?:[A-Za-z_$][\w$]*)?|\{\*[A-Za-z_$][\w$]*\}|\(\.\*\))$/;

/** `routeLabel` ("METHOD /path") is a configured `proxies[]` rule's own catch-all for `repo` — the
 * passthrough route the rule exists to bypass (0.5 acceptance fix §2), never a real entry point to show a
 * reviewer: its path is the rule's `from` followed by one catch-all parameter (CATCH_ALL_TAIL). A real route
 * of the repo's own that merely sits under `from` (`GET /api/session` under `from: "/api"`) is not. */
function isProxyOwnRoute(ws: WorkspaceData, repo: string, routeLabel: string): boolean {
  const space = routeLabel.indexOf(" ");
  const path = space === -1 ? routeLabel : routeLabel.slice(space + 1);
  const proxies = ws.repos.find((r) => r.ref.id === repo)?.ref.proxies ?? [];
  return proxies.some((p) => {
    const from = p.from.replace(/\/+$/, "");
    return path.startsWith(`${from}/`) && CATCH_ALL_TAIL.test(path.slice(from.length));
  });
}

/** The proxied backend route(s) of the very same call/page as `chain` (0.5 acceptance fix §2): buildChains
 * makes one chain per route target of a UI call (its own-repo match, e.g. a catch-all proxy route, plus
 * each workspace `proxies` match), every such chain sharing the identical `Chain.entry` string and
 * differing only in which route it reaches — so a sibling found by that shared entry, whose own route
 * isn't itself another proxy's own route, is the real backend this call reaches. */
function proxiedSiblingRoutes(chain: Chain, ws: WorkspaceData, byEntry: ReadonlyMap<string, Chain[]>): Array<Omit<ReviewEntry, "journey">> {
  const siblings = (byEntry.get(chain.entry) ?? []).filter((c) => c.id !== chain.id);
  const out: Array<Omit<ReviewEntry, "journey">> = [];
  const seen = new Set<string>();
  for (const sib of siblings) {
    const route = sib.stops.find((s) => s.kind === "route");
    if (!route) continue;
    const label = route.label ?? route.symbol;
    if (isProxyOwnRoute(ws, route.repo, label)) continue;
    const key = `${route.repo}\0${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "route", label, repo: route.repo });
  }
  return out;
}

/** A chain's entry point(s): its first stop, as a page (URL path), route ("METHOD /path") or queue
 * consumer. Usually one entry; a UI call's chain whose own route is itself a configured proxy's own
 * catch-all (isProxyOwnRoute) yields the proxied backend route(s) reached by that same call instead (0.5
 * acceptance fix §2) — possibly several; the catch-all route itself when no sibling chain reaches a real
 * backend route. */
function entryOf(chain: Chain, ws: WorkspaceData, byEntry: ReadonlyMap<string, Chain[]>): Array<Omit<ReviewEntry, "journey">> {
  const first = chain.stops[0];
  if (!first) return [];
  const name = first.label ?? first.symbol;
  if (chain.entry.startsWith("page:") || first.kind === "page") {
    const prefix = `page:${first.repo}:`;
    return [{ kind: "page", label: chain.entry.startsWith(prefix) ? chain.entry.slice(prefix.length) : name, repo: first.repo }];
  }
  if (chain.entry.startsWith("consumer:") || first.kind === "consume") return [{ kind: "consumer", label: name, repo: first.repo }];

  // The entry's own route stop: for a UI call's chain (often through a workspace proxy), the first ROUTE
  // stop reached (never the call stop's own URL/repo); otherwise the chain's own first stop (a backend-
  // only "route:" chain, or 0.4 back-compat data with no `kind` at all).
  const routeStop = first.kind === "call" ? chain.stops.find((s) => s.kind === "route") : first;
  if (!routeStop) return [];
  const label = routeStop.label ?? routeStop.symbol;
  const own: Omit<ReviewEntry, "journey"> = { kind: "route", label, repo: routeStop.repo };
  if (!isProxyOwnRoute(ws, routeStop.repo, label)) return [own];
  const proxied = proxiedSiblingRoutes(chain, ws, byEntry);
  return proxied.length > 0 ? proxied : [own];
}

const KIND_RANK: Record<ReviewEntry["kind"], number> = { page: 0, route: 1, consumer: 2 };

/** One entry per touched chain, deduplicated; named-journey entries first (by journey name), then the rest. */
function buildEntries(chains: Chain[], journeys: ReviewJourney[], ws: WorkspaceData, byEntry: ReadonlyMap<string, Chain[]>): ReviewEntry[] {
  const journeyOf = new Map<string, string>();
  for (const j of [...journeys].sort((a, b) => compare(a.name, b.name))) {
    for (const id of j.chains) if (!journeyOf.has(id)) journeyOf.set(id, j.name);
  }
  const all: ReviewEntry[] = [];
  for (const c of chains) {
    const es = entryOf(c, ws, byEntry);
    if (es.length === 0) continue;
    const journey = journeyOf.get(c.id);
    for (const e of es) all.push(journey !== undefined ? { ...e, journey } : e);
  }
  all.sort(
    (a, b) =>
      (a.journey === undefined ? 1 : 0) - (b.journey === undefined ? 1 : 0) ||
      compare(a.journey ?? "", b.journey ?? "") ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      compare(a.label, b.label) ||
      compare(a.repo, b.repo),
  );
  const seen = new Set<string>();
  return all.filter((e) => {
    const key = `${e.kind}\0${e.repo}\0${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where the changed code's own writes start on a chain: each changed backend stop (api/code lane, or a
 * handler) itself, and each call stop made by a changed function itself (a call's nodeId is its enclosing
 * function) — so a changed UI function counts only through its own calls, never through unchanged child
 * components or hooks it merely renders or uses (a call-first chain's changed function has no stop of its
 * own, only its call). */
function walkStarts(chain: Chain, stops: ReviewStop[], changedRefs: ReadonlySet<string>): number[] {
  const out: number[] = [];
  stops.forEach((s, i) => {
    const raw = chain.stops[i]!;
    if (s.changed && (s.lane !== "ui" || s.kind === "handler")) out.push(i);
    else if (raw.kind === "call" && raw.nodeId !== undefined && changedRefs.has(formatNodeRef({ repo: raw.repo, nodeId: raw.nodeId }))) out.push(i);
  });
  return out;
}

/** Tables/queues written after the changed code on its own chain, and tables only read there (spec §2). */
function writesAndReads(chains: Chain[], chainStops: Record<string, ReviewStop[]>, changedRefs: ReadonlySet<string>): { writes: string[]; readsOnly: string[] } {
  const writes = new Set<string>();
  const reads = new Set<string>();
  for (const chain of chains) {
    const stops = chainStops[chain.id] ?? [];
    for (const start of walkStarts(chain, stops, changedRefs)) {
      for (const j of downstream(stops, start)) {
        const t = stops[j]!;
        const raw = chain.stops[j]!;
        const name = raw.label ?? raw.symbol;
        if (isWrite(t)) writes.add(name);
        else if (isRead(t)) reads.add(name);
      }
    }
  }
  return { writes: [...writes].sort(compare), readsOnly: [...reads].filter((r) => !writes.has(r)).sort(compare) };
}

// ---- ⚠ Before deploying ------------------------------------------------------------------------------------

const RISK_ORDER: Record<ReviewRisk["kind"], number> = { migration: 0, schema: 1, env: 2, docker: 3, ci: 4 };
const CI_FILES = new Set([".gitlab-ci.yml", "bitbucket-pipelines.yml", "Jenkinsfile", "azure-pipelines.yml", ".travis.yml"]);
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|vue|svelte|php|java|kt|cs|rs)$/;
const isDotEnv = (name: string): boolean => /^\.env(\..+)?$/.test(name);

/** The risk kind a path's name alone implies (repo- or root-relative, "/"-separated), if any. */
export function riskKindOf(path: string): ReviewRisk["kind"] | undefined {
  const segs = path.split("/");
  const name = segs.at(-1)!;
  const dirs = segs.slice(0, -1);
  if (dirs.includes("migrations") || dirs.includes("drizzle")) return "migration";
  if (name === "schema.prisma" || name.endsWith(".sql")) return "schema";
  if (isDotEnv(name) || /^env\.(?:[cm]?[jt]s)$/.test(name)) return "env";
  if (/^Dockerfile/i.test(name) || /^(?:docker-)?compose(?:[.-].+)?\.ya?ml$/.test(name) || name === ".dockerignore") return "docker";
  if (path.startsWith(".github/workflows/") || CI_FILES.has(name) || dirs[0] === ".circleci" || dirs[0] === ".buildkite") return "ci";
  return undefined;
}

const ENV_READS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\benv\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/gi,
  /\bos\.(?:getenv\(|environ\.get\(|environ\[)\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];

function envNames(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const re of ENV_READS) for (const m of line.matchAll(re)) out.add(m[1]!);
  return out;
}

function envKeys(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** True when `name` appears as a word anywhere in `dir`'s tree at `commit`. `git grep` exits 1 for "no match";
 * any other failure is a real error and is rethrown. Cached per (dir, commit, name) in `known`. */
function knownAt(known: Map<string, boolean>, dir: string, commit: string, name: string): boolean {
  const key = `${dir}\0${commit}\0${name}`;
  const hit = known.get(key);
  if (hit !== undefined) return hit;
  let found: boolean;
  try {
    git(dir, ["grep", "-q", "-w", "-F", "-e", name, commit, "--"]);
    found = true;
  } catch (err) {
    if ((err as { status?: unknown }).status !== 1) throw err;
    found = false;
  }
  known.set(key, found);
  return found;
}

interface RiskFile {
  /** As shown: "<repo>/<file>", or root-relative. */
  display: string;
  dir: string;
  file: string;
  cache: RepoCache;
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

/** One risk per file at most: migrations/schema/env/Docker/CI files by name, with what changed in them; any
 * other code file that starts reading an env var no file read at base (a new deploy-time setting). Tests and
 * docs (paths.ts fileKind) never count — a `docs/migrations/*.md`, a `test/fixtures/*.sql` or a test's own
 * env read is nothing to do before deploying. `known` caches knownAt across files. */
function riskFor(f: RiskFile, base: string, head: string, known: Map<string, boolean>): ReviewRisk | undefined {
  const fk = fileKind(f.file);
  if (fk === "tests" || fk === "docs") return undefined;
  const kind = riskKindOf(f.file);
  if (kind === undefined && !CODE_FILE.test(f.file)) return undefined;
  const status = (): string =>
    readAt(f.cache, f.dir, base, f.file) === undefined ? "new file" : readAt(f.cache, f.dir, head, f.file) === undefined ? "deleted" : "changed";
  const hunks = hunksFor(f.cache, f.dir, base, head, f.file);
  const added = hunks.flatMap((h) => h.added);
  const removed = hunks.flatMap((h) => h.removed);
  const name = f.file.split("/").at(-1)!;

  if (kind === "env" && isDotEnv(name)) {
    const gone = envKeys(removed);
    const keys = [...envKeys(added)].filter((k) => !gone.has(k)).sort(compare);
    return { kind, file: f.display, detail: keys.length > 0 ? `new ${plural(keys.length, "key")}: ${keys.join(", ")}` : status() };
  }
  const gone = envNames(removed);
  const reads = CODE_FILE.test(f.file) ? [...envNames(added)].filter((n) => !gone.has(n) && !knownAt(known, f.dir, base, n)).sort(compare) : [];
  const readsDetail = `new env ${plural(reads.length, "read")}: ${reads.join(", ")}`;
  if (kind !== undefined) return { kind, file: f.display, detail: kind === "env" && reads.length > 0 ? readsDetail : status() };
  return reads.length > 0 ? { kind: "env", file: f.display, detail: readsDetail } : undefined;
}

/** Changed files under the workspace root that are in no repo (whole-workspace mode only): e.g. the root's
 * own `.github/workflows/`. Root-relative paths. */
function rootOnlyFiles(ws: WorkspaceData, base: string, head: string): string[] {
  const prefixes = ws.repos.map((r) => relative(ws.root, r.abs).split(sep).join("/"));
  return git(ws.root, ["diff", "--name-only", "-z", "--no-renames", "--relative", "--end-of-options", base, head], { maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .filter((f) => !f.startsWith(".codeloom/") && !prefixes.some((p) => p === "" || f === p || f.startsWith(`${p}/`)));
}

// ---- the Review ----------------------------------------------------------------------------------------------

/** The Review model for `baseRef..HEAD` (PR review maps design §2, §4; 0.5 spec §2): built on the existing
 * `impact_of_diff`, re-reading each changed function's code at base and head for its before/after text and
 * diff hunks, and the journeys/spec state of whatever it touches. Self-contained (§5): `chainStops` carries
 * every affected chain's full stop layout, so the renderers (mermaid.ts, markdown.ts) need nothing beyond
 * this Review — no live MapState, as the publish step (Task 3) only ever has data/review.json.
 * Which history is diffed: `opts.repoId` (`--repo`) → only that repo, base = merge-base inside it, every
 * other repo read as it is checked out; without it, see pickTarget. `opts.wholeWorkspaceOnly` (snapshot/
 * write.ts): only the 0.4 mode — the workspace root is the one git repo holding every repo — else exit 2
 * (hosted snapshots of a folder of repos are out of scope in 0.5). Throws a CodeloomError (exit 2, via
 * dataError) when no git history can be picked, or `baseRef`/HEAD cannot be resolved there. */
export function buildReview(start: string, baseRef: string, opts: { repoId?: string; wholeWorkspaceOnly?: boolean } = {}): Review {
  const state = loadMapState(start);
  const target = pickTarget(start, state.ws, opts.repoId, opts.wholeWorkspaceOnly);
  const where = target.dir;
  const baseCommit = resolveCommit(where, baseRef);
  if (baseCommit === undefined) throw dataError(`Bad base "${baseRef}": git cannot resolve it in ${where}.`);
  const head = resolveCommit(where, "HEAD");
  if (head === undefined) throw dataError(`The repo at ${where} has no HEAD commit.`);
  const base = git(where, ["merge-base", "--end-of-options", baseCommit, head]).trim();

  const impact = impactOfDiff(start, `${base}..${head}`, { lineSpaceAware: true, state, ...(target.repos ? { repos: target.repos } : {}) });
  const touchedChainIds = new Set(impact.chains);
  const chainsById = new Map(state.chains.map((c) => [c.id, c]));
  const touchedChains = impact.chains.map((id) => chainsById.get(id)).filter((c): c is Chain => c !== undefined);
  // Every chain in the workspace, grouped by its own `entry` string (0.5 acceptance fix §2): buildChains
  // gives sibling chains of the same UI call/page — one per route target — the identical entry string, so
  // this is how entryOf finds "the proxied route(s) of this same call" when the chain at hand is itself the
  // repo's own catch-all/passthrough route. The FULL chain set, not just touchedChains: the sibling that
  // actually reaches the backend may not itself be touched by this diff.
  const chainsByEntry = new Map<string, Chain[]>();
  for (const c of state.chains) chainsByEntry.set(c.entry, [...(chainsByEntry.get(c.entry) ?? []), c]);

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
  const riskFiles: RiskFile[] = [];
  /** Function node refs a touched chain stops at: its own stop, or a call made inside it (the call's nodeId). */
  const onChainRefs = new Set<string>();
  for (const c of touchedChains) for (const s of c.stops) if (s.nodeId !== undefined) onChainRefs.add(formatNodeRef({ repo: s.repo, nodeId: s.nodeId }));
  let wholeFileBudget = MAX_WHOLE_FILE_FUNCTIONS;
  let wholeFileSkipped = 0;

  for (const repoImpact of impact.repos) {
    const repo = state.ws.repos.find((r) => r.ref.id === repoImpact.id);
    if (!repo) continue;
    const cache = cacheFor(repo.ref.id);
    const indexedAtHead = indexedCommit(repo.abs) === head;

    for (const file of repoImpact.changedFiles) {
      const h = hunksFor(cache, repo.abs, base, head, file);
      const added = h.reduce((n, x) => n + x.added.length, 0);
      const removed = h.reduce((n, x) => n + x.removed.length, 0);
      files.push({ repo: repo.ref.id, file, added, removed, onChain: stopFiles.has(`${repo.ref.id}\0${file}`) });
      riskFiles.push({ display: `${repo.ref.id}/${file}`, dir: repo.abs, file, cache });
    }

    const seen = new Set<string>();
    for (const ref of repoImpact.changedNodes) {
      const { nodeId } = parseNodeRef(ref);
      const node = repo.graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      seen.add(node.id);
      if (node.filePath !== undefined && isTestOrDocsFile(node.filePath)) continue;
      const built = buildNode(cache, repo, node, base, head, indexedAtHead);
      if (built) nodes.push(built);
    }
    // A brand-new or deleted file reaches impact_of_diff as "the whole file" (its file node only), so its
    // functions are added here: every one is new (before null) or deleted (after null). Those a touched chain
    // stops at (its own stop, or a call inside it) are always built; the rest at most
    // MAX_WHOLE_FILE_FUNCTIONS per review. A file whose functions are not graph nodes (the map was indexed on
    // its other side — e.g. a deleted file, indexed at head) is parsed where it exists.
    const whole = addedOrDeletedFiles(repo.abs, base, head);
    const pending: Array<{ ref: string; build: () => ReviewNodeChange | null }> = [];
    const mappedFiles = new Set<string>();
    for (const node of repo.graph.nodes) {
      if (node.type !== "function" || node.filePath === undefined || !whole.has(node.filePath)) continue;
      mappedFiles.add(node.filePath);
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (isTestOrDocsFile(node.filePath)) continue;
      pending.push({ ref: formatNodeRef({ repo: repo.ref.id, nodeId: node.id }), build: () => buildNode(cache, repo, node, base, head, indexedAtHead) });
    }
    for (const file of [...whole].sort(compare)) {
      if (mappedFiles.has(file) || isTestOrDocsFile(file)) continue;
      const isNew = readAt(cache, repo.abs, base, file) === undefined;
      const commit = isNew ? head : base;
      for (const fn of functionsAt(repo.abs, commit, file)) {
        const nodeId = `function:${file}:${fn.name}`;
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        pending.push({ ref: formatNodeRef({ repo: repo.ref.id, nodeId }), build: () => wholeFileNode(cache, repo, file, fn, commit, isNew) });
      }
    }
    for (const p of pending) {
      if (!onChainRefs.has(p.ref)) {
        if (wholeFileBudget <= 0) {
          wholeFileSkipped++;
          continue;
        }
        wholeFileBudget--;
      }
      const built = p.build();
      if (built) nodes.push(built);
    }
  }
  const notes = [...impact.notes];
  if (wholeFileSkipped > 0) notes.push(`${wholeFileSkipped} more ${wholeFileSkipped === 1 ? "function" : "functions"} in new or deleted files ${wholeFileSkipped === 1 ? "is" : "are"} not listed.`);
  nodes.sort((a, b) => compare(a.ref, b.ref));
  const nodeRefSet = new Set(nodes.map((n) => n.ref));

  if (target.repoId === "") {
    const rootCache = newCache();
    for (const file of rootOnlyFiles(state.ws, base, head)) riskFiles.push({ display: file, dir: state.ws.root, file, cache: rootCache });
  }
  const known = new Map<string, boolean>();
  const risks = riskFiles
    .map((f) => riskFor(f, base, head, known))
    .filter((r): r is ReviewRisk => r !== undefined)
    .sort((a, b) => RISK_ORDER[a.kind] - RISK_ORDER[b.kind] || compare(a.file, b.file));

  // Every stop of every touched chain (not just the changed ones), with its real predecessor (`from`,
  // ChainStop.from — I1) so the diagram can draw branches instead of a straight line: Review needs to be
  // self-contained.
  // A call stop is changed when the function it sits in is (its nodeId is that enclosing function — the same
  // rule walkStarts uses): a changed hook whose only stop on the chain is its own call is still drawn, tagged
  // to its journeys and named in Code to check's journey names. `ownerOf` maps such a call stop's ref to its
  // function's node ref, so journeys list the changed function itself; its label is that function's name.
  const chainStops: Record<string, ReviewStop[]> = {};
  const chainNames: Record<string, string> = {};
  const ownerOf = new Map<string, string>();
  for (const chain of touchedChains) {
    chainNames[chain.id] = chain.name;
    chainStops[chain.id] = chain.stops.map((s) => {
      const ref = stopRef(s);
      const owner = s.kind === "call" && s.nodeId !== undefined ? formatNodeRef({ repo: s.repo, nodeId: s.nodeId }) : undefined;
      const changed = nodeRefSet.has(ref) || (owner !== undefined && nodeRefSet.has(owner));
      const viaOwner = changed && owner !== undefined && !nodeRefSet.has(ref);
      if (viaOwner) ownerOf.set(ref, owner);
      return {
        // A call changed through its function is labelled by that function (the ✏️ box names what changed).
        ref, repo: s.repo, lane: s.lane, kind: s.kind, label: viaOwner ? s.symbol : stopLabel(s),
        ...(s.op !== undefined && (s.lane === "db" || s.lane === "queue") ? { op: s.op } : {}),
        file: s.file, changed,
        ...(s.from !== undefined ? { from: s.from } : {}),
      };
    });
  }

  // Journeys: for each one touched, which of its stops are among the changed nodes, and its spec state.
  const specEntries = new Map(listSpecs(start, {}, state).journeys.map((j) => [j.journeyId, j]));
  const chains = chainLookup(state.chains);
  const nodeJourneys = new Map<string, Set<string>>();
  const journeys: ReviewJourney[] = journeysForChains(state, touchedChainIds).map((j) => {
    const resolved = chains.resolve(j.chainIds).chains.filter((c) => touchedChainIds.has(c.id));
    const changedStops = new Set<string>();
    for (const c of resolved) for (const stop of chainStops[c.id] ?? []) if (stop.changed) changedStops.add(ownerOf.get(stop.ref) ?? stop.ref);
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

  const { writes, readsOnly } = writesAndReads(touchedChains, chainStops, nodeRefSet);

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
    chainNames,
    tables: impact.tables,
    queues: impact.queues,
    truncated: impact.truncated,
    notes,
    repoId: target.repoId,
    entries: buildEntries(touchedChains, journeys, state.ws, chainsByEntry),
    writes,
    readsOnly,
    risks,
  };
}
