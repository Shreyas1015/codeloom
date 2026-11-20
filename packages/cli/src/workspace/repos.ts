import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CodeloomError, dataError } from "../errors.js";
import { compare } from "../util.js";
import { readJson } from "../store/json.js";
import { WORKSPACE_FILE } from "../store/paths.js";
import { type ExternalService, type RepoRef, type SpecsConfig, type TracesConfig, type WorkspaceFile, WorkspaceFileSchema } from "../store/schemas.js";
import { git, gitAsync } from "./git.js";
import { findGroup, groupWorkspace, readRegistry, type RegistryFile } from "./registry.js";

let warnedRegistry = false;
/** Once per process, on stderr (stdout may carry MCP frames). */
function warnRegistry(err: unknown): void {
  if (warnedRegistry) return;
  warnedRegistry = true;
  process.stderr.write(`codeloom: ${err instanceof Error ? err.message : String(err)} Reading this repo on its own until then.\n`);
}

/** A repo id from its package.json name (else its folder name), safe for link refs (`[^:#]+`):
 * drop `@`, and `/`, `:`, `#` become `-` — so `@acme/web` is `acme-web`. */
export function repoIdFor(packageName: string | undefined, folder: string): string {
  const clean = (s: string) => s.replace(/@/g, "").replace(/[/:#]/g, "-").trim();
  const fromPkg = packageName === undefined ? "" : clean(packageName);
  return fromPkg !== "" ? fromPkg : clean(folder) || "repo";
}

export function packageName(repoAbs: string): string | undefined {
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

/** 0.6: a group repo's id — its git remote's repo name (`installer-ui`), else its folder name, else its package
 * name. package.json names are often a template's (`web`, `web-2`): a group of repos is told apart by their remotes.
 * (A workspace folder keeps defaultRepoId: its ids are in its workspace file.) */
export function groupRepoId(repoAbs: string, remoteName: string | undefined): string {
  const clean = (s: string | undefined) => (s ?? "").replace(/@/g, "").replace(/[/:#]/g, "-").trim();
  return clean(remoteName?.split("/").pop()) || clean(basename(resolve(repoAbs))) || clean(packageName(repoAbs)) || "repo";
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

/** Every `proxies[]` rule that is wrong (spec §4, hardened after real-workspace review): `to` naming no
 * repo in `repos`, or naming the rule's own repo (nothing to proxy to itself) — one entry per bad rule,
 * in repo then declaration order. Exported so `codeloom doctor` can report the same problems. */
export function proxyProblems(repos: RepoRef[]): string[] {
  const ids = new Set(repos.map((r) => r.id));
  return repos.flatMap((r) => (r.proxies ?? []).flatMap((p) => {
    if (p.to === r.id) return [`${r.id}: proxies "${p.from}" -> "${p.to}" names its own repo`];
    if (!ids.has(p.to)) return [`${r.id}: proxies "${p.from}" -> unknown repo "${p.to}"`];
    return [];
  }));
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

/** The top folder of the git repo holding `start`, or null when it is in none. */
export function gitToplevel(start: string): string | null {
  try {
    return git(start, ["rev-parse", "--show-toplevel"]).trim();
  } catch (err) {
    if (err instanceof CodeloomError) throw err;
    return null;
  }
}

export interface LoadedWorkspace {
  root: string; name: string; repos: RepoRef[]; links: WorkspaceFile["links"]; traces?: TracesConfig; external?: ExternalService[];
  specs?: SpecsConfig;
  /** Set for a group (0.6 §1): the group's name. Its repos' paths are absolute (see repoAbsPath). */
  group?: string;
}

/** The workspace at `start`: the nearest `codeloom.workspace.json` above it (a workspace folder); else the
 * group of the registered repo holding `start`, or of the group data folder holding it (0.6 §1); else the
 * git repo holding `start` as a one-repo workspace (a repo never indexed outside a workspace folder). */
export function loadWorkspace(start: string): LoadedWorkspace {
  const wsRoot = findWorkspaceRoot(start);
  if (wsRoot) {
    // Hand-written: a bad file must be fixed by hand, never deleted and re-indexed.
    const ws = readJson(join(wsRoot, WORKSPACE_FILE), WorkspaceFileSchema, { handWritten: true });
    if (ws) {
      const problems = proxyProblems(ws.repos);
      if (problems.length > 0) {
        throw dataError(`Bad ${WORKSPACE_FILE}: ${problems.join("; ")}. Repos in this workspace: ${ws.repos.map((r) => r.id).sort(compare).join(", ")}.`);
      }
      return { root: wsRoot, name: ws.name, repos: ws.repos, links: ws.links, traces: ws.traces, ...(ws.external ? { external: ws.external } : {}),
        ...(ws.specs ? { specs: ws.specs } : {}) };
    }
  }
  const top = gitToplevel(start);
  let reg: RegistryFile;
  try {
    reg = readRegistry();
  } catch (err) {
    // A corrupt registry: say so, and go on with this repo alone (right for a repo that never joined a
    // group); a group's data folder cannot be read without it.
    if (top === null) throw err;
    warnRegistry(err);
    reg = { version: 1, repos: [] };
  }
  const group = findGroup(reg, start, top);
  if (group !== null) {
    const g = groupWorkspace(reg, group);
    return { root: g.root, name: g.name, repos: g.repos, links: [], group: g.group };
  }
  if (!top) {
    // A usage/data problem, not a crash: exit 2 (codeloom check's contract).
    throw dataError(
      `No codeloom workspace or git repo found at ${resolve(start)}. Run "codeloom init" in a repo or a folder of repos first.`,
      { code: "no-workspace" },
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

/** gitHead without blocking the event loop (the dashboard server). */
export async function gitHeadAsync(repoAbs: string): Promise<string> {
  try {
    return (await gitAsync(repoAbs, ["rev-parse", "HEAD"])).trim();
  } catch {
    return "uncommitted";
  }
}
