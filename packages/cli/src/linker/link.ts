import { symbolAt } from "./code-index.js";
import type { CallSite, FileCodeIndex } from "./code-index.js";
import type { CallResolver, SymbolRef, WalkStep } from "./resolve-calls.js";
import { walkCallers, walkCalls } from "./resolve-calls.js";
import { joinPaths, pickRoute, worse } from "./paths.js";
import type { RouteCandidate } from "./paths.js";
import { effectiveRoutes } from "./mounts.js";
import type { EffectiveRoute } from "./mounts.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { Confidence, DbAccess, HttpCall, HttpClient, HttpMethod, Loc, QueueOp, UiPage } from "../store/schemas.js";
import { HttpMethodSchema } from "../store/schemas.js";
import { compare } from "../util.js";
import { absoluteHost } from "../adapters/ast.js";
import { wrapperCalls } from "./wrappers.js";
import type { LinkedCall } from "./wrappers.js";

export interface LinkInput {
  ws: WorkspaceData;
  /** repo id → resolver (built by runLinker from IndexResult codeIndex/files/aliases). */
  resolvers: Map<string, CallResolver>;
}

/** One walk hop: the symbol plus the confidence of its call towards the next symbol on the way to the
 * HTTP call site (the call-site symbol itself, which makes no further hop, is "exact"). */
export type ReachStep = SymbolRef & { confidence: Confidence };

export interface PageReach {
  page: UiPage;
  /** page symbol, ..., call-site symbol. */
  path: ReachStep[];
  /** Worst confidence over every hop in `path`. */
  confidence: Confidence;
}

export interface UiLink {
  repo: string;
  /** An adapter HttpCall, or one derived from a call to an HTTP wrapper (`via: "wrapper"`). */
  call: LinkedCall;
  pages: PageReach[];
  target:
    | { kind: "route"; route: EffectiveRoute; confidence: Confidence; reason?: string }
    | { kind: "external"; base: string }
    | { kind: "unresolved"; reason: string };
}

/** Plain `repo:file#symbol` key for comparing `SymbolRef`s. */
export function stepKey(ref: SymbolRef): string {
  return `${ref.repo}:${ref.file}#${ref.symbol}`;
}

/**
 * Chase `WalkStep.parent` pointers from `steps`'s entry for `targetKey` back towards `startKey`,
 * collecting steps target-first. Shared by the UI reverse walk (Task 10, no further reversal needed:
 * target = page, start = call site, and "target-first" is exactly "page, ..., call") and the backend
 * forward walk (Task 11, which reverses the result to get "handler, ..., store-access" order).
 */
export function chainTowardStart(steps: WalkStep[], targetKey: string, startKey: string): WalkStep[] {
  const byKey = new Map(steps.map((s) => [stepKey(s.ref), s] as const));
  const chain: WalkStep[] = [];
  let cur = byKey.get(targetKey);
  const seen = new Set<string>();
  while (cur) {
    chain.push(cur);
    const key = stepKey(cur.ref);
    if (key === startKey || seen.has(key)) break;
    seen.add(key);
    cur = cur.parent ? byKey.get(stepKey(cur.parent)) : undefined;
  }
  return chain;
}

/** The symbol a page starts from. React Router: the routed component, resolved through the router
 * file's own bindings/imports (never the router component that merely contains the `<Route>`s — that
 * would credit every page with whatever the shell calls); unresolvable -> undefined (reaches nothing).
 * Next: the file's default export, else the symbol at page.line. */
function pageSymbolRef(input: LinkInput, repoId: string, page: UiPage): SymbolRef | undefined {
  const resolver = input.resolvers.get(repoId);
  const idx: FileCodeIndex | undefined = resolver?.fileIndex(page.file);
  if (!resolver || !idx) return undefined;
  if (page.framework === "react-router") {
    return page.component ? resolver.resolveName(page.file, page.component.name) ?? undefined : undefined;
  }
  const def = idx.symbols.find((s) => s.exportNames?.includes("default"));
  if (def) return { repo: repoId, file: page.file, symbol: def.name };
  const bySite = symbolAt(idx, page.line);
  return bySite ? { repo: repoId, file: page.file, symbol: bySite.name } : undefined;
}

/** Every UiPage that reaches `call` by a reverse walk over resolved calls, ≤6 hops. */
function reachingPages(input: LinkInput, repoId: string, call: HttpCall): PageReach[] {
  const resolver = input.resolvers.get(repoId);
  const repo = input.ws.repos.find((r) => r.ref.id === repoId);
  if (!resolver || !repo) return [];
  const start: SymbolRef = { repo: repoId, file: call.at.file, symbol: call.at.symbol };
  const startKey = stepKey(start);
  // walkCallers always includes `start` itself at depth 0, so byKey.get(startKey) is never undefined.
  const steps = walkCallers(resolver, start, 6);
  const byKey = new Map(steps.map((s) => [stepKey(s.ref), s] as const));
  const reaches: PageReach[] = [];
  for (const page of repo.endpoints.pages) {
    const pageRef = pageSymbolRef(input, repoId, page);
    if (!pageRef || !byKey.has(stepKey(pageRef))) continue;
    const path = chainTowardStart(steps, stepKey(pageRef), startKey);
    const hops: ReachStep[] = path.map((s) => ({ ...s.ref, confidence: s.via?.confidence ?? "exact" }));
    reaches.push({ page, path: hops, confidence: hops.reduce<Confidence>((acc, h) => worse(acc, h.confidence), "exact") });
  }
  reaches.sort((a, b) => compare(a.page.file, b.page.file) || a.page.line - b.page.line || compare(a.page.route, b.page.route));
  return reaches;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Hosts named in any repo's apiBase (entries may be env var names, bare hosts, or full URLs). */
function apiBaseHosts(repos: RepoData[]): Set<string> {
  const out = new Set<string>();
  for (const r of repos) {
    for (const entry of r.ref.apiBase ?? []) {
      const host = absoluteHost(entry) ?? entry.trim().split("/")[0]!.toLowerCase();
      if (host !== "") out.add(host);
    }
  }
  return out;
}

/** Loopback hosts and hosts listed in an apiBase are the workspace's own backends; anything else is a
 * third party. `host` may carry a port; a known host matches with or without it. */
function isInternalHost(host: string, known: Set<string>): boolean {
  const hostname = host.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(hostname) || known.has(host) || known.has(hostname);
}

const ENV_VAR_RE = /process\.env\.(\w+)/;

/** Text of whatever base expression a call carries, or its client's, to match against `apiBase` hints. */
function baseHintText(call: HttpCall, clients: HttpClient[]): string {
  if (call.base) return call.base;
  const own = absoluteHost(call.raw);
  if (own) return own;
  const client = clients.find((c) => c.name === call.client);
  return client?.baseExpr ?? client?.baseHost ?? "";
}

/** Backend choice for a call (memo (c)): all repos with routes; unique match wins; several → prefer
 * repos whose apiBase includes the env var / host in call.base or the client's baseExpr, then role
 * "api"; else guess (every candidate is returned, unhinted). */
export function chooseBackend(
  call: HttpCall, clients: HttpClient[], backends: RepoData[],
): { repos: RepoData[]; hinted: boolean } {
  if (backends.length <= 1) return { repos: backends, hinted: false };
  const hintText = baseHintText(call, clients);
  const envVar = hintText.match(ENV_VAR_RE)?.[1];
  const byApiBase = backends.filter((b) => {
    const bases = b.ref.apiBase ?? [];
    return bases.some((h) => h !== "" && (h === envVar || hintText.includes(h)));
  });
  if (byApiBase.length === 1) return { repos: byApiBase, hinted: true };
  const byRole = backends.filter((b) => b.ref.role === "api");
  if (byRole.length === 1) return { repos: byRole, hinted: true };
  return { repos: backends, hinted: false };
}

/** Call path after a known axios/ky instance's literal baseURL is prepended. */
export function callPathWithClient(call: HttpCall, clients: HttpClient[]): string {
  if (call.kind === "unknown") return "";
  const client = clients.find((c) => c.name === call.client);
  return client?.baseLiteral ? joinPaths(client.baseLiteral, call.path) : call.path;
}

function resolveTarget(
  call: LinkedCall, clients: HttpClient[], allBackends: RepoData[], effectiveByRepo: Map<string, EffectiveRoute[]>,
  knownHosts: Set<string>,
): UiLink["target"] {
  if (call.kind === "unknown") return { kind: "unresolved", reason: "url has no literal text" };
  // A hardcoded absolute URL (no stripped `base` expression) names its host outright; otherwise the
  // client's literal baseURL may. Loopback / apiBase hosts are ours (strip and match), others external.
  // A wrapper-derived call's literal base host plays the same role (its path already carries the base path).
  const ownHost = call.host ?? (call.base === undefined ? absoluteHost(call.raw) : undefined);
  const host = ownHost ?? clients.find((c) => c.name === call.client)?.baseHost;
  if (host !== undefined && !isInternalHost(host, knownHosts)) return { kind: "external", base: host };
  if (allBackends.length === 0) return { kind: "unresolved", reason: "no matching route" };
  // An absolute URL on the call itself overrides any client baseURL (axios/ky semantics).
  const path = ownHost !== undefined ? call.path : callPathWithClient(call, clients);
  // chooseBackend only narrows the candidate pool (e.g. to avoid matching the wrong repo's same-named
  // route); it is NOT itself a confidence signal. pickRoute already produces "guess" on a genuine tie
  // (two backends whose best candidate is equally specific), which is the only real ambiguity — a
  // repo set that merely wasn't *hinted* is not ambiguous when the paths themselves don't collide
  // (demo-shop's "api" and "billing" never share a route, so every call there resolves "exact").
  const pick = (repos: RepoData[]) => pickRoute(call.method, path, repos.flatMap((b) =>
    (effectiveByRepo.get(b.ref.id) ?? []).map((er): RouteCandidate<EffectiveRoute> => ({
      item: er, method: er.route.method, path: er.effectivePath, mountsKnown: er.mountsKnown,
    })),
  ));
  const { repos: backends, hinted } = chooseBackend(call, clients, allBackends);
  const picked = pick(backends);
  if (picked) return { kind: "route", route: picked.item, confidence: picked.match.confidence, reason: picked.match.reason };
  // A hint (apiBase / role "api") that leads nowhere is weaker evidence than a route that really
  // exists elsewhere: retry over every backend, but only ever as a guess.
  const fallback = hinted ? pick(allBackends) : null;
  if (fallback) return { kind: "route", route: fallback.item, confidence: "guess", reason: "matched outside the hinted backends" };
  return { kind: "unresolved", reason: "no matching route" };
}

/** For each HttpCall: the UI pages that reach it, and the route (or external/unresolved) it targets. */
export function linkUi(input: LinkInput): UiLink[] {
  const allBackends = input.ws.repos.filter((r) => r.endpoints.routes.length > 0);
  const effectiveByRepo = new Map(input.ws.repos.map((r) => [r.ref.id, effectiveRoutes(r.endpoints)]));
  const knownHosts = apiBaseHosts(input.ws.repos);
  const links: UiLink[] = [];
  for (const repo of input.ws.repos) {
    const resolver = input.resolvers.get(repo.ref.id);
    // A wrapper call on a line where the adapter already sees an HTTP call (e.g. `api.get("/x")` on an
    // object named like a client) is the same call: keep the adapter's.
    // Keyed on file, line, method and path so a different call sharing the line is kept.
    const key = (c: HttpCall) => `${c.at.file}:${c.at.line}:${c.method}:${c.path}`;
    const seen = new Set(repo.endpoints.httpCalls.map(key));
    const derived = resolver ? wrapperCalls(resolver).filter((c) => !seen.has(key(c))) : [];
    const calls: LinkedCall[] = [...repo.endpoints.httpCalls, ...derived];
    for (const call of calls) {
      links.push({
        repo: repo.ref.id,
        call,
        pages: reachingPages(input, repo.ref.id, call),
        target: resolveTarget(call, repo.endpoints.httpClients, allBackends, effectiveByRepo, knownHosts),
      });
    }
  }
  links.sort((a, b) => compare(a.repo, b.repo) || compare(a.call.at.file, b.call.at.file) || a.call.at.line - b.call.at.line
    || compare(a.call.method, b.call.method) || compare(a.call.path, b.call.path));
  return links;
}

// ---------------------------------------------------------------------------------------------------
// Backend half (Task 11): route -> handler -> store/queue; queue pairing; consumers; manual links.
// ---------------------------------------------------------------------------------------------------

export type StoreHit =
  | { kind: "db"; access: DbAccess; viaPath: WalkStep[] }
  | { kind: "queue"; op: QueueOp; viaPath: WalkStep[] };

export interface QueuePair {
  publish: QueueOp; consume: QueueOp; repoFrom: string; repoTo: string; confidence: Confidence; reason?: string;
}

export interface BackendLink {
  repo: string;
  route: EffectiveRoute;
  handler: SymbolRef | null;
  handlerConfidence: Confidence;
  hits: StoreHit[];
  unresolved: Array<{ at: Loc; reason: string }>;
}

export interface ConsumerLink {
  repo: string; consume: QueueOp; handler: SymbolRef; hits: StoreHit[]; unresolved: Array<{ at: Loc; reason: string }>;
}

export interface ManualLink { from: string; to: string; resolved: boolean; reason?: string }

/** Where a walk starts. `lines` is set for an anonymous inline route callback: it has no symbol of its
 * own, so its calls and store accesses are joined to it by line range within `ref.file`. `registration`
 * is the `app.get(...)` call that hands the callback over: it shares the callback's first line but is
 * not one of its calls. */
interface HandlerScope {
  ref: SymbolRef; confidence: Confidence; lines?: [number, number]; registration?: { line: number; method: HttpMethod };
}

const REGISTRATION_PROPS = new Set(["get", "post", "put", "patch", "delete", "all", "any", "head", "options", "route", "use"]);

function isRegistration(site: CallSite, reg: HandlerScope["registration"]): boolean {
  if (!reg || site.line !== reg.line) return false;
  const prop = calleeProp(site.callee)?.toLowerCase();
  return prop !== undefined && (prop === reg.method.toLowerCase() || REGISTRATION_PROPS.has(prop));
}

const DEFAULT_PREFIX_RE = /^default(\.|$)/;

/** Strip a leading "default." (or bare "default") and resolve what remains against the file's actual
 * default-exported function/class, e.g. next-api "default" whose default export is named "handler" ->
 * "handler"; "default.create" on a default-exported class `Svc` -> "Svc.create". With no default
 * function/class (e.g. `export default { create() {} }`, indexed as "default.create") it is kept as-is. */
function handlerSymbolName(idx: FileCodeIndex | undefined, handler: string): string {
  if (!DEFAULT_PREFIX_RE.test(handler)) return handler;
  const rest = handler.replace(DEFAULT_PREFIX_RE, "");
  const def = idx?.symbols.find((s) => s.exportNames?.includes("default"));
  if (!def) return handler;
  return rest ? `${def.name}.${rest}` : def.name;
}

function within(line: number, lines: [number, number]): boolean {
  return line >= lines[0] && line <= lines[1];
}

function handlerScope(input: LinkInput, r: EffectiveRoute): HandlerScope | null {
  const route = r.route;
  if (!route.handlerFile) return null;
  const resolver = input.resolvers.get(r.repo);
  const idx = resolver?.fileIndex(route.handlerFile);
  const lines = route.handlerLines;
  if (route.inline && lines) {
    // A named function expression is its own symbol; anything else found at that line (the module, or a
    // function that merely registers the routes) is wider than the callback, so use a synthetic symbol.
    const bySite = idx ? symbolAt(idx, lines[0]) : undefined;
    if (bySite && bySite.lines[0] >= lines[0] && bySite.lines[1] <= lines[1]) {
      return { ref: { repo: r.repo, file: route.handlerFile, symbol: bySite.name }, confidence: "exact" };
    }
    return {
      ref: { repo: r.repo, file: route.handlerFile, symbol: route.handler }, confidence: "exact", lines,
      ...(route.at.file === route.handlerFile ? { registration: { line: route.at.line, method: route.method } } : {}),
    };
  }
  const name = handlerSymbolName(idx, route.handler);
  if (idx?.symbols.some((s) => s.name === name)) {
    return { ref: { repo: r.repo, file: route.handlerFile, symbol: name }, confidence: "exact" };
  }
  // Not declared in handlerFile under that name: maybe re-exported / aliased from there.
  const viaExport = resolver?.resolveExport(route.handlerFile, name);
  if (viaExport) return { ref: viaExport, confidence: "exact" };
  return { ref: { repo: r.repo, file: route.handlerFile, symbol: name }, confidence: "guess" };
}

/** route.handlerFile + route.handler ("default" prefix mapped to the real default export); an inline
 * callback -> the symbol exactly spanning handlerLines, else a synthetic "<route.handler>" symbol (its
 * calls are joined by line range). Null when the handler file is unknown. A named handler that the code
 * index does not know is still returned, as a guess. */
export function findHandler(input: LinkInput, r: EffectiveRoute): { ref: SymbolRef; confidence: Confidence } | null {
  const scope = handlerScope(input, r);
  return scope ? { ref: scope.ref, confidence: scope.confidence } : null;
}

/** The call sites a walk step makes: by caller name, or by line range for a synthetic inline handler. */
function sitesOf(resolver: CallResolver, ref: SymbolRef, scope: HandlerScope): CallSite[] {
  const idx = resolver.fileIndex(ref.file);
  if (!idx) return [];
  const lines = stepKey(ref) === stepKey(scope.ref) ? scope.lines : undefined;
  if (!lines) return idx.calls.filter((site) => site.caller === ref.symbol);
  return idx.calls.filter((site) => within(site.line, lines) && !isRegistration(site, scope.registration));
}

/** `resolver` with the synthetic inline handler's calls joined by line range (everything else as-is). */
function scopedResolver(resolver: CallResolver, scope: HandlerScope): CallResolver {
  if (!scope.lines) return resolver;
  const key = stepKey(scope.ref);
  return {
    ...resolver,
    callsFrom(ref) {
      if (stepKey(ref) !== key) return resolver.callsFrom(ref);
      return sitesOf(resolver, ref, scope)
        .map((site) => resolver.resolve(ref.file, site))
        .filter((rc) => rc !== null)
        .sort((a, b) => a.site.line - b.site.line);
    },
  };
}

/** `resolver` whose walk stops at recorded DbAccess / QueueOp sites: such a call is the ORM/broker call
 * that already became a store hit (a terminal), so a *guessed* resolution at that `file:line` — typically
 * a unique-method guess onto a same-named repo method — must not be followed. Exact resolutions on the
 * same line (`ch.consume("q", (m) => record(m))`, `prisma.x.create({ data: build() })`) are real calls
 * and are walked. `knownAt` keys are `file:line`. */
function terminalStores(resolver: CallResolver, knownAt: Set<string>): CallResolver {
  return {
    ...resolver,
    callsFrom(ref) {
      return resolver.callsFrom(ref).filter((rc) => rc.confidence !== "guess" || !knownAt.has(`${ref.file}:${rc.site.line}`));
    },
  };
}

/** Method / function names a recorded store call is made through (db.ts and queues.ts adapters). */
const STORE_CALL_NAMES = new Set([
  // queues
  "sendToQueue", "publish", "consume", "bindQueue",
  // Lucid model statics, Prisma delegates, TypeORM repositories
  "create", "createMany", "createManyAndReturn", "firstOrCreate", "fetchOrCreateMany", "updateOrCreate", "updateOrCreateMany",
  "find", "findOrFail", "findBy", "findByOrFail", "findMany", "findManyBy", "first", "firstOrFail", "all", "query", "truncate",
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy",
  "update", "updateMany", "upsert", "delete", "deleteMany", "findOne", "findOneBy", "findOneOrFail",
  "save", "insert", "remove", "softDelete", "getRepository",
  // query builders / drizzle / raw SQL
  "from", "table", "into", "knex", "db", "trx", "execute", "raw", "unsafe", "prepare", "exec", "rawQuery",
  "queryRaw", "executeRaw", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe",
]);

/** Is this unresolved call site part of the store call recorded on its line? A chained receiver
 * (`prisma.audit.create`, `db.from("t").where().insert()`) always is; otherwise the called name must be
 * one a store call is made through. `res.json(...)` wrapped around a store call is not. */
function isStoreCall(site: CallSite): boolean {
  const c = site.callee;
  if (c.kind === "other") return true;
  return STORE_CALL_NAMES.has(c.kind === "ident" ? c.name : c.prop);
}

function describeCallee(c: CallSite["callee"]): string {
  switch (c.kind) {
    case "ident": return `could not resolve "${c.name}(...)"`;
    case "member": return `could not resolve "${c.object}.${c.prop}(...)"`;
    case "new-member": return `could not resolve "new ${c.className}().${c.prop}(...)"`;
    case "this": return `could not resolve "this.${c.prop}(...)"`;
    case "this-field": return `could not resolve "this.${c.field}.${c.prop}(...)"`;
    default: return c.prop !== undefined ? `could not resolve ".${c.prop}(...)"` : "could not resolve call";
  }
}

type Unresolved = { at: Loc; reason: string };

function sortUnresolved(list: Unresolved[]): Unresolved[] {
  return list.sort((a, b) => compare(a.at.file, b.at.file) || a.at.line - b.at.line || compare(a.reason, b.reason));
}

/** Every call site inside a visited symbol that the resolver could not resolve — except the store call
 * itself at a recognised DbAccess/QueueOp location (`knownAt`): that is the ORM/broker call already turned
 * into a hit, not a lost call. Other calls on that line (`res.json(await prisma.x.create())`) are reported. */
function collectUnresolved(resolver: CallResolver, steps: WalkStep[], scope: HandlerScope, knownAt: Set<string>): Unresolved[] {
  const out: Unresolved[] = [];
  for (const step of steps) {
    for (const site of sitesOf(resolver, step.ref, scope)) {
      if (resolver.resolve(step.ref.file, site)) continue;
      if (knownAt.has(`${step.ref.file}:${site.line}`) && isStoreCall(site)) continue;
      out.push({ at: { file: step.ref.file, line: site.line, symbol: step.ref.symbol }, reason: describeCallee(site.callee) });
    }
  }
  return sortUnresolved(out);
}

function knownAtKeys(access: DbAccess[], queues: QueueOp[]): Set<string> {
  return new Set([...access, ...queues].map((x) => `${x.at.file}:${x.at.line}`));
}

function hitLabel(h: StoreHit): string {
  return h.kind === "db" ? `${h.access.at.file}:${String(h.access.at.line).padStart(8, "0")}:${h.access.table}:${h.access.op}`
    : `${h.op.at.file}:${String(h.op.at.line).padStart(8, "0")}:${h.op.queue}`;
}

/** Store hits reachable from the scope's start symbol (≤6 hops), nearest first. An access counts when
 * its enclosing symbol was visited, or (synthetic inline handler) when it sits inside the handler's lines. */
function storeHits(resolver: CallResolver, repoId: string, scope: HandlerScope, access: DbAccess[], queues: QueueOp[]): { steps: WalkStep[]; hits: StoreHit[] } {
  const steps = walkCalls(terminalStores(scopedResolver(resolver, scope), knownAtKeys(access, queues)), scope.ref, 6);
  const visited = new Set(steps.map((s) => stepKey(s.ref)));
  const startKey = stepKey(scope.ref);
  const viaPathTo = (at: Loc): WalkStep[] | undefined => {
    if (scope.lines && at.file === scope.ref.file && within(at.line, scope.lines)) return [steps[0]!];
    const key = stepKey({ repo: repoId, file: at.file, symbol: at.symbol });
    return visited.has(key) ? chainTowardStart(steps, key, startKey).reverse() : undefined;
  };
  const hits: StoreHit[] = [];
  for (const a of access) {
    const viaPath = viaPathTo(a.at);
    if (viaPath) hits.push({ kind: "db", access: a, viaPath });
  }
  for (const q of queues) {
    if (q.op !== "publish") continue;
    const viaPath = viaPathTo(q.at);
    if (viaPath) hits.push({ kind: "queue", op: q, viaPath });
  }
  hits.sort((a, b) => a.viaPath.length - b.viaPath.length || compare(hitLabel(a), hitLabel(b)));
  return { steps, hits };
}

/** Route -> handler -> walkCalls -> every DbAccess / publish QueueOp reached. */
export function linkBackend(input: LinkInput): BackendLink[] {
  const out: BackendLink[] = [];
  for (const repo of input.ws.repos) {
    const resolver = input.resolvers.get(repo.ref.id);
    if (!resolver) continue;
    const knownAt = knownAtKeys(repo.endpoints.dbAccess, repo.endpoints.queues);
    for (const er of effectiveRoutes(repo.endpoints)) {
      const scope = handlerScope(input, er);
      if (!scope) {
        out.push({ repo: repo.ref.id, route: er, handler: null, handlerConfidence: "guess", hits: [], unresolved: [] });
        continue;
      }
      const { steps, hits } = storeHits(resolver, repo.ref.id, scope, repo.endpoints.dbAccess, repo.endpoints.queues);
      out.push({
        repo: repo.ref.id, route: er, handler: scope.ref, handlerConfidence: scope.confidence,
        hits, unresolved: collectUnresolved(resolver, steps, scope, knownAt),
      });
    }
  }
  out.sort((a, b) => compare(a.repo, b.repo) || compare(a.route.effectivePath, b.route.effectivePath)
    || compare(a.route.route.method, b.route.route.method) || compare(a.route.route.at.file, b.route.route.at.file)
    || a.route.route.at.line - b.route.route.at.line || compare(a.route.route.handler, b.route.route.handler));
  return out;
}

/** AMQP topic match: "*" = exactly one word, "#" = zero or more words. */
function routingKeyMatches(bindKey: string, pubKey: string): boolean {
  if (bindKey === pubKey) return true;
  const match = (b: string[], p: string[]): boolean => {
    if (b.length === 0) return p.length === 0;
    const [head, ...rest] = b;
    if (head === "#") {
      for (let i = 0; i <= p.length; i++) if (match(rest, p.slice(i))) return true;
      return false;
    }
    if (p.length === 0) return false;
    return (head === "*" || head === p[0]) && match(rest, p.slice(1));
  };
  return match(bindKey.split("."), pubKey.split("."));
}

function opKey(repo: string, q: QueueOp): string {
  return `${repo}:${q.at.file}:${String(q.at.line).padStart(8, "0")}:${q.op}:${q.queue}`;
}

/** Memo (f): sendToQueue <-> consume on the same queue -> exact; exchange publish -> bind(exchange, key)
 * -> consume(bound queue) -> exact, or param when the binding key has a topic wildcard; no binding ->
 * consume on a queue named like the routing key or exchange -> guess. */
export function pairQueues(ws: WorkspaceData): QueuePair[] {
  const pairs = new Map<string, QueuePair>();
  const consumers = ws.repos.flatMap((r) => r.endpoints.queues.filter((q) => q.op === "consume").map((q) => ({ repo: r.ref.id, q })));
  const binds = ws.repos.flatMap((r) => r.endpoints.queues.filter((q) => q.op === "bind").map((q) => ({ repo: r.ref.id, q })));
  const add = (from: string, publish: QueueOp, to: { repo: string; q: QueueOp }, confidence: Confidence, reason?: string) => {
    const key = `${opKey(from, publish)}|${opKey(to.repo, to.q)}`;
    const prev = pairs.get(key);
    // Several bindings can lead to the same consumer: keep the strongest.
    if (prev && worse(prev.confidence, confidence) === confidence) return;
    pairs.set(key, { publish, consume: to.q, repoFrom: from, repoTo: to.repo, confidence, ...(reason !== undefined ? { reason } : {}) });
  };
  for (const from of ws.repos) {
    for (const publish of from.endpoints.queues.filter((q) => q.op === "publish")) {
      if (publish.exchange === undefined) {
        for (const c of consumers.filter((c) => c.q.queue === publish.queue)) add(from.ref.id, publish, c, "exact");
        continue;
      }
      const matches = binds.filter((b) => b.q.exchange === publish.exchange && routingKeyMatches(b.q.routingKey ?? "", publish.routingKey ?? ""));
      if (matches.length > 0) {
        for (const b of matches) {
          const confidence: Confidence = /[*#]/.test(b.q.routingKey ?? "") ? "param" : "exact";
          for (const c of consumers.filter((c) => c.q.queue === b.q.queue)) add(from.ref.id, publish, c, confidence);
        }
        continue;
      }
      for (const c of consumers.filter((c) => c.q.queue === publish.routingKey || c.q.queue === publish.exchange)) {
        add(from.ref.id, publish, c, "guess", "no binding found; matched by exchange/routing-key heuristic");
      }
    }
  }
  return [...pairs.entries()].sort(([a], [b]) => compare(a, b)).map(([, p]) => p);
}

const CONSUME_ARG = 1;

function calleeProp(c: CallSite["callee"]): string | undefined {
  return c.kind === "ident" ? undefined : c.prop;
}

/** The consume callback's own symbol: `channel.consume("q", handleEmail)` -> whatever `handleEmail`
 * binds to in that file (local function or import). QueueOp records only the consume() call site, and a
 * callback passed by reference is never *called* there, so it is read from the call site's recorded
 * identifier arguments. Inline / unresolvable callback -> the consume() call's own enclosing symbol. */
function consumeHandlerRef(resolver: CallResolver, repoId: string, q: QueueOp): SymbolRef {
  const site = resolver.fileIndex(q.at.file)?.calls.find((s) => s.line === q.at.line && calleeProp(s.callee) === "consume");
  const name = site?.refArgs?.find((a) => a.index === CONSUME_ARG)?.name;
  const resolved = name !== undefined ? resolver.resolveName(q.at.file, name) : null;
  return resolved ?? { repo: repoId, file: q.at.file, symbol: q.at.symbol };
}

/** Every `consume` op -> its handler -> walkCalls -> store hits; each consumer starts its own chain. */
export function linkConsumers(input: LinkInput): ConsumerLink[] {
  const out: ConsumerLink[] = [];
  for (const repo of input.ws.repos) {
    const resolver = input.resolvers.get(repo.ref.id);
    if (!resolver) continue;
    const knownAt = knownAtKeys(repo.endpoints.dbAccess, repo.endpoints.queues);
    for (const q of repo.endpoints.queues) {
      if (q.op !== "consume") continue;
      const scope: HandlerScope = { ref: consumeHandlerRef(resolver, repo.ref.id, q), confidence: "exact" };
      const { steps, hits } = storeHits(resolver, repo.ref.id, scope, repo.endpoints.dbAccess, repo.endpoints.queues);
      out.push({ repo: repo.ref.id, consume: q, handler: scope.ref, hits, unresolved: collectUnresolved(resolver, steps, scope, knownAt) });
    }
  }
  out.sort((a, b) => compare(opKey(a.repo, a.consume), opKey(b.repo, b.consume)));
  return out;
}

export type LinkRef =
  | { kind: "symbol"; repo: string; file: string; symbol: string }
  | { kind: "route"; repo: string; method: HttpMethod; path: string }
  | { kind: "queue"; repo: string; queue: string };

/** "<repo>:<file>#<symbol>" | "route:<repo>:<METHOD> <path>" | "queue:<repo>:<queue>". Route/queue
 * prefixes are checked first. */
export function parseLinkRef(s: string): LinkRef | null {
  let m = s.match(/^route:([^:]+):([A-Z]+) (\S+)$/);
  if (m) {
    const method = HttpMethodSchema.safeParse(m[2]);
    return method.success ? { kind: "route", repo: m[1]!, method: method.data, path: m[3]! } : null;
  }
  m = s.match(/^queue:([^:]+):(.+)$/);
  if (m) return { kind: "queue", repo: m[1]!, queue: m[2]! };
  m = s.match(/^([^:#]+):([^#]+)#(.+)$/);
  if (m) return { kind: "symbol", repo: m[1]!, file: m[2]!, symbol: m[3]! };
  return null;
}

function refExists(input: LinkInput, ref: LinkRef): boolean {
  const repo = input.ws.repos.find((r) => r.ref.id === ref.repo);
  if (!repo) return false;
  if (ref.kind === "symbol") return !!input.resolvers.get(ref.repo)?.fileIndex(ref.file)?.symbols.some((s) => s.name === ref.symbol);
  if (ref.kind === "route") return effectiveRoutes(repo.endpoints).some((er) => er.route.method === ref.method && er.effectivePath === ref.path);
  return repo.endpoints.queues.some((q) => q.queue === ref.queue);
}

/** Validate every workspace `links` entry against the repos/symbols/routes/queues that actually exist.
 * Kept in workspace-file order (the author's order). */
export function resolveManualLinks(input: LinkInput): ManualLink[] {
  return input.ws.links.map((l) => {
    const from = parseLinkRef(l.from);
    const to = parseLinkRef(l.to);
    if (!from || !to) return { from: l.from, to: l.to, resolved: false, reason: "could not parse link reference" };
    if (!refExists(input, from)) return { from: l.from, to: l.to, resolved: false, reason: `"${l.from}" was not found` };
    if (!refExists(input, to)) return { from: l.from, to: l.to, resolved: false, reason: `"${l.to}" was not found` };
    return { from: l.from, to: l.to, resolved: true };
  });
}

export interface LinkResult {
  ui: UiLink[]; backend: BackendLink[]; consumers: ConsumerLink[]; queuePairs: QueuePair[]; manual: ManualLink[];
}

export function linkAll(input: LinkInput): LinkResult {
  return {
    ui: linkUi(input),
    backend: linkBackend(input),
    consumers: linkConsumers(input),
    queuePairs: pairQueues(input.ws),
    manual: resolveManualLinks(input),
  };
}
