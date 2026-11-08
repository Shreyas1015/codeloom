import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { CodeloomError } from "../errors.js";

const execFileAsync = promisify(execFile);

/** The environment every git call runs with: GIT_NO_LAZY_FETCH=1 so reading history in a partial clone
 * never downloads missing objects from the remote (codeloom works offline). */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1" };
}

/** A spawn ENOENT with an existing cwd means git itself is missing (a missing cwd also reports ENOENT). */
function noGit(err: unknown, cwd: string): CodeloomError | null {
  if ((err as NodeJS.ErrnoException).code === "ENOENT" && existsSync(cwd)) {
    return new CodeloomError("git was not found on PATH. Install git (https://git-scm.com) and try again.");
  }
  return null;
}

/** Run git and return stdout. A missing git binary becomes a clear CodeloomError; other failures throw as usual. */
export function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: opts.maxBuffer, env: gitEnv() });
  } catch (err) {
    throw noGit(err, cwd) ?? err;
  }
}

/** git without blocking the event loop (the dashboard server): same contract as `git`. */
export async function gitAsync(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 64, env: gitEnv() });
    return stdout;
  } catch (err) {
    throw noGit(err, cwd) ?? err;
  }
}
