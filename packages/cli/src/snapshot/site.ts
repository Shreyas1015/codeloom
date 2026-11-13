// The publish step's trusted half (design spec §5): validates an untrusted build artifact's data/
// folder (validate.ts), copies THIS codeloom version's own dashboard assets next to it (never anything
// from the artifact), fills in `pr`/`repoSlug`, and renders the PR block from the now-trusted
// data/review.json with the same renderer `codeloom review` uses locally.
//
// Nothing is written to `outDir` until validation has passed — a refused artifact never leaves a
// partial site (validateSnapshotData throws before any fs write below runs).

import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
}

export interface SiteResult {
  reviewMd: string;
  body?: string;
  comment?: string;
  /** false when the manifest was tooLarge: no dashboard assets were copied, so there is nothing at
   * `outDir` a reviewer could open as a working snapshot. */
  hosted: boolean;
}

/** Splices `reviewMd` into the PR body read from `bodyFile` (review/pr-body.ts), if given. */
function spliceBody(bodyFile: string | undefined, reviewMd: string): { body?: string; comment?: string } {
  if (!bodyFile) return {};
  const existing = readFileSync(bodyFile, "utf8");
  const spliced = splicePrBody(existing, reviewMd);
  return "body" in spliced ? { body: spliced.body } : { comment: spliced.comment };
}

/** `cpSync` throws when `from` and `to` are the same path — true for `codeloom snapshot` (no
 * --data-only), where the data was just written straight into `<out>/data` and `dataDir` IS
 * `<outDir>/data`: a no-op there, since the file is already exactly where it needs to be. */
function copyRecursive(from: string, to: string): void {
  if (resolve(from) === resolve(to)) return;
  cpSync(from, to, { recursive: true });
}

export function buildSnapshotSite(opts: SiteOptions): SiteResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // Validate first: throws (writing nothing) before any of the writes below ever run.
  const manifest = validateSnapshotData(opts.dataDir, { maxBytes, expectedHead: opts.expectedHead });

  const review = JSON.parse(readFileSync(join(opts.dataDir, "review.json"), "utf8")) as Review;

  const patchedManifest: SnapshotManifest = {
    ...manifest,
    ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
    ...(opts.repoSlug !== undefined ? { repoSlug: opts.repoSlug } : {}),
  };

  const outData = join(opts.outDir, "data");
  mkdirSync(outData, { recursive: true });
  for (const file of manifest.files) {
    if (file === "manifest.json") continue; // written below, patched
    copyRecursive(join(opts.dataDir, file), join(outData, file));
  }
  writeFileSync(join(outData, "manifest.json"), JSON.stringify(patchedManifest));

  const hosted = manifest.tooLarge === undefined;
  if (hosted) {
    // This codeloom version's own build — never anything from the artifact (design spec §5: "no HTML or
    // script from the PR reaches <owner>.github.io").
    const assetsDir = locateDashboardAssets();
    for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
      copyRecursive(join(assetsDir, entry.name), join(opts.outDir, entry.name));
    }
  }

  const reviewMd = renderReviewMarkdown(review, {
    link: opts.link,
    builtFor: manifest.head.slice(0, 7),
    tooLarge: manifest.tooLarge,
  });

  return { reviewMd, hosted, ...spliceBody(opts.bodyFile, reviewMd) };
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
}

/** The PR block for a build (not just a publish/validation) that failed before producing a Review at
 * all (design spec §6): just the error line pointing at the failed run, plus the last good snapshot's
 * link when one is known. */
export function buildFailedBlock(opts: FailedSiteOptions): { reviewMd: string; body?: string; comment?: string } {
  mkdirSync(opts.outDir, { recursive: true });

  let previous: { link: string; builtFor: string } | undefined;
  if (opts.previousManifest && opts.link) {
    const prev = JSON.parse(readFileSync(opts.previousManifest, "utf8")) as { head: string };
    previous = { link: opts.link, builtFor: prev.head.slice(0, 7) };
  }

  const reviewMd = renderReviewMarkdown(null, {
    error: `codeloom review map: the build failed — see the run: ${opts.runUrl}`,
    previous,
  });

  return { reviewMd, ...spliceBody(opts.bodyFile, reviewMd) };
}
