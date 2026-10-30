import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CodeloomError } from "../errors.js";

/** Run git and return stdout. A missing git binary becomes a clear CodeloomError; other failures throw as usual. */
export function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: opts.maxBuffer });
  } catch (err) {
    // spawn reports ENOENT both for a missing binary and a missing cwd; only the former means "no git".
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && existsSync(cwd)) {
      throw new CodeloomError("git was not found on PATH. Install git (https://git-scm.com) and try again.");
    }
    throw err;
  }
}
