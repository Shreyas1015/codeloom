// The Review model (PR review maps design §2, §4): the impact of a diff, rendered later as a PR block
// (markdown.ts) and a Mermaid diagram (mermaid.ts). Built once by build.ts from the existing
// impact_of_diff, functionExtents, journeysForChains and listSpecs; nothing here reaches outside the repo.

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
  /** "<repo>::<nodeId>" (mcp/state.ts formatNodeRef), e.g. "api::function:app/services/customer_service.ts:CustomerService.create". */
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

/** One journey touched by the diff: which of its stops changed, and its spec state. "unchecked" is "none"
 * (store/specs.ts SpecState) with `checked: false` — not yet reviewed, as opposed to a confirmed "none". */
export interface ReviewJourney {
  id: string;
  name: string;
  /** Refs (ReviewNodeChange.ref) of this journey's stops that changed, sorted. */
  changedStops: string[];
  spec: "linked" | "candidates" | "none" | "unchecked";
  /** This journey's chain ids touched by the diff, sorted. */
  chains: string[];
}

/** The impact of one diff, ready to render as a PR block (markdown.ts) or inspect as JSON. */
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
  tables: string[];
  queues: string[];
  truncated: boolean;
  notes: string[];
}
