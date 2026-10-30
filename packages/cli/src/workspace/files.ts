import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";
import { createIgnoreFilter } from "@codeloom/core";
import { CODELOOM_DIR } from "../store/paths.js";

export function listFiles(repoAbs: string, extraIgnore: string[] = []): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoAbs,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const defaults = createIgnoreFilter(repoAbs);
  const extra = ignore().add([`${CODELOOM_DIR}/`, ...extraIgnore]);
  const isFile = (rel: string) => {
    try {
      return statSync(join(repoAbs, rel)).isFile();
    } catch {
      return false;
    }
  };
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter((rel) => !defaults.isIgnored(rel) && !extra.ignores(rel) && isFile(rel))
    .sort();
}
