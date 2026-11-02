import { dataError } from "../errors.js";
import { compare } from "../util.js";
import { git } from "./git.js";

/** A changed file: repo-relative posix path, and the changed line ranges in the NEW file (inclusive), or
 * "all" for a new / untracked / deleted / renamed / binary file. */
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

function resolves(repoAbs: string, rev: string): boolean {
  try {
    git(repoAbs, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
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
  // git ends an unquoted name that holds a space with a TAB, so the line stays unambiguous.
  const p = raw.startsWith('"') ? unquote(raw) : raw.replace(/\t$/, "");
  if (p === "/dev/null") return undefined;
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

interface Section {
  path?: string;
  oldPath?: string;
  all: boolean;
  /** After the first hunk header every line is content ("--- x" may be a removed "-- x"), never a header. */
  inHunks: boolean;
  ranges: Array<[number, number]>;
}

/** Parse `git diff -U0` output into per-file changes. A file's path is the NEW path (`+++ b/…`,
 * `rename to …`), else the old one for a deletion. */
function parsePatch(out: string): ChangedFile[] {
  const sections: Section[] = [];
  let cur: Section | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { all: false, inHunks: false, ranges: [] };
      sections.push(cur);
      const sym = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (sym && sym[1] === sym[2]) cur.oldPath = sym[1];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@ ")) {
      cur.inHunks = true;
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (h) {
        const c = Number(h[1]);
        const d = h[2] === undefined ? 1 : Number(h[2]);
        // d = 0: a pure deletion; git reports the line BEFORE it (c), so the gap sits at c (min 1).
        cur.ranges.push(d === 0 ? [Math.max(c, 1), Math.max(c, 1)] : [c, c + d - 1]);
      }
      continue;
    }
    if (cur.inHunks) continue;
    if (line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("Binary files ")) {
      cur.all = true;
    } else if (line.startsWith("rename to ")) {
      cur.path = unquote(line.slice("rename to ".length));
      cur.all = true;
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      cur.all = true;
    } else if (line.startsWith("copy to ")) {
      cur.path = unquote(line.slice("copy to ".length));
    } else if (line.startsWith("--- ")) {
      cur.oldPath = stripPrefix(line.slice(4)) ?? cur.oldPath;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p !== undefined) cur.path = p;
    }
  }
  const files: ChangedFile[] = [];
  for (const s of sections) {
    const file = s.path ?? s.oldPath;
    if (file === undefined) continue;
    if (s.all) files.push({ file, lines: "all" });
    else if (s.ranges.length > 0) files.push({ file, lines: s.ranges });
    // else: a mode-only change: no lines changed.
  }
  return files;
}

/** Changed files and line ranges in one repo folder (paths relative to it, posix).
 * range undefined → working tree vs HEAD (staged + unstaged) plus untracked files;
 * "base..head" (or "base...head") → that diff; "base" alone → base..HEAD.
 * A range that is option-like or that git cannot resolve → dataError (exit 2). Sorted by file. */
export function changedLines(repoAbs: string, range?: string): ChangedFile[] {
  let files: ChangedFile[];
  if (range === undefined) {
    const base = resolves(repoAbs, "HEAD") ? "HEAD" : EMPTY_TREE;
    files = parsePatch(git(repoAbs, [...DIFF_OPTS, "--end-of-options", base], { maxBuffer: 256 * 1024 * 1024 }));
    const untracked = git(repoAbs, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
    const seen = new Set(files.map((f) => f.file));
    for (const file of untracked) if (!seen.has(file)) files.push({ file, lines: "all" });
  } else {
    const { revs, spec } = rangeRevs(range);
    const bad = revs.find((r) => !resolves(repoAbs, r));
    if (bad !== undefined) throw dataError(`Bad range "${range}": git cannot resolve "${bad}" in ${repoAbs}.`);
    files = parsePatch(git(repoAbs, [...DIFF_OPTS, "--end-of-options", spec], { maxBuffer: 256 * 1024 * 1024 }));
  }
  return files.sort((a, b) => compare(a.file, b.file));
}
