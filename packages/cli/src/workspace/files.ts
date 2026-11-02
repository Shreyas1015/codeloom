import { lstatSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";
import { createIgnoreFilter } from "@codeloom/core";
import { CODELOOM_DIR } from "../store/paths.js";
import { git, gitAsync } from "./git.js";

const LS_FILES = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
const LS_MAX_BUFFER = 256 * 1024 * 1024;

export function listFiles(repoAbs: string, extraIgnore: string[] = []): string[] {
  return filterListedFiles(repoAbs, git(repoAbs, LS_FILES, { maxBuffer: LS_MAX_BUFFER }), extraIgnore);
}

/** listFiles without blocking the event loop on git (the dashboard server). */
export async function listFilesAsync(repoAbs: string, extraIgnore: string[] = []): Promise<string[]> {
  return filterListedFiles(repoAbs, await gitAsync(repoAbs, LS_FILES, { maxBuffer: LS_MAX_BUFFER }), extraIgnore);
}

/** The indexable files from `git ls-files -z` output: ignore rules applied, regular files only, sorted. */
function filterListedFiles(repoAbs: string, out: string, extraIgnore: string[]): string[] {
  const defaults = createIgnoreFilter(repoAbs);
  const extra = ignore().add([`${CODELOOM_DIR}/`, ...extraIgnore]);
  const isFile = (rel: string) => {
    try {
      return lstatSync(join(repoAbs, rel)).isFile();
    } catch {
      return false;
    }
  };
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter((rel) => !defaults.isIgnored(rel) && !extra.ignores(rel) && isFile(rel))
    .sort();
}
