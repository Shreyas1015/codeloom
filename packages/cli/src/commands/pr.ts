import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dataError } from "../errors.js";
import { buildReview, reviewTarget } from "../review/build.js";
import { checkedOn, renderReviewDraft } from "../review/markdown.js";
import { loadPrReview, type SavedPrReview } from "../review/saved.js";
import { buildPrSummary, checksThis, type PrSummary } from "../review/summary.js";
import { buildSnapshotSite } from "../snapshot/site.js";
import { writeSnapshotData } from "../snapshot/write.js";
import { CODELOOM_DIR } from "../store/paths.js";
import { locateDashboardAssets } from "../web/assets.js";
import { resolveCommit } from "../workspace/diff.js";
import { loadWorkspace } from "../workspace/repos.js";
import { repoAbsPath } from "../workspace/registry.js";
import { CHECK_PR_QUESTION, letClaudeCheck, notSavedLine, type ReviewRunDeps } from "./review.js";

// `codeloom pr`: one command on a PR branch, one page that shows what the PR does. It indexes, builds the review
// (as `codeloom review`), lets Claude check it under the same consent rules (`--check`, or a yes on a terminal;
// never otherwise), writes a local snapshot of the PR — whose This PR page opens on the summary — serves it on
// 127.0.0.1 and opens the browser there. The block to paste into the PR description is printed too.

/** The bases tried, in order, when `--base` is not given. */
export const DEFAULT_BASES = ["origin/main", "main", "master"] as const;
/** Where `codeloom pr` keeps its snapshots: `<ws>/.codeloom/pr/<short head>/` — the workspace folder, or a group's
 * data folder (`<home>/groups/<group>-<hash>/`), so nothing is written into a group's repo (never committed). */
export const PR_DIR = "pr";
/** Written first into every folder `codeloom pr` fills (so even a run that fails half way leaves a folder the next run
 * may replace), with exactly this text. */
export const PR_OWNED_MARKER = ".codeloom-pr";
export const PR_OWNED_TEXT = "Written by codeloom pr. This whole folder is replaced on the next run.\n";
/** How many marker-owned snapshot folders `.codeloom/pr/` keeps; older ones are removed after a successful run. */
export const PR_KEEP = 5;

export interface PrOptions {
  /** Default: origin/main, else main, else master (DEFAULT_BASES), in the reviewed repo. */
  base?: string;
  /** In a folder of separate repos: the repo the pull request is in. */
  repo?: string;
  /** Let Claude check the PR now, without asking (the consent). */
  check?: boolean;
  /** Check again even though Claude already saved a review of this head (also the consent), replacing it. */
  recheck?: boolean;
  /** false (`--no-open`): print the URL, open no browser. */
  open?: boolean;
  /** Port for the local page (default: one the OS picks). */
  port?: number;
  /** Where to write the snapshot. Default `<ws>/.codeloom/pr/<short head>/`. */
  out?: string;
}

export interface PrDeps extends ReviewRunDeps {
  /** `codeloom index` (runIndex). */
  index: (start: string) => Promise<unknown>;
  /** Opens `url` in the browser (dashboard.ts openBrowser; tests record it). */
  open: (url: string) => void;
  /** Serves the snapshot folder on 127.0.0.1 (web/static-site.ts serveStaticSite). */
  serve: (dir: string, port: number | undefined) => Promise<{ url: string; close(): Promise<void> }>;
}

export interface PrResult {
  /** The snapshot folder. */
  outDir: string;
  /** The This PR page (`<server>/#/review`); undefined when the snapshot was too large to host. */
  url?: string;
  summary: PrSummary;
  /** Stops the local server. */
  close(): Promise<void>;
}

/** The first of origin/main, main, master that git resolves in `dir`; else a usage error asking for --base. */
export function defaultBaseRef(dir: string): string {
  for (const ref of DEFAULT_BASES) if (resolveCommit(dir, ref) !== undefined) return ref;
  throw dataError(`No --base given, and none of ${DEFAULT_BASES.join(", ")} exists in ${dir}. Pass --base <ref>.`);
}

/** `dir` holds codeloom pr's marker, with exactly codeloom's text. */
function hasMarker(dir: string): boolean {
  try {
    const marker = join(dir, PR_OWNED_MARKER);
    return lstatSync(marker).isFile() && readFileSync(marker, "utf8") === PR_OWNED_TEXT;
  } catch {
    return false;
  }
}

/** The entries a `codeloom pr` snapshot folder can hold: the dashboard's own files, data/ and the marker. */
function snapshotEntries(): Set<string> {
  return new Set([...readdirSync(locateDashboardAssets()), "data", PR_OWNED_MARKER]);
}

/** Whether `dir` may take a fresh snapshot: absent or empty ("fresh"), or a non-empty folder codeloom owns, then
 * replaced whole ("replace") — `owned` (the default folder under .codeloom/pr/), or one with codeloom's marker that
 * holds nothing but what a snapshot writes. Anything else (a symlink, a file, a folder with something of yours in it)
 * is refused (exit 2) and left untouched: codeloom never deletes a folder it does not own. */
function outDirState(dir: string, owned: boolean): "fresh" | "replace" {
  let st;
  try {
    st = lstatSync(dir); // lstat: a symlink (even a dangling one) is seen as itself, never followed
  } catch {
    return "fresh";
  }
  if (st.isSymbolicLink()) throw dataError(`${dir} is a symlink — refusing to write the PR snapshot through it.`);
  if (!st.isDirectory()) throw dataError(`${dir} exists and is not a folder.`);
  const entries = readdirSync(dir);
  if (entries.length === 0) return "fresh";
  if (owned) return "replace";
  const allowed = snapshotEntries();
  if (hasMarker(dir) && entries.every((e) => allowed.has(e))) return "replace";
  throw dataError(`--out must be empty, not exist, or be a folder "codeloom pr" wrote (and nothing else) — refusing to touch ${dir}.`);
}

/** `p` with symlinks resolved as far as it exists (macOS /var → /private/var), the rest appended. */
function realish(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realish(parent), basename(abs));
}

const isWithin = (dir: string, path: string): boolean => {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** `--out` must not be inside a workspace repo (a site written into your code), except under a .codeloom folder. */
function refuseOutInRepo(start: string, out: string): void {
  const ws = loadWorkspace(start);
  const target = realish(out);
  for (const repo of ws.repos) {
    const abs = realish(repoAbsPath(ws.root, repo));
    if (!isWithin(abs, target)) continue;
    if (isWithin(realish(join(ws.root, CODELOOM_DIR)), target) || isWithin(realish(join(abs, CODELOOM_DIR)), target)) continue;
    throw dataError(
      `--out ${out} is inside repo "${repo.id}" (${abs}): codeloom pr would write a web page into your code. Pick a folder outside the repos, or leave --out off (the default is ${CODELOOM_DIR}/${PR_DIR}/<short head>/).`,
    );
  }
}

/** After a successful run: removes all but the PR_KEEP newest marker-owned folders in `.codeloom/pr/` (newest by
 * marker time; `current` always stays). Anything without codeloom's marker is never touched. */
function pruneOld(prDir: string, current: string): void {
  let names: string[];
  try {
    if (lstatSync(prDir).isSymbolicLink()) return;
    names = readdirSync(prDir);
  } catch {
    return;
  }
  const owned = names
    .map((n) => join(prDir, n))
    .filter((d) => {
      try {
        return lstatSync(d).isDirectory() && hasMarker(d);
      } catch {
        return false;
      }
    })
    .map((d) => ({ d, t: d === current ? Infinity : lstatSync(join(d, PR_OWNED_MARKER)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { d } of owned.slice(PR_KEEP)) rmSync(d, { recursive: true, force: true });
}

/** `<ws>/.codeloom/pr/`, with a "*" .gitignore so nothing in it is ever committed. Refused when it is a symlink. */
function ensurePrDir(root: string): string {
  const dir = join(root, CODELOOM_DIR, PR_DIR);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw dataError(`${dir} is a symlink — refusing to write the PR snapshot through it.`);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore) || readFileSync(ignore, "utf8") !== "*\n") writeFileSync(ignore, "*\n");
  return dir;
}

/** `codeloom pr`. Claude is started only with `--check` or a yes to CHECK_PR_QUESTION on a terminal with claude on
 * PATH, and never when Claude already saved a review of this same head/base/repo (that one is reused). Returns once
 * the page is served; the caller keeps the process alive until Ctrl+C and calls `close`. */
export async function runPrCommand(start: string, opts: PrOptions, deps: PrDeps): Promise<PrResult> {
  const warn = deps.warn ?? deps.print;
  // A --out codeloom may not touch is refused before any work is done.
  if (opts.out !== undefined) {
    refuseOutInRepo(start, opts.out);
    outDirState(resolve(opts.out), false);
  }

  await deps.index(start);
  deps.print("Indexed.");

  const target = reviewTarget(start, opts.repo !== undefined ? { repoId: opts.repo } : {});
  const base = opts.base ?? defaultBaseRef(target.dir);
  if (opts.base === undefined) deps.print(`Comparing with ${base}${target.repoId !== "" ? ` (repo "${target.repoId}")` : ""}.`);
  const review = buildReview(start, base, opts.repo !== undefined ? { repoId: opts.repo } : {});

  // Claude's check: a saved review of this very diff is reused (unless --recheck); otherwise only with consent.
  const loadSaved = (): SavedPrReview | null => {
    const saved = loadPrReview(start, review.head, warn);
    return checksThis(review, saved) ? saved : null;
  };
  const saved = loadSaved();
  let checked: SavedPrReview | null = opts.recheck ? null : saved;
  if (checked !== null) {
    const on = checkedOn(checked.savedAt);
    deps.print(`Reusing Claude's review from ${on || "earlier"} (run with --recheck to check again).`);
  } else {
    const consent =
      opts.check === true || opts.recheck === true || (deps.interactive && deps.claude !== null && (await deps.confirm(CHECK_PR_QUESTION, false)));
    if (consent) {
      const result = await letClaudeCheck(start, review, deps);
      const fresh = result.checked !== null && checksThis(review, result.checked) && result.checked.savedAt !== saved?.savedAt;
      if (result.ran && !fresh) warn(notSavedLine(result));
      // A check that saved nothing (or could not run) leaves any earlier review of this head in place.
      checked = fresh ? result.checked : saved;
    } else if (deps.claude === null && deps.interactive) {
      deps.print('Claude Code is not on PATH, so this is codeloom\'s draft (not checked by Claude). With Claude Code installed, run "codeloom pr --check".');
    }
  }

  // The local snapshot of this PR: the folder is marked as codeloom's first, so a run that fails half way still
  // leaves one the next run may replace.
  const { root } = loadWorkspace(start);
  const owned = opts.out === undefined;
  const prDir = join(root, CODELOOM_DIR, PR_DIR);
  const outDir = owned ? join(ensurePrDir(root), review.head.slice(0, 7)) : resolve(opts.out!);
  if (outDirState(outDir, owned) === "replace") rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, PR_OWNED_MARKER), PR_OWNED_TEXT);
  const manifest = await writeSnapshotData(start, { baseRef: base, outDir, review, warn });
  const site = buildSnapshotSite({ dataDir: join(outDir, "data"), outDir, expectedHead: manifest.head, summary: "keep", allowEntries: [PR_OWNED_MARKER] });
  pruneOld(prDir, outDir);

  const summary = buildPrSummary(review, checked);
  deps.print(renderReviewDraft(review, { checked }));
  if (!site.hosted) {
    deps.print(`\nThis PR is too large to show as a page (over the snapshot size cap). The block above is the summary.`);
    return { outDir, summary, close: async () => {} };
  }
  const server = await deps.serve(outDir, opts.port);
  const url = `${server.url}#/review`;
  if (opts.open !== false) deps.open(url);
  deps.print(`\nThis PR: ${url}  (Ctrl+C to stop)`);
  return { outDir, url, summary, close: () => server.close() };
}
