import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { CodeloomError } from "../errors.js";
import { writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { defaultRepoConfig, type RepoRef, type WorkspaceFile } from "../store/schemas.js";
import { git } from "../workspace/git.js";
import { discoverRepos, findWorkspaceRoot } from "../workspace/repos.js";

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
  /** Repos whose hook was already installed; nothing to do, but still worth showing so a repo is
   * never silently missing from the output. */
  present: string[];
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
  return resolve(repoAbs, git(repoAbs, ["rev-parse", "--git-path", "hooks"]).trim());
}

/** husky v9 points core.hooksPath at `.husky/_`, a folder of generated wrapper scripts that end
 * in `exit $c` (so anything appended there never runs) and that husky rewrites on every install.
 * When that's the resolved hooks dir, install into the sibling `.husky/post-commit` instead. */
function huskyParent(dir: string): string | null {
  return basename(dir) === "_" && basename(dirname(dir)) === ".husky" ? dirname(dir) : null;
}

/** Resolve symlinks in whatever portion of `path` already exists, leaving a not-yet-created tail
 * as is, so a not-yet-created hooks folder can still be compared reliably. */
function realish(path: string): string {
  let p = resolve(path);
  const tail: string[] = [];
  while (!existsSync(p)) {
    const parent = dirname(p);
    if (parent === p) break;
    tail.unshift(basename(p));
    p = parent;
  }
  try {
    p = realpathSync(p);
  } catch {
    // Leave it as is (e.g. permission denied on an ancestor).
  }
  return tail.length ? join(p, ...tail) : p;
}

/** True when `dir` sits outside both the repo's working tree and its (possibly shared, e.g. a
 * worktree's) git directory — installing a hook there would affect other repos or checkouts too. */
function isSharedOutsideRepo(repoAbs: string, dir: string): boolean {
  const toplevel = realish(resolve(repoAbs, git(repoAbs, ["rev-parse", "--show-toplevel"]).trim()));
  const commonDir = realish(resolve(repoAbs, git(repoAbs, ["rev-parse", "--git-common-dir"]).trim()));
  const real = realish(dir);
  const within = (base: string) => real === base || real.startsWith(base + sep);
  return !within(toplevel) && !within(commonDir);
}

const SHELL_SHEBANG = /^#!\s*(\S*\/)?(env\s+)?(sh|bash|zsh)(\s|$)/;

export function installHook(repoAbs: string, wsRoot: string): HookResult {
  let dir: string;
  try {
    dir = hooksDir(repoAbs);
  } catch (err) {
    if (err instanceof CodeloomError) throw err;
    const msg = err instanceof Error ? (err.message.split("\n").find((l) => /fatal|error/i.test(l)) ?? err.message) : String(err);
    return { status: "skipped", reason: `could not find the git hooks folder (${msg.trim()})` };
  }
  const husky = huskyParent(dir);
  if (husky) {
    dir = husky;
  } else if (isSharedOutsideRepo(repoAbs, dir)) {
    return { status: "skipped", reason: `hooks folder is shared outside this repo (${dir})` };
  }
  const hook = join(dir, "post-commit");
  let existing = existsSync(hook) ? readFileSync(hook, "utf8") : "";
  if (existing.includes(HOOK_MARK)) return { status: "present", path: hook };
  if (!husky) {
    // husky's own hook files are plain scripts husky itself runs with sh, with no shebang
    // requirement; only check and default a shebang for a hook git invokes directly.
    if (existing.trim() === "") existing = "#!/bin/sh\n";
    else if (!SHELL_SHEBANG.test(existing.split("\n", 1)[0]!)) {
      return { status: "skipped", reason: `the existing hook ${hook} is not a shell script, so codeloom left it unchanged` };
    }
  }
  mkdirSync(dir, { recursive: true });
  const prefix = existing.trim() === "" ? "" : `${existing.trimEnd()}\n\n`;
  writeFileSync(hook, `${prefix}${HOOK_MARK}\n${hookLine(wsRoot)}\n`);
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
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new CodeloomError(`Folder not found: ${root}`);
  const repos = discoverRepos(root);
  if (repos.length === 0) {
    throw new CodeloomError(
      `No git repos found in ${root}. Run "codeloom init" inside a repo, or in a folder that contains repos.`,
    );
  }
  const created: string[] = [];
  const present: string[] = [];
  const skipped: InitResult["skipped"] = [];
  const single = repos.length === 1 && repos[0]!.path === ".";
  // A single repo gets a workspace file too, so its id (package.json name, else folder) is saved and
  // stays stable if the folder is renamed — unless it already sits inside a workspace.
  const insideWorkspace = single && findWorkspaceRoot(root) !== null;
  if (!insideWorkspace && !existsSync(join(root, WORKSPACE_FILE))) {
    const ws: WorkspaceFile = { version: 1, name: single ? repos[0]!.id : basename(root), repos, links: [] };
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
    if (hook.status === "present") present.push(repo.id);
    if (hook.status === "skipped") skipped.push({ repo: repo.id, reason: hook.reason });
    if (ensureGitignore(repoAbs)) created.push(posix.join(repo.path, ".gitignore"));
  }
  return { root, repos, created, present, skipped };
}

export function formatInit(r: InitResult): string {
  const lines = [
    `Found ${r.repos.length} repo${r.repos.length === 1 ? "" : "s"} in ${r.root}: ${r.repos.map((x) => x.id).join(", ")}`,
    r.created.length ? "Created or updated:" : "Already set up; nothing changed.",
    ...r.created.map((c) => `  ${c}`),
    ...r.present.map((id) => `  ${id}: hook already installed`),
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
