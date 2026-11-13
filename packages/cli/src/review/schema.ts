// Runtime shape check for review.json (design spec §5, security review I1b): the writer always
// produces a well-typed Review (types.ts), but a snapshot-site artifact's review.json is untrusted bytes
// from a stranger's PR — JSON.parse alone proves it's *some* JSON, not that it has this shape. Checked by
// snapshot/validate.ts before anything is written anywhere, so a mismatch is a clean refusal (never a
// crash after data/assets have already been copied).

import { z } from "zod";

const SPEC_STATES = ["linked", "candidates", "none", "unchecked"] as const;

const count = z.number().int().nonnegative();
const position = z.number().int();

const hunkSchema = z.object({
  oldStart: position,
  oldLines: count,
  newStart: position,
  newLines: count,
  lines: z.array(z.string()),
});

const codeSliceSchema = z.object({ start: position, end: position, text: z.string() });

const nodeChangeSchema = z.object({
  ref: z.string(),
  repo: z.string(),
  file: z.string(),
  symbol: z.string(),
  before: codeSliceSchema.nullable(),
  after: codeSliceSchema.nullable(),
  hunks: z.array(hunkSchema),
  added: count,
  removed: count,
  journeys: z.array(z.string()),
});

const fileSchema = z.object({
  repo: z.string(),
  file: z.string(),
  added: count,
  removed: count,
  onJourney: z.boolean(),
});

const stopSchema = z.object({
  ref: z.string(),
  repo: z.string(),
  lane: z.string(),
  label: z.string(),
  file: z.string().optional(),
  changed: z.boolean(),
  from: count.optional(),
});

const journeySchema = z.object({
  id: z.string(),
  name: z.string(),
  changedStops: z.array(z.string()),
  spec: z.enum(SPEC_STATES),
  chains: z.array(z.string()),
});

/** Matches review/types.ts's `Review` field for field. `z.record` here always takes a key schema (zod
 * v4): chain ids and names are plain strings, not the snapshotKey charset (they never become file
 * names). */
export const reviewSchema = z
  .object({
    version: z.literal(1),
    base: z.string(),
    head: z.string(),
    baseRef: z.string(),
    files: z.array(fileSchema),
    nodes: z.array(nodeChangeSchema),
    journeys: z.array(journeySchema),
    chains: z.array(z.string()),
    chainStops: z.record(z.string(), z.array(stopSchema)),
    chainNames: z.record(z.string(), z.string()),
    tables: z.array(z.string()),
    queues: z.array(z.string()),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  })
  // Security review I1'a: every `chains` id must be a genuine OWN key of chainStops. Without this, a
  // chain id that collides with an inherited Object.prototype property name (e.g. "constructor",
  // "toString") would pass z.record's own validation (chainStops simply never mentions it) while still
  // crashing the renderer, which looks the id up directly — Object.hasOwn is the renderer's OWN defense
  // (mermaid.ts, markdown.ts), and this refinement is the writer-contract check: every id a Review
  // claims to have stops for really does have an explicit (even if empty) entry.
  .superRefine((data, ctx) => {
    for (const id of data.chains) {
      if (!Object.hasOwn(data.chainStops, id)) {
        ctx.addIssue({ code: "custom", message: "a chain id has no matching entry in chainStops" });
      }
    }
  });

// Security review I1'b: snapshot/validate.ts previously trusted manifest.json's OTHER fields (omitted,
// bytes, tooLarge, codeloom, base, builtAt) with no shape check at all — a `{...manifest}` spread then
// carried whatever shape they had straight into the published site's manifest.json. A deeply nested
// `omitted` (or any of its arrays) stack-overflows JSON.stringify; `tooLarge: null` or
// `tooLarge: {bytes: "<b>"}` passes the old `=== undefined` / truthiness checks while rendering garbage
// ("NaN MB") or silently mismatching `hosted`. `manifest.files`' own format/uniqueness/on-disk-equality
// checks stay as validate.ts's separate, filesystem-aware cross-checks (zod alone can't see the disk).
const nonNegativeFinite = z.number().finite().nonnegative();

export const manifestFieldsSchema = z.object({
  codeloom: z.string(),
  base: z.string(),
  builtAt: z.string(),
  omitted: z.object({ mapFolders: z.array(z.string()), codeFiles: z.array(z.string()) }),
  bytes: nonNegativeFinite,
  // Round 3 item 3: byte counts are always whole numbers — `count` (the same non-negative-integer
  // schema review.json's own added/removed/oldLines/newLines use), not the merely-finite
  // `nonNegativeFinite` above.
  tooLarge: z.object({ bytes: count, max: count }).optional(),
});
