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
});
export type UiPage = z.infer<typeof UiPageSchema>;

export const HttpCallSchema = z.object({
  method: HttpMethodSchema,
  path: z.string(),
  raw: z.string(),
  resolved: z.boolean(),
  client: z.string(),
  at: LocSchema,
});
export type HttpCall = z.infer<typeof HttpCallSchema>;

export const RouteSchema = z.object({
  method: HttpMethodSchema,
  path: z.string(),
  handler: z.string(),
  inline: z.boolean(),
  framework: z.enum(["adonis", "express", "fastify", "nest", "next-api"]),
  at: LocSchema,
  /** Repo-relative file holding the handler's code, when codeloom could find it. */
  handlerFile: z.string().optional(),
  /** First and last line of the handler function, for inline handlers (and Nest methods). */
  handlerLines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});
export type Route = z.infer<typeof RouteSchema>;

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
  queue: z.string(),
  op: z.enum(["publish", "consume"]),
  at: LocSchema,
});
export type QueueOp = z.infer<typeof QueueOpSchema>;

export const EndpointsFileSchema = z.object({
  version: z.literal(1),
  repo: z.string(),
  pages: z.array(UiPageSchema),
  httpCalls: z.array(HttpCallSchema),
  routes: z.array(RouteSchema),
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

export const RepoRefSchema = z.object({ id: z.string(), path: z.string() });
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const WorkspaceFileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  repos: z.array(RepoRefSchema),
  links: z.array(z.object({ from: z.string(), to: z.string() })),
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
    z.object({ hash: z.string(), structure: z.any(), calls: z.any(), endpoints: z.any() }),
  ),
});
export type Fingerprints = z.infer<typeof FingerprintsSchema>;
