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
  target: z.object({ name: z.string().optional(), file: z.string().optional() }),
  at: LocSchema,
});
export type Mount = z.infer<typeof MountSchema>;

export const DbOpSchema = z.enum(["read", "insert", "update", "delete"]);
export type DbOp = z.infer<typeof DbOpSchema>;

export const DbAccessSchema = z.object({
  table: z.string().optional(),
  model: z.string().optional(),
  op: DbOpSchema,
  via: z.enum(["lucid", "prisma", "typeorm", "drizzle", "query-builder", "sql"]),
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
  source: z.enum(["lucid", "typeorm", "prisma", "drizzle"]),
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
  z.object({ kind: z.literal("otlp-file"), path: z.string() }),
]);
export type TracesConfig = z.infer<typeof TracesConfigSchema>;

export const WorkspaceFileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  repos: z.array(RepoRefSchema),
  /** Manual hops. Strings use the chain-stop address form "<repo>:<file>#<symbol>" or
   * "route:<repo>:<METHOD path>" / "queue:<repo>:<queue>" (see R11 parseLinkRef, Task 11). */
  links: z.array(z.object({ from: z.string(), to: z.string() })),
  traces: TracesConfigSchema.optional(),
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
});
export type Chain = z.infer<typeof ChainSchema>;

export const ChainsFileSchema = z.object({ version: z.literal(1), chains: z.array(ChainSchema) });
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

// ---------------------------------------------------------------------------------------------------
// `codeloom check` report (printed with --json; never written to disk).
// ---------------------------------------------------------------------------------------------------

export const CheckItemKindSchema = z.enum([
  "unmatched-call",
  "handler-not-found",
  "no-store",
  "unresolved-url",
  "route-no-caller",
  "guess-link",
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

export const CheckReportSchema = z.object({
  version: z.literal(1),
  summary: z.object({
    chains: z.number().int(),
    complete: z.number().int(),
    missingDb: z.number().int(),
    brokenUiApi: z.number().int(),
    unresolvedCalls: z.number().int(),
    uncalledRoutes: z.number().int(),
    byConfidence: z.object({ exact: z.number().int(), param: z.number().int(), guess: z.number().int() }),
  }),
  items: z.array(CheckItemSchema),
  traces: z.unknown().optional(),
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
