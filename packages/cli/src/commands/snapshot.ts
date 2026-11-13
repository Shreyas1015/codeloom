// `codeloom snapshot` and `codeloom snapshot-site` (design spec §2): the untrusted build step and the
// trusted publish step, wired as two CLI commands sharing one file (they are two steps of the same
// pipeline — see snapshot/write.ts and snapshot/site.ts for the actual work).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeloomError, dataError } from "../errors.js";
import { renderReviewMarkdown } from "../review/markdown.js";
import { buildFailedBlock, buildSnapshotSite, type SiteResult } from "../snapshot/site.js";
import { writeSnapshotData } from "../snapshot/write.js";

/** `--max-size`: a bare number of bytes, or a number with a b/kb/mb/gb suffix (case-insensitive), e.g.
 * "25MB" — the design doc's own example. 1024-based, matching DEFAULT_MAX_BYTES's own 25 * 1024 * 1024. */
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;
const SIZE_UNIT: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };

export function parseMaxSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = SIZE_RE.exec(raw.trim());
  if (!m) throw dataError(`--max-size must be a number of bytes, or e.g. "25MB", got "${raw}".`);
  return Math.round(Number(m[1]) * SIZE_UNIT[(m[2] ?? "b").toLowerCase()]!);
}

/** `--pr`: a positive whole number, else a usage error (exit 2). */
export function parsePrNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw dataError(`--pr must be a positive whole number, got "${raw}".`);
  return n;
}

export interface SnapshotOptions {
  /** `impact_of_diff`'s base ref: the snapshot covers `merge-base(baseRef, HEAD)..HEAD`. */
  base: string;
  out: string;
  maxBytes?: number;
  /** Write only data/*.json — for the untrusted build step (no dashboard assets, no review.md). */
  dataOnly?: boolean;
}

/** `codeloom snapshot --base <ref> --out <dir> [--max-size <size>] [--data-only]`: writes
 * `<out>/data/*.json` (writeSnapshotData). Unless `--data-only`, also builds the site next to it
 * (buildSnapshotSite) and writes `<out>/review.md` — a trusted, local call: `expectedHead` is this
 * same run's own manifest.head, not a value read back from anything untrusted. */
export async function runSnapshot(start: string, opts: SnapshotOptions): Promise<{ exitCode: number }> {
  const manifest = await writeSnapshotData(start, { baseRef: opts.base, outDir: opts.out, maxBytes: opts.maxBytes });
  if (opts.dataOnly) return { exitCode: 0 };
  const result = buildSnapshotSite({
    dataDir: join(opts.out, "data"),
    outDir: opts.out,
    expectedHead: manifest.head,
    maxBytes: opts.maxBytes,
  });
  writeFileSync(join(opts.out, "review.md"), result.reviewMd);
  return { exitCode: 0 };
}

export interface SnapshotSiteOptions {
  out: string;
  /** Normal mode: the build artifact's data/ folder and the event's own head SHA. */
  data?: string;
  head?: string;
  pr?: number;
  repoSlug?: string;
  link?: string;
  /** A file holding the PR's current description, spliced with the rendered block. */
  bodyFile?: string;
  maxBytes?: number;
  /** Failed-build mode instead of data/head: the failed run's own URL. */
  failed?: string;
  /** Failed-build mode only: the last good snapshot's own data/manifest.json. */
  previousManifest?: string;
}

function writeSiteOutputs(out: string, result: { reviewMd: string; body?: string; comment?: string }): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "review.md"), result.reviewMd);
  if (result.body !== undefined) writeFileSync(join(out, "body.md"), result.body);
  if (result.comment !== undefined) writeFileSync(join(out, "comment.md"), result.comment);
}

/** `codeloom snapshot-site`: the trusted publish step (design spec §5). Either `--data <dir> --head
 * <sha>` (validate the untrusted artifact and build the hosted site), or `--failed <run-url>
 * [--previous <manifest>]` when the build itself failed. Always writes `out/review.md` and, when a
 * `bodyFile` is given, `out/body.md` or `out/comment.md`. A validation failure in the first mode still
 * writes `out/review.md` (the refusal) and returns exit 1 — nothing else reaches `out` (SiteResult's own
 * caller, buildSnapshotSite, never writes before it has validated). */
export function runSnapshotSite(opts: SnapshotSiteOptions): { exitCode: number } {
  if (opts.failed !== undefined) {
    const result = buildFailedBlock({
      outDir: opts.out,
      runUrl: opts.failed,
      previousManifest: opts.previousManifest,
      link: opts.link,
      bodyFile: opts.bodyFile,
    });
    writeSiteOutputs(opts.out, result);
    return { exitCode: 0 };
  }

  if (opts.data === undefined || opts.head === undefined) {
    throw dataError('codeloom snapshot-site needs either "--data <dir> --head <sha>" or "--failed <run-url>".');
  }

  let result: SiteResult;
  try {
    result = buildSnapshotSite({
      dataDir: opts.data,
      outDir: opts.out,
      expectedHead: opts.head,
      maxBytes: opts.maxBytes,
      pr: opts.pr,
      repoSlug: opts.repoSlug,
      link: opts.link,
      bodyFile: opts.bodyFile,
    });
  } catch (err) {
    if (!(err instanceof CodeloomError)) throw err;
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, "review.md"), renderReviewMarkdown(null, { error: `codeloom review map refused: ${err.message}` }));
    return { exitCode: 1 };
  }
  writeSiteOutputs(opts.out, result);
  return { exitCode: 0 };
}
