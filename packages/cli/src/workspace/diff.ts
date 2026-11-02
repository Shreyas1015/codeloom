import { dataError } from "../errors.js";
import { compare } from "../util.js";
import { git } from "./git.js";

/** A changed file: repo-relative posix path, and the changed line ranges (inclusive) on the side the caller
 * asked for, or "all" for a new / untracked / deleted / renamed (old and new path) / binary / mode-only file. */
export interface ChangedFile {
  file: string;
  lines: Array<[number, number]> | "all";
}

/** git's hash of the empty tree: the base for a repo with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Options that keep the patch format predictable whatever the user's git config says. */
const DIFF_OPTS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
  "--relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Split "base..head" / "base...head" / "base" into revisions, rejecting anything that could be read as a
 * git option or that holds whitespace / control characters. */
function rangeRevs(range: string): { revs: string[]; spec: string } {
  // eslint-disable-next-line no-control-regex
  if (range === "" || /[\s\u0000-\u001f\u007f]/.test(range)) {
    throw dataError(`Bad range "${range}". Use "base..head" or a single commit / branch name.`);
  }
  const m = /^(.*?)(\.\.\.?)(.*)$/.exec(range);
  const revs = m ? [m[1] || "HEAD", m[3] || "HEAD"] : [range];
  if (revs.some((r) => r.startsWith("-"))) {
    throw dataError(`Bad range "${range}": a revision may not start with "-".`);
  }
  const spec = m ? `${revs[0]}${m[2]}${revs[1]}` : `${range}..HEAD`;
  return { revs, spec };
}

/** Undo git's C-style quoting of a path ("a/tab\there.ts" with the quotes). Unquoted input is returned as is. */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** "a/x" or "b/x" (possibly quoted) from a ---/+++ line → "x"; "/dev/null" → undefined. */
function stripPrefix(raw: string): string | undefined {
  // git ends a name that holds a space with a TAB (after the closing quote, if quoted), so the line stays
  // unambiguous: strip it before unquoting.
  const p = unquote(raw.replace(/\t$/, ""));
  if (p === "/dev/null") return undefined;
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** Which side of each hunk to report: "old" = line numbers in the base version, "new" = in the head /
 * working-tree version. */
export type DiffSide = "old" | "new";

/** Parse `git diff -U0` output into hunk ranges per modified path (the `+++` path, else the `---` one).
 * Only hunks are taken from the patch; which paths changed, and how, comes from `--raw`. */
function parseHunks(out: string, side: DiffSide): Map<string, Array<[number, number]>> {
  const hunks = new Map<string, Array<[number, number]>>();
  let path: string | undefined;
  let ranges: Array<[number, number]> | undefined;
  /** After the first hunk header every line is content ("--- x" may be a removed "-- x"), never a header. */
  let inHunks = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = undefined;
      ranges = undefined;
      inHunks = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunks = true;
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!h || path === undefined) continue;
      const c = Number(side === "old" ? h[1] : h[3]);
      const dRaw = side === "old" ? h[2] : h[4];
      const d = dRaw === undefined ? 1 : Number(dRaw);
      if (!ranges) {
        ranges = [];
        hunks.set(path, ranges);
      }
      // d = 0: nothing on this side; git reports the line BEFORE the gap (c), so the gap sits at c (min 1).
      ranges.push(d === 0 ? [Math.max(c, 1), Math.max(c, 1)] : [c, c + d - 1]);
      continue;
    }
    if (inHunks) continue;
    if (line.startsWith("--- ")) {
      path = stripPrefix(line.slice(4)) ?? path;
    } else if (line.startsWith("+++ ")) {
      path = stripPrefix(line.slice(4)) ?? path;
    }
  }
  return hunks;
}

/** Parse `git diff --raw -z` into { status letter, paths } entries (a rename or copy carries old and new). */
function parseRaw(out: string): Array<{ status: string; paths: string[] }> {
  const parts = out.split("\0");
  const entries: Array<{ status: string; paths: string[] }> = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i]!;
    if (!meta.startsWith(":")) continue;
    const status = meta.split(" ").pop()!.charAt(0);
    const n = status === "R" || status === "C" ? 2 : 1;
    entries.push({ status, paths: parts.slice(i + 1, i + 1 + n) });
    i += n;
  }
  return entries;
}

const BIG = { maxBuffer: 256 * 1024 * 1024 };

/** The changed files between `revs` (one rev = vs the working tree, two = commit vs commit). The list of
 * paths comes from `--raw -z`, so binary, mode-only and type changes are never lost; the `-U0` patch only
 * supplies line ranges. Any path that is added, deleted, renamed (both paths), or has no hunks → "all". */
function diffFiles(repoAbs: string, revs: string[], side: DiffSide): ChangedFile[] {
  const raw = parseRaw(git(repoAbs, ["diff", "--raw", "-z", "--no-abbrev", "-M", "--relative", "--end-of-options", ...revs], BIG));
  const hunks = parseHunks(git(repoAbs, [...DIFF_OPTS, "--end-of-options", ...revs], BIG), side);
  const files = new Map<string, ChangedFile>();
  for (const { status, paths } of raw) {
    for (const file of paths) {
      const ranges = status === "M" ? hunks.get(file) : undefined;
      files.set(file, ranges ? { file, lines: ranges } : { file, lines: "all" });
    }
  }
  return [...files.values()];
}

/** Add untracked files (not git-ignored) as "all", skipping any path already listed. */
function addUntracked(repoAbs: string, files: ChangedFile[]): void {
  const untracked = git(repoAbs, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  // A path deleted since `base` but present again as an untracked file is listed by both.
  const seen = new Set(files.map((f) => f.file));
  for (const file of untracked) if (!seen.has(file)) files.push({ file, lines: "all" });
}

const sortFiles = (files: ChangedFile[]) => files.sort((a, b) => compare(a.file, b.file));

/** True when `dir` is inside a git work tree. */
export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** The full commit id `rev` names in this repo, or undefined when git cannot resolve it to a commit. */
export function resolveCommit(repoAbs: string, rev: string): string | undefined {
  if (rev === "" || rev.startsWith("-")) return undefined;
  try {
    return git(repoAbs, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The commits a range compares: "base..head" → (base, head); "base...head" → (merge-base, head);
 * "base" alone → (base, HEAD). Option-like or unresolvable → dataError (exit 2). */
export function resolveRange(repoAbs: string, range: string): { base: string; head: string } {
  const { revs } = rangeRevs(range);
  const shas = revs.map((r) => resolveCommit(repoAbs, r));
  const bad = shas.findIndex((s) => s === undefined);
  if (bad !== -1) throw dataError(`Bad range "${range}": git cannot resolve "${revs[bad]}" in ${repoAbs}.`);
  const head = shas.length === 2 ? shas[1]! : resolveCommit(repoAbs, "HEAD");
  if (head === undefined) throw dataError(`Bad range "${range}": the repo at ${repoAbs} has no HEAD commit.`);
  let base = shas[0]!;
  if (range.includes("...")) base = git(repoAbs, ["merge-base", "--end-of-options", base, head]).trim();
  return { base, head };
}

/** Changed files and line ranges in one repo folder (paths relative to it, posix), with line numbers in
 * the NEW version (head / working tree). range undefined → working tree vs HEAD (staged + unstaged) plus
 * untracked files; "base..head" (or "base...head") → that diff; "base" alone → base..HEAD.
 * A range that is option-like or that git cannot resolve → dataError (exit 2). Sorted by file. */
export function changedLines(repoAbs: string, range?: string): ChangedFile[] {
  if (range === undefined) {
    const files = diffFiles(repoAbs, [resolveCommit(repoAbs, "HEAD") ? "HEAD" : EMPTY_TREE], "new");
    addUntracked(repoAbs, files);
    return sortFiles(files);
  }
  const { revs, spec } = rangeRevs(range);
  const bad = revs.find((r) => resolveCommit(repoAbs, r) === undefined);
  if (bad !== undefined) throw dataError(`Bad range "${range}": git cannot resolve "${bad}" in ${repoAbs}.`);
  return sortFiles(diffFiles(repoAbs, [spec], "new"));
}

/** Changed files with line ranges in the BASE version (the old side of each hunk): the line space of a
 * map indexed at `base`. head undefined → `base` vs the working tree (commits since base + staged +
 * unstaged) plus untracked files; else `base` vs `head`. `base` / `head` must be commit ids (or the empty
 * tree). An insertion after line a is reported as [max(a,1), max(a,1)]. Sorted by file. */
export function changedLinesAtBase(repoAbs: string, base: string, head?: string): ChangedFile[] {
  const files = diffFiles(repoAbs, head === undefined ? [base] : [base, head], "old");
  if (head === undefined) addUntracked(repoAbs, files);
  return sortFiles(files);
}

/** git's empty tree id, the base to use for a repo with no commits. */
export { EMPTY_TREE };
