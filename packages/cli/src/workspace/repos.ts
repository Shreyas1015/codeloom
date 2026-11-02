import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CodeloomError, dataError } from "../errors.js";
import { compare } from "../util.js";
import { readJson } from "../store/json.js";
import { WORKSPACE_FILE } from "../store/paths.js";
import { type RepoRef, type TracesConfig, type WorkspaceFile, WorkspaceFileSchema } from "../store/schemas.js";
import { git } from "./git.js";

/** A repo id from its package.json name (else its folder name), safe for link refs (`[^:#]+`):
 * drop `@`, and `/`, `:`, `#` become `-` — so `@acme/web` is `acme-web`. */
export function repoIdFor(packageName: string | undefined, folder: string): string {
  const clean = (s: string) => s.replace(/@/g, "").replace(/[/:#]/g, "-").trim();
  const fromPkg = packageName === undefined ? "" : clean(packageName);
  return fromPkg !== "" ? fromPkg : clean(folder) || "repo";
}

function packageName(repoAbs: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(repoAbs, "package.json"), "utf8"));
    const name = pkg && typeof pkg === "object" ? (pkg as { name?: unknown }).name : undefined;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined; // no package.json, or not JSON: fall back to the folder name
  }
}

/** The default id of the repo at `repoAbs` (see `repoIdFor`). */
export function defaultRepoId(repoAbs: string): string {
  return repoIdFor(packageName(repoAbs), basename(resolve(repoAbs)));
}

/** Give every repo a unique id: in path order, the first repo keeps its id and later ones with the
 * same id get `-2`, `-3`, ... (skipping any id another repo has on its own). Sorted by id. */
function uniqueIds(repos: Array<{ base: string; path: string }>): RepoRef[] {
  const taken = new Set(repos.map((r) => r.base));
  const used = new Set<string>();
  const out: RepoRef[] = [];
  for (const r of [...repos].sort((a, b) => compare(a.path, b.path))) {
    let id = r.base;
    if (used.has(id)) {
      let n = 2;
      while (taken.has(`${r.base}-${n}`) || used.has(`${r.base}-${n}`)) n++;
      id = `${r.base}-${n}`;
    }
    used.add(id);
    out.push({ id, path: r.path });
  }
  return out.sort((a, b) => compare(a.id, b.id));
}

export function discoverRepos(root: string): RepoRef[] {
  const abs = resolve(root);
  if (existsSync(join(abs, ".git"))) return [{ id: defaultRepoId(abs), path: "." }];
  return uniqueIds(
    readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(abs, d.name, ".git")))
      .map((d) => ({ base: defaultRepoId(join(abs, d.name)), path: d.name })),
  );
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
    // Hand-written: a bad file must be fixed by hand, never deleted and re-indexed.
    const ws = readJson(join(wsRoot, WORKSPACE_FILE), WorkspaceFileSchema, { handWritten: true });
    if (ws) return { root: wsRoot, name: ws.name, repos: ws.repos, links: ws.links, traces: ws.traces };
  }
  const top = gitToplevel(start);
  if (!top) {
    // A usage/data problem, not a crash: exit 2 (codeloom check's contract).
    throw dataError(
      `No codeloom workspace or git repo found at ${resolve(start)}. Run "codeloom init" in a repo or a folder of repos first.`,
    );
  }
  // No init: derive the id the way init would (package.json name, else folder), so a renamed clone
  // with a package.json name keeps its ids.
  const id = defaultRepoId(top);
  return { root: top, name: id, repos: [{ id, path: "." }], links: [] };
}

export function gitHead(repoAbs: string): string {
  try {
    return git(repoAbs, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "uncommitted";
  }
}
