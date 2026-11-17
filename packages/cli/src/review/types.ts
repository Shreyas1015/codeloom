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
  /** True when the file holds a stop of any chain the diff touches (named as a journey or not). */
  onChain: boolean;
}

/** One stop of an affected chain, as the renderers need it — Review is self-contained (the publish step,
 * Task 3, renders the PR block from data/review.json alone, with no live workspace to read a chain's full
 * stop list from). `ref` is "<repo>::<nodeId>" (mcp/state.ts formatNodeRef) for a stop on a graph node, or
 * "<repo>::<lane>:<label>" for one that isn't (a db/queue stop); either way, stable and shared by every
 * chain that reaches the same stop. */
export interface ReviewStop {
  ref: string;
  repo: string;
  lane: string;
  label: string;
  /** The ChainStop's own kind (page/call/route/handler/function/db/publish/consume) — lets the 0.5 draft
   * diagram keep only the stops that matter (entry, route, handler, changed, writes). Optional: review.json
   * written by 0.4 has none. */
  kind?: string;
  /** db/queue stops only: the ChainStop's op (read/insert/update/delete/upsert, publish/consume). */
  op?: string;
  file?: string;
  changed: boolean;
  /** Index (into this same chain's ReviewStop[]) of the stop this one was reached from — copied from
   * ChainStop.from (store/schemas.ts), so the diagram can draw the real predecessor instead of assuming a
   * straight line; absent for a chain's first stop. */
  from?: number;
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

/** A file whose change needs care before deploying (spec §2 "⚠ Before deploying"). `file` is shown as is:
 * "<repo id>/<repo-relative path>", or a workspace-root-relative path for a file outside every repo (e.g. the
 * root's own `.github/workflows/…` when the workspace is itself one git repo). */
export interface ReviewRisk {
  kind: "migration" | "schema" | "env" | "docker" | "ci";
  file: string;
  /** e.g. "new file", "new key: GST_RATE", "new env read: CUSTOMER_WEBHOOK_URL". */
  detail?: string;
}

/** An entry point (a chain's first stop) that reaches the changed code (spec §2 "Where it matters"). `label`
 * is the page's URL path, the route's "METHOD /path", or the consumed queue's name; `journey` the name of
 * the (first, by name) journey that chain belongs to, when one is named. */
export interface ReviewEntry {
  kind: "route" | "page" | "consumer";
  label: string;
  journey?: string;
  repo: string;
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
  /** Every stop (in the chain's own order) of every chain in `chains` — the full chain layout, not just
   * the changed stops, so the renderers (mermaid.ts, markdown.ts) need nothing beyond this Review. */
  chainStops: Record<string, ReviewStop[]>;
  /** Every chain in `chains`' own name (the linker's `defaultChainName`), for display when no journey
   * names it (markdown.ts's bare chains table — Review carries no live chain lookup to read it from). */
  chainNames: Record<string, string>;
  tables: string[];
  queues: string[];
  truncated: boolean;
  notes: string[];
  /** The repo whose history was diffed (`--repo`, or the one picked for the caller); "" when the workspace
   * root is itself the git repo and every repo in it was diffed together (0.4's only mode). */
  repoId: string;
  /** Entry points of the touched chains, named-journey ones first; deduplicated. */
  entries: ReviewEntry[];
  /** Tables/queues the changed stops write on their own chains, after the changed stop (db insert/update/
   * delete/upsert, queue publish; never past a queue's consumer). Sorted. */
  writes: string[];
  /** Tables the changed stops only read (db read after the changed stop), minus `writes`. Sorted. */
  readsOnly: string[];
  /** Files to look at before deploying: migrations/schema, env, Docker, CI. */
  risks: ReviewRisk[];
}
