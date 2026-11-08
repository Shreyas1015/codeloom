import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CODELOOM_DIR } from "./paths.js";

// One path-safety check for every place that reads a repo file a caller named: /api/code, /api/docs,
// save_spec_links doc refs and match_specs snippets. The file must stay inside the repo (after symlinks),
// and never be git internals, an env file or codeloom's own folder.

export type SafeRepoFile =
  | { ok: true; real: string; size: number }
  | { ok: false; reason: "outside" | "hidden" | "missing" | "not-file" };

/** True when a path's segments name git internals, codeloom's folder or an env file. Compared lowercased,
 * so `.GIT`, `.Env.local` or `.CODELOOM` on a case-insensitive file system are refused too. */
export function hiddenSegments(segments: readonly string[]): boolean {
  return segments.some((s) => {
    const l = s.toLowerCase();
    return l === ".git" || l === CODELOOM_DIR || l === ".env" || l.startsWith(".env.");
  });
}

function inside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `rel` (a repo-relative path a caller gave) as a real file inside `repoAbs`. Refused: absolute paths,
 * `..` segments, NUL, a real path (after symlinks) outside the repo's real path, and hidden segments
 * (hiddenSegments) in the asked path or the real one. Never throws. */
export function safeRepoFile(repoAbs: string, rel: string): SafeRepoFile {
  if (rel === "" || rel.includes("\0") || isAbsolute(rel) || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) return { ok: false, reason: "outside" };
  const asked = rel.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  // hidden first, so `src/../.codeloom/x` is refused as codeloom's folder (the clearer message)
  if (hiddenSegments(asked)) return { ok: false, reason: "hidden" };
  if (asked.includes("..") || asked.length === 0) return { ok: false, reason: "outside" };
  const abs = resolve(repoAbs, ...asked);
  if (!inside(resolve(repoAbs), abs)) return { ok: false, reason: "outside" };
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync.native(repoAbs);
    real = realpathSync.native(abs);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!inside(realRoot, real)) return { ok: false, reason: "outside" };
  if (hiddenSegments(relative(realRoot, real).split(sep))) return { ok: false, reason: "hidden" };
  try {
    const st = statSync(real);
    if (!st.isFile()) return { ok: false, reason: "not-file" };
    return { ok: true, real, size: st.size };
  } catch {
    return { ok: false, reason: "missing" };
  }
}
