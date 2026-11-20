import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { git } from "./git.js";

/** A path inside the repo's git dir (`rev-parse --git-path`): right for linked worktrees too. */
export function gitPath(repoAbs: string, rel: string): string {
  return resolve(repoAbs, git(repoAbs, ["rev-parse", "--git-path", rel]).trim());
}

/** Adds any of `lines` not already present to `<repoAbs>/.git/info/exclude` (never `.gitignore`: this is
 * local-only and never committed). Returns whether anything was written. */
export function ensureExcludeLines(repoAbs: string, lines: string[]): boolean {
  const path = gitPath(repoAbs, "info/exclude");
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingLines = new Set(current.split(/\r?\n/));
  const missing = lines.filter((l) => !existingLines.has(l));
  if (missing.length === 0) return false;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  writeFileSync(path, `${prefix}${missing.join("\n")}\n`);
  return true;
}

export function hasExcludeLine(repoAbs: string, line: string): boolean {
  const path = gitPath(repoAbs, "info/exclude");
  return existsSync(path) && readFileSync(path, "utf8").split(/\r?\n/).includes(line);
}
