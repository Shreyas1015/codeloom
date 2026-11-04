/** Response shapes of the dashboard's JSON API (packages/cli/src/web/api.ts).
 *
 * The dashboard imports these with `import type` (via its `codeloom` workspace devDependency), so this
 * file must stay self-contained: no imports, only types. The MCP-backed shapes are written out as
 * explicit interfaces matching the Plan 2b tool catalogue; test/web-endpoints.test.ts checks every
 * endpoint's real response against zod schemas mirroring these types. */

export type Confidence = "exact" | "param" | "guess";
export type Lane = "ui" | "api" | "code" | "db" | "queue";
export type StopKind = "page" | "call" | "route" | "handler" | "function" | "db" | "publish" | "consume";
export type RepoRole = "ui" | "api" | "worker" | "lib";

/** Every non-200 response: `{ error }`; a 409 (the map is not usable) also carries `code`. */
export type ApiErrorCode = "not-indexed" | "no-workspace" | "bad-data";
export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
}

// ---- /api/overview ------------------------------------------------------------------------------

export interface OverviewRepo {
  id: string;
  path: string;
  role?: RepoRole;
  files: number;
  nodes: number;
  edges: number;
  pages: number;
  routes: number;
  calls: number;
  tables: number;
  queues: number;
}

export interface RepoIndexStatus {
  id: string;
  head: string;
  indexedCommit: string | null;
  stale: boolean;
  changedFiles: string[];
  truncated: boolean;
}

export interface IndexStatusResult {
  repos: RepoIndexStatus[];
}

/** workspace_overview. */
export interface OverviewResult {
  name: string;
  repos: OverviewRepo[];
  chains: { total: number; complete: number; byConfidence: Record<Confidence, number> };
  journeys: { total: number; orphaned: number };
  unnamedChains: number;
}

/** GET /api/overview */
export interface OverviewResponse extends OverviewResult {
  indexStatus: IndexStatusResult;
  mcpConnected: boolean;
}

// ---- /api/journeys (dashboard-only) -------------------------------------------------------------

export interface JourneyRow {
  id: string;
  name: string;
  area: string;
  note: string;
  status: "ok" | "orphaned";
  chainIds: string[];
  /** Repos touched by its chains, sorted. */
  repos: string[];
  /** Distinct stops per lane (a stop shared by two chains counts once). */
  stops: Record<Lane, number>;
  /** Worst over its chains. */
  confidence: Confidence;
  /** Every chain present, and every chain with a UI stop complete (at least one such chain) — hG. */
  complete: boolean;
  /** No chain has a UI stop and every chain present reaches a store (H3: "API → DB"; hG). */
  apiOnly: boolean;
  /** Tables its db stops touch, sorted. */
  tables: string[];
  /** Other services its pages call (the workspace file's `external` name, else the env var / host),
   * sorted; absent when none. Dashboard-only. */
  external?: string[];
}

/** A UI call to another service, from one of a journey's pages. */
export interface ExternalCallView {
  /** The workspace file's `external` name, else the env var / host. */
  name: string;
  repo: string;
  file: string;
  line: number;
  symbol: string;
  method: string;
  path: string;
}

export interface ChainRow {
  id: string;
  name: string;
  entry: string;
  confidence: Confidence;
  complete: boolean;
  /** Reaches a store but has no UI stop (H3: "API → DB"); never true when `complete`. */
  apiOnly: boolean;
  repos: string[];
}

/** GET /api/journeys — journeys sorted by name then id; unnamed chains (in no journey) sorted by id. */
export interface JourneysResponse {
  journeys: JourneyRow[];
  unnamedChains: ChainRow[];
}

// ---- chains and journeys (list_chains, get_journey) ---------------------------------------------

export interface StopView {
  lane: Lane;
  kind: StopKind;
  repo: string;
  file: string;
  line: number;
  symbol: string;
  label?: string;
  op?: string;
  confidence: Confidence;
  reason?: string;
  /** "repo::nodeId" when the stop sits on a graph node. */
  ref?: string;
  /** Index (in the same chain's `stops`) of the stop this one was reached from; on every stop but a chain's
   * first, always below the stop's own index; `confidence`/`reason` describe that edge. Absent in
   * get_journey's `lanes` (merged across chains) and in chains.json files written before it existed. */
  from?: number;
}

export interface UnresolvedItem {
  at: { file: string; line: number; symbol: string; repo: string };
  reason: string;
}

export interface ChainView {
  id: string;
  name: string;
  entry: string;
  routeKey: string;
  confidence: Confidence;
  complete: boolean;
  journeys: string[];
  stopCount: number;
  /** Stops per lane. */
  lanes: Record<Lane, number>;
  /** Tables the chain's db stops reach, sorted. */
  tables: string[];
  stops: StopView[];
  unresolved: UnresolvedItem[];
}

/** GET /api/chains (list_chains). */
export interface ChainsResult {
  total: number;
  chains: ChainView[];
  truncated: boolean;
}

export interface Journey {
  id: string;
  name: string;
  area: string;
  note: string;
  chainIds: string[];
  status: "ok" | "orphaned";
}

/** GET /api/journeys/:id (get_journey) — a journey id (j_…) or a chain id (ch_…, then `journey` is null). */
export interface JourneyResult {
  journey: Journey | null;
  chains: ChainView[];
  lanes: Record<Lane, StopView[]>;
  /** "repo:file", sorted. */
  files: string[];
  tables: string[];
  queues: string[];
  unresolved: Array<UnresolvedItem & { chainId: string }>;
  /** Saved chain ids that match no chain, by id or by alias. */
  missingChainIds: string[];
  /** H11: saved chain ids found only as another chain's alias (the flow gained a UI step), with the current ids. */
  movedChainIds: Array<{ from: string; to: string[] }>;
  /** GET /api/journeys/:id only (not get_journey): the other-service calls its pages make, sorted by
   * name; absent when none. */
  external?: ExternalCallView[];
}

// ---- /api/graph (dashboard-only) ----------------------------------------------------------------

export interface GraphFolder {
  /** Repo-relative folder path. */
  path: string;
  name: string;
  /** Files under it, recursively. */
  files: number;
  /** Set when every file under it is in the same layer. */
  layer?: string;
}

export interface GraphFunction {
  ref: string;
  name: string;
  type: "function" | "class";
  line?: number;
}

export interface GraphFile {
  /** "repo::file:<path>" for get_node / neighbors. */
  ref: string;
  /** Repo-relative file path. */
  path: string;
  name: string;
  layer?: string;
  functions: GraphFunction[];
  /** Ids of the journeys with a stop in this file, sorted. */
  journeys: string[];
}

export interface GraphEdgeAgg {
  /** Repo-relative path of a folder or file at this level. */
  from: string;
  to: string;
  /** "imports" | "calls". */
  type: string;
  count: number;
}

/** GET /api/graph?repo=&dir= — one folder level of one repo. */
export interface GraphLevel {
  repo: string;
  /** "" = the repo root. */
  dir: string;
  folders: GraphFolder[];
  files: GraphFile[];
  edges: GraphEdgeAgg[];
}

// ---- graph nodes (get_node, get_neighbors, get_layers, search) ----------------------------------

export interface NodeInfo {
  type: string;
  name: string;
  filePath?: string;
  lineRange?: [number, number];
  layer?: string;
}

/** GET /api/node/:ref (get_node). */
export interface NodeResult {
  ref: string;
  node: NodeInfo;
  summary: string | null;
  edges: {
    out: Array<{ type: string; target: string }>;
    in: Array<{ type: string; source: string }>;
    truncated: boolean;
  };
  chains: string[];
  journeys: Array<{ id: string; name: string }>;
}

export interface Neighbor {
  ref: string;
  name: string;
  type: string;
  depth: number;
  via: { type: string; direction: "in" | "out" };
}

/** GET /api/neighbors/:ref (get_neighbors). */
export interface NeighborsResult {
  root: string;
  neighbors: Neighbor[];
  truncated: boolean;
}

/** GET /api/layers (get_layers). */
export interface LayersResult {
  repos: Array<{ id: string; layers: Array<{ id: string; name: string; description: string; nodeCount: number }> }>;
}

export type SearchKind = "file" | "function" | "class" | "route" | "page" | "table" | "queue" | "journey" | "chain";

export interface SearchHit {
  kind: SearchKind;
  ref: string;
  name: string;
  repo?: string;
  file?: string;
  line?: number;
  score: number;
}

/** GET /api/search (search). Best match first. */
export interface SearchResult {
  results: SearchHit[];
  truncated: boolean;
}

// ---- /api/code (dashboard-only) -----------------------------------------------------------------

/** GET /api/code?repo=&file=&start=&end= — at most 400 lines / 60 000 chars; `truncated` when less than
 * the asked range (or, with no `end`, less than the rest of the file) came back. */
export interface CodeResponse {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

// ---- /api/events (SSE) --------------------------------------------------------------------------

/** What changed: the workspace file, the workspace's chains or journeys, or one repo's map files
 * (graph, endpoints, summaries, config: `repo:<id>`). */
export type ChangeKey = "workspace" | "chains" | "journeys" | `repo:${string}`;

/** GET /api/events — a `text/event-stream`: `event: change` frames whose data is this (keys sorted), and
 * a `: ping` comment every 25 s. */
export interface ChangeEvent {
  keys: ChangeKey[];
}
