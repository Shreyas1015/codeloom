import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { CodeloomError } from "../errors.js";
import { writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { defaultRepoConfig, type RepoRef, type WorkspaceFile } from "../store/schemas.js";
import { discoverRepos } from "../workspace/repos.js";

export const HOOK_MARK = "# codeloom: re-index after commit";
const CACHE_IGNORE = `${CODELOOM_DIR}/${FILES.fingerprints}`;

export interface InitResult {
  root: string;
  repos: RepoRef[];
  created: string[];
}

export function installHook(repoAbs: string, wsRoot: string): boolean {
  const gitDir = join(repoAbs, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return false;
  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, "post-commit");
  const existing = existsSync(hook) ? readFileSync(hook, "utf8") : "#!/bin/sh\n";
  if (existing.includes(HOOK_MARK)) return false;
  const block = [
    HOOK_MARK,
    `if command -v codeloom >/dev/null 2>&1; then (cd ${JSON.stringify(wsRoot)} && codeloom index --quiet) >/dev/null 2>&1 & fi`,
  ].join("\n");
  writeFileSync(hook, `${existing.trimEnd()}\n\n${block}\n`);
  chmodSync(hook, 0o755);
  return true;
}

export function ensureGitignore(repoAbs: string): boolean {
  const path = join(repoAbs, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split(/\r?\n/).includes(CACHE_IGNORE)) return false;
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  writeFileSync(path, `${prefix}${CACHE_IGNORE}\n`);
  return true;
}

export function runInit(dir: string): InitResult {
  const root = resolve(dir);
  const repos = discoverRepos(root);
  if (repos.length === 0) {
    throw new CodeloomError(
      `No git repos found in ${root}. Run "codeloom init" inside a repo, or in a folder that contains repos.`,
    );
  }
  const created: string[] = [];
  const isWorkspace = !(repos.length === 1 && repos[0]!.path === ".");
  if (isWorkspace && !existsSync(join(root, WORKSPACE_FILE))) {
    const ws: WorkspaceFile = { version: 1, name: basename(root), repos, links: [] };
    writeJsonAtomic(join(root, WORKSPACE_FILE), ws);
    created.push(WORKSPACE_FILE);
  }
  for (const repo of repos) {
    const repoAbs = join(root, repo.path);
    const config = join(repoAbs, CODELOOM_DIR, FILES.config);
    if (!existsSync(config)) {
      writeJsonAtomic(config, defaultRepoConfig());
      created.push(posix.join(repo.path, CODELOOM_DIR, FILES.config));
    }
    if (installHook(repoAbs, root)) created.push(posix.join(repo.path, ".git/hooks/post-commit"));
    if (ensureGitignore(repoAbs)) created.push(posix.join(repo.path, ".gitignore"));
  }
  return { root, repos, created };
}

export function formatInit(r: InitResult): string {
  const lines = [
    `Found ${r.repos.length} repo${r.repos.length === 1 ? "" : "s"} in ${r.root}: ${r.repos.map((x) => x.id).join(", ")}`,
    r.created.length ? "Created or updated:" : "Already set up; nothing changed.",
    ...r.created.map((c) => `  ${c}`),
    "",
    'Next: run "codeloom index" to build the map.',
  ];
  return lines.join("\n");
}
