import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeloomError } from "../errors.js";
import { writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, MCP_FILE, WORKSPACE_FILE } from "../store/paths.js";
import { defaultRepoConfig, type RepoRef, type WorkspaceFile } from "../store/schemas.js";
import { VERSION } from "../version.js";
import { cliRootFrom } from "../web/assets.js";
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

/** Why an "invalid" .mcp.json cannot be merged into. */
export type McpInvalidReason = "not-json" | "not-object" | "servers-not-object";

/** The plain-language problem for an McpInvalidReason (shared by init and doctor). */
export function mcpInvalidText(reason: McpInvalidReason): string {
  switch (reason) {
    case "not-json":
      return ".mcp.json is not valid JSON";
    case "not-object":
      return ".mcp.json is not a JSON object";
    case "servers-not-object":
      return '"mcpServers" in .mcp.json is not an object';
  }
}

interface McpInspection {
  state: McpEntryState;
  reason?: McpInvalidReason;
  obj?: Record<string, unknown>;
  servers?: Record<string, unknown>;
}

function inspectMcp(root: string): McpInspection {
  const path = join(root, MCP_FILE);
  if (!existsSync(path)) return { state: "missing-file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "invalid", reason: "not-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "invalid", reason: "not-object" };
  const obj = parsed as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return { state: "invalid", reason: "servers-not-object" };
  }
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

/** Read-only: why <root>/.mcp.json is "invalid", or undefined when it is not. */
export function mcpInvalidReason(root: string): McpInvalidReason | undefined {
  return inspectMcp(root).reason;
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

/** The two GitHub workflow templates `codeloom init --github` installs (design spec §1, §5, §6). */
const GITHUB_WORKFLOW_FILES = ["codeloom-review-build.yml", "codeloom-review-publish.yml"] as const;

/** packages/cli/templates/github, resolved the same way from src/ (tests), dist/ (tsc output) or the
 * bundled dist/bin.js (the published package) as locateDashboardAssets resolves dist/dashboard. */
function githubTemplatesDir(): string {
  return join(cliRootFrom(dirname(fileURLToPath(import.meta.url))), "templates", "github");
}

/** The template's own content with `{{version}}` replaced by the running codeloom version, so the
 * installed workflow always runs this codeloom (`npx codeloom@<version>`), never whatever "latest"
 * happens to resolve to later. */
function renderGithubTemplate(name: string): string {
  const raw = readFileSync(join(githubTemplatesDir(), name), "utf8");
  return raw.split("{{version}}").join(VERSION);
}

export type GithubWorkflowStatus = "created" | "present" | "kept-custom";
export interface GithubWorkflowResult {
  /** Repo-relative, forward-slashed, e.g. ".github/workflows/codeloom-review-build.yml". */
  path: string;
  status: GithubWorkflowStatus;
}

/** Writes one workflow template into `<root>/.github/workflows/<name>`, unless a file is already there:
 * identical to what codeloom would write now ("present", left alone — no point rewriting the same
 * bytes), or different ("kept-custom" — the user's own edits are never overwritten; rerun with the
 * file removed to pick up a newer template). */
function writeGithubWorkflow(root: string, name: string): GithubWorkflowResult {
  const rel = posix.join(".github", "workflows", name);
  const path = join(root, ".github", "workflows", name);
  const rendered = renderGithubTemplate(name);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
    return { path: rel, status: "created" };
  }
  return { path: rel, status: readFileSync(path, "utf8") === rendered ? "present" : "kept-custom" };
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
  /** Why, when `mcp` is "invalid". */
  mcpInvalid?: McpInvalidReason;
  /** The codeloom bin the hook runs, when init was given one. */
  bin?: string;
  /** The two GitHub workflow templates (design spec §1, §5, §6), only when `--github` was given. */
  github?: GithubWorkflowResult[];
}

export type HookResult =
  | { status: "installed"; path: string }
  | { status: "present"; path: string }
  | { status: "skipped"; reason: string };

/** The codeloom bin that is running (`process.argv[1]`, made absolute), when it is an executable file —
 * the command the post-commit hook should run, so it works without codeloom on PATH (an `npx` or local
 * install). Undefined otherwise. */
export function codeloomBin(argv1: string | undefined = process.argv[1]): string | undefined {
  if (!argv1) return undefined;
  const abs = resolve(argv1);
  return isExecutable(abs) ? abs : undefined;
}

/** The line the post-commit hook runs: re-index the workspace in the background with `bin` (the absolute
 * path of the codeloom that ran init) while it is still there, else with `codeloom` on PATH, else
 * nothing — never `npx`, which could download in a hook. */
export function hookLine(wsRoot: string, bin?: string): string {
  const run = (cmd: string) => `(cd ${shellQuote(wsRoot)} && ${cmd} index --quiet) >/dev/null 2>&1 &`;
  const onPath = `command -v codeloom >/dev/null 2>&1; then ${run("codeloom")}`;
  if (bin === undefined) return `if ${onPath} fi`;
  return `if [ -x ${shellQuote(bin)} ]; then ${run(shellQuote(bin))} elif ${onPath} fi`;
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

export function installHook(repoAbs: string, wsRoot: string, bin?: string): HookResult {
  const plan = planHook(repoAbs);
  if (plan.status !== "missing") return plan;
  const { dir, existing, path: hook } = plan;
  mkdirSync(dir, { recursive: true });
  const prefix = existing.trim() === "" ? "" : `${existing.trimEnd()}\n\n`;
  writeFileSync(hook, `${prefix}${HOOK_MARK}\n${hookLine(wsRoot, bin)}\n`);
  chmodSync(hook, 0o755);
  return { status: "installed", path: hook };
}

/** Undo shellQuote. */
function shellUnquote(word: string): string {
  return word.slice(1, -1).split(`'\\''`).join("'");
}

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
}

/** Whether `cmd` is an executable file in one of `pathEnv`'s folders (what `command -v` finds). */
function onPath(cmd: string, pathEnv: string): boolean {
  return pathEnv.split(delimiter).some((dir) => dir !== "" && isExecutable(join(dir, cmd)));
}

/** Read-only, for `codeloom doctor` (H7): why the installed hook at `hookPath` cannot run codeloom — its
 * bin (`[ -x '<bin>' ]`) is gone and `codeloom` is not on `pathEnv` — or undefined when it can (or when
 * codeloom's line was edited into something this check does not recognise). */
export function hookCommandProblem(hookPath: string, pathEnv: string = process.env.PATH ?? ""): string | undefined {
  const lines = readFileSync(hookPath, "utf8").split(/\r?\n/);
  const line = lines[lines.indexOf(HOOK_MARK) + 1] ?? "";
  const bins = [...line.matchAll(/\[ -x ('(?:[^']|'\\'')*') \]/g)].map((m) => shellUnquote(m[1]!));
  const pathFallback = line.includes("command -v codeloom");
  if (bins.length === 0 && !pathFallback) return undefined;
  if (bins.some(isExecutable)) return undefined;
  if (pathFallback && onPath("codeloom", pathEnv)) return undefined;
  const missing = bins.map((b) => `${b} is missing`);
  return [...missing, pathFallback ? "codeloom is not on PATH" : undefined].filter(Boolean).join(" and ");
}

/** Replace codeloom's line (the one after HOOK_MARK) in an installed hook with hookLine(wsRoot, bin);
 * the rest of the hook is left as it is. */
export function rewriteHookLine(hookPath: string, wsRoot: string, bin: string): void {
  const lines = readFileSync(hookPath, "utf8").split("\n");
  const at = lines.indexOf(HOOK_MARK);
  if (at === -1) throw new Error(`${hookPath} has no codeloom line`);
  lines[at + 1] = hookLine(wsRoot, bin);
  writeFileSync(hookPath, lines.join("\n"));
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

/** `bin`: the codeloom bin the hook should run (the CLI passes codeloomBin()); without it the hook
 * runs `codeloom` from PATH. `github`: also install the two PR review map workflow templates (design
 * spec §1, §5, §6) into `<dir>/.github/workflows/`, pinned to this running codeloom version. */
export function runInit(dir: string, opts: { bin?: string; github?: boolean } = {}): InitResult {
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
    const hook = installHook(repoAbs, root, opts.bin);
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
  const mcpInvalid = mcp === "invalid" ? mcpInvalidReason(mcpRoot) : undefined;
  let github: GithubWorkflowResult[] | undefined;
  if (opts.github) {
    github = GITHUB_WORKFLOW_FILES.map((name) => writeGithubWorkflow(root, name));
    for (const g of github) if (g.status === "created") created.push(g.path);
  }
  return {
    root, repos, created, present, skipped, mcp,
    ...(mcpInvalid ? { mcpInvalid } : {}),
    ...(opts.bin ? { bin: opts.bin } : {}),
    ...(github ? { github } : {}),
  };
}

function mcpLine(mcp: McpFileResult, reason: McpInvalidReason = "not-json"): string {
  switch (mcp) {
    case "added":
      return "Added codeloom to .mcp.json";
    case "present":
      return "codeloom already in .mcp.json";
    case "kept-custom":
      return "kept your own codeloom entry in .mcp.json";
    case "invalid":
      return `${mcpInvalidText(reason)} — add this entry by hand: ${JSON.stringify({ mcpServers: { codeloom: MCP_ENTRY } })}`;
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
          `    ${hookLine(r.root, r.bin)}`,
        ]
      : []),
    ...(r.github?.some((g) => g.status === "kept-custom")
      ? [
          "",
          ...r.github
            .filter((g) => g.status === "kept-custom")
            .map((g) => `kept your own ${g.path} (customised; not overwritten)`),
        ]
      : []),
    "",
    mcpLine(r.mcp, r.mcpInvalid),
    "",
    'Next: run "codeloom index" to build the map.',
  ];
  return lines.join("\n");
}
