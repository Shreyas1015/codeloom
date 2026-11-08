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
    /** `confidence` only on a `calls` edge from a resolved call (v0.2a). */
    out: Array<{ type: string; target: string; confidence?: CallConfidence }>;
    in: Array<{ type: string; source: string; confidence?: CallConfidence }>;
    truncated: boolean;
  };
  chains: string[];
  journeys: Array<{ id: string; name: string }>;
}

/** How sure a `calls` edge is: `exact` (a direct call the resolver followed), `param` (likely: the function is passed
 * or wired, not called directly), or `unverified` (tree-sitter matched it by name in a file the resolver does not index). */
export type CallConfidence = "exact" | "param" | "unverified";

export interface Neighbor {
  ref: string;
  name: string;
  type: string;
  depth: number;
  /** `confidence` only when reached by a `calls` edge (v0.2a): exact, param, or unverified. */
  via: { type: string; direction: "in" | "out"; confidence?: CallConfidence };
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

// ---- /api/progress and /api/tours (v0.2b) -------------------------------------------------------
// Written out to match src/store/progress.ts and src/store/tours.ts (api.ts returns the store's values
// typed as these, so a drift is a type error there; test/web-progress.test.ts checks them strictly).

/** The four Tour mode phases, in order; all four must be viewed to mark a journey toured. */
export type TourPhase = "flow" | "data-journey" | "file-notes" | "check";
export type ProgressLevel = "none" | "seen" | "toured" | "understood";

/** One check-me result (recorded only through MCP record_check). `commit`: git HEAD per repo. */
export interface CheckRecord {
  at: string;
  questions: string[];
  answers: string[];
  verdict: "pass" | "fail";
  notes: string;
  commit: Record<string, string>;
}

export interface JourneyProgressView {
  journeyId: string;
  name: string;
  area: string;
  /** Repos the journey's stops touch, sorted. */
  repos: string[];
  /** Stays "understood" while needsReWalk is non-empty (the UI shows a "needs re-walk" badge). */
  level: ProgressLevel;
  /** For an understood journey: its stops (stopKeys) whose file changed since, or that are new since. */
  needsReWalk: string[];
  lastCheck: CheckRecord | null;
  seenAt?: string;
  touredAt?: string;
  understoodAt?: string;
}

/** Journeys at each exact level (none + seen + toured + understood = total); needsReWalk counts the
 * understood ones with stops to re-walk. */
export interface LevelCounts {
  total: number;
  none: number;
  seen: number;
  toured: number;
  understood: number;
  needsReWalk: number;
}

/** GET /api/progress — your personal progress for this workspace (never committed). */
export interface ProgressResponse {
  workspaceId: string;
  /** The progress file (under CODELOOM_HOME or ~/.codeloom). */
  path: string;
  /** Every journey in journeys.json, sorted by id. */
  journeys: JourneyProgressView[];
  /** byRepo lists every workspace repo (also those with no journey). */
  totals: { all: LevelCounts; byRepo: Record<string, LevelCounts>; byArea: Record<string, LevelCounts> };
  /** Journey ids with progress or a tour that are no longer in journeys.json (renamed, merged or split), sorted. */
  olderJourneys: string[];
  /** The olderJourneys that still have a tour (Tour mode opens it), sorted. */
  olderTours: string[];
}

export interface TourStop {
  chainId: string;
  stopIndex: number;
  /** The shared stopKey: JSON [lane, repo, file, line, symbol]. */
  key: string;
  fileHash: string;
  /** Markdown. */
  explanation: string;
}

/** A tour as the dashboard gets it: the committed tour file minus each check question's `expected` points. */
export interface TourFile {
  version: 1;
  journeyId: string;
  writtenAt: string;
  writtenAtCommit: Record<string, string>;
  stops: TourStop[];
  dataJourney: { input: string; steps: Array<{ stopKey: string; sql?: string; note: string }>; output: string };
  fileNotes: Array<{ repo: string; file: string; notes: Array<{ kind: "trap" | "note"; text: string }> }>;
  /** Exactly 3. Only the questions: the expected key points stay in the tour file for the agent judging
   * check-me, and are never sent to the dashboard (showing them would defeat "understood"). */
  check: Array<{ question: string }>;
}

/** GET /api/tours/:journeyId — 404 when the journey is neither in journeys.json nor has a tour; 400 for a
 * malformed id; 409 bad-data for a corrupt tour file. */
export interface TourResponse {
  journeyId: string;
  /** false: an older journey's tour (the journey was renamed, merged or split). */
  journeyExists: boolean;
  /** null: no tour yet (show the write-tour empty state). */
  tour: TourFile | null;
  /** Tour stop keys whose file changed since the tour was written, or is gone ("may be out of date"). */
  staleStops: string[];
  /** Tour stop keys no longer among the journey's stops (all of them when the journey is gone). */
  removedStops: string[];
}

/** POST /api/progress/seen (Content-Type application/json, ≤ 16 KB, no other keys). */
export interface SeenRequest {
  journey: string;
}

/** POST /api/progress/toured: `phases` must hold all four TourPhase values; the journey needs a tour. */
export interface TouredRequest {
  journey: string;
  phases: TourPhase[];
}

/** The answer to both POSTs: the journey's progress after the write. */
export interface ProgressWriteResponse {
  journey: JourneyProgressView;
}

// ---- /api/specs, /api/views, /api/docs (v0.3, read only) ---------------------------------------

/** linked: ≥ 1 saved link. candidates: not checked yet, and codeloom found candidates. none: checked
 * with no links ("no spec"), or not checked and nothing found (`checked` tells them apart). */
export type SpecState = "linked" | "candidates" | "none";
/** A journeys widget's spec filter (store/views.ts ViewSpecFilterSchema): `none` = checked with no spec,
 * `unchecked` = not checked and no candidates (the Home badges). */
export type ViewSpecFilter = "linked" | "candidates" | "none" | "unchecked";

/** A confirmed link (written by the save_spec_links MCP tool). `ref`: "repo:path" for a doc, the key for a ticket. */
export interface SpecLink {
  kind: "doc" | "ticket";
  ref: string;
  reason: string;
  savedAt: string;
}

export interface SpecCoverage {
  total: number;
  linked: number;
  candidates: number;
  none: number;
  checked: number;
}

/** One row of GET /api/specs (list_specs). */
export interface JourneySpecRow {
  journeyId: string;
  name: string;
  area: string;
  repos: string[];
  state: SpecState;
  checked: boolean;
  /** Set when checked. */
  checkedAt?: string;
  links: SpecLink[];
  /** How many candidates wait (docs and tickets). */
  candidates: { docs: number; tickets: number };
}

/** GET /api/specs[?repo=&area=] — list_specs: every journey's spec state, coverage totals, and the saved
 * links of journeys that no longer exist (`olderJourneys`). Unknown repo → 404; a broken specs.json → 409 bad-data. */
export interface SpecsResponse {
  journeys: JourneySpecRow[];
  totals: { all: SpecCoverage; byRepo: Record<string, SpecCoverage>; byArea: Record<string, SpecCoverage> };
  olderJourneys: Array<{ journeyId: string; checkedAt: string; links: SpecLink[] }>;
  /** false: no spec-candidates.json yet (run codeloom index). */
  candidatesIndexed: boolean;
}

export type SpecDocHitKind = "route" | "page" | "table" | "queue" | "symbol";

/** A doc candidate: `ref` "repo:path", split into `repo` and `file` (open it with /api/docs). */
export interface SpecDocCandidate {
  ref: string;
  repo: string;
  file: string;
  /** Weighted hits (route 3, page 3, table 2, queue 2, symbol 1): only for ordering. */
  score: number;
  /** Total hits. */
  count: number;
  /** The first 5 hits; `file` is the doc's path in its repo. */
  evidence: Array<{ kind: SpecDocHitKind; term: string; file: string; line: number }>;
}

/** A ticket candidate: a key found in the commits that touched the journey's files. */
export interface SpecTicketCandidate {
  ref: string;
  /** Distinct commits. */
  score: number;
  count: number;
  /** The first 5 commits: `file` is the journey file it changed, in `repo`. */
  evidence: Array<{ repo: string; commit: string; file: string; subject: string }>;
}

/** GET /api/specs/:journeyId — one journey's spec state, saved links and full candidates (best first).
 * A journey that is gone but still has saved links: `journeyExists` false, `journey` null, no candidates.
 * Neither in journeys.json nor in specs.json → 404; a malformed id → 400. */
export interface JourneySpecsResponse {
  journeyId: string;
  journeyExists: boolean;
  journey: { id: string; name: string; area: string } | null;
  state: SpecState;
  checked: boolean;
  checkedAt: string | null;
  links: SpecLink[];
  candidates: { docs: SpecDocCandidate[]; tickets: SpecTicketCandidate[] };
  /** false: no spec-candidates.json yet (run codeloom index). */
  candidatesIndexed: boolean;
}

export type ViewCountKey = "files" | "pages" | "routes" | "tables" | "queues" | "journeys" | "understood" | "specLinked";
export type ViewLevel = ProgressLevel | "rewalk";

/** The fixed widget set (store/views.ts WidgetSchema). */
export type Widget =
  | { type: "counts"; show?: ViewCountKey[] }
  | {
      type: "journeys";
      title?: string;
      filter?: { area?: string; repo?: string; spec?: ViewSpecFilter; level?: ViewLevel; confidence?: Confidence; complete?: boolean };
      sort?: "name" | "area" | "stops" | "confidence" | "progress" | "spec";
      limit?: number;
    }
  | { type: "map"; repo: string; overlay?: "layer" | `journey:${string}`; dir?: string }
  | { type: "progress"; by?: "repo" | "area" }
  | { type: "checks"; limit?: number }
  | { type: "specCoverage"; by?: "repo" | "area" }
  /** Markdown, rendered without raw HTML. */
  | { type: "note"; markdown: string };

export type WidgetType = Widget["type"];

/** `.codeloom/views/<id>.json`. */
export interface ViewFile {
  version: 1;
  id: string;
  title: string;
  description?: string;
  widgets: Widget[];
}

/** One entry of GET /api/views: a readable view, or the error that makes its file unreadable. `url` is
 * where the dashboard shows it ("/" for home, else /views/<id>). */
export type ViewSummary =
  | { id: string; url: string; title: string; description?: string; widgets: number }
  | { id: string; url: string; error: string };

/** GET /api/views — every view file, sorted by id. */
export interface ViewsResponse {
  views: ViewSummary[];
}

/** GET /api/views/:id — always 200 for a view file that exists: `view` when it is valid; `view: null` and
 * `error` (with a codeloom doctor hint) when it is broken, so the UI shows an error card. `home` with no
 * file: `view: null` and no `error` (render the built-in Home). Another missing view → 404; a bad id → 400. */
export interface ViewResponse {
  id: string;
  url: string;
  view: ViewFile | null;
  error?: string;
}

/** GET /api/docs?repo=&file= — a doc's whole text (≤ 512 KB, not binary). Path safety as /api/code:
 * outside the repo / absolute → 400; git internals, .env and .codeloom files → 400; missing → 404. */
export interface DocResponse {
  repo: string;
  file: string;
  text: string;
  /** Number of lines. */
  lines: number;
  bytes: number;
}

// ---- /api/events (SSE)--------------------------------------------------------------------------

/** What changed: the workspace file, the workspace's chains or journeys, one repo's map files
 * (graph, endpoints, summaries, config: `repo:<id>`), the workspace's tours (`.codeloom/tours/`),
 * your progress file for this workspace (`progress`), the spec candidates or confirmed spec links
 * (`.codeloom/spec-candidates.json`, `.codeloom/specs.json`: `specs`), or the views (`.codeloom/views/`). */
export type ChangeKey = "workspace" | "chains" | "journeys" | "tours" | "progress" | "specs" | "views" | `repo:${string}`;

/** GET /api/events — a `text/event-stream`: `event: change` frames whose data is this (keys sorted), and
 * a `: ping` comment every 25 s. */
export interface ChangeEvent {
  keys: ChangeKey[];
}
