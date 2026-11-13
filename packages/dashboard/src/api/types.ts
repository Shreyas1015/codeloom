/** Response shapes the dashboard reads: type-only re-exports of the server's own types
 * (packages/cli/src/web/api-types.ts, via the `codeloom` workspace devDependency). No runtime code
 * crosses over; `import type` is erased at build time. */

export type * from "codeloom/src/web/api-types.ts";
export type { OverviewResponse as Overview } from "codeloom/src/web/api-types.ts";

// ---- Review ("This PR" screen; PR review maps design §3, §7) --------------------------------------------
// Mirrored by hand from packages/cli/src/review/types.ts — not imported: the dashboard depends on the
// `codeloom` workspace package only for its web API types (api-types.ts above), never on the CLI's own
// review module. `GET /api/review` (in a snapshot, `data/review.json`) answers with `Review`.

/** One diff hunk, lines kept in order with their leading " " (context), "+" (added) or "-" (removed). */
export interface ReviewHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A function-like graph node whose code changed between base and head. `before`/`after` are null for a
 * node that did not exist on that side (a new or deleted function); otherwise the node's own code slice. */
export interface ReviewNodeChange {
  /** "<repo>::<nodeId>", e.g. "api::function:app/services/customer_service.ts:CustomerService.create". */
  ref: string;
  repo: string;
  file: string;
  symbol: string;
  before: { start: number; end: number; text: string } | null;
  after: { start: number; end: number; text: string } | null;
  hunks: ReviewHunk[];
  added: number;
  removed: number;
  /** Journey ids this node is a stop of (sorted). */
  journeys: string[];
}

/** A changed file, whether or not it is reachable from any chain. */
export interface ReviewFile {
  repo: string;
  file: string;
  added: number;
  removed: number;
  onJourney: boolean;
}

/** One stop of an affected chain, as the renderers need it. `ref` is "<repo>::<nodeId>" for a stop on a
 * graph node, or "<repo>::<lane>:<label>" for one that isn't (a db/queue stop); either way, stable and
 * shared by every chain that reaches the same stop. */
export interface ReviewStop {
  ref: string;
  repo: string;
  lane: string;
  label: string;
  file?: string;
  changed: boolean;
  /** Index (into this same chain's ReviewStop[]) of the stop this one was reached from; absent for a
   * chain's first stop. */
  from?: number;
}

/** One journey touched by the diff: which of its stops changed, and its spec state. "unchecked" is "none"
 * with `checked: false` — not yet reviewed, as opposed to a confirmed "none". */
export interface ReviewJourney {
  id: string;
  name: string;
  /** Refs (ReviewNodeChange.ref) of this journey's stops that changed, sorted. */
  changedStops: string[];
  spec: "linked" | "candidates" | "none" | "unchecked";
  /** This journey's chain ids touched by the diff, sorted. */
  chains: string[];
}

/** The impact of one diff (PR review maps design §3): every changed file and function, the journeys and
 * chains they touch, and the full stop layout of every touched chain. */
export interface Review {
  version: 1;
  /** Full SHAs: `base` is merge-base(baseRef, head). */
  base: string;
  head: string;
  /** What the caller passed (e.g. "origin/main"), kept for display. */
  baseRef: string;
  files: ReviewFile[];
  nodes: ReviewNodeChange[];
  /** Empty when no journeys are named yet; `chains` then carries the touched chain ids on its own. */
  journeys: ReviewJourney[];
  /** Every chain id touched by the diff (sorted), named or not. */
  chains: string[];
  /** Every stop (in the chain's own order) of every chain in `chains`. */
  chainStops: Record<string, ReviewStop[]>;
  /** Every chain in `chains`' own name, for display when no journey names it. */
  chainNames: Record<string, string>;
  tables: string[];
  queues: string[];
  truncated: boolean;
  notes: string[];
}
