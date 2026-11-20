import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `$CODELOOM_HOME` when set (tests), else `~/.codeloom`: codeloom's machine-local folder (personal
 * progress, the repo registry, group data). Never inside a workspace, never committed. */
export function codeloomHome(): string {
  const env = process.env.CODELOOM_HOME;
  return env !== undefined && env !== "" ? resolve(env) : join(homedir(), ".codeloom");
}
