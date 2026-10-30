import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CodeloomError } from "../errors.js";
import { readJson } from "../store/json.js";
import { WORKSPACE_FILE } from "../store/paths.js";
import { type RepoRef, WorkspaceFileSchema } from "../store/schemas.js";

export function discoverRepos(root: string): RepoRef[] {
  const abs = resolve(root);
  if (existsSync(join(abs, ".git"))) return [{ id: basename(abs), path: "." }];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(abs, d.name, ".git")))
    .map((d) => ({ id: d.name, path: d.name }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitToplevel(start: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

export function loadWorkspace(start: string): { root: string; name: string; repos: RepoRef[] } {
  const wsRoot = findWorkspaceRoot(start);
  if (wsRoot) {
    const ws = readJson(join(wsRoot, WORKSPACE_FILE), WorkspaceFileSchema);
    if (ws) return { root: wsRoot, name: ws.name, repos: ws.repos };
  }
  const top = gitToplevel(start);
  if (!top) {
    throw new CodeloomError(
      `No codeloom workspace or git repo found at ${resolve(start)}. Run "codeloom init" in a repo or a folder of repos first.`,
    );
  }
  return { root: top, name: basename(top), repos: [{ id: basename(top), path: "." }] };
}

export function gitHead(repoAbs: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoAbs, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "uncommitted";
  }
}
