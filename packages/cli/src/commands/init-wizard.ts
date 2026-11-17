import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { runClaudeHeadless as realRunClaudeHeadless } from "../claude/headless.js";
import { CodeloomError } from "../errors.js";
import { nameJourneysPromptText } from "../mcp/prompts.js";
import { readJson, writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, MCP_FILE, WORKSPACE_FILE } from "../store/paths.js";
import { defaultRepoConfig, type RepoRef, type WorkspaceFile, WorkspaceFileSchema } from "../store/schemas.js";
import { VERSION } from "../version.js";
import { git } from "../workspace/git.js";
import { discoverRepos, findWorkspaceRoot } from "../workspace/repos.js";
import {
  ensureGitignore,
  ensureMcpEntry,
  hasGitignoreLine,
  hookState,
  installHook,
  type McpFileResult,
  mcpEntryState,
  mcpPinnedVersion,
  pinnedMcpEntry,
  replaceMcpEntry,
} from "./init.js";
import { runIndex } from "./index-cmd.js";

/** The only MCP tools the headless "name journeys" run needs — list_chains to read the unnamed chains,
 * save_journeys to save the groups (design spec §1 step 4: "allowedTools limited to codeloom's MCP
 * tools"). Never Bash, never any other tool: Claude needs no other calls to do this. */
const NAME_JOURNEYS_ALLOWED_TOOLS = ["mcp__codeloom__list_chains", "mcp__codeloom__save_journeys"];

// ---------------------------------------------------------------------------------------------------
// Ask: the interactive surface the wizard talks to. readlineAsk is the real one (cli.ts); tests use a
// fake that answers from a fixed script, so no test ever waits on real stdin.
// ---------------------------------------------------------------------------------------------------

export interface Ask {
  confirm(q: string, def: boolean): Promise<boolean>;
  pickMany(q: string, items: { label: string; checked: boolean }[]): Promise<boolean[]>;
  /** Releases the underlying input/output (readlineAsk's readline interface), so the process can exit
   * normally after the wizard finishes. A no-op for a fake Ask that owns nothing. */
  close(): void;
}

/** A real, interactive Ask over readline/promises. `input`/`output` default to the process's own
 * stdin/stderr (stderr, not stdout: question text must never land in piped stdout — cli.ts prints the
 * final summary to stdout separately). cli.ts calls this with no arguments and must call `.close()` in a
 * finally, or the open readline interface keeps the process alive after an interactive run.
 *
 * EOF/Ctrl+D while a question is in flight: readline/promises' own `question()` promise can be left
 * unsettled forever when the input ends before a line is read (a known gap in the underlying module),
 * which would otherwise make the wizard hang silently. This races every in-flight question against the
 * interface's own 'close' event and resolves with the question's default (confirm) or the defaults it
 * offered (pickMany) when the input closed first — the same "take the default" behaviour as --yes, for
 * whichever single question was interrupted. */
export function readlineAsk(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Ask {
  const rl = createInterface({ input, output });
  let closed = false;
  const closedPromise = new Promise<void>((resolveClosed) => {
    rl.once("close", () => {
      closed = true;
      resolveClosed();
    });
  });

  /** Ask one question; `onLine` turns the answer into a result, `onClosed` supplies it when the input
   * ends (or was already closed) before any line came back. */
  async function ask<T>(prompt: string, onLine: (line: string) => T, onClosed: () => T): Promise<T> {
    if (closed) return onClosed();
    let pending: Promise<string>;
    try {
      pending = rl.question(prompt);
    } catch {
      return onClosed(); // question() after close can throw synchronously, depending on the Node version
    }
    const outcome = await Promise.race([
      pending.then((line) => ({ done: false as const, line })),
      closedPromise.then(() => ({ done: true as const, line: "" })),
    ]);
    return outcome.done ? onClosed() : onLine(outcome.line);
  }

  return {
    confirm(q, def) {
      const hint = def ? "Y/n" : "y/N";
      return ask(
        `${q} [${hint}] `,
        (line) => {
          const trimmed = line.trim().toLowerCase();
          if (trimmed === "") return def;
          return trimmed === "y" || trimmed === "yes";
        },
        () => def,
      );
    },
    pickMany(q, items) {
      output.write(`${q}\n`);
      items.forEach((item, i) => output.write(`  [${item.checked ? "x" : " "}] ${i + 1}. ${item.label}\n`));
      const defaults = () => items.map((it) => it.checked);
      return ask(
        "Toggle by number (space separated), or press Enter to keep the defaults above: ",
        (line) => {
          const picks = defaults();
          const trimmed = line.trim();
          if (trimmed !== "") {
            for (const tok of trimmed.split(/\s+/)) {
              const n = Number(tok);
              if (Number.isInteger(n) && n >= 1 && n <= items.length) picks[n - 1] = !picks[n - 1];
            }
          }
          return picks;
        },
        defaults,
      );
    },
    close() {
      rl.close();
    },
  };
}

/** Whether `codeloom init` should behave as if `--yes` was given: it was, or stdin/stdout are not a TTY
 * (a script or CI pipe, where there is no one to answer questions — spec §1, "`--yes` takes every
 * default (CI, scripts)"). Read-only; cli.ts uses this to compute the `yes` it passes to runInitWizard. */
export function effectiveYes(
  yes: boolean | undefined,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): boolean {
  return yes === true || !(input as { isTTY?: boolean }).isTTY || !(output as { isTTY?: boolean }).isTTY;
}

// ---------------------------------------------------------------------------------------------------
// Repo discovery with remote/branch info, and the pure dedup rule (step 1).
// ---------------------------------------------------------------------------------------------------

export interface RepoCandidate {
  id: string;
  path: string;
  remote?: string;
  branch?: string;
  defaultBranch?: string;
}

/** A remote URL safe to show: an http(s) URL loses its user and token (`https://user:token@host/x` →
 * `https://host/x`); any other `scheme://user:password@` keeps the user but loses the password; scp-style
 * `git@host:x` is left as it is. */
export function displayRemote(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@/i.exec(url);
  if (!m) return url;
  const [whole, scheme, userinfo] = m as unknown as [string, string, string];
  const rest = url.slice(whole.length);
  if (/^https?:\/\/$/i.test(scheme)) return `${scheme}${rest}`;
  const colon = userinfo.indexOf(":");
  return colon === -1 ? url : `${scheme}${userinfo.slice(0, colon)}@${rest}`;
}

/** origin's URL, credentials stripped (displayRemote) — it is shown in the picker and the summary; repos are
 * grouped by it, which stripping does not change for copies of one repo. */
function repoRemote(repoAbs: string): string | undefined {
  try {
    const url = displayRemote(git(repoAbs, ["remote", "get-url", "origin"]).trim());
    return url || undefined;
  } catch {
    return undefined;
  }
}

function repoBranch(repoAbs: string): string | undefined {
  try {
    const b = git(repoAbs, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return b === "HEAD" ? undefined : b; // detached HEAD
  } catch {
    return undefined;
  }
}

const ORIGIN_REF_PREFIX = "refs/remotes/origin/";

function repoDefaultBranch(repoAbs: string): string | undefined {
  try {
    const ref = git(repoAbs, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
    return ref.startsWith(ORIGIN_REF_PREFIX) ? ref.slice(ORIGIN_REF_PREFIX.length) : undefined;
  } catch {
    return undefined;
  }
}

function discoverCandidates(root: string): RepoCandidate[] {
  return discoverRepos(root).map((r) => {
    const abs = join(root, r.path);
    return { id: r.id, path: r.path, remote: repoRemote(abs), branch: repoBranch(abs), defaultBranch: repoDefaultBranch(abs) };
  });
}

/** Repos sharing the same (non-empty) remote URL are duplicates of one checkout: only the one on its
 * default branch (else the first, input order) is pre-selected; every other repo always is (design spec
 * §1 step 1: "repos with the same git remote URL are grouped and only the one on the default branch
 * (else the first) is pre-selected"). Pure and order-preserving: result[i] answers for repos[i]. */
export function defaultSelection(repos: Array<{ path: string; remote?: string; branch?: string; defaultBranch?: string }>): boolean[] {
  const selected = new Array<boolean>(repos.length).fill(false);
  const groups = new Map<string, number[]>();
  repos.forEach((r, i) => {
    if (!r.remote) {
      selected[i] = true;
      return;
    }
    const list = groups.get(r.remote) ?? [];
    list.push(i);
    groups.set(r.remote, list);
  });
  for (const indices of groups.values()) {
    const onDefault = indices.find((i) => repos[i]!.branch !== undefined && repos[i]!.branch === repos[i]!.defaultBranch);
    selected[onDefault ?? indices[0]!] = true;
  }
  return selected;
}

// ---------------------------------------------------------------------------------------------------
// Keep-local: exclude files instead of .gitignore (step 2, "keep local").
// ---------------------------------------------------------------------------------------------------

function gitPath(repoAbs: string, rel: string): string {
  return resolve(repoAbs, git(repoAbs, ["rev-parse", "--git-path", rel]).trim());
}

/** Adds any of `lines` not already present to `<repoAbs>/.git/info/exclude` (never `.gitignore`: this is
 * local-only and never committed). Returns whether anything was written. */
function ensureExcludeLines(repoAbs: string, lines: string[]): boolean {
  const path = gitPath(repoAbs, "info/exclude");
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingLines = new Set(current.split(/\r?\n/));
  const missing = lines.filter((l) => !existingLines.has(l));
  if (missing.length === 0) return false;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  writeFileSync(path, `${prefix}${missing.join("\n")}\n`);
  return true;
}

function hasExcludeLine(repoAbs: string, line: string): boolean {
  const path = gitPath(repoAbs, "info/exclude");
  return existsSync(path) && readFileSync(path, "utf8").split(/\r?\n/).includes(line);
}

/** Whether `repoAbs` already looks set up for "commit" (hook or .gitignore line present) or "local" (the
 * .codeloom/ exclude line present), so a re-run can skip asking again. "none" when neither is there yet. */
function repoSetupMode(repoAbs: string): "commit" | "local" | "none" {
  if (hookState(repoAbs).status === "present" || hasGitignoreLine(repoAbs)) return "commit";
  if (hasExcludeLine(repoAbs, `${CODELOOM_DIR}/`)) return "local";
  return "none";
}

function relFromRoot(root: string, absPath: string): string {
  const rel = relative(root, absPath).split(sep).join("/");
  return rel.startsWith("..") || isAbsolute(rel) ? absPath : rel;
}

// ---------------------------------------------------------------------------------------------------
// The wizard itself.
// ---------------------------------------------------------------------------------------------------

export type SetupMode = "commit" | "local";

export interface InitWizardResult {
  root: string;
  /** The repos now in codeloom.workspace.json. */
  repos: RepoRef[];
  /** Repos that were found but not selected (usually duplicate checkouts of the same remote). */
  skipped: Array<{ id: string; path: string; remote?: string }>;
  mode: SetupMode;
  /** Every file created or updated this run (workspace file, per-repo config, hook, .gitignore / exclude
   * line, .mcp.json). Empty on a re-run that finds nothing left to do. */
  created: string[];
  index?: { repos: number };
  /** "skipped" when Claude was not connected (not found, or the user said no). */
  mcp: McpFileResult | "skipped";
  claude: {
    found: boolean;
    connected: boolean;
    namedJourneys?: { ran: boolean; exitCode: number };
    /** The name-journeys prompt text, set only when Claude was not found (so the user can run it
       themselves — codeloom never runs Claude it cannot ask first, and it cannot ask a Claude that
       is not there). */
    prompt?: string;
  };
  dashboardOpened: boolean;
}

export async function runInitWizard(
  dir: string,
  opts: {
    ask: Ask;
    yes?: boolean;
    bin?: string;
    claude?: string | null;
    run?: typeof realRunClaudeHeadless;
    openDashboard?: (root: string) => Promise<void>;
  },
): Promise<InitWizardResult> {
  const start = resolve(dir);
  if (!existsSync(start) || !statSync(start).isDirectory()) throw new CodeloomError(`Folder not found: ${start}`);
  const yes = opts.yes === true;
  const created: string[] = [];

  // ---- Step 1: repos --------------------------------------------------------------------------
  const existingWsRoot = findWorkspaceRoot(start);
  let root: string;
  let selected: RepoRef[];
  let skipped: InitWizardResult["skipped"] = [];

  if (existingWsRoot) {
    root = existingWsRoot;
    const ws = readJson(join(root, WORKSPACE_FILE), WorkspaceFileSchema, { handWritten: true });
    selected = ws ? ws.repos : [];
  } else {
    root = start;
    const candidates = discoverCandidates(root);
    if (candidates.length === 0) {
      throw new CodeloomError(`No git repos found in ${root}. Run "codeloom init" inside a repo, or in a folder that contains repos.`);
    }
    const defaults = defaultSelection(candidates);
    const items = candidates.map((c, i) => ({ label: c.remote ? `${c.id}  —  ${c.remote}` : c.id, checked: defaults[i]! }));
    const picks = yes ? defaults : await opts.ask.pickMany("Repos found. Pick the ones codeloom should map:", items);
    selected = candidates.filter((_, i) => picks[i]).map((c) => ({ id: c.id, path: c.path }));
    skipped = candidates.filter((_, i) => !picks[i]).map((c) => ({ id: c.id, path: c.path, remote: c.remote }));
    if (selected.length === 0) throw new CodeloomError("No repos selected; nothing to set up.");

    const single = selected.length === 1 && selected[0]!.path === ".";
    const ws: WorkspaceFile = {
      version: 1,
      name: single ? selected[0]!.id : basename(root),
      repos: [...selected].sort((a, b) => a.id.localeCompare(b.id)),
      links: [],
    };
    writeJsonAtomic(join(root, WORKSPACE_FILE), ws);
    created.push(WORKSPACE_FILE);
    selected = ws.repos;
  }

  // ---- Step 2: commit or keep local -----------------------------------------------------------
  const single = selected.length === 1 && selected[0]!.path === ".";
  const repoAbsOf = (r: RepoRef) => join(root, r.path);
  const existingModes = selected.map((r) => repoSetupMode(repoAbsOf(r)));
  let mode: SetupMode;
  if (selected.length > 0 && existingModes.every((m) => m === "commit")) {
    mode = "commit";
  } else if (selected.length > 0 && existingModes.every((m) => m === "local")) {
    mode = "local";
  } else {
    const defaultCommit = single;
    mode = yes
      ? defaultCommit
        ? "commit"
        : "local"
      : (await opts.ask.confirm("Commit codeloom's files with your code?", defaultCommit))
        ? "commit"
        : "local";
  }

  for (const repo of selected) {
    const repoAbs = repoAbsOf(repo);
    const configPath = join(repoAbs, CODELOOM_DIR, FILES.config);
    if (!existsSync(configPath)) {
      writeJsonAtomic(configPath, defaultRepoConfig());
      created.push(posix.join(repo.path, CODELOOM_DIR, FILES.config));
    }
    if (mode === "commit") {
      const hook = installHook(repoAbs, root, opts.bin);
      if (hook.status === "installed") created.push(relFromRoot(root, hook.path));
      if (ensureGitignore(repoAbs)) created.push(posix.join(repo.path, ".gitignore"));
    } else {
      const lines = [`${CODELOOM_DIR}/`];
      if (repo.path === "." && existsSync(join(repoAbs, WORKSPACE_FILE))) lines.push(WORKSPACE_FILE);
      if (ensureExcludeLines(repoAbs, lines)) created.push(`${posix.join(repo.path, ".git/info/exclude")} (local only)`);
    }
  }

  // ---- Step 3: index ----------------------------------------------------------------------------
  const indexed = await runIndex(root);

  // ---- Step 4: Claude Code ------------------------------------------------------------------------
  let claudeConnected = false;
  let mcpResult: McpFileResult | undefined;
  let namedJourneys: InitWizardResult["claude"]["namedJourneys"];
  let prompt: string | undefined;

  if (opts.claude) {
    const state = mcpEntryState(root);
    const pinned = state === "kept-custom" ? mcpPinnedVersion(root) : undefined;
    if (pinned !== undefined && pinned !== VERSION) {
      // The wizard's own entry, pinned to another codeloom: offer to move it to this one.
      claudeConnected = true;
      mcpResult = "kept-custom";
      const update = yes ? true : await opts.ask.confirm(`Update Claude Code's codeloom from codeloom@${pinned} to codeloom@${VERSION}?`, true);
      if (update) mcpResult = replaceMcpEntry(root, pinnedMcpEntry());
    } else if (state === "present" || state === "kept-custom") {
      claudeConnected = true;
      mcpResult = state;
    } else {
      const connect = yes ? true : await opts.ask.confirm("Connect Claude Code?", true);
      if (connect) {
        mcpResult = ensureMcpEntry(root, pinnedMcpEntry());
        claudeConnected = mcpResult === "added" || mcpResult === "present";
        if (mcpResult === "added") created.push(relFromRoot(root, join(root, MCP_FILE)));
      }
    }

    if (claudeConnected) {
      const nameNow = yes ? false : await opts.ask.confirm("Let Claude name your journeys now? (uses your Claude Code)", false);
      if (nameNow) {
        const runFn = opts.run ?? realRunClaudeHeadless;
        const result = await runFn({
          prompt: nameJourneysPromptText(),
          allowedTools: NAME_JOURNEYS_ALLOWED_TOOLS,
          cwd: root,
          claudeBin: opts.claude,
        });
        namedJourneys = { ran: true, exitCode: result.exitCode };
      }
    }
  } else {
    prompt = nameJourneysPromptText();
  }

  // ---- Step 5: dashboard --------------------------------------------------------------------------
  // Opening the dashboard starts a server that keeps the process alive (same as `codeloom dashboard`):
  // under --yes (or a non-interactive run) the default must be NO, exactly like "name journeys now",
  // or `codeloom init --yes` would never exit. formatInitWizard prints the "codeloom dashboard" hint
  // whenever it was not opened.
  const wantDashboard = yes ? false : await opts.ask.confirm("Open the dashboard?", true);
  let dashboardOpened = false;
  if (wantDashboard && opts.openDashboard) {
    await opts.openDashboard(root);
    dashboardOpened = true;
  }

  return {
    root,
    repos: selected,
    skipped,
    mode,
    created,
    index: { repos: indexed.repos.length },
    mcp: mcpResult ?? "skipped",
    claude: {
      found: !!opts.claude,
      connected: claudeConnected,
      ...(namedJourneys ? { namedJourneys } : {}),
      ...(prompt ? { prompt } : {}),
    },
    dashboardOpened,
  };
}

/** A short summary of what the wizard did and the next command, for cli.ts to print (to stdout — unlike
 * the questions themselves, this is the result, not a prompt, so it is safe to pipe). The dashboard hint
 * always appears when the dashboard was not opened (including the --yes/non-interactive default of no),
 * and the name-journeys prompt (when Claude was not found) appears as its own block after it. */
export function formatInitWizard(r: InitWizardResult): string {
  const lines: Array<string | undefined> = [
    `${r.repos.length} repo${r.repos.length === 1 ? "" : "s"} mapped in ${r.root}: ${r.repos.map((x) => x.id).join(", ")}`,
    r.skipped.length > 0 ? `Not selected (duplicate checkouts): ${r.skipped.map((s) => s.id).join(", ")}` : undefined,
    `Setup: ${r.mode === "commit" ? "committed with your code" : "kept local (.git/info/exclude)"}`,
    r.index ? `Indexed ${r.index.repos} repo${r.index.repos === 1 ? "" : "s"}.` : undefined,
    r.claude.found
      ? r.claude.connected
        ? `Claude Code connected (.mcp.json).${
            !r.claude.namedJourneys?.ran
              ? ""
              : r.claude.namedJourneys.exitCode === 0
                ? " Journeys named."
                : ` Claude could not name journeys (exit ${r.claude.namedJourneys.exitCode}); run /mcp__codeloom__name-journeys in Claude Code.`
          }`
        : "Claude Code was found but not connected."
      : "Claude Code was not found on PATH.",
    r.dashboardOpened ? "Dashboard opened." : 'Next: run "codeloom dashboard" any time to open the map.',
    r.claude.prompt ? `\nRun this in Claude Code to name your journeys:\n\n${r.claude.prompt}` : undefined,
  ];
  return lines.filter((l): l is string => l !== undefined).join("\n");
}
