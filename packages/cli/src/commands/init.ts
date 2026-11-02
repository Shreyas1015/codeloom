import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { CodeloomError } from "../errors.js";
import { writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, MCP_FILE, WORKSPACE_FILE } from "../store/paths.js";
import { defaultRepoConfig, type RepoRef, type WorkspaceFile } from "../store/schemas.js";
import { git } from "../workspace/git.js";
import { discoverRepos, findWorkspaceRoot } from "../workspace/repos.js";

export const HOOK_MARK = "# codeloom: re-index after commit";
const CACHE_IGNORE = `${CODELOOM_DIR}/${FILES.fingerprints}`;

/** The .mcp.json entry codeloom installs for itself. */
export const MCP_ENTRY = { command: "npx", args: ["-y", "codeloom", "serve"] } as const;

export type McpFileResult = "added" | "present" | "kept-custom" | "invalid";

/** Structural equality for parsed JSON values (key order doesn't matter). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) => Object.hasOwn(b as object, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** What `ensureMcpEntry` would find in <root>/.mcp.json, without changing anything: no file
 * ("missing-file"), no codeloom entry ("missing-entry"), an identical one ("present"), a different one
 * ("kept-custom"), or a file it cannot safely merge into ("invalid"). */
export type McpEntryState = "missing-file" | "missing-entry" | "present" | "kept-custom" | "invalid";

function inspectMcp(root: string): { state: McpEntryState; obj?: Record<string, unknown>; servers?: Record<string, unknown> } {
  const path = join(root, MCP_FILE);
  if (!existsSync(path)) return { state: "missing-file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "invalid" };
  const obj = parsed as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) return { state: "invalid" };
  const serversObj = (servers as Record<string, unknown> | undefined) ?? {};
  if ("codeloom" in serversObj) {
    return { state: jsonEqual(serversObj.codeloom, MCP_ENTRY) ? "present" : "kept-custom" };
  }
  return { state: "missing-entry", obj, servers: serversObj };
}

/** Read-only: the state of codeloom's entry in <root>/.mcp.json (used by `codeloom doctor`). */
export function mcpEntryState(root: string): McpEntryState {
  return inspectMcp(root).state;
}

/** Merge mcpServers.codeloom into <root>/.mcp.json, keeping every other key/entry.
 * No file → created with just the codeloom entry. Existing identical entry → left untouched,
 * "present". An existing different codeloom entry → left alone, "kept-custom". A top-level value
 * that isn't an object, or an `mcpServers` that exists but isn't an object → untouched, "invalid". */
export function ensureMcpEntry(root: string): McpFileResult {
  const path = join(root, MCP_FILE);
  const found = inspectMcp(root);
  switch (found.state) {
    case "missing-file":
      writeJsonAtomic(path, { mcpServers: { codeloom: MCP_ENTRY } });
      return "added";
    case "missing-entry":
      writeJsonAtomic(path, { ...found.obj, mcpServers: { ...found.servers, codeloom: MCP_ENTRY } });
      return "added";
    default:
      return found.state;
  }
}

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
  /** Result of merging codeloom's entry into the workspace root's .mcp.json. */
  mcp: McpFileResult;
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

type HookPlan =
  | { status: "skipped"; reason: string }
  | { status: "present"; path: string }
  | { status: "missing"; path: string; dir: string; existing: string };

function planHook(repoAbs: string): HookPlan {
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
  return { status: "missing", path: hook, dir, existing };
}

/** Read-only: whether the post-commit hook is installed ("present"), could be ("missing"), or
 * codeloom would not install it ("skipped", with the reason). Used by `codeloom doctor`. */
export function hookState(repoAbs: string):
  | { status: "present" | "missing"; path: string }
  | { status: "skipped"; reason: string } {
  const plan = planHook(repoAbs);
  return plan.status === "missing" ? { status: "missing", path: plan.path } : plan;
}

export function installHook(repoAbs: string, wsRoot: string): HookResult {
  const plan = planHook(repoAbs);
  if (plan.status !== "missing") return plan;
  const { dir, existing, path: hook } = plan;
  mkdirSync(dir, { recursive: true });
  const prefix = existing.trim() === "" ? "" : `${existing.trimEnd()}\n\n`;
  writeFileSync(hook, `${prefix}${HOOK_MARK}\n${hookLine(wsRoot)}\n`);
  chmodSync(hook, 0o755);
  return { status: "installed", path: hook };
}

/** Read-only: whether the repo's .gitignore already has the fingerprints cache line. */
export function hasGitignoreLine(repoAbs: string): boolean {
  const path = join(repoAbs, ".gitignore");
  return existsSync(path) && readFileSync(path, "utf8").split(/\r?\n/).includes(CACHE_IGNORE);
}

export function ensureGitignore(repoAbs: string): boolean {
  const path = join(repoAbs, ".gitignore");
  if (hasGitignoreLine(repoAbs)) return false;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
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
  const enclosingWorkspaceRoot = single ? findWorkspaceRoot(root) : null;
  const insideWorkspace = single && enclosingWorkspaceRoot !== null;
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
  // .mcp.json belongs at the workspace root: when a single repo sits inside an existing workspace,
  // that's the enclosing root, not the repo itself.
  const mcpRoot = insideWorkspace ? enclosingWorkspaceRoot! : root;
  const mcp = ensureMcpEntry(mcpRoot);
  return { root, repos, created, present, skipped, mcp };
}

function mcpLine(mcp: McpFileResult): string {
  switch (mcp) {
    case "added":
      return "Added codeloom to .mcp.json";
    case "present":
      return "codeloom already in .mcp.json";
    case "kept-custom":
      return "kept your own codeloom entry in .mcp.json";
    case "invalid":
      return `.mcp.json is not valid JSON — add this entry by hand: ${JSON.stringify({ mcpServers: { codeloom: MCP_ENTRY } })}`;
  }
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
    mcpLine(r.mcp),
    "",
    'Next: run "codeloom index" to build the map.',
  ];
  return lines.join("\n");
}
