import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import type { DbAccess, EndpointsFile, ExchangeDef, HttpCall, HttpClient, Mount, QueueOp, QueueUnknown, Route, TableDef } from "../store/schemas.js";
import { compare } from "../util.js";
import { JS_EXT, parseSource, pascal } from "./ast.js";
import { detectDb } from "./db.js";
import { detectHttpCalls, detectHttpClientDrafts, detectImportedClientCalls, detectReExports } from "./http-calls.js";
import { detectPages } from "./pages.js";
import { extractQueueFlow } from "./queue-flow.js";
import { solveQueueFlow } from "./queue-solve.js";
import { collectQueueOps, detectQueueLiteralExports, detectQueueWrapperExports, resolveExchangeOpDraft, resolveQueueOpDraft, resolveQueueWrapperCall } from "./queues.js";
import { adonisNamespaced, detectMounts, detectRouteRegistrars, detectRouters, detectRoutes } from "./routes.js";
import { normalizePath } from "./ast.js";
import {
  type AdapterContext, type DbAccessDraft, type EndpointsPart, emptyPart, type ExchangeOpDraft, type HttpCallDraft, type HttpClientDraft,
  type MountDraft, type ParsedFile, type PendingLiteral, type QueueOpDraft, type QueuePendingWrapperCall, type QueueWrapper,
  type ReExportDraft, type RepoContext, type RouteDraft, type RouteRegistrarDraft,
} from "./types.js";

function readDeps(abs: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(abs, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[key] ?? {})) deps.add(name);
    }
  } catch {
    // A broken package.json only means fewer adapters apply.
  }
  return deps;
}

/** Adonis v5's `.adonisrc.json` `namespaces.httpControllers` (`App/Controllers/Http` when unset). */
function readAdonisControllers(abs: string): string | undefined {
  try {
    const rc = ts.parseConfigFileTextToJson(abs, readFileSync(abs, "utf8")).config as { namespaces?: { httpControllers?: unknown } } | undefined;
    const ns = rc?.namespaces?.httpControllers;
    return typeof ns === "string" && ns.trim() !== "" ? ns.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Each file gets the deps of its nearest package.json at or above it (unioned with the repo
 * root's, for hoisted monorepo deps) and that package's folder; no package.json above -> empty set.
 * A package with an `.adonisrc.json` that sets the controllers namespace passes it on too. */
export function loadContext(repoAbs: string, files: string[]): RepoContext {
  const byDir = new Map<string, Set<string>>();
  const adonisNs = new Map<string, string>();
  for (const rel of files) {
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    if (rel === ".adonisrc.json" || rel.endsWith("/.adonisrc.json")) {
      const ns = readAdonisControllers(join(repoAbs, rel));
      if (ns !== undefined) adonisNs.set(dir, ns);
    }
    if (rel !== "package.json" && !rel.endsWith("/package.json")) continue;
    byDir.set(dir, readDeps(join(repoAbs, rel)));
  }
  const rootDeps = byDir.get("") ?? new Set<string>();
  const contexts = new Map<string, AdapterContext>();
  const forDir = (dir: string): AdapterContext => {
    const cached = contexts.get(dir);
    if (cached) return cached;
    let ctx: AdapterContext;
    if (byDir.has(dir)) {
      const ns = adonisNs.get(dir);
      ctx = { deps: new Set([...rootDeps, ...byDir.get(dir)!]), packageRoot: dir, ...(ns !== undefined ? { adonisControllers: ns } : {}) };
    }
    else if (dir === "") ctx = { deps: new Set(), packageRoot: "" };
    else ctx = forDir(posix.dirname(dir) === "." ? "" : posix.dirname(dir));
    contexts.set(dir, ctx);
    return ctx;
  };
  const key = [...byDir.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([dir, deps]) => `${dir || "."}:${[...deps].sort().join("|")}${adonisNs.has(dir) ? `@${adonisNs.get(dir)}` : ""}`)
    .join(";");
  return {
    key,
    contextFor: (rel) => forDir(posix.dirname(rel) === "." ? "" : posix.dirname(rel)),
  };
}

export function runAdapters(rel: string, content: string, ctx: AdapterContext): EndpointsPart {
  const part = emptyPart();
  const isJs = JS_EXT.test(rel) && !rel.endsWith(".d.ts");
  if (!isJs && !rel.endsWith(".prisma") && !rel.endsWith(".sql")) return part;
  const file: ParsedFile = { rel, content, sf: isJs ? parseSource(rel, content) : undefined };
  part.pages.push(...detectPages(file, ctx));
  part.httpCalls.push(...detectHttpCalls(file), ...detectImportedClientCalls(file));
  part.httpClients.push(...detectHttpClientDrafts(file));
  part.reExports.push(...detectReExports(file));
  part.routes.push(...detectRoutes(file, ctx));
  part.routeRegistrars.push(...detectRouteRegistrars(file, ctx));
  part.mounts.push(...detectMounts(file, ctx));
  part.routers.push(...detectRouters(file, ctx));
  const db = detectDb(file, ctx);
  part.dbAccess.push(...db.dbAccess);
  part.tables.push(...db.tables);
  part.models.push(...db.models);
  const queues = collectQueueOps(file, ctx);
  part.queues.push(...queues.resolved);
  part.queueDrafts.push(...queues.drafts);
  part.queueWrapperCalls.push(...queues.wrapperCalls);
  part.exchanges.push(...queues.exchanges);
  part.exchangeDrafts.push(...queues.exchangeDrafts);
  part.queueLiteralExports.push(...detectQueueLiteralExports(file, ctx));
  part.queueWrapperExports.push(...detectQueueWrapperExports(file, ctx));
  const flow = extractQueueFlow(file, ctx);
  if (flow) part.queueFlow.push(flow);
  return part;
}

/** Turn a draft route's handlerImport into handlerFile, and drop the internal field. Never mutates
 * the draft (drafts are cached and must keep their specifier for later runs). */
function resolveHandler(draft: RouteDraft, resolve?: ImportResolver): Route {
  const { handlerImport, registeredIn: _in, adonisController: _ctrl, ...route } = draft;
  if (handlerImport && !route.handlerFile && resolve) {
    const file = resolve(route.at.file, handlerImport);
    if (file) route.handlerFile = file;
  }
  return route;
}

/** Turn a draft mount's targetImport into target.file and its onImport into onFile, and drop the internal
 * fields. A mount onto an imported receiver that resolves to no repo file (`i18n.use(...)` with i18n from a
 * package) is not a router mount: it is dropped, unless the receiver is a top-level name (app/server). */
function resolveMount(draft: MountDraft, resolve?: ImportResolver): Mount | undefined {
  const { targetImport, onImport, ...mount } = draft;
  if (targetImport && !mount.target.file && resolve) {
    const file = resolve(mount.at.file, targetImport);
    if (file) mount.target = { ...mount.target, file };
  }
  if (onImport !== undefined) {
    const file = resolve?.(mount.at.file, onImport);
    if (file) return { ...mount, onFile: file };
    const { onExport: _unused, ...rest } = mount;
    return TOP_LEVEL_NAMES.has(mount.on) ? rest : undefined;
  }
  return mount;
}

const TOP_LEVEL_NAMES = new Set(["app", "server", "fastify"]);

const REGISTRAR_MAX_DEPTH = 4;

/** Where a registering function's routes end up: the group prefix and namespace around each call of it.
 * `unsure` when a call sits in another exported function that nothing visible calls. */
type Placement = { prefix: string; namespace?: string; unsure?: true };

/** Adonis: a route registered inside an exported function (`export default () => { Route.get(...) }`) takes
 * the group prefix and namespace around each call of that function in another file (`Route.group(() => {
 * adminRoutes() }).prefix("/api").namespace(...)`), following calls in calls up to REGISTRAR_MAX_DEPTH. One
 * route per distinct placement. With no visible call, the route stays as written and, when a caller's
 * namespace could have changed its controller, its handler is marked a guess. */
function placeRegisteredRoutes(routes: RouteDraft[], registrars: RouteRegistrarDraft[], resolve?: ImportResolver): RouteDraft[] {
  if (!routes.some((r) => r.registeredIn !== undefined)) return routes;
  const calls = new Map<string, RouteRegistrarDraft[]>();
  for (const c of registrars) {
    const file = c.file ?? (c.spec !== undefined ? resolve?.(c.at.file, c.spec) : null);
    if (!file) continue;
    const key = `${file}\0${c.export}`;
    calls.set(key, [...(calls.get(key) ?? []), c]);
  }
  const placements = (file: string, exp: string, depth: number): Placement[] | undefined => {
    const found = calls.get(`${file}\0${exp}`);
    if (!found || depth > REGISTRAR_MAX_DEPTH) return undefined;
    const out: Placement[] = [];
    for (const c of found) {
      const own: Placement = { prefix: c.prefix, ...(c.namespace !== undefined ? { namespace: c.namespace } : {}) };
      const outer = c.registeredIn !== undefined ? placements(c.at.file, c.registeredIn, depth + 1) : [{ prefix: "" }];
      if (!outer) {
        out.push({ ...own, unsure: true });
        continue;
      }
      for (const o of outer) {
        const namespace = own.namespace ?? o.namespace;
        out.push({ prefix: `${o.prefix}/${own.prefix}`, ...(namespace !== undefined ? { namespace } : {}), ...(o.unsure ? { unsure: true as const } : {}) });
      }
    }
    return out;
  };
  const out: RouteDraft[] = [];
  for (const r of routes) {
    if (r.registeredIn === undefined) {
      out.push(r);
      continue;
    }
    const places = placements(r.at.file, r.registeredIn, 0);
    if (!places) {
      out.push(r.adonisController !== undefined ? { ...r, handlerGuess: true } : r);
      continue;
    }
    const seen = new Set<string>();
    for (const p of places) {
      const path = normalizePath(`${p.prefix}/${r.path}`);
      const handlerImport = r.adonisController !== undefined && p.namespace !== undefined
        ? adonisNamespaced(p.namespace, r.adonisController) : r.handlerImport;
      const guess = p.unsure && r.adonisController !== undefined;
      const key = `${path}\0${handlerImport ?? ""}\0${guess}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { handlerImport: _old, ...rest } = r;
      const prefix = normalizePath(p.prefix);
      out.push({
        ...rest, path, ...(handlerImport !== undefined ? { handlerImport } : {}), ...(guess ? { handlerGuess: true as const } : {}),
        ...(prefix !== "/" && path.startsWith(`${prefix}/`) ? { registeredPrefix: prefix } : {}),
      });
    }
  }
  return out;
}

/** Turn a draft access's default-import `modelImport` into the imported file's model class (its local name
 * may be any alias) and that file's table, and drop the internal field. Falls back to the import path's
 * naming convention (`#models/invoice_line` -> `InvoiceLine`) when the file is not resolved or defines no model. */
function resolveModelImport(draft: DbAccessDraft, modelsByFile: Map<string, { model: string; table: string }>, resolve?: ImportResolver): DbAccess {
  const { modelImport, ...access } = draft;
  if (modelImport === undefined) return access;
  const file = resolve?.(access.at.file, modelImport);
  const fromFile = file ? modelsByFile.get(file) : undefined;
  if (fromFile) return { ...access, model: fromFile.model, table: access.table ?? fromFile.table };
  const base = modelImport.split("/").pop()!.replace(/\.(m|c)?[jt]sx?$/, "");
  const model = pascal(base) || access.model;
  return model ? { ...access, model } : access;
}

/** Model name -> its table, only for names that map to exactly one table across the repo (an ambiguous
 * name resolves to no table rather than to whichever definition came first). */
function uniqueTables(models: Array<{ model: string; table: string }>, key: (model: string) => string): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const m of models) {
    const k = key(m.model);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k)!.add(m.table);
  }
  const out = new Map<string, string>();
  for (const [k, tables] of seen) if (tables.size === 1) out.set(k, [...tables][0]!);
  return out;
}

/** Keep a call on an imported binding only when that binding is an HTTP client instance exported by the
 * module it comes from; the call then carries the instance's own name (so its baseURL applies). Plain
 * calls pass through without their draft field. */
function resolveImportedClient(
  call: HttpCallDraft, clients: HttpClientDraft[], reExports: ReExportDraft[], resolve?: ImportResolver,
): HttpCall | undefined {
  const { clientImport, ...plain } = call;
  if (!clientImport) return plain;
  const file = resolve?.(call.at.file, clientImport.from);
  if (!file || !resolve) return undefined;
  const client = exportedClient(file, clientImport.name, clients, reExports, resolve, 0);
  return client ? { ...plain, client: client.name } : undefined;
}

const CLIENT_BARREL_MAX_HOPS = 3;

/** The HTTP client instance `file` exports under `name`: declared there, else followed through its
 * re-exports (`export *` never forwards "default"), up to CLIENT_BARREL_MAX_HOPS files further (v0.2a). */
function exportedClient(
  file: string, name: string, clients: HttpClientDraft[], reExports: ReExportDraft[], resolve: ImportResolver, hops: number,
): HttpClientDraft | undefined {
  const own = clients.find((c) => c.file === file && c.exportNames?.includes(name));
  if (own || hops >= CLIENT_BARREL_MAX_HOPS) return own;
  for (const re of reExports) {
    if (re.file !== file) continue;
    const next = re.kind === "all" ? (name === "default" ? undefined : name) : re.exported === name ? re.imported : undefined;
    if (next === undefined) continue;
    const target = resolve(file, re.from);
    const hit = target ? exportedClient(target, next, clients, reExports, resolve, hops + 1) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function stripClientDraft(c: HttpClientDraft): HttpClient {
  const { exportNames: _unused, ...client } = c;
  return client;
}

const byLoc = <T extends { at: { file: string; line: number } }>(a: T, b: T) =>
  compare(a.at.file, b.at.file) || a.at.line - b.at.line;

const byHttpClient = (a: HttpClient, b: HttpClient) =>
  compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name);

const byMount = (a: Mount, b: Mount) =>
  compare(a.at.file, b.at.file) || a.at.line - b.at.line || compare(a.prefix, b.prefix) || compare(a.on, b.on) ||
  compare(a.target.name ?? "", b.target.name ?? "") || compare(a.target.file ?? "", b.target.file ?? "");

const byQueue = (a: QueueOp, b: QueueOp) =>
  byLoc(a, b) || compare(a.op, b.op) || compare(a.exchange ?? "", b.exchange ?? "") || compare(a.routingKey ?? "", b.routingKey ?? "");

const byExchange = (a: ExchangeDef, b: ExchangeDef) => byLoc(a, b) || compare(a.name, b.name) || compare(a.type, b.type);

/** A queue op's identity without its handler details: the same op found by the wrapper pass and by the class
 * flow is kept once (the class flow's, which may know its handler). */
const queueKey = (q: QueueOp) => `${q.at.file}:${q.at.line}\0${q.op}\0${q.queue}\0${q.exchange ?? ""}\0${q.routingKey ?? ""}`;
const exchangeKey = (e: ExchangeDef) => `${e.at.file}:${e.at.line}\0${e.name}\0${e.type}`;

const byUnknown = (a: QueueUnknown, b: QueueUnknown) =>
  byLoc(a, b) || compare(a.op, b.op) || compare(a.queue ?? a.exchange ?? "", b.queue ?? b.exchange ?? "");

/** Task B's ops plus the class flow's (queue-solve.ts), each op once, in a stable order. */
function mergeQueues(wrapperPass: QueueOp[], flow: QueueOp[]): QueueOp[] {
  const flowKeys = new Set(flow.map(queueKey));
  const seen = new Set<string>();
  const out: QueueOp[] = [];
  for (const q of [...wrapperPass.filter((q) => !flowKeys.has(queueKey(q))), ...flow]) {
    const k = `${queueKey(q)}\0${q.handler?.symbol ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(q);
    }
  }
  return out.sort((a, b) => byQueue(a, b) || compare(a.queue, b.queue) || compare(a.handler?.symbol ?? "", b.handler?.symbol ?? ""));
}

function mergeExchanges(wrapperPass: ExchangeDef[], flow: ExchangeDef[]): ExchangeDef[] {
  const seen = new Map<string, ExchangeDef>();
  for (const e of [...wrapperPass, ...flow]) if (!seen.has(exchangeKey(e))) seen.set(exchangeKey(e), e);
  return [...seen.values()].sort(byExchange);
}

/** Resolves a module specifier written in `fromRel` to a repo file (null when it is not in the repo). */
export type ImportResolver = (fromRel: string, specifier: string) => string | null;

const QUEUE_EXPORT_BARREL_MAX_HOPS = 3;

/** v0.6 Task B: `queueLiteralExports` (every file's own exported enum/`as const` object/static-member
 * map, or bare const under the reserved member key `""`), reshaped for a one-import-hop lookup: file ->
 * export name -> member -> value. */
function queueLiteralIndex(exports: EndpointsPart["queueLiteralExports"]): Map<string, Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, Map<string, string>>>();
  for (const e of exports) {
    const byName = out.get(e.file) ?? new Map<string, Map<string, string>>();
    byName.set(e.name, new Map(Object.entries(e.members)));
    out.set(e.file, byName);
  }
  return out;
}

/** `reExports`, grouped by their own file once (review round 2, item 2 — `literalExportAt`/
 * `wrapperExportAt` used to scan the FULL list on every single lookup: measured 14.5s at 40 re-export
 * barrels × 400 callers × 10k pending calls). */
function reExportsByFile(reExports: ReExportDraft[]): Map<string, ReExportDraft[]> {
  const out = new Map<string, ReExportDraft[]>();
  for (const re of reExports) {
    const arr = out.get(re.file);
    if (arr) arr.push(re);
    else out.set(re.file, [re]);
  }
  return out;
}

/** Splits a wrapper lookup name on its first "." — "QueueService.publish" -> {base: "QueueService",
 * suffix: ".publish"}, "QueueService" (a bare function wrapper's own name) -> {base: "QueueService",
 * suffix: ""}. A *named* re-export (`export { X } from`/`export { default as X } from`) only ever
 * renames the bare class/instance/function name itself — the method suffix has to be spliced back onto
 * whatever that renames to (review round 2, item 3). `literalExportAt` never needs this: a literal
 * export's name is never compound (the member is already a separate field). */
function splitWrapperName(name: string): { base: string; suffix: string } {
  const dot = name.indexOf(".");
  return dot === -1 ? { base: name, suffix: "" } : { base: name.slice(0, dot), suffix: name.slice(dot) };
}

/** The literal map `file` exports under `name`: declared there, else followed through its re-exports
 * (`export *` never forwards "default"), up to `QUEUE_EXPORT_BARREL_MAX_HOPS` files further (review
 * round 1, item 6 — the same barrel-following `exportedClient` already does for HTTP clients). `memo`
 * caches every `(file, name)` result within one `finalizeEndpoints` call (review round 2, item 2). */
function literalExportAt(
  file: string, name: string, index: Map<string, Map<string, Map<string, string>>>, byFile: Map<string, ReExportDraft[]>,
  resolve: ImportResolver | undefined, hops: number, memo: Map<string, Map<string, string> | undefined>,
): Map<string, string> | undefined {
  const key = `${file}\0${name}`;
  if (memo.has(key)) return memo.get(key);
  let result = index.get(file)?.get(name);
  if (!result && hops < QUEUE_EXPORT_BARREL_MAX_HOPS && resolve) {
    for (const re of byFile.get(file) ?? []) {
      const next = re.kind === "all" ? (name === "default" ? undefined : name) : re.exported === name ? re.imported : undefined;
      if (next === undefined) continue;
      const target = resolve(file, re.from);
      const hit = target ? literalExportAt(target, next, index, byFile, resolve, hops + 1, memo) : undefined;
      if (hit) {
        result = hit;
        break;
      }
    }
  }
  memo.set(key, result);
  return result;
}

/** Resolves a `QueueOpDraft`'s one-import-hop names against every file's exported literal maps; never
 * guesses (no resolver, no matching file, or no such member -> the draft is dropped, same as any other
 * unresolved queue name). */
function resolvePendingQueue(
  draft: QueueOpDraft, index: Map<string, Map<string, Map<string, string>>>, byFile: Map<string, ReExportDraft[]>,
  resolve: ImportResolver | undefined, memo: Map<string, Map<string, string> | undefined>,
): QueueOp | undefined {
  return resolveQueueOpDraft(draft, (p: PendingLiteral) => {
    const file = resolve?.(draft.at.file, p.from);
    return file ? literalExportAt(file, p.importedName, index, byFile, resolve, 0, memo)?.get(p.member ?? "") : undefined;
  });
}

/** Resolves an `ExchangeOpDraft`'s one-import-hop names the same way. */
function resolvePendingExchange(
  draft: ExchangeOpDraft, index: Map<string, Map<string, Map<string, string>>>, byFile: Map<string, ReExportDraft[]>,
  resolve: ImportResolver | undefined, memo: Map<string, Map<string, string> | undefined>,
): ExchangeDef | undefined {
  return resolveExchangeOpDraft(draft, (p: PendingLiteral) => {
    const file = resolve?.(draft.at.file, p.from);
    return file ? literalExportAt(file, p.importedName, index, byFile, resolve, 0, memo)?.get(p.member ?? "") : undefined;
  });
}

/** v0.6 Task B: `queueWrapperExports` (every file's own exported wrappers), reshaped for a
 * one-import-hop lookup: file -> export name -> wrapper. */
function queueWrapperIndex(exports: EndpointsPart["queueWrapperExports"]): Map<string, Map<string, QueueWrapper>> {
  const out = new Map<string, Map<string, QueueWrapper>>();
  for (const e of exports) {
    const byName = out.get(e.file) ?? new Map<string, QueueWrapper>();
    byName.set(e.name, e.wrapper);
    out.set(e.file, byName);
  }
  return out;
}

/** Like `literalExportAt`, for a wrapper export — except a *named* re-export's own exported name is
 * never compound (`export { QueueService } from "./x"` renames "QueueService", not
 * "QueueService.publish"), so a named hop splits `name` on its first "." first and splices the suffix
 * back onto whatever the rename resolves to (review round 2, item 3); an `export *` barrel needs no
 * splitting — the target file already has the full compound key verbatim. */
function wrapperExportAt(
  file: string, name: string, index: Map<string, Map<string, QueueWrapper>>, byFile: Map<string, ReExportDraft[]>,
  resolve: ImportResolver | undefined, hops: number, memo: Map<string, QueueWrapper | undefined>,
): QueueWrapper | undefined {
  const key = `${file}\0${name}`;
  if (memo.has(key)) return memo.get(key);
  let result = index.get(file)?.get(name);
  if (!result && hops < QUEUE_EXPORT_BARREL_MAX_HOPS && resolve) {
    const { base, suffix } = splitWrapperName(name);
    for (const re of byFile.get(file) ?? []) {
      const next = re.kind === "all" ? (name === "default" ? undefined : name)
        : re.exported === base ? `${re.imported}${suffix}` : undefined;
      if (next === undefined) continue;
      const target = resolve(file, re.from);
      const hit = target ? wrapperExportAt(target, next, index, byFile, resolve, hops + 1, memo) : undefined;
      if (hit) {
        result = hit;
        break;
      }
    }
  }
  memo.set(key, result);
  return result;
}

/** Resolves a `QueuePendingWrapperCall`: follows its import (through any barrel) to find the wrapper it
 * might be calling, then (reusing `resolveQueueWrapperCall`) substitutes its own arguments into each of
 * the wrapper's ops and resolves any of THOSE that are themselves one import hop away. Never guesses: no
 * matching import, no such export, or no such wrapper member -> falls to `call.fallbackDirect` or drops,
 * same as any other unresolved queue name. Returns every op the wrapper produces (review round 1, item 7
 * — a call can both assert an exchange and consume a queue). */
function resolvePendingWrapperCall(
  call: QueuePendingWrapperCall,
  wrappers: Map<string, Map<string, QueueWrapper>>,
  literals: Map<string, Map<string, Map<string, string>>>,
  byFile: Map<string, ReExportDraft[]>,
  resolve: ImportResolver | undefined,
  wrapperMemo: Map<string, QueueWrapper | undefined>,
  literalMemo: Map<string, Map<string, string> | undefined>,
): ReturnType<typeof resolveQueueWrapperCall> {
  const file = resolve?.(call.at.file, call.from);
  const key = call.method !== undefined ? `${call.importedName}.${call.method}` : call.importedName;
  const wrapper = file ? wrapperExportAt(file, key, wrappers, byFile, resolve, 0, wrapperMemo) : undefined;
  return resolveQueueWrapperCall(call, wrapper, (p: PendingLiteral) => {
    const pendingFile = resolve?.(call.at.file, p.from);
    return pendingFile ? literalExportAt(pendingFile, p.importedName, literals, byFile, resolve, 0, literalMemo)?.get(p.member ?? "") : undefined;
  });
}

export function finalizeEndpoints(repo: string, parts: EndpointsPart[], resolveImport?: ImportResolver): EndpointsFile {
  const all = emptyPart();
  for (const p of parts) {
    for (const key of Object.keys(all) as Array<keyof EndpointsPart>) {
      // review round 1, item 4: a part cached before a field existed (an older CACHE_FORMAT; the cache
      // itself is `z.any()` and not revalidated) lacks it entirely — tolerate that rather than throwing,
      // on top of the CACHE_FORMAT bump that makes such a part get rebuilt on the next run anyway.
      (all[key] as unknown[]).push(...((p[key] as unknown[] | undefined) ?? []));
    }
  }
  const modelsByFile = new Map<string, { model: string; table: string }>();
  for (const m of [...all.models].sort((a, b) => compare(a.model, b.model))) {
    if (!modelsByFile.has(m.file)) modelsByFile.set(m.file, { model: m.model, table: m.table });
  }
  const exact = uniqueTables(all.models, (m) => m);
  const lower = uniqueTables(all.models, (m) => m.toLowerCase());
  const dbAccess = all.dbAccess.map((d) => resolveModelImport(d, modelsByFile, resolveImport)).map((a) => {
    if (a.table || !a.model) return a;
    const table = exact.get(a.model) ?? lower.get(a.model.toLowerCase());
    return table ? { ...a, table } : a;
  });
  const tables = new Map<string, TableDef>();
  for (const t of all.tables) if (!tables.has(t.name)) tables.set(t.name, t);
  for (const m of all.models) {
    if (!tables.has(m.table)) tables.set(m.table, { name: m.table, file: m.file, line: 1, source: "model" });
  }
  const literalIndex = queueLiteralIndex(all.queueLiteralExports);
  const wrapperIndex = queueWrapperIndex(all.queueWrapperExports);
  // review round 2, item 2: `reExports` grouped by file once, and a (file, name) memo for each of the two
  // lookup kinds, both scoped to this one `finalizeEndpoints` call — not a lasting cache (a repo's
  // re-exports can change between runs), but well worth it within a single run that resolves many
  // pending calls against the same handful of barrels.
  const byFile = reExportsByFile(all.reExports);
  const wrapperMemo = new Map<string, QueueWrapper | undefined>();
  const literalMemo = new Map<string, Map<string, string> | undefined>();
  const fromWrapperCalls = all.queueWrapperCalls.flatMap((c) =>
    resolvePendingWrapperCall(c, wrapperIndex, literalIndex, byFile, resolveImport, wrapperMemo, literalMemo));
  // v0.6 queues fix: names that flow through classes, singletons and wrappers of wrappers (queue-solve.ts).
  const flow = solveQueueFlow(all.queueFlow, resolveImport, all.reExports);
  return {
    version: 2,
    repo,
    pages: all.pages.sort((a, b) => compare(a.route, b.route) || compare(a.file, b.file)),
    httpCalls: all.httpCalls.map((c) => resolveImportedClient(c, all.httpClients, all.reExports, resolveImport))
      .filter((c): c is HttpCall => c !== undefined).sort(byLoc),
    httpClients: all.httpClients.map(stripClientDraft).sort(byHttpClient),
    routes: placeRegisteredRoutes(all.routes, all.routeRegistrars, resolveImport).map((r) => resolveHandler(r, resolveImport)).sort(byLoc),
    mounts: all.mounts.map((m) => resolveMount(m, resolveImport)).filter((m): m is Mount => m !== undefined).sort(byMount),
    routers: all.routers.sort((a, b) => compare(a.file, b.file) || compare(a.name, b.name)),
    dbAccess: dbAccess.sort(byLoc),
    tables: [...tables.values()].sort((a, b) => compare(a.name, b.name)),
    models: all.models.sort((a, b) => compare(a.model, b.model)),
    queues: mergeQueues([
      ...all.queues,
      ...all.queueDrafts.map((d) => resolvePendingQueue(d, literalIndex, byFile, resolveImport, literalMemo)),
      ...fromWrapperCalls.filter((r): r is Extract<typeof r, { kind: "queue" }> => r.kind === "queue").map((r) => r.op),
    ].filter((q): q is QueueOp => q !== undefined), flow.ops),
    exchanges: mergeExchanges([
      ...all.exchanges,
      ...all.exchangeDrafts.map((d) => resolvePendingExchange(d, literalIndex, byFile, resolveImport, literalMemo)),
      ...fromWrapperCalls.filter((r): r is Extract<typeof r, { kind: "exchange" }> => r.kind === "exchange").map((r) => r.def),
    ].filter((e): e is ExchangeDef => e !== undefined), flow.exchanges),
    ...(flow.unknown.length > 0 ? { queueUnknown: flow.unknown.sort(byUnknown) } : {}),
  };
}
