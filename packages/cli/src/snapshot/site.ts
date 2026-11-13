// The publish step's trusted half (design spec §5): validates an untrusted build artifact's data/
// folder (validate.ts), copies THIS codeloom version's own dashboard assets next to it (never anything
// from the artifact), fills in `pr`/`repoSlug`, and renders the PR block from the now-trusted
// data/review.json with the same renderer `codeloom review` uses locally.
//
// Nothing is written to `outDir` until validation has passed — a refused artifact never leaves a
// partial site (validateSnapshotData throws before any fs write below runs).

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
   * their outputs here. Never touched before validation passes. */
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

/** Splices `reviewMd` into the PR body read from `bodyFile` (review/pr-body.ts), if given. Exported so
 * commands/snapshot.ts can reuse it for a *refused* artifact too (security review I2: a refusal must
 * still reach body.md/comment.md when --body was given, not just review.md). splicePrBody (m2) always
 * returns `body` (the spliced body, or — over the limit — the old body with any stale inline block
 * stripped) plus `comment` only when the block had to move out of the body. */
export function spliceIntoBody(bodyFile: string | undefined, reviewMd: string): { body?: string; comment?: string } {
  if (!bodyFile) return {};
  const existing = readFileSync(bodyFile, "utf8");
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

/** `outDir` is entirely codeloom's own output — nothing the caller should have hand-placed there.
 * Before writing, any leftover content from an earlier run (a stale dashboard asset from an older
 * codeloom version, a data key a newer snapshot no longer has, ...) is cleared first, so the published
 * site never mixes old and new content (security review m4). The one exception: when `dataDir` IS
 * `outDir/data` (`codeloom snapshot`'s own local run, no --data-only), that folder is the very data
 * this call is about to read from and patch in place — left alone. */
function resetOutDir(outDir: string, dataDir: string): void {
  if (!existsSync(outDir)) return;
  const dataIsOwnData = sameResolved(join(outDir, "data"), dataDir);
  for (const entry of readdirSync(outDir)) {
    if (dataIsOwnData && entry === "data") continue;
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
}

/** Same idea as resetOutDir, for buildFailedBlock: nothing there is protected (there is no data/ to
 * read from in this mode), so a stale outDir is simply cleared in full before review.md is written. */
function resetOutDirFully(outDir: string): void {
  if (!existsSync(outDir)) return;
  for (const entry of readdirSync(outDir)) rmSync(join(outDir, entry), { recursive: true, force: true });
}

export function buildSnapshotSite(opts: SiteOptions): SiteResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // Validate first: throws (writing nothing) before any of the writes below ever run.
  const manifest = validateSnapshotData(opts.dataDir, { maxBytes, expectedHead: opts.expectedHead });

  // Only now, after validation has fully passed, is anything about `outDir` touched.
  resetOutDir(opts.outDir, opts.dataDir);

  const review = JSON.parse(readFileSync(join(opts.dataDir, "review.json"), "utf8")) as Review;

  const patchedManifest: SnapshotManifest = {
    ...manifest,
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

  const hosted = manifest.tooLarge === undefined;
  if (hosted) {
    // This codeloom version's own build — never anything from the artifact (design spec §5: "no HTML or
    // script from the PR reaches <owner>.github.io").
    const assetsDir = locateDashboardAssets();
    for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
      copyAssetEntry(join(assetsDir, entry.name), join(opts.outDir, entry.name));
    }
  }

  const reviewMd = renderReviewMarkdown(review, {
    link: opts.link,
    builtFor: manifest.head.slice(0, 7),
    tooLarge: manifest.tooLarge,
    pagesDisabled: opts.pagesDisabled,
  });

  return { reviewMd, hosted, ...spliceIntoBody(opts.bodyFile, reviewMd) };
}

export interface FailedSiteOptions {
  /** Created (even though nothing else may be written there): the CLI always has an out/ to write
   * review.md (and body.md/comment.md) into, failed build or not. */
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
  resetOutDirFully(opts.outDir);
  mkdirSync(opts.outDir, { recursive: true });

  let previous: { link: string; builtFor: string } | undefined;
  if (opts.previousManifest && opts.link) {
    const head = previousHead(opts.previousManifest);
    if (head) previous = { link: opts.link, builtFor: head.slice(0, 7) };
  }

  const reviewMd = renderReviewMarkdown(null, {
    error: `codeloom review map: the build failed — see the run: ${opts.runUrl}`,
    previous,
    pagesDisabled: opts.pagesDisabled,
  });

  return { reviewMd, ...spliceIntoBody(opts.bodyFile, reviewMd) };
}
