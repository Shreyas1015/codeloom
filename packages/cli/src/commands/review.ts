import { dataError } from "../errors.js";
import { buildReview } from "../review/build.js";
import { renderReviewMarkdown } from "../review/markdown.js";
import type { Review } from "../review/types.js";

export type ReviewFormat = "markdown" | "json";

export interface ReviewOptions {
  base: string;
  format?: ReviewFormat;
  link?: string;
}

/** --format: "markdown" (default) or "json"; anything else is a usage error (exit 2). */
export function parseReviewFormat(raw: string | undefined): ReviewFormat {
  if (raw === undefined) return "markdown";
  if (raw === "markdown" || raw === "json") return raw;
  throw dataError(`--format must be "markdown" or "json", got "${raw}".`);
}

/** `codeloom review --base <ref>`: the PR block (spec §4) for `merge-base(<ref>, HEAD)..HEAD` — the same
 * renderer `codeloom snapshot-site` uses for a hosted PR's description, so what you see locally is what
 * lands on the PR. `--format json` prints the `Review` model instead (what later tasks' `snapshot` writes
 * to `review.json`). `--link` adds the "Open the full review map" line, for when you already have one. */
export function runReview(start: string, opts: ReviewOptions): { review: Review; output: string } {
  const review = buildReview(start, opts.base);
  if (opts.format === "json") return { review, output: JSON.stringify(review, null, 2) };
  const output = renderReviewMarkdown(review, { link: opts.link, builtFor: review.head.slice(0, 7) });
  return { review, output };
}
