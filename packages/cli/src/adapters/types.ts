import type ts from "typescript";
import type { QFlowFile } from "./queue-flow.js";
import type {
  DbAccess, ExchangeDef, HttpCall, HttpClient, Loc, ModelDef, Mount, QueueOp, Route, RouterDef, TableDef, UiPage,
} from "../store/schemas.js";

/** A route as an adapter sees it: `handlerImport` is the raw module specifier of an imported
 * handler, resolved to `handlerFile` by the indexer (which knows every file and alias) and then dropped. */
export type RouteDraft = Route & {
  handlerImport?: string;
  /** Adonis: the export name of the top-level exported function this route is registered in; another file's
   * call of it (a `RouteRegistrarDraft`) supplies the group prefix and namespace around it. */
  registeredIn?: string;
  /** Adonis v5: the string handler's controller path when its namespace did not come from this file
   * (`"Admin/CustomersController"`), so a caller's group namespace can still be put in front of it. */
  adonisController?: string;
};

/** Adonis: a call that may register another function's routes (`adminRoutes()` inside a group). `spec` (an
 * import) or `file` (this file) + `export` name the function; `prefix`/`namespace` are the groups around the
 * call; `registeredIn` when the call itself sits in an exported function. Resolved by `finalizeEndpoints`. */
export interface RouteRegistrarDraft {
  spec?: string;
  file?: string;
  export: string;
  prefix: string;
  namespace?: string;
  registeredIn?: string;
  at: Loc;
}

/** A mount as an adapter sees it: `targetImport` is the raw module specifier of an imported router/plugin,
 * resolved to `target.file` by `finalizeEndpoints` (which knows every file and alias) and then dropped. */
export type MountDraft = Mount & {
  targetImport?: string;
  /** Raw specifier of an imported `on` receiver; resolved to `onFile` by `finalizeEndpoints`. */
  onImport?: string;
};

/** A DB access as an adapter sees it: `modelImport` is the raw module specifier a model was default-imported
 * from, resolved by `finalizeEndpoints` to that file's model class (so a local alias never becomes the model
 * name) and then dropped. */
export type DbAccessDraft = DbAccess & { modelImport?: string };
/** An HTTP call as an adapter sees it: `clientImport` marks a call on an imported binding (`svc.get(url)`,
 * `client(config)`) that is only an HTTP call if that binding is an exported HTTP client instance;
 * `finalizeEndpoints` checks it (keeping the call under the instance's own name) and drops the field. */
export type HttpCallDraft = HttpCall & { clientImport?: { from: string; name: string } };

/** An HTTP client as an adapter sees it: `exportNames` are the names other files can import it under
 * ("default" for the default export); used by `finalizeEndpoints`, then dropped. */
export type HttpClientDraft = HttpClient & { exportNames?: string[] };

/** A module re-export (`export * from "./x"` / `export { a as b } from "./x"`), so `finalizeEndpoints` can
 * follow an imported HTTP client through barrel files (v0.2a). Never written to endpoints.json. */
export type ReExportDraft =
  | { file: string; kind: "all"; from: string }
  | { file: string; kind: "named"; exported: string; imported: string; from: string };

// ---------------------------------------------------------------------------------------------------
// v0.6 Task B (spec §3): RabbitMQ through the repo's own wrappers. A queue/exchange/routing-key name
// that is one import hop away (an enum/const-object/static-readonly member exported by another file)
// cannot be resolved inside a single file's adapter pass, so it is carried as a draft through
// `EndpointsPart` and resolved once in `finalizeEndpoints`, the same way `HttpCallDraft.clientImport`
// and `DbAccessDraft.modelImport` already are. Never written to endpoints.json; never guessed.
// ---------------------------------------------------------------------------------------------------

/** A name one import hop away: `importedName` is the ORIGINAL exported name in `from` (not the local
 * alias); `member` the property/enum-member read off it (`Queues.INVOICE_CREATED` -> `{ from, importedName:
 * "Queues", member: "INVOICE_CREATED" }`), or undefined for a bare re-exported const
 * (`import { ORDERS_QUEUE } from "./c"` -> `{ from, importedName: "ORDERS_QUEUE" }`, the whole export
 * IS the value). */
export interface PendingLiteral {
  from: string;
  importedName: string;
  member?: string;
}

/** A queue identity value: already known, or one import hop away. */
export type QueueResolved = { literal: string } | { pending: PendingLiteral };

/** A queue op not yet fully resolved within its own file: at least one of its identity values is a
 * `PendingLiteral`. `shape` picks how `queue` is finally encoded (mirrors the cases `adapters/queues.ts`
 * already handles for direct amqplib calls): "name" for sendToQueue/consume (`name` is the queue),
 * "exchange-key" for an exchange publish (`queue` becomes `exchange:routingKey`), "bind" for bindQueue
 * (`name` is the bound queue, `exchange`/`routingKey` the binding). `handlerArg` (consume only): the
 * argument index, at the resolved op's own `at` call site, holding the message handler — works for a
 * wrapper of any method name or a bare function, not just a literal `.consume(...)` property (review
 * round 1, critical 1; the linker reads this instead of assuming the property name). */
export interface QueueOpDraft {
  shape: "name" | "exchange-key" | "bind";
  op: "publish" | "consume" | "bind";
  at: Loc;
  name?: QueueResolved;
  exchange?: QueueResolved;
  routingKey?: QueueResolved;
  handlerArg?: number;
}

/** An `assertExchange(name, type)` declaration not yet fully resolved within its own file (review round
 * 1, item 8) — the counterpart to `QueueOpDraft` for exchange *declarations* rather than publish/consume/
 * bind ops. `type` must resolve to one of amqplib's four exchange kinds; anything else is dropped (never
 * guessed — a typo'd or dynamic exchange type names nothing). */
export interface ExchangeOpDraft {
  at: Loc;
  name: QueueResolved;
  type: QueueResolved;
}

/** A file's own exported enum / `as const` object / class-with-static-members, keyed by its export
 * name, for resolving another file's `PendingLiteral` one hop away. A bare exported `const X = "literal"`
 * is also carried here, under the reserved member key `""` (`PendingLiteral.member === undefined` reads
 * that key). */
export interface QueueLiteralExport {
  file: string;
  name: string;
  members: Record<string, string>;
}

/** A recognised amqplib method whose leading arguments carry identity (the message/payload is never
 * inspected, except `consume`'s handler argument — tracked separately as `handlerParamIndex`).
 * `assertExchange` (review round 1, item 8) is here too: a wrapper can mix it with the other three in the
 * same body (review round 1, item 7 — "subscribe" asserting an exchange, binding, then consuming). */
export type QueueWrapperMethod = "sendToQueue" | "publish" | "consume" | "bindQueue" | "assertExchange";

/** One identity argument of the wrapper's own inner amqplib call: fixed at the wrapper's own
 * definition (`literal`), or that same position in the wrapper's OWN parameter list, forwarded as-is
 * (`paramIndex`) — so a call site's own argument at that index becomes this identity value.
 * `fallbackLiteral` is that parameter's own default value (`queue = DEFAULT_QUEUE`), already resolved at
 * wrapper-discovery time in this file's own scope, used when a call site omits the argument entirely.
 * Neither `literal` nor `paramIndex` set means this position could not be read at all (never guessed; a
 * call through this wrapper can never resolve this slot). */
export interface QueueWrapperSlot {
  literal?: string;
  paramIndex?: number;
  fallbackLiteral?: string;
}

/** One amqplib call inside a wrapper's body: which method it is, how each of that method's identity
 * arguments is produced, and (consume only) which of the wrapper's own parameters forwards into the
 * inner call's handler argument — so a call site's `handlerArg` is just that same index, positions being
 * preserved 1:1 through forwarding. */
export interface QueueWrapperOp {
  methodName: QueueWrapperMethod;
  slots: QueueWrapperSlot[];
  handlerParamIndex?: number;
}

/** A wrapper function/method's shape: every amqplib call its body makes (review round 1, item 7 — a
 * single wrapper can assert an exchange, bind a queue and consume it, all in one call site). */
export interface QueueWrapper {
  ops: QueueWrapperOp[];
}

/** A wrapper this file exports under `name` — a bare function/const-arrow's own export name, or
 * `ExportedClassOrInstanceName.methodName` for a class method reached through an exported class or an
 * exported singleton instance of a locally-declared class (including a default export, and a later
 * `export { x }` list). Lets another file's `queueWrapperCalls` resolve one import hop away, the same way
 * `queueLiteralExports` does for a plain literal name. */
export interface QueueWrapperExport {
  file: string;
  name: string;
  wrapper: QueueWrapper;
}

/** A direct amqplib reading of a call site — the pre-0.6 interpretation, kept as a fallback on a
 * `QueuePendingWrapperCall` (review round 2, critical 1): the imported name a repo-relative call targets
 * is very often not a wrapper at all but a plain re-exported channel value
 * (`export const channel = await conn.createChannel();`), which this file cannot tell apart from a real
 * wrapper import ahead of time. Used only when no wrapper resolves at the other end. */
export type DirectOpDraft = { kind: "queue"; draft: QueueOpDraft } | { kind: "exchange"; draft: ExchangeOpDraft };

/** A call, in this file, to what might be another file's exported queue wrapper (`import { queueService }
 * from "./queue-service"; queueService.publish(Queues.ORDER_CREATED, payload)`) — the receiver/callee is
 * bound to an import (a relative/alias/`#` specifier — never a bare package: see `isLikelyRepoImport`)
 * this file cannot itself resolve as a wrapper. `args` are this call's own arguments, already resolved in
 * THIS file's scope (literal, local-map, or themselves one-hop-pending); `method` is the property called
 * (undefined for a bare call to an imported function). Resolved in `finalizeEndpoints` once the imported
 * module's own `queueWrapperExports` are known; dropped if nothing matches there and there is no
 * `fallbackDirect` either (never guessed — most calls to an imported function are not a queue wrapper at
 * all, and simply resolve to nothing). */
export interface QueuePendingWrapperCall {
  at: Loc;
  from: string;
  importedName: string;
  method?: string;
  args: Array<QueueResolved | undefined>;
  fallbackDirect?: DirectOpDraft;
}

export interface ParsedFile {
  rel: string;
  content: string;
  /** Present for JS/TS files. */
  sf?: ts.SourceFile;
}

/** What adapters know about the package a file belongs to. */
export interface AdapterContext {
  /** Dependencies of the file's nearest package.json at or above it, plus the repo root's. */
  deps: Set<string>;
  /** Repo-relative folder of that package.json ("" for the repo root, or when there is none). */
  packageRoot: string;
  /** Adonis v5: the package's `.adonisrc.json` `namespaces.httpControllers`, when it sets one. */
  adonisControllers?: string;
}

/** Per-file adapter contexts for a whole repo. */
export interface RepoContext {
  contextFor(rel: string): AdapterContext;
  /** Changes whenever any package's dependencies change (part of the cache key). */
  key: string;
}

/** `rel` with its package root removed, so framework folders (app/, pages/) match package-relative. */
export function packageRelative(rel: string, ctx: AdapterContext): string | undefined {
  if (!ctx.packageRoot) return rel;
  return rel.startsWith(`${ctx.packageRoot}/`) ? rel.slice(ctx.packageRoot.length + 1) : undefined;
}

export interface EndpointsPart {
  pages: UiPage[];
  httpCalls: HttpCallDraft[];
  httpClients: HttpClientDraft[];
  routes: RouteDraft[];
  mounts: MountDraft[];
  routers: RouterDef[];
  dbAccess: DbAccessDraft[];
  tables: TableDef[];
  models: ModelDef[];
  queues: QueueOp[];
  /** v0.6 Task B: queue ops needing a one-import-hop literal before they can be finalized. */
  queueDrafts: QueueOpDraft[];
  /** v0.6 Task B: this file's own exported literal maps, for resolving another file's `queueDrafts`
   * and `queueWrapperCalls`. */
  queueLiteralExports: QueueLiteralExport[];
  /** v0.6 Task B: this file's own exported wrappers, for resolving another file's `queueWrapperCalls`. */
  queueWrapperExports: QueueWrapperExport[];
  /** v0.6 Task B: calls in this file to what might be another file's exported wrapper. */
  queueWrapperCalls: QueuePendingWrapperCall[];
  /** v0.6 Task B review round 1 (item 8): `assertExchange` declarations, resolved. */
  exchanges: ExchangeDef[];
  /** v0.6 Task B review round 1 (item 8): `assertExchange` declarations needing one import hop. */
  exchangeDrafts: ExchangeOpDraft[];
  /** v0.6 queues fix: this file's queue-flow summary (classes, functions, amqplib calls), settled with every
   * other file's in `finalizeEndpoints`. */
  queueFlow: QFlowFile[];
  reExports: ReExportDraft[];
  /** Adonis: calls that may register another function's routes. */
  routeRegistrars: RouteRegistrarDraft[];
}

export function emptyPart(): EndpointsPart {
  return {
    pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [], routers: [], dbAccess: [], tables: [], models: [],
    queues: [], queueDrafts: [], queueLiteralExports: [], queueWrapperExports: [], queueWrapperCalls: [],
    exchanges: [], exchangeDrafts: [], queueFlow: [], reExports: [], routeRegistrars: [],
  };
}
