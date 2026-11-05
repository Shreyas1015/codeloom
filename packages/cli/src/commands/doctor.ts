import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadContext } from "../adapters/run.js";
import { cacheContextKey } from "../indexer/index-repo.js";
import { repoIndexStatus } from "../mcp/tools/workspace.js";
import { DOCTOR_HINT, readJson, writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { progressPath, readProgress } from "../store/progress.js";
import { readEndpoints, readGraph } from "../store/read.js";
import {
  ChainsFileSchema,
  defaultRepoConfig,
  FingerprintsSchema,
  JourneysFileSchema,
  RepoConfigSchema,
  type RepoConfig,
  type RepoRef,
  SummariesFileSchema,
  WorkspaceFileSchema,
} from "../store/schemas.js";
import { listTours, readTour, type StoreWorkspace, tourStaleStops } from "../store/tours.js";
import { compare } from "../util.js";
import { listFiles } from "../workspace/files.js";
import { findWorkspaceRoot, loadWorkspace } from "../workspace/repos.js";
import {
  ensureGitignore,
  ensureMcpEntry,
  hasGitignoreLine,
  hookCommandProblem,
  hookState,
  installHook,
  mcpEntryState,
  mcpInvalidReason,
  mcpInvalidText,
  rewriteHookLine,
} from "./init.js";

export type DoctorStatus = "ok" | "warn" | "error" | "fixed";
/** fix = what --fix would do (warn/error items it can repair) or did (fixed items). */
export interface DoctorItem { check: string; repo?: string; status: DoctorStatus; message: string; fix?: string }
export interface DoctorReport { version: 1; items: DoctorItem[]; summary: { ok: number; warn: number; error: number; fixed: number } }

/** Check order: report items are sorted by this, then by repo id. */
const CHECKS = [
  "git", "workspace", "config", "graph", "endpoints", "cache", "summaries",
  "chains", "journeys", "progress", "tours", "hook", "gitignore", "mcp", "index",
] as const;
type Check = (typeof CHECKS)[number];

/** A readJson / dataError message without the trailing "Run codeloom doctor" hint (we are doctor). */
function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n").filter((l) => l !== DOCTOR_HINT).join("\n");
}

class Doctor {
  readonly items: DoctorItem[] = [];
  constructor(readonly fix: boolean) {}

  add(check: Check, repo: string | undefined, status: DoctorStatus, message: string, fix?: string): void {
    this.items.push({ check, ...(repo !== undefined ? { repo } : {}), status, message, ...(fix ? { fix } : {}) });
  }

  /** A fixable problem: without --fix, a warn item saying what --fix would do; with --fix, run the
   * repair and report it as fixed (or as an error if the repair itself failed). */
  fixable(check: Check, repo: string | undefined, problem: string, fixText: string, repair: () => void): void {
    if (!this.fix) return this.add(check, repo, "warn", problem, fixText);
    try {
      repair();
      this.add(check, repo, "fixed", problem, fixText);
    } catch (err) {
      this.add(check, repo, "error", `${problem}; the repair failed: ${errText(err)}`);
    }
  }

  /** Run one check; anything it throws unexpectedly becomes an error item instead of a crash. */
  guard(check: Check, repo: string | undefined, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.add(check, repo, "error", errText(err));
    }
  }
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

interface WsInfo { root: string; name: string; repos: RepoRef[] | null }

/** The `workspace` check. Returns the root to check and the repos (null when the workspace file is
 * unusable, so no per-repo check can run), or null when there is neither a workspace nor a git repo. */
function checkWorkspace(d: Doctor, start: string): WsInfo | null {
  const wsRoot = findWorkspaceRoot(start);
  if (wsRoot) {
    try {
      const ws = readJson(join(wsRoot, WORKSPACE_FILE), WorkspaceFileSchema, { handWritten: true });
      if (ws) {
        d.add("workspace", undefined, "ok", `${WORKSPACE_FILE}: ${ws.repos.length} repo${ws.repos.length === 1 ? "" : "s"}`);
        return { root: wsRoot, name: ws.name, repos: ws.repos };
      }
    } catch (err) {
      d.add("workspace", undefined, "error", errText(err));
      d.add(
        "workspace", undefined, "warn",
        `The per-repo checks (config, graph, endpoints, cache, summaries, hook, gitignore, index) were skipped until ${WORKSPACE_FILE} is fixed.`,
      );
      return { root: wsRoot, name: "", repos: null };
    }
  }
  try {
    const ws = loadWorkspace(start);
    d.add("workspace", undefined, "warn", `No ${WORKSPACE_FILE} for this repo: run "codeloom init" to set it up.`);
    return { root: ws.root, name: ws.name, repos: ws.repos };
  } catch (err) {
    d.add("workspace", undefined, "error", errText(err));
    return null;
  }
}

/** Returns the repo's config (defaults when missing or invalid) for the cache check's file list. */
function checkConfig(d: Doctor, repoAbs: string, id: string): RepoConfig {
  const path = join(repoAbs, CODELOOM_DIR, FILES.config);
  try {
    const config = readJson(path, RepoConfigSchema);
    if (config) {
      d.add("config", id, "ok", `${CODELOOM_DIR}/${FILES.config} is valid`);
      return config;
    }
    d.fixable("config", id, `${CODELOOM_DIR}/${FILES.config} is missing`, "write the default config", () =>
      writeJsonAtomic(path, defaultRepoConfig()),
    );
  } catch (err) {
    d.add("config", id, "error", errText(err));
  }
  return defaultRepoConfig();
}

function checkIndexed(d: Doctor, check: "graph" | "endpoints", id: string, read: () => unknown): void {
  const file = `${CODELOOM_DIR}/${FILES[check]}`;
  try {
    if (read() === null) d.add(check, id, "warn", `${file} is missing: run "codeloom index"`);
    else d.add(check, id, "ok", `${file} is valid`);
  } catch (err) {
    d.add(check, id, "error", errText(err));
  }
}

/** The `cache` check. Only a corrupt cache (bad JSON or wrong shape) is fixable (deleted). A cache built
 * for another context (codeloom version, cache format or dependencies) is fine as a file: the next index
 * throws it away by itself, so it is reported once, by the `index` check. Returns whether it is outdated. */
function checkCache(d: Doctor, repoAbs: string, id: string, config: RepoConfig): boolean {
  const path = join(repoAbs, CODELOOM_DIR, FILES.fingerprints);
  const file = `${CODELOOM_DIR}/${FILES.fingerprints}`;
  let cache;
  try {
    cache = readJson(path, FingerprintsSchema);
  } catch {
    d.fixable("cache", id, `${file} is corrupt`, "delete it (a git-ignored cache; the next index rebuilds it)", () =>
      rmSync(path, { force: true }),
    );
    return false;
  }
  if (cache === null) {
    d.add("cache", id, "ok", `no ${file} yet`);
    return false;
  }
  const expected = cacheContextKey(loadContext(repoAbs, listFiles(repoAbs, config.ignore)).key);
  if (cache.contextKey !== expected) {
    d.add("cache", id, "ok", `${file} is readable (outdated: see the index check)`);
    return true;
  }
  d.add("cache", id, "ok", `${file} is current`);
  return false;
}

function checkSummaries(d: Doctor, repoAbs: string, id: string): void {
  try {
    const s = readJson(join(repoAbs, CODELOOM_DIR, FILES.summaries), SummariesFileSchema, { handWritten: true });
    const n = s ? Object.keys(s.summaries).length : 0;
    d.add("summaries", id, "ok", s ? `${n} summar${n === 1 ? "y" : "ies"}` : "no summaries yet");
  } catch (err) {
    d.add("summaries", id, "error", errText(err));
  }
}

function checkChainsAndJourneys(d: Doctor, root: string): void {
  try {
    const chains = readJson(join(root, CODELOOM_DIR, FILES.chains), ChainsFileSchema);
    if (chains) d.add("chains", undefined, "ok", `${chains.chains.length} chain${chains.chains.length === 1 ? "" : "s"}`);
    else d.add("chains", undefined, "warn", `${CODELOOM_DIR}/${FILES.chains} is missing: run "codeloom index"`);
  } catch (err) {
    d.add("chains", undefined, "error", errText(err));
  }
  try {
    const file = readJson(join(root, CODELOOM_DIR, FILES.journeys), JourneysFileSchema, { handWritten: true });
    const journeys = file?.journeys ?? [];
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const j of journeys) (seen.has(j.id) ? dups : seen).add(j.id);
    if (dups.size > 0) {
      const ids = [...dups].sort(compare).join(", ");
      return d.add("journeys", undefined, "error", `duplicate journey id ${ids} in ${FILES.journeys}: fix it by hand`);
    }
    const orphaned = journeys.filter((j) => j.status === "orphaned").map((j) => j.name).sort(compare);
    if (orphaned.length > 0) {
      return d.add(
        "journeys", undefined, "warn",
        `${orphaned.length} orphaned journey${orphaned.length === 1 ? "" : "s"} (their chains are gone): ${orphaned.join(", ")}`,
      );
    }
    d.add("journeys", undefined, "ok", `${journeys.length} journey${journeys.length === 1 ? "" : "s"}`);
  } catch (err) {
    d.add("journeys", undefined, "error", errText(err));
  }
}

/** The `progress` check: the personal progress file (outside the workspace) is valid or missing. A corrupt
 * one is an error that --fix never repairs: it holds progress that cannot be regenerated. */
function checkProgress(d: Doctor, ws: StoreWorkspace): void {
  try {
    const path = progressPath(ws);
    const n = Object.keys(readProgress(ws).journeys).length;
    d.add("progress", undefined, "ok", n === 0 ? `no progress yet (${path})` : `${n} journey${n === 1 ? "" : "s"} tracked in ${path}`);
  } catch (err) {
    d.add("progress", undefined, "error", errText(err));
  }
}

/** The `tours` check: every .codeloom/tours/<journeyId>.json is valid; a tour with stops whose file changed
 * since it was written is a warning (the tour still works; re-run write-tour to refresh it). */
function checkTours(d: Doctor, ws: StoreWorkspace): void {
  const ids = listTours(ws.root);
  if (ids.length === 0) return d.add("tours", undefined, "ok", "no tours yet");
  let valid = 0;
  const stale: string[] = [];
  for (const id of ids) {
    try {
      const tour = readTour(ws.root, id);
      if (!tour) continue;
      valid++;
      const n = tourStaleStops(tour, ws).length;
      if (n > 0) stale.push(`${id}: ${n} stop${n === 1 ? "" : "s"} may be out of date`);
    } catch (err) {
      d.add("tours", undefined, "error", errText(err));
    }
  }
  if (stale.length > 0) {
    return d.add("tours", undefined, "warn", `${stale.join("; ")} (run the write-tour prompt again to refresh)`);
  }
  if (valid > 0) d.add("tours", undefined, "ok", `${valid} tour${valid === 1 ? "" : "s"}`);
}

/** `bin`: the codeloom bin running doctor (codeloomBin()), which an installed or repaired hook runs.
 * `pathEnv`: the PATH the hook would search for `codeloom`. */
function checkHook(d: Doctor, repoAbs: string, id: string, wsRoot: string, bin: string | undefined, pathEnv: string): void {
  const state = hookState(repoAbs);
  if (state.status === "present") {
    const problem = hookCommandProblem(state.path, pathEnv);
    if (problem === undefined) return d.add("hook", id, "ok", "post-commit hook installed");
    const message = `post-commit hook cannot run codeloom: ${problem} (the map won't update after each commit)`;
    if (bin === undefined) return d.add("hook", id, "warn", `${message}. Install codeloom (npm i -g codeloom) or edit the hook.`);
    return d.fixable("hook", id, message, `point the hook at ${bin}`, () => rewriteHookLine(state.path, wsRoot, bin));
  }
  if (state.status === "skipped") return d.add("hook", id, "warn", `post-commit hook not installed: ${state.reason}`);
  d.fixable("hook", id, "post-commit hook not installed (the map won't update after each commit)", "install the post-commit hook", () => {
    const r = installHook(repoAbs, wsRoot, bin);
    if (r.status === "skipped") throw new Error(r.reason);
  });
}

function checkGitignore(d: Doctor, repoAbs: string, id: string): void {
  const line = `${CODELOOM_DIR}/${FILES.fingerprints}`;
  if (hasGitignoreLine(repoAbs)) return d.add("gitignore", id, "ok", `.gitignore has ${line}`);
  d.fixable("gitignore", id, `.gitignore is missing the ${line} line`, `add ${line} to .gitignore`, () => {
    ensureGitignore(repoAbs);
  });
}

function checkMcp(d: Doctor, root: string): void {
  const state = mcpEntryState(root);
  switch (state) {
    case "present":
      return d.add("mcp", undefined, "ok", ".mcp.json has the codeloom entry");
    case "kept-custom":
      return d.add("mcp", undefined, "ok", "custom codeloom entry");
    case "invalid":
      return d.add("mcp", undefined, "error", `${mcpInvalidText(mcpInvalidReason(root) ?? "not-json")}: fix it by hand`);
    case "missing-file":
    case "missing-entry":
      return d.fixable(
        "mcp", undefined,
        state === "missing-file" ? ".mcp.json is missing" : ".mcp.json has no codeloom entry",
        "add the codeloom entry to .mcp.json",
        () => {
          ensureMcpEntry(root);
        },
      );
  }
}

const CACHE_OUTDATED =
  'cache will be rebuilt on the next "codeloom index" (codeloom version, cache format or dependencies changed)';

/** The `index` check: one warn per repo at most, also carrying an outdated cache (never a second warn). */
function checkIndex(d: Doctor, repoAbs: string, id: string, cacheOutdated: boolean): void {
  const s = repoIndexStatus(repoAbs, id);
  if (s.indexedCommit === null) {
    // graph.json is committed, so a repo can be indexed with no local record (fresh clone, deleted cache).
    const indexed = existsSync(join(repoAbs, CODELOOM_DIR, FILES.graph));
    return d.add("index", id, "warn", indexed ? "no local index record — run codeloom index" : `not indexed on this machine: run "codeloom index"`);
  }
  if (s.stale) {
    const n = s.changedFiles.length;
    const what = n > 0 ? `${n}${s.truncated ? "+" : ""} changed file${n === 1 ? "" : "s"}` : "HEAD moved";
    const tail = cacheOutdated ? `; ${CACHE_OUTDATED}` : `: run "codeloom index"`;
    return d.add("index", id, "warn", `index is stale (${what})${tail}`);
  }
  if (cacheOutdated) return d.add("index", id, "warn", CACHE_OUTDATED);
  d.add("index", id, "ok", `indexed at ${s.head.slice(0, 7)}`);
}

/** Check codeloom's data files, hooks, .gitignore line and MCP entry. With fix, repair only the safe
 * things (missing config, hook, .gitignore line, MCP entry; a corrupt cache). Hand-written
 * and committed generated files are never touched. Never throws for a bad data file — reports it. */
/** `bin`: the running codeloom bin (the CLI passes codeloomBin()); the hook check and its repair use it.
 * `pathEnv`: the PATH the hook check searches (default: this process's). */
export function runDoctor(start: string, opts: { fix?: boolean; bin?: string; pathEnv?: string }): DoctorReport {
  const d = new Doctor(opts.fix === true);
  if (!gitAvailable()) {
    d.add("git", undefined, "error", "git was not found on PATH. Install git (https://git-scm.com) and try again.");
    return finish(d);
  }
  d.add("git", undefined, "ok", "git found");
  const ws = checkWorkspace(d, start);
  if (!ws) return finish(d);

  const repos = [...(ws.repos ?? [])].sort((a, b) => compare(a.id, b.id));
  const present: Array<{ id: string; abs: string; cacheOutdated: boolean }> = [];
  for (const ref of repos) {
    const abs = join(ws.root, ref.path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      d.add("config", ref.id, "error", `repo folder not found at ${abs}: fix its path in ${WORKSPACE_FILE}`);
      continue;
    }
    const repo = { id: ref.id, abs, cacheOutdated: false };
    present.push(repo);
    const config = checkConfig(d, abs, ref.id);
    checkIndexed(d, "graph", ref.id, () => readGraph(abs));
    checkIndexed(d, "endpoints", ref.id, () => readEndpoints(abs));
    d.guard("cache", ref.id, () => {
      repo.cacheOutdated = checkCache(d, abs, ref.id, config);
    });
    checkSummaries(d, abs, ref.id);
  }
  checkChainsAndJourneys(d, ws.root);
  if (ws.repos !== null) {
    const store: StoreWorkspace = { root: ws.root, name: ws.name, repos: repos.map((ref) => ({ ref, abs: join(ws.root, ref.path) })) };
    checkProgress(d, store);
    d.guard("tours", undefined, () => checkTours(d, store));
  }
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  for (const r of present) d.guard("hook", r.id, () => checkHook(d, r.abs, r.id, ws.root, opts.bin, pathEnv));
  for (const r of present) d.guard("gitignore", r.id, () => checkGitignore(d, r.abs, r.id));
  d.guard("mcp", undefined, () => checkMcp(d, ws.root));
  for (const r of present) d.guard("index", r.id, () => checkIndex(d, r.abs, r.id, r.cacheOutdated));
  return finish(d);
}

function finish(d: Doctor): DoctorReport {
  const rank = (c: string) => CHECKS.indexOf(c as Check);
  const items = d.items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.check) - rank(b.item.check) || compare(a.item.repo ?? "", b.item.repo ?? "") || a.i - b.i)
    .map((x) => x.item);
  const summary = { ok: 0, warn: 0, error: 0, fixed: 0 };
  for (const item of items) summary[item.status]++;
  return { version: 1, items, summary };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line per non-ok item, grouped under its check; a summary line; and a --fix hint when doctor
 * found fixable problems it was not asked to fix. */
export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  let group = "";
  for (const item of r.items) {
    if (item.status === "ok") continue;
    if (item.check !== group) {
      if (lines.length) lines.push("");
      lines.push(`${item.check}:`);
      group = item.check;
    }
    const [first, ...rest] = item.message.split("\n");
    const who = item.repo !== undefined ? `${item.repo}: ` : "";
    const tail = item.fix ? (item.status === "fixed" ? `  (fixed: ${item.fix})` : `  (--fix: ${item.fix})`) : "";
    lines.push(`  ${item.status.padEnd(5)}  ${who}${first}${tail}`);
    for (const l of rest) lines.push(`         ${l}`);
  }
  if (lines.length === 0) lines.push("Everything looks good.");
  const s = r.summary;
  lines.push(
    "",
    `${s.ok} ok, ${plural(s.warn, "warning", "warnings")}, ${plural(s.error, "error", "errors")}, ${s.fixed} fixed`,
  );
  const fixable = r.items.filter((i) => i.fix && (i.status === "warn" || i.status === "error")).length;
  if (fixable > 0) lines.push(`Run "codeloom doctor --fix" to repair ${plural(fixable, "item", "items")}.`);
  return lines.join("\n");
}
