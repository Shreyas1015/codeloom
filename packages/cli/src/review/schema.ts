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
export const reviewSchema = z.object({
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
});
