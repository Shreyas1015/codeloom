import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CodeloomError } from "../errors.js";
import { readJson } from "../store/json.js";
import { WORKSPACE_FILE } from "../store/paths.js";
import { type RepoRef, type TracesConfig, type WorkspaceFile, WorkspaceFileSchema } from "../store/schemas.js";
import { git } from "./git.js";

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
    return git(start, ["rev-parse", "--show-toplevel"]).trim();
  } catch (err) {
    if (err instanceof CodeloomError) throw err;
    return null;
  }
}

export function loadWorkspace(start: string): {
  root: string; name: string; repos: RepoRef[]; links: WorkspaceFile["links"]; traces?: TracesConfig;
} {
  const wsRoot = findWorkspaceRoot(start);
  if (wsRoot) {
    const ws = readJson(join(wsRoot, WORKSPACE_FILE), WorkspaceFileSchema);
    if (ws) return { root: wsRoot, name: ws.name, repos: ws.repos, links: ws.links, traces: ws.traces };
  }
  const top = gitToplevel(start);
  if (!top) {
    throw new CodeloomError(
      `No codeloom workspace or git repo found at ${resolve(start)}. Run "codeloom init" in a repo or a folder of repos first.`,
    );
  }
  return { root: top, name: basename(top), repos: [{ id: basename(top), path: "." }], links: [] };
}

export function gitHead(repoAbs: string): string {
  try {
    return git(repoAbs, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "uncommitted";
  }
}
