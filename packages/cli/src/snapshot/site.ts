// The publish step's trusted half (design spec §5): validates an untrusted build artifact's data/
// folder (validate.ts), copies THIS codeloom version's own dashboard assets next to it (never anything
// from the artifact), fills in `pr`/`repoSlug`, and renders the PR block from the now-trusted
// data/review.json with the same renderer `codeloom review` uses locally.
//
// Nothing is EVER deleted here (security review C1': a non-empty `outDir` is refused outright, not
// cleared — round 1's resetOutDir/resetOutDirFully were an rmSync of the caller's own `--out`, which for
// `codeloom snapshot --out .` would delete the working tree, `.git` included). Nothing is written to
// `outDir` until outDir's own safety check AND validation have both passed, and (security review I1')
// not until the PR block has actually rendered successfully either — a refused/failed render never
// leaves a partial site.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodeloomError, dataError } from "../errors.js";
import { renderReviewMarkdown } from "../review/markdown.js";
import { splicePrBody } from "../review/pr-body.js";
import type { Review } from "../review/types.js";
import { locateDashboardAssets } from "../web/assets.js";
import { DEFAULT_MAX_BYTES, type SnapshotManifest } from "./write.js";
import { validateSnapshotData } from "./validate.js";

export interface SiteOptions {
  /** The validated artifact's data/ folder (untrusted until validateSnapshotData passes it). */
  dataDir: string;
  /** The site's root: data/, the dashboard's own assets (unless tooLarge) and review.md's caller write
   * their outputs here. Must be empty or not exist (security review C1') — never touched before outDir's
   * own safety check, validation, AND rendering have all passed. */
  outDir: string;
  /** The event's own head SHA; must equal data/manifest.json's `head` (never the artifact's own say-so). */
  expectedHead: string;
  /** Default 25 MB (DEFAULT_MAX_BYTES). */
  maxBytes?: number;
  pr?: number;
  repoSlug?: string;
  /** The hosted snapshot's URL; added to the PR block as "Open the full review map" (ignored when the
   * manifest is tooLarge: there is nothing to link to). */
  link?: string;
  /** A file holding the PR's current description; when given, the rendered block is spliced into it
   * (review/pr-body.ts) and returned as `body` (or `comment` over GitHub's body limit). */
  bodyFile?: string;
  /** GitHub Pages isn't enabled for this repo (design spec §6, workflow coordination): the rendered
   * block gets a one-line note instead of `link`'s "Open the full review map" line — nothing is hosted,
   * even though data/ and the dashboard assets are still written here (Pages may be enabled later). */
  pagesDisabled?: boolean;
}

export interface SiteResult {
  reviewMd: string;
  body?: string;
  comment?: string;
  /** false when the manifest was tooLarge: no dashboard assets were copied, so there is nothing at
   * `outDir` a reviewer could open as a working snapshot. */
  hosted: boolean;
}

/** Splices `reviewMd` into the PR body read from `bodyFile` (review/pr-body.ts), if given — minus one
 * trailing newline, the one `gh … -q .body` adds (final review m6). Exported so
 * commands/snapshot.ts can reuse it for a *refused* artifact too (security review I2: a refusal must
 * still reach body.md/comment.md when --body was given, not just review.md). splicePrBody (m2) always
 * returns `body` (the spliced body, or — over the limit — the old body with any stale inline block
 * stripped) plus `comment` only when the block had to move out of the body. */
export function spliceIntoBody(bodyFile: string | undefined, reviewMd: string): { body?: string; comment?: string } {
  if (!bodyFile) return {};
  const raw = readFileSync(bodyFile, "utf8");
  // Final review m6: the publish workflow reads the body with `gh pr view --json body -q .body`, which
  // always adds one "\n" — kept, it would grow the PR description by one newline on every run.
  const existing = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const spliced = splicePrBody(existing, reviewMd);
  return { body: spliced.body, comment: spliced.comment };
}

function sameResolved(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** `cpSync`/`copyFileSync` throw when `from` and `to` are the same path — true for `codeloom snapshot`
 * (no --data-only), where the data was just written straight into `<out>/data` and `dataDir` IS
 * `<outDir>/data`: a no-op there, since the file is already exactly where it needs to be. */
function copyDataFile(from: string, to: string): void {
  if (sameResolved(from, to)) return;
  // A plain file-to-file copy, never recursive (security review C1): validateSnapshotData has already
  // proven `manifest.files` is exactly the flat, safely-named set of files actually on disk in
  // `dataDir`, so `from` can only ever be a single file — but copyFileSync enforces that even if some
  // future change to validate.ts ever let something else through.
  copyFileSync(from, to);
}

/** This codeloom version's own dashboard asset entries (a trusted source, never the artifact) — may be
 * a file or a folder (e.g. assets/), so a recursive copy is right here. */
function copyAssetEntry(from: string, to: string): void {
  if (sameResolved(from, to)) return;
  cpSync(from, to, { recursive: true });
}

/** Security review C1' (Critical): `outDir` must be empty or not exist — refused otherwise, nothing
 * deleted, nothing added. Round 1's fix (resetOutDir/resetOutDirFully) rmSync'd whatever was already
 * there, which for a non-empty `--out` (a checked-out gh-pages folder with real files, or `--out .` on
 * an ordinary working tree) deleted README.md/keep/notes.txt/even `.git` — exactly what this replaces.
 * `ownDataDir`, when given, is the ONE legitimate exception: `codeloom snapshot` (no --data-only)
 * writes data/*.json straight into `<out>/data` and then calls buildSnapshotSite with that SAME `<out>`
 * as both `dataDir`'s parent and `outDir` — so `outDir` already, legitimately, contains exactly its own
 * `data/` folder by the time this runs. Any OTHER entry (or a `data/` that isn't `ownDataDir`) is still
 * refused. */
export function assertOutDirUsable(outDir: string, ownDataDir?: string): void {
  if (!existsSync(outDir)) return;
  if (!statSync(outDir).isDirectory()) throw dataError("--out exists and is not a folder.");
  const allowed = ownDataDir !== undefined && sameResolved(join(outDir, "data"), ownDataDir) ? new Set(["data"]) : new Set<string>();
  const entries = readdirSync(outDir);
  if (entries.some((e) => !allowed.has(e))) {
    throw dataError("--out must be empty or not exist — refusing to touch a non-empty folder.");
  }
}

export function buildSnapshotSite(opts: SiteOptions): SiteResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // C1': outDir's own safety first — before even looking at the artifact. Throws (a dataError, exit 2)
  // and touches nothing.
  assertOutDirUsable(opts.outDir, opts.dataDir);
  // Validate the artifact: throws (writing nothing) before any of the writes below ever run.
  const manifest = validateSnapshotData(opts.dataDir, { maxBytes, expectedHead: opts.expectedHead });

  // I1': render BEFORE touching outDir at all, and treat any failure here as a plain refusal (never an
  // uncaught crash after some files have already been copied) — defense in depth underneath validate.ts
  // and review/schema.ts's own checks, for whatever those don't anticipate.
  let review: Review;
  let hosted: boolean;
  let reviewMd: string;
  try {
    review = JSON.parse(readFileSync(join(opts.dataDir, "review.json"), "utf8")) as Review;
    hosted = manifest.tooLarge === undefined;
    reviewMd = renderReviewMarkdown(review, {
      link: opts.link,
      builtFor: manifest.head.slice(0, 7),
      tooLarge: manifest.tooLarge,
      pagesDisabled: opts.pagesDisabled,
    });
  } catch (err) {
    if (err instanceof CodeloomError) throw err;
    throw new CodeloomError("codeloom could not render the review map for this snapshot.");
  }

  // Only now, after outDir's safety, the artifact's validation, AND a successful render, is outDir
  // touched at all.
  // Built field by field from the already-validated manifest only — never a raw spread (I1'b): an
  // unknown/extra key on `manifest` (there shouldn't be one, since validateSnapshotData already builds
  // it this same way, but this is the last line of defense right before it's written back out).
  const patchedManifest: SnapshotManifest = {
    version: manifest.version,
    codeloom: manifest.codeloom,
    head: manifest.head,
    base: manifest.base,
    ...(manifest.baseRef !== undefined ? { baseRef: manifest.baseRef } : {}),
    builtAt: manifest.builtAt,
    files: manifest.files,
    omitted: manifest.omitted,
    bytes: manifest.bytes,
    ...(manifest.tooLarge !== undefined ? { tooLarge: manifest.tooLarge } : {}),
    ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
    ...(opts.repoSlug !== undefined ? { repoSlug: opts.repoSlug } : {}),
  };

  const outData = join(opts.outDir, "data");
  mkdirSync(outData, { recursive: true });
  // manifest.files is, by now, exactly the validated on-disk set (validate.ts), each a flat, safely-
  // named file — never anything that could address outside dataDir (security review C1).
  for (const file of manifest.files) {
    if (file === "manifest.json") continue; // written below, patched
    copyDataFile(join(opts.dataDir, file), join(outData, file));
  }
  writeFileSync(join(outData, "manifest.json"), JSON.stringify(patchedManifest));

  if (hosted) {
    // This codeloom version's own build — never anything from the artifact (design spec §5: "no HTML or
    // script from the PR reaches <owner>.github.io").
    const assetsDir = locateDashboardAssets();
    for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
      copyAssetEntry(join(assetsDir, entry.name), join(opts.outDir, entry.name));
    }
  }

  return { reviewMd, hosted, ...spliceIntoBody(opts.bodyFile, reviewMd) };
}

export interface FailedSiteOptions {
  /** Created (even though nothing else may be written there): the CLI always has an out/ to write
   * review.md (and body.md/comment.md) into, failed build or not. Must be empty or not exist (C1'). */
  outDir: string;
  /** The failed build/publish run's own URL, shown instead of trusting its error text (design spec §6). */
  runUrl: string;
  /** Path to the last good snapshot's own data/manifest.json (e.g. fetched from gh-pages pr-<n>/data/
   * manifest.json), so the block can still point reviewers at a working map. */
  previousManifest?: string;
  /** The last good snapshot's own URL; shown together with `previousManifest`'s head. Ignored alone
   * (with no previousManifest there's nothing to confirm that link is still the right commit). */
  link?: string;
  bodyFile?: string;
  /** Same as SiteOptions.pagesDisabled: valid in --failed mode too (workflow coordination) — nothing
   * is hosted regardless of whether the build itself failed. */
  pagesDisabled?: boolean;
}

/** The last good snapshot's own head SHA from `path` (a fetched `data/manifest.json`), or null when the
 * file is missing, unreadable, not valid JSON, or its `head` isn't a 40-character hex SHA — a PR's first
 * failed build has no previous snapshot at all, and none of that is a crash (security review I4). */
function previousHead(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { head?: unknown };
    return typeof parsed.head === "string" && /^[0-9a-f]{40}$/.test(parsed.head) ? parsed.head : null;
  } catch {
    return null;
  }
}

/** The PR block for a build (not just a publish/validation) that failed before producing a Review at
 * all (design spec §6): just the error line pointing at the failed run, plus the last good snapshot's
 * link when one is known. */
export function buildFailedBlock(opts: FailedSiteOptions): { reviewMd: string; body?: string; comment?: string } {
  // C1': no data/ concept in this mode at all, so no exception — outDir must be empty or not exist.
  assertOutDirUsable(opts.outDir);

  let previous: { link: string; builtFor: string } | undefined;
  if (opts.previousManifest && opts.link) {
    const head = previousHead(opts.previousManifest);
    if (head) previous = { link: opts.link, builtFor: head.slice(0, 7) };
  }

  // I1': render before touching outDir (here, just mkdirSync — there's no data/assets to copy in this
  // mode, but the same "never leave a partial write behind a crash" principle applies).
  const reviewMd = renderReviewMarkdown(null, {
    error: `codeloom review map: the build failed — see the run: ${opts.runUrl}`,
    previous,
    pagesDisabled: opts.pagesDisabled,
  });

  mkdirSync(opts.outDir, { recursive: true });
  return { reviewMd, ...spliceIntoBody(opts.bodyFile, reviewMd) };
}
