import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { CodeloomError } from "../errors.js";
import { writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { defaultRepoConfig, type RepoRef, type WorkspaceFile } from "../store/schemas.js";
import { discoverRepos } from "../workspace/repos.js";

export const HOOK_MARK = "# codeloom: re-index after commit";
const CACHE_IGNORE = `${CODELOOM_DIR}/${FILES.fingerprints}`;

/** Quote a string as a single POSIX shell word, safe against shell expansion. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface InitResult {
  root: string;
  repos: RepoRef[];
  created: string[];
  /** Repos whose git hook codeloom could not (or would not) install, and why. */
  skipped: Array<{ repo: string; reason: string }>;
}

export type HookResult =
  | { status: "installed"; path: string }
  | { status: "present"; path: string }
  | { status: "skipped"; reason: string };

/** The line the post-commit hook runs: re-index the workspace in the background. */
export function hookLine(wsRoot: string): string {
  return `if command -v codeloom >/dev/null 2>&1; then (cd ${shellQuote(wsRoot)} && codeloom index --quiet) >/dev/null 2>&1 & fi`;
}

/** The repo's hooks folder as git sees it (handles worktrees and core.hooksPath, e.g. husky). */
function hooksDir(repoAbs: string): string {
  const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repoAbs, encoding: "utf8", stdio: "pipe" });
  return resolve(repoAbs, out.trim());
}

const SHELL_SHEBANG = /^#!\s*(\S*\/)?(env\s+)?(sh|bash|zsh)(\s|$)/;

export function installHook(repoAbs: string, wsRoot: string): HookResult {
  let dir: string;
  try {
    dir = hooksDir(repoAbs);
  } catch (err) {
    const msg = err instanceof Error ? (err.message.split("\n").find((l) => /fatal|error/i.test(l)) ?? err.message) : String(err);
    return { status: "skipped", reason: `could not find the git hooks folder (${msg.trim()})` };
  }
  const hook = join(dir, "post-commit");
  let existing = existsSync(hook) ? readFileSync(hook, "utf8") : "";
  if (existing.includes(HOOK_MARK)) return { status: "present", path: hook };
  if (existing.trim() === "") existing = "#!/bin/sh\n";
  else if (!SHELL_SHEBANG.test(existing.split("\n", 1)[0]!)) {
    return { status: "skipped", reason: `the existing hook ${hook} is not a shell script, so codeloom left it unchanged` };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(hook, `${existing.trimEnd()}\n\n${HOOK_MARK}\n${hookLine(wsRoot)}\n`);
  chmodSync(hook, 0o755);
  return { status: "installed", path: hook };
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
  const skipped: InitResult["skipped"] = [];
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
    const hook = installHook(repoAbs, root);
    if (hook.status === "installed") {
      const rel = relative(root, hook.path).split(sep).join("/");
      created.push(rel.startsWith("..") || isAbsolute(rel) ? hook.path : rel);
    }
    if (hook.status === "skipped") skipped.push({ repo: repo.id, reason: hook.reason });
    if (ensureGitignore(repoAbs)) created.push(posix.join(repo.path, ".gitignore"));
  }
  return { root, repos, created, skipped };
}

export function formatInit(r: InitResult): string {
  const lines = [
    `Found ${r.repos.length} repo${r.repos.length === 1 ? "" : "s"} in ${r.root}: ${r.repos.map((x) => x.id).join(", ")}`,
    r.created.length ? "Created or updated:" : "Already set up; nothing changed.",
    ...r.created.map((c) => `  ${c}`),
    ...(r.skipped.length
      ? [
          "",
          "Git hook not installed (the map won't update after each commit):",
          ...r.skipped.map((s) => `  ${s.repo}: ${s.reason}`),
          "  To auto-update, add this line to that repo's post-commit hook (a shell script):",
          `    ${hookLine(r.root)}`,
        ]
      : []),
    "",
    'Next: run "codeloom index" to build the map.',
  ];
  return lines.join("\n");
}
