import { z } from "zod";

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/** Where something is in the code: repo-relative file, 1-based line, enclosing function or Class.method. */
export const LocSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  symbol: z.string(),
});
export type Loc = z.infer<typeof LocSchema>;

export const UiPageSchema = z.object({
  route: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  framework: z.enum(["next-app", "next-pages", "react-router"]),
  /** React Router only: the component the route renders (`element={<X/>}`, `element: <X/>`,
   * `Component: X`) and the module it is imported from in the router file, when it is imported. */
  component: z.object({ name: z.string(), importSource: z.string().optional() }).optional(),
});
export type UiPage = z.infer<typeof UiPageSchema>;

export const ConfidenceSchema = z.enum(["exact", "param", "guess"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const HttpCallKindSchema = z.enum(["literal", "template", "unknown"]);
export type HttpCallKind = z.infer<typeof HttpCallKindSchema>;

export const HttpCallSchema = z.object({
  method: HttpMethodSchema,
  /** Normalised route pattern; "" when kind === "unknown" (nothing literal in the URL). */
  path: z.string(),
  raw: z.string(),
  resolved: z.boolean(),
  client: z.string(),
  at: LocSchema,
  /** literal: whole URL is a string; template: literal text + expressions; unknown: no literal text. */
  kind: HttpCallKindSchema,
  /** Source text of a leading base expression that was stripped, e.g. "process.env.NEXT_PUBLIC_API_URL". */
  base: z.string().optional(),
});
export type HttpCall = z.infer<typeof HttpCallSchema>;

export const HttpClientSchema = z.object({
  /** Variable the instance is bound to (`export const api = axios.create(...)` -> "api"). */
  name: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  /** "axios" | "ky" | callee text of a generic `create({ baseURL })`. */
  factory: z.string(),
  /** Source text of a non-literal baseURL / prefixUrl expression. */
  baseExpr: z.string().optional(),
  /** baseURL when it is a string literal, normalised by normalizePath (host stripped). */
  baseLiteral: z.string().optional(),
  /** Host (lowercased, port kept) of an absolute literal baseURL, e.g. "api.stripe.com" or
   * "localhost:3333"; absent for a relative or non-literal baseURL. */
  baseHost: z.string().optional(),
});
export type HttpClient = z.infer<typeof HttpClientSchema>;

export const RouteSchema = z.object({
  method: HttpMethodSchema,
  /** As declared, including Adonis group prefixes (Plan 1 behaviour); mounts are NOT applied here. */
  path: z.string(),
  handler: z.string(),
  inline: z.boolean(),
  framework: z.enum(["adonis", "express", "fastify", "nest", "next-api"]),
  at: LocSchema,
  handlerFile: z.string().optional(),
  handlerLines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  /** Receiver identifier the route was registered on (express/fastify): "router", "app", "fastify", ... */
  router: z.string().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const MountKindSchema = z.enum(["express-use", "fastify-register", "nest-global"]);
export type MountKind = z.infer<typeof MountKindSchema>;

export const MountSchema = z.object({
  /** Normalised prefix ("/billing"); nest-global "api" -> "/api". */
  prefix: z.string(),
  kind: MountKindSchema,
  /** Receiver the mount was called on ("app", "router", "fastify"); "" for nest-global. */
  on: z.string(),
  /** What gets the prefix. name = local identifier passed (router var / plugin fn); file = repo-relative
   * file it resolves to when imported (set by finalizeEndpoints from the draft's import specifier).
   * Both absent for nest-global (applies to every nest route in the repo). */
  target: z.object({
    name: z.string().optional(),
    file: z.string().optional(),
    /** The name the target was imported under from `file`: "default" for a default import / require(),
     * else the named export. When set, only the router exported under this name in `file` gets the prefix. */
    export: z.string().optional(),
  }),
  /** When `on` is a router imported from another repo file: that file, and the name it is exported
   * under there. The mount then applies on that file's router, not on a local `on`. */
  onFile: z.string().optional(),
  onExport: z.string().optional(),
  at: LocSchema,
});
export type Mount = z.infer<typeof MountSchema>;

/** A router (express/fastify) that its file exports, or an app/server created by express()/fastify(). */
export const RouterDefSchema = z.object({
  /** Local identifier; "default" for an anonymous default-exported router (`export default Router().use(...)`). */
  name: z.string(),
  file: z.string(),
  /** Names it is exported under ("default" for export default / module.exports), sorted; [] when not exported. */
  exports: z.array(z.string()),
  /** True for an app/server (express(), fastify()): a top-level receiver. It can itself be mounted as a
   * sub-app under another app (`const admin = express(); app.use("/admin", admin)`); see linker/mounts.ts
   * (isTopLevelReceiver, isMainApp) for how the linker decides whether a chain stops here. */
  app: z.boolean().optional(),
  /** The file's package root (AdapterContext.packageRoot: nearest directory with a package.json, "" for
   * the repo root), set by detectRouters. Lets isMainApp group apps by real package instead of guessing
   * from the file's top-level directory; optional so older cache entries without it still read. */
  packageRoot: z.string().optional(),
});
export type RouterDef = z.infer<typeof RouterDefSchema>;

export const DbOpSchema = z.enum(["read", "insert", "update", "delete"]);
export type DbOp = z.infer<typeof DbOpSchema>;

export const DbAccessSchema = z.object({
  table: z.string().optional(),
  model: z.string().optional(),
  op: DbOpSchema,
  via: z.enum(["lucid", "prisma", "typeorm", "drizzle", "mongoose", "query-builder", "sql"]),
  at: LocSchema,
});
export type DbAccess = z.infer<typeof DbAccessSchema>;

export const TableDefSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  source: z.enum(["migration", "prisma", "drizzle", "model"]),
});
export type TableDef = z.infer<typeof TableDefSchema>;

export const ModelDefSchema = z.object({
  model: z.string(),
  table: z.string(),
  file: z.string(),
  source: z.enum(["lucid", "typeorm", "prisma", "drizzle", "mongoose"]),
});
export type ModelDef = z.infer<typeof ModelDefSchema>;

export const QueueOpSchema = z.object({
  /** publish via sendToQueue: queue name; publish via exchange: "exchange:key" (or exchange alone when key
   * is ""); consume / bind: queue name. (Plan 1 encoding kept.) */
  queue: z.string(),
  op: z.enum(["publish", "consume", "bind"]),
  at: LocSchema,
  exchange: z.string().optional(),
  /** Present (possibly "") for exchange publishes and binds. */
  routingKey: z.string().optional(),
});
export type QueueOp = z.infer<typeof QueueOpSchema>;

export const EndpointsFileSchema = z.object({
  version: z.literal(2),
  repo: z.string(),
  pages: z.array(UiPageSchema),
  httpCalls: z.array(HttpCallSchema),
  httpClients: z.array(HttpClientSchema),
  routes: z.array(RouteSchema),
  mounts: z.array(MountSchema),
  /** Exported routers and apps, sorted by file then name. Optional so older v2 files still read. */
  routers: z.array(RouterDefSchema).optional(),
  dbAccess: z.array(DbAccessSchema),
  tables: z.array(TableDefSchema),
  models: z.array(ModelDefSchema),
  queues: z.array(QueueOpSchema),
});
export type EndpointsFile = z.infer<typeof EndpointsFileSchema>;

export const RepoConfigSchema = z.object({
  version: z.literal(1),
  autoUpdate: z.boolean(),
  ignore: z.array(z.string()),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export function defaultRepoConfig(): RepoConfig {
  return { version: 1, autoUpdate: true, ignore: [] };
}

export const RepoRoleSchema = z.enum(["ui", "api", "worker", "lib"]);
export type RepoRole = z.infer<typeof RepoRoleSchema>;

export const RepoRefSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** Optional hint for picking the target backend of an HTTP call. */
  role: RepoRoleSchema.optional(),
  /** Env var names (e.g. "NEXT_PUBLIC_API_URL") or hosts ("api.example.com") whose calls go to this repo. */
  apiBase: z.array(z.string()).optional(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

/** Stored now, used by Plan 2b. Validated so a typo is caught early. */
export const TracesConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tempo"),
    url: z.string(),
    headersEnv: z.string().optional(),
    services: z.record(z.string(), z.string()).optional(),
    lookback: z.string().optional(),
  }),
  z.object({ kind: z.literal("otlp-file"), path: z.string(), services: z.record(z.string(), z.string()).optional() }),
]);
export type TracesConfig = z.infer<typeof TracesConfigSchema>;

export const ExternalServiceSchema = z.object({ name: z.string().min(1), apiBase: z.array(z.string().min(1)) });
export type ExternalService = z.infer<typeof ExternalServiceSchema>;

/** The default ticket key pattern and ignored key prefixes (v0.3 spec §1). */
export const DEFAULT_TICKET_PATTERN = "\\b[A-Z][A-Z0-9]+-\\d+\\b";
export const DEFAULT_TICKET_IGNORE_PREFIXES: readonly string[] = ["CVE", "UTF", "ISO", "RFC", "SHA"];

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "g");
    return true;
  } catch {
    return false;
  }
}

/** Workspace `specs` (v0.3 §1): `docs` extra doc globs and `ignoreDocs` doc globs to skip (both
 * gitignore-style, repo-relative); `ticketPattern` a JavaScript regex for ticket keys; `ignorePrefixes`
 * key prefixes (the part before the first "-") that are never tickets. */
export const SpecsConfigSchema = z.object({
  docs: z.array(z.string().min(1)).optional(),
  ignoreDocs: z.array(z.string().min(1)).optional(),
  ticketPattern: z.string().min(1).refine(compiles, { message: "is not a valid regular expression" }).optional(),
  ignorePrefixes: z.array(z.string()).optional(),
});
export type SpecsConfig = z.infer<typeof SpecsConfigSchema>;

export const WorkspaceFileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  repos: z.array(RepoRefSchema),
  /** Manual hops. Strings use the chain-stop address form "<repo>:<file>#<symbol>" or
   * "route:<repo>:<METHOD path>" / "queue:<repo>:<queue>" (see R11 parseLinkRef, Task 11). */
  links: z.array(z.object({ from: z.string(), to: z.string() })),
  traces: TracesConfigSchema.optional(),
  /** Other services the UI calls (not repos in this workspace): a call whose base env var / host is in
   * an entry's `apiBase` is listed as a call to that `name`, never matched to a route. */
  external: z.array(ExternalServiceSchema).optional(),
  specs: SpecsConfigSchema.optional(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/** Local, git-ignored cache for incremental indexing. structure/calls/endpoints are codeloom's own
 * outputs. It also holds the run's time and commit, which are kept out of the committed files so
 * those depend only on code. */
export const FingerprintsSchema = z.object({
  version: z.literal(2),
  contextKey: z.string(),
  indexedAt: z.string(),
  gitCommitHash: z.string(),
  files: z.record(
    z.string(),
    z.object({ hash: z.string(), structure: z.any(), calls: z.any(), endpoints: z.any(), codeIndex: z.any() }),
  ),
});
export type Fingerprints = z.infer<typeof FingerprintsSchema>;

// ---------------------------------------------------------------------------------------------------
// chains.json (linker-only) and journeys.json (agent/user; the indexer only creates it and flips status).
// ---------------------------------------------------------------------------------------------------

export const LaneSchema = z.enum(["ui", "api", "code", "db", "queue"]);
export type Lane = z.infer<typeof LaneSchema>;

export const StopKindSchema = z.enum(["page", "call", "route", "handler", "function", "db", "publish", "consume"]);
export type StopKind = z.infer<typeof StopKindSchema>;

export const HopSchema = z.object({ confidence: ConfidenceSchema, reason: z.string().optional() });
export type Hop = z.infer<typeof HopSchema>;

export const ChainStopSchema = z.object({
  lane: LaneSchema,
  kind: StopKindSchema,
  repo: z.string(),
  nodeId: z.string().optional(),
  file: z.string(),
  line: z.number().int().positive(),
  symbol: z.string(),
  op: z.string().optional(),
  label: z.string().optional(),
  hop: HopSchema,
  /** Index (in the same chain's `stops`) of the stop this one was reached from; set on every stop but the
   * first, always below the stop's own index. `hop` describes the edge from `stops[from]` to this stop.
   * Optional so chains.json files written before it existed still parse. */
  from: z.number().int().nonnegative().optional(),
});
export type ChainStop = z.infer<typeof ChainStopSchema>;

export const UnresolvedSchema = z.object({ at: LocSchema.extend({ repo: z.string() }), reason: z.string() });
export type Unresolved = z.infer<typeof UnresolvedSchema>;

export const ChainSchema = z.object({
  id: z.string().regex(/^ch_[0-9a-f]{12}$/),
  entry: z.string(),
  routeKey: z.string(),
  name: z.string(),
  stops: z.array(ChainStopSchema),
  unresolved: z.array(UnresolvedSchema),
  confidence: ConfidenceSchema,
  complete: z.boolean(),
  /** H11: ids the same flow has under other entries (sorted, never the chain's own id; absent when none):
   * the route-only id for a chain with a routeKey, and each call stop's call-entry id for a page chain.
   * Readers resolve a journey's chain ids through ids first, then aliases (mcp/state.ts chainLookup). */
  aliases: z.array(z.string()).optional(),
});
export type Chain = z.infer<typeof ChainSchema>;

/** A UI-side HTTP call and whether ≥1 page reaches it (H3b), written by the linker from its own linkUi
 * results. Backend calls, third-party calls and calls with no literal URL are not listed. */
export const UiReachFactSchema = z.object({
  repo: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  symbol: z.string(),
  method: HttpMethodSchema,
  path: z.string(),
  reached: z.boolean(),
});
export type UiReachFact = z.infer<typeof UiReachFactSchema>;

/** `uiReach` was added after version 1 shipped; it is optional (absent in older files, which then yield
 * no ui-unreached items) and sorted by repo, file, line, method, path, symbol. */
/** Each workspace `links` entry and what became of it: `used` (it added a hop to some chain), `unused`
 * (valid, but its `from` matched no chain stop), `broken` (it does not parse or names nothing that exists;
 * `reason` says which). Workspace-file order. Written only when the workspace has links. */
export const ManualLinkStatusSchema = z.object({
  from: z.string(), to: z.string(), status: z.enum(["used", "unused", "broken"]), reason: z.string().optional(),
});
export type ManualLinkStatus = z.infer<typeof ManualLinkStatusSchema>;

/** A UI call to another service (spec §3): `base` is the env var name or host it goes to, `name` the
 * workspace file's `external` entry for that base (when one lists it), `pages` the routes of the pages
 * that reach it (sorted). Never a route match, never broken. */
export const ExternalCallFactSchema = z.object({
  repo: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  symbol: z.string(),
  method: HttpMethodSchema,
  path: z.string(),
  base: z.string(),
  name: z.string().optional(),
  pages: z.array(z.string()),
});
export type ExternalCallFact = z.infer<typeof ExternalCallFactSchema>;

/** `external` is written only when some UI call goes to another service (sorted by repo, file, line,
 * method, path, base). */
export const ChainsFileSchema = z.object({
  version: z.literal(1), chains: z.array(ChainSchema), uiReach: z.array(UiReachFactSchema).optional(),
  manualLinks: z.array(ManualLinkStatusSchema).optional(),
  external: z.array(ExternalCallFactSchema).optional(),
});
export type ChainsFile = z.infer<typeof ChainsFileSchema>;

export const JourneySchema = z.object({
  id: z.string().regex(/^j_[0-9a-f]{12}$/),
  name: z.string(),
  area: z.string(),
  note: z.string(),
  chainIds: z.array(z.string()),
  status: z.enum(["ok", "orphaned"]),
});
export type Journey = z.infer<typeof JourneySchema>;

export const JourneysFileSchema = z.object({ version: z.literal(1), journeys: z.array(JourneySchema) });
export type JourneysFile = z.infer<typeof JourneysFileSchema>;

/** <repo>/.codeloom/summaries.json: agent-written node summaries, keyed by graph node id (sorted with
 * compare). Committed; written only by the save_summary MCP tool. */
export const SummariesFileSchema = z.object({ version: z.literal(1), summaries: z.record(z.string(), z.string()) });
export type SummariesFile = z.infer<typeof SummariesFileSchema>;

// ---------------------------------------------------------------------------------------------------
// <ws>/.codeloom/spec-candidates.json (v0.3 §1): generated by `codeloom index`, committed, deterministic.
// ---------------------------------------------------------------------------------------------------

export const SpecDocHitKindSchema = z.enum(["route", "page", "table", "queue", "symbol"]);
export type SpecDocHitKind = z.infer<typeof SpecDocHitKindSchema>;

/** One mention of a journey term in a doc. `term` is what matched (a route as "METHOD path" when the doc
 * names the method, else its path), `file` the doc's repo-relative path (its repo is in the candidate's `ref`), `line` 1-based. */
export const SpecDocEvidenceSchema = z.object({
  kind: SpecDocHitKindSchema,
  term: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
});
export type SpecDocEvidence = z.infer<typeof SpecDocEvidenceSchema>;

/** One commit naming a ticket key. `commit` is the short sha (7 hex), `file` the journey stop file it
 * touched, repo-relative (the first in sort order), `subject` the commit subject cut to 120 chars. */
export const SpecTicketEvidenceSchema = z.object({
  commit: z.string(),
  file: z.string(),
  subject: z.string().max(120),
});
export type SpecTicketEvidence = z.infer<typeof SpecTicketEvidenceSchema>;

/** A doc candidate: `ref` is `repo:path`; `score` the weighted hits (route 3, page 3, table 2, queue 2,
 * symbol 1; for ordering only); `count` the total number of hits; `evidence` the first 5 hits (doc order). */
export const SpecDocCandidateSchema = z.object({
  ref: z.string(),
  score: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
  evidence: z.array(SpecDocEvidenceSchema).max(5),
});
export type SpecDocCandidate = z.infer<typeof SpecDocCandidateSchema>;

/** A ticket candidate: `ref` is the key; `score` and `count` the number of distinct commits; `evidence`
 * the first 5 of those commits (by repo id, then newest first). */
export const SpecTicketCandidateSchema = z.object({
  ref: z.string(),
  score: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
  evidence: z.array(SpecTicketEvidenceSchema).max(5),
});
export type SpecTicketCandidate = z.infer<typeof SpecTicketCandidateSchema>;

/** Per journey: up to 20 of each, sorted by score desc then ref. */
export const SpecJourneyCandidatesSchema = z.object({
  docs: z.array(SpecDocCandidateSchema).max(20),
  tickets: z.array(SpecTicketCandidateSchema).max(20),
});
export type SpecJourneyCandidates = z.infer<typeof SpecJourneyCandidatesSchema>;

/** Every journey in journeys.json has an entry (empty lists when nothing matched), keys sorted. */
export const SpecCandidatesFileSchema = z.object({
  version: z.literal(1),
  journeys: z.record(z.string(), SpecJourneyCandidatesSchema),
});
export type SpecCandidatesFile = z.infer<typeof SpecCandidatesFileSchema>;

// ---------------------------------------------------------------------------------------------------
// `codeloom check` report (printed with --json; never written to disk).
// ---------------------------------------------------------------------------------------------------

export const CheckItemKindSchema = z.enum([
  "ui-no-route",
  "unmatched-call",
  "handler-not-found",
  "no-store",
  "unresolved-url",
  "route-no-caller",
  "guess-link",
  "ui-unreached",
  "manual-link-broken",
  "manual-link-unused",
  "external-call",
]);
export type CheckItemKind = z.infer<typeof CheckItemKindSchema>;

export const CheckItemSchema = z.object({
  kind: CheckItemKindSchema,
  repo: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  symbol: z.string(),
  detail: z.string(),
});
export type CheckItem = z.infer<typeof CheckItemSchema>;

/** `codeloom check --traces`: the map compared with runtime traces (check/traces/compare.ts). Every list
 * is sorted with `compare`. */
export const TracesReportSchema = z.object({
  source: z.enum(["tempo", "otlp-file"]),
  spans: z.number().int(),
  serverSpans: z.number().int(),
  /** stores: "table:<name> <op>" / "queue:<name> publish" seen under that route and present in the map. */
  confirmed: z.array(z.object({ routeKey: z.string(), hits: z.number().int(), stores: z.array(z.string()) })),
  missingInMap: z.array(z.object({
    repo: z.string(),
    kind: z.enum(["route", "store"]),
    method: z.string().optional(),
    route: z.string().optional(),
    store: z.string().optional(),
    hits: z.number().int(),
    detail: z.string(),
  })),
  /** routeKeys of api routes in chains with no server span. */
  neverHit: z.array(z.string()),
  /** Service names mapped to no repo. */
  unmatchedServices: z.array(z.string()),
});
export type TracesReport = z.infer<typeof TracesReportSchema>;

/** The trace comparison did not run; one-line reason. */
export const TracesSkippedSchema = z.object({ skipped: z.string() });
export type TracesSkipped = z.infer<typeof TracesSkippedSchema>;

export const CheckReportSchema = z.object({
  version: z.literal(1),
  summary: z.object({
    /** chains = complete + apiOnly + missingDb + brokenUiApi (each chain lands in exactly one). */
    chains: z.number().int(),
    /** Has a UI stop (page or call) and reaches a database table or queue: UI → API → DB. */
    complete: z.number().int(),
    /** Reaches a store but has no UI stop (a route or consumer no UI code calls): API → DB only. */
    apiOnly: z.number().int(),
    missingDb: z.number().int(),
    brokenUiApi: z.number().int(),
    /** Chains with a UI stop: `--fail-under` compares complete / uiChains. */
    uiChains: z.number().int(),
    /** Every route in the workspace, and those a page or UI call reaches (routes = routesWithUiCaller +
     * uncalledRoutes). */
    routes: z.number().int(),
    routesWithUiCaller: z.number().int(),
    /** Calls whose URL codeloom could not read (`unresolved-url` items). Per call, not per chain: never
     * part of chains = complete + apiOnly + missingDb + brokenUiApi. */
    unresolvedCalls: z.number().int(),
    uncalledRoutes: z.number().int(),
    /** UI calls to other services (`external-call` items): info only, never broken, never in the buckets. */
    externalCalls: z.number().int(),
    byConfidence: z.object({ exact: z.number().int(), param: z.number().int(), guess: z.number().int() }),
  }),
  items: z.array(CheckItemSchema),
  traces: z.union([TracesReportSchema, TracesSkippedSchema]).optional(),
});
export type CheckReport = z.infer<typeof CheckReportSchema>;

// ---------------------------------------------------------------------------------------------------
// Answer key (fixtures/<app>/expected-journeys.json) — what the linker should find, written by hand.
// ---------------------------------------------------------------------------------------------------

export const ExpectedHopSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ui-api"),
    from: z.object({ repo: z.string(), file: z.string(), symbol: z.string() }),
    to: z.object({ repo: z.string(), method: HttpMethodSchema, path: z.string() }),
  }),
  z.object({
    type: z.literal("route-handler"),
    route: z.string(),
    handler: z.object({ file: z.string(), symbol: z.string() }),
  }),
  z.object({
    type: z.literal("handler-store"),
    route: z.string(),
    table: z.string().optional(),
    queue: z.string().optional(),
    op: z.string(),
  }),
]);
export type ExpectedHop = z.infer<typeof ExpectedHopSchema>;

export const ExpectedJourneysSchema = z.object({
  version: z.literal(1),
  source: z.object({ url: z.string(), sha: z.string(), licence: z.string() }),
  hops: z.array(ExpectedHopSchema),
});
export type ExpectedJourneys = z.infer<typeof ExpectedJourneysSchema>;
