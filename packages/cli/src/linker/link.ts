import { symbolAt } from "./code-index.js";
import type { CallSite, FileCodeIndex } from "./code-index.js";
import type { CallResolver, SymbolRef, WalkStep } from "./resolve-calls.js";
import { isTestFile, walkCallers, walkCalls } from "./resolve-calls.js";
import { joinPaths, pickRoute, worse } from "./paths.js";
import type { RouteCandidate } from "./paths.js";
import { effectiveRoutes } from "./mounts.js";
import { type EffectiveRoute, routeCandidate } from "./mounts.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type {
  Confidence, DbAccess, ExternalService, HttpCall, HttpClient, HttpMethod, Loc, ProxyRule, QueueOp, RepoRef, Route, RouteForward, UiPage, UiReachFact,
} from "../store/schemas.js";
import { HttpMethodSchema } from "../store/schemas.js";
import { compare } from "../util.js";
import { absoluteHost } from "../adapters/ast.js";
import { wrapperCalls } from "./wrappers.js";
import type { LinkedCall } from "./wrappers.js";
import { baseFromExpr, type BaseMatch, type CallBase, isInternalHost as looksInternal, matchBase, type NamedRepo } from "./hints.js";
import type { UnresolvedBase } from "../store/schemas.js";

export interface LinkInput {
  ws: WorkspaceData;
  /** repo id → resolver (built by runLinker from IndexResult codeIndex/files/aliases). */
  resolvers: Map<string, CallResolver>;
}

/** One walk hop: the symbol plus the confidence of its call towards the next symbol on the way to the
 * HTTP call site (the call-site symbol itself, which makes no further hop, is "exact"). */
export type ReachStep = SymbolRef & {
  confidence: Confidence;
  /** Set when the step is a hook reached through an inline function it returns: that function's first line. */
  line?: number;
};

export interface PageReach {
  page: UiPage;
  /** page symbol, ..., call-site symbol. */
  path: ReachStep[];
  /** Worst confidence over every hop in `path`. */
  confidence: Confidence;
}

/** A call matched to a route (same shape whether the match is the call's own-repo target or one found
 * through a workspace `proxies` rule — see `UiLink.proxied`). */
export interface RouteTarget {
  kind: "route";
  route: EffectiveRoute;
  confidence: Confidence;
  reason?: string;
  /** 0.6 §2: a proxied match through a Next.js catch-all route read as a proxy rule — that route (the call's own
   * match), which the chain passes through on its way to `route`. */
  via?: EffectiveRoute;
}

export interface UiLink {
  repo: string;
  /** An adapter HttpCall, or one derived from a call to an HTTP wrapper (`via: "wrapper"`). */
  call: LinkedCall;
  pages: PageReach[];
  target:
    | RouteTarget
    /** A call to another service: `base` is its host or env var name; `name` the workspace file's
     * `external` entry that lists that base, when one does. */
    | { kind: "external"; base: string; name?: string }
    | { kind: "unresolved"; reason: string };
  /** Extra route matches through the repo's workspace `proxies` (spec §4): this call's URL, with the
   * matching rule's prefix stripped (default) or kept (`stripPrefix: false`), matched against the named
   * repo's routes — exact/param confidence as for any other UI call. Absent, or [], when the repo
   * declares no `proxies` or none applies. `target` (the call's own-repo match, e.g. a catch-all proxy
   * route) is unaffected by this: that chain stays, and buildChains adds a further chain per entry here,
   * continuing into that repo's handler and tables. */
  proxied?: RouteTarget[];
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

/** When `from` hands over an inline function that `to` (a hook) returns, and that inline function holds
 * `outLine` (the line where `to` makes its next hop, or the HTTP call itself): the inline function's first
 * line, so the stop shows the arrow rather than the hook's first line (v0.2a). Undefined otherwise. */
function inlineHandlerLine(resolver: CallResolver, from: SymbolRef, to: SymbolRef, outLine: number): number | undefined {
  const lines = resolver.callsFrom(from)
    .filter((c) => c.lines && c.target.file === to.file && c.target.symbol === to.symbol && within(outLine, c.lines))
    .map((c) => c.lines![0]);
  return lines.length > 0 ? Math.max(...lines) : undefined;
}

/** Every UiPage that reaches `call` by a reverse walk over resolved calls, ≤6 hops. */
function reachingPages(input: LinkInput, repoId: string, call: HttpCall): PageReach[] {
  const resolver = input.resolvers.get(repoId);
  const repo = input.ws.repos.find((r) => r.ref.id === repoId);
  if (!resolver || !repo) return [];
  const start: SymbolRef = { repo: repoId, file: call.at.file, symbol: call.at.symbol };
  const startKey = stepKey(start);
  // walkCallers always includes `start` itself at depth 0, so byKey.get(startKey) is never undefined.
  const steps = walkCallers(resolver, start, 6, undefined, call.at.line);
  const byKey = new Map(steps.map((s) => [stepKey(s.ref), s] as const));
  const reaches: PageReach[] = [];
  for (const page of repo.endpoints.pages) {
    const pageRef = pageSymbolRef(input, repoId, page);
    if (!pageRef || !byKey.has(stepKey(pageRef))) continue;
    const path = chainTowardStart(steps, stepKey(pageRef), startKey);
    const hops: ReachStep[] = path.map((s, i) => {
      const line = i > 0 ? inlineHandlerLine(resolver, path[i - 1]!.ref, s.ref, s.via?.site.line ?? call.at.line) : undefined;
      return { ...s.ref, confidence: s.via?.confidence ?? "exact", ...(line !== undefined ? { line } : {}) };
    });
    reaches.push({ page, path: hops, confidence: hops.reduce<Confidence>((acc, h) => worse(acc, h.confidence), "exact") });
  }
  reaches.sort((a, b) => compare(a.page.file, b.page.file) || a.page.line - b.page.line || compare(a.page.route, b.page.route));
  return reaches;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Hosts named in any repo's apiBase (entries may be env var names, bare hosts, or full URLs). */
export function apiBaseHosts(repos: RepoData[]): Set<string> {
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

export const ENV_VAR_RE = /(?:process\.env|import\.meta\.env)\.(\w+)/;

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
  /** 0.6 §2: the one repo the call's base names (see baseHint), used after the workspace file's apiBase. */
  named?: string,
): { repos: RepoData[]; hinted: boolean } {
  if (backends.length <= 1) return { repos: backends, hinted: false };
  const hintText = baseHintText(call, clients);
  const envVar = hintText.match(ENV_VAR_RE)?.[1];
  const byApiBase = backends.filter((b) => {
    const bases = b.ref.apiBase ?? [];
    return bases.some((h) => h !== "" && (h === envVar || hintText.includes(h)));
  });
  if (byApiBase.length === 1) return { repos: byApiBase, hinted: true };
  if (named !== undefined) return { repos: backends.filter((b) => b.ref.id === named), hinted: true };
  const byRole = backends.filter((b) => b.ref.role === "api");
  if (byRole.length === 1) return { repos: byRole, hinted: true };
  return { repos: backends, hinted: false };
}

/** The `HttpClient` named `call.client`: a single repo-wide match wins outright; with more than one,
 * the one declared in the call's own file wins (two unrelated files each declaring their own local
 * client under the same conventional name, e.g. "apiClient", never cross-link). When the calling file
 * declares none of them, there is no real import graph available here to say which one it actually
 * imports (review fix, round 2: that would need tracing imports through `EndpointsFile`, which carries
 * none — out of scope for this fix), so this never guesses: it is ambiguous, and `undefined` (no base
 * prepended) is safer than a same-named client that happens to belong to an unrelated file. This is a
 * narrow, local fix (one lookup site); every other `clients.find(c => c.name === ...)` in this module
 * keeps the project's existing by-name-only convention. */
export function clientFor(call: HttpCall, clients: HttpClient[]): HttpClient | undefined {
  const named = clients.filter((c) => c.name === call.client);
  if (named.length <= 1) return named[0];
  return named.find((c) => c.file === call.at.file);
}

/** Where a call's base comes from (0.6 §5): the name the linker's hints read (an env var or config key, a host, an
 * identifier — see destinationOf), else the base expression's full text. A relative URL has none, unless
 * `relative` (a backend's call: its base was set where codeloom cannot see, so the URL's client stands for it —
 * the same name the linker records as an unresolved "relative" base). Answers, gaps and unresolvedBases all key a
 * base by this text. */
export function callBase(
  call: LinkedCall, clients: HttpClient[], opts: { relative?: boolean } = {},
): { base: string; kind: "env" | "host" | "name" | "expr" | "relative" } | undefined {
  const dest = destinationOf(call, clients);
  switch (dest.kind) {
    case "base": return { base: dest.base.text, kind: dest.base.kind as "env" | "host" | "name" };
    case "loopback": return { base: dest.host, kind: "host" };
    case "opaque": return dest.expr === "" ? undefined : { base: dest.expr, kind: "expr" };
    case "relative": return opts.relative ? { base: call.client || "fetch", kind: "relative" } : undefined;
  }
}

/** What the user answered about a call base (0.6 §5, answers.json): calls through `base` made by repo `from`
 * (every repo when absent) go to repo `repo`, or to another service named `external`. */
export interface AnswerHint { from?: string; base: string; repo?: string; external?: string }

/** The hint for `call` made by repo `caller`: one for that repo first, then one for every repo. */
export function hintFor(
  hints: AnswerHint[], caller: string, call: LinkedCall, clients: HttpClient[], opts: { relative?: boolean } = {},
): AnswerHint | undefined {
  if (hints.length === 0) return undefined;
  const b = callBase(call, clients, opts);
  if (b === undefined) return undefined;
  return hints.find((h) => h.from === caller && h.base === b.base) ?? hints.find((h) => h.from === undefined && h.base === b.base);
}

/** Call path after a known axios/ky instance's literal baseURL is prepended. */
export function callPathWithClient(call: HttpCall, clients: HttpClient[]): string {
  if (call.kind === "unknown") return "";
  const client = clientFor(call, clients);
  return client?.baseLiteral ? joinPaths(client.baseLiteral, call.path) : call.path;
}

/** A hardcoded absolute URL (no stripped `base` expression) names its host outright. A wrapper-derived
 * call's literal base host plays the same role (its path already carries the base path). */
function ownHostOf(call: LinkedCall): string | undefined {
  return call.host ?? (call.base === undefined ? absoluteHost(call.raw) : undefined);
}

/** The third-party host a call goes to, or undefined when it targets the workspace's own backends. The
 * call's own absolute URL wins, else its client's literal baseURL; loopback / apiBase hosts are ours. */
export function externalHost(call: LinkedCall, clients: HttpClient[], knownHosts: Set<string>): string | undefined {
  const host = ownHostOf(call) ?? clients.find((c) => c.name === call.client)?.baseHost;
  return host !== undefined && !isInternalHost(host, knownHosts) ? host : undefined;
}

/** The env var a call's base comes from (`process.env.X` / `import.meta.env.X`, on the call or its
 * client's baseExpr), when it has one and no absolute host of its own. */
function envBaseOf(call: LinkedCall, clients: HttpClient[]): string | undefined {
  if (ownHostOf(call) !== undefined) return undefined;
  const text = call.base ?? clients.find((c) => c.name === call.client)?.baseExpr ?? "";
  return text.match(ENV_VAR_RE)?.[1];
}

/** The workspace file's `external` entry naming this base (env var name or host, port optional). */
function externalNameFor(base: string, external: ExternalService[]): string | undefined {
  const hostname = base.replace(/:\d+$/, "");
  return external.find((e) => e.apiBase.some((b) => {
    const entry = absoluteHost(b) ?? b.trim();
    return entry === base || entry === hostname || entry.toLowerCase() === base.toLowerCase();
  }))?.name;
}

/** Is `envVar` named in some repo's apiBase (so calls through it are ours)? */
function isOwnEnvBase(envVar: string, repos: RepoData[]): boolean {
  return repos.some((r) => (r.ref.apiBase ?? []).includes(envVar));
}

// ---------------------------------------------------------------------------------------------------
// 0.6 §2: base hints. A call's base (env var, host, identifier) names the repo it goes to.
// ---------------------------------------------------------------------------------------------------

/** Where a call goes, as far as its own URL and its client say: a relative URL (this origin / this service), a
 * loopback host, a named base, or a base expression whose name cannot be read (`getBase()`). */
export type Destination =
  | { kind: "relative" }
  | { kind: "loopback"; host: string }
  | { kind: "base"; base: CallBase }
  | { kind: "opaque"; expr: string };

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ""));
}

function hostDestination(host: string): Destination {
  return isLoopbackHost(host) ? { kind: "loopback", host } : { kind: "base", base: { kind: "host", text: host } };
}

function exprDestination(expr: string): Destination {
  const base = baseFromExpr(expr);
  return base ? { kind: "base", base } : { kind: "opaque", expr: expr.trim() };
}

/** The call's own absolute host wins, then its stripped base expression, then its client's base. */
export function destinationOf(call: LinkedCall, clients: HttpClient[]): Destination {
  const own = ownHostOf(call);
  if (own !== undefined) return hostDestination(own);
  if (call.base !== undefined) return exprDestination(call.base);
  const client = clientFor(call, clients);
  if (client?.baseHost !== undefined) return hostDestination(client.baseHost);
  if (client?.baseExpr !== undefined) return exprDestination(client.baseExpr);
  return { kind: "relative" };
}

/** Every repo that serves routes, with the names hints match it by: its id, plus what the linker read (package,
 * folder, remote). A repo with no routes is never what an HTTP base points at, so it is no candidate. */
export function namedRepos(repos: RepoData[]): NamedRepo[] {
  return repos.filter((r) => r.endpoints.routes.length > 0).map((r) => ({ id: r.ref.id, names: [r.ref.id, ...(r.names ?? [])] }));
}

/** Does a workspace file `apiBase` entry name this base? Env var / identifier by name, host with or without port. */
function apiBaseNames(entry: string, base: CallBase): boolean {
  const e = (absoluteHost(entry) ?? entry.trim()).toLowerCase();
  const text = base.text.toLowerCase();
  return e !== "" && (e === text || (base.kind === "host" && e === text.replace(/:\d+$/, "")));
}

/** Repos whose `apiBase` names this base (the workspace file's own answer; hints never override it). */
function configuredRepos(base: CallBase, repos: RepoData[]): RepoData[] {
  return repos.filter((r) => (r.ref.apiBase ?? []).some((entry) => apiBaseNames(entry, base)));
}

/** A call's named base and the repos its name matches (0.6 §2). `trusted`: the name may decide where the call
 * goes — false for a public-looking host (`billing.vendor.com`), whose match is only ever reported. */
export interface BaseHint { base: CallBase; match: BaseMatch; trusted?: boolean }

/** A hint whose name decides the target: `one` repo, or the `candidates` an ambiguous name leaves. */
function trustedRepos(hint: BaseHint | undefined): { one?: string; candidates?: string[] } {
  if (!hint || hint.trusted === false) return {};
  if (hint.match.kind === "one") return { one: hint.match.repo };
  if (hint.match.kind === "ambiguous") return { candidates: hint.match.candidates };
  return {};
}

/** For an ambiguous base: the one candidate repo with an exact or param route for the call, if exactly one has. */
function pickAmong(
  candidates: string[], method: HttpMethod, path: string, candidatesByRepo: Map<string, RouteCandidate<EffectiveRoute>[]>,
): RouteTarget | undefined {
  const found = candidates.flatMap((id) => {
    const picked = pickRoute(method, path, candidatesByRepo.get(id) ?? []);
    return picked && picked.match.confidence !== "guess" ? [picked] : [];
  });
  if (found.length !== 1) return undefined;
  const p = found[0]!;
  return { kind: "route", route: p.item, confidence: p.match.confidence, ...(p.match.reason !== undefined ? { reason: p.match.reason } : {}) };
}

interface HintCtx { repos: RepoData[]; external: ExternalService[]; named: NamedRepo[] }

/** The hint a call's base gives, unless the workspace file already settles that base (an `apiBase` or
 * `external` entry naming it), or the call has no named base. */
function baseHint(call: LinkedCall, clients: HttpClient[], ctx: HintCtx): BaseHint | undefined {
  const dest = destinationOf(call, clients);
  if (dest.kind !== "base") return undefined;
  if (externalNameFor(dest.base.text, ctx.external) !== undefined || configuredRepos(dest.base, ctx.repos).length > 0) return undefined;
  const trusted = dest.base.kind !== "host" || looksInternal(dest.base.text);
  return { base: dest.base, match: matchBase(dest.base, ctx.named), ...(trusted ? {} : { trusted: false }) };
}

function ambiguousReason(hint: BaseHint & { match: { kind: "ambiguous" } }): string {
  return `base ${hint.base.text} could be ${hint.match.candidates.join(" or ")}`;
}

/** Other-service calls (spec §3): a call whose base the workspace file's `external` list names is that
 * service's, before any route matching. An env var base that no repo's apiBase names is another
 * service's only when the call also matches no route (never drops a route) and some repo declares an
 * apiBase (otherwise there is nothing to tell other services from our own backend). */
function resolveTarget(
  call: LinkedCall, clients: HttpClient[], allBackends: RepoData[], effectiveByRepo: Map<string, EffectiveRoute[]>,
  knownHosts: Set<string>, ctx: HintCtx, answer?: AnswerHint,
): UiLink["target"] {
  // 0.6 §5: the user's answer about this caller's base wins over everything codeloom reads.
  if (answer?.external !== undefined) return { kind: "external", base: answer.base, name: answer.external };
  if (answer?.repo !== undefined) return resolveHinted(call, clients, allBackends, effectiveByRepo, answer.repo);
  const hint = baseHint(call, clients, ctx);
  const found = resolveRouteTarget(call, clients, allBackends, effectiveByRepo, knownHosts, ctx, hint);
  if (found.kind !== "unresolved" || call.kind === "unknown" || trustedRepos(hint).candidates) return found;
  const env = envBaseOf(call, clients);
  if (env === undefined || isOwnEnvBase(env, ctx.repos)) return found;
  if (!ctx.repos.some((r) => (r.ref.apiBase ?? []).length > 0)) return found;
  return { kind: "external", base: env };
}

function resolveRouteTarget(
  call: LinkedCall, clients: HttpClient[], allBackends: RepoData[], effectiveByRepo: Map<string, EffectiveRoute[]>,
  knownHosts: Set<string>, ctx: HintCtx, hint: BaseHint | undefined,
): UiLink["target"] {
  if (call.kind === "unknown") return { kind: "unresolved", reason: "url has no literal text" };
  const declaredBase = envBaseOf(call, clients) ?? ownHostOf(call) ?? clients.find((c) => c.name === call.client)?.baseHost;
  const declaredName = declaredBase === undefined ? undefined : externalNameFor(declaredBase, ctx.external);
  if (declaredBase !== undefined && declaredName !== undefined) return { kind: "external", base: declaredBase, name: declaredName };
  // 0.6 §2: a trusted base naming exactly one repo narrows the match to that repo — even an internal-looking
  // host that would otherwise count as a third party's. One naming two or more links only when exactly one of
  // them has an exact or param route for the call; otherwise nothing (never guessed).
  const { one: named, candidates } = trustedRepos(hint);
  const ownHost = ownHostOf(call);
  // An absolute URL on the call itself overrides any client baseURL (axios/ky semantics).
  const path = ownHost !== undefined ? call.path : callPathWithClient(call, clients);
  if (candidates) {
    const among = pickAmong(candidates, call.method, path, routeCandidatesByRepo(effectiveByRepo));
    return among ?? { kind: "unresolved", reason: ambiguousReason(hint as BaseHint & { match: { kind: "ambiguous" } }) };
  }
  const external = externalHost(call, clients, knownHosts);
  if (external !== undefined && named === undefined) return { kind: "external", base: external };
  if (allBackends.length === 0) return { kind: "unresolved", reason: "no matching route" };
  // chooseBackend only narrows the candidate pool (e.g. to avoid matching the wrong repo's same-named
  // route); it is NOT itself a confidence signal. pickRoute already produces "guess" on a genuine tie
  // (two backends whose best candidate is equally specific), which is the only real ambiguity — a
  // repo set that merely wasn't *hinted* is not ambiguous when the paths themselves don't collide
  // (demo-shop's "api" and "billing" never share a route, so every call there resolves "exact").
  const pick = (repos: RepoData[]) => pickRoute(call.method, path, repos.flatMap((b) =>
    (effectiveByRepo.get(b.ref.id) ?? []).map(routeCandidate),
  ));
  const { repos: backends, hinted } = chooseBackend(call, clients, allBackends, named);
  const picked = pick(backends);
  if (picked) return { kind: "route", route: picked.item, confidence: picked.match.confidence, reason: picked.match.reason };
  // A host naming a repo that has no such route stays the other service it always was.
  if (external !== undefined) return { kind: "external", base: external };
  // A hint (apiBase / role "api") that leads nowhere is weaker evidence than a route that really
  // exists elsewhere: retry over every backend, but only ever as a guess.
  const fallback = hinted ? pick(allBackends) : null;
  if (fallback) return { kind: "route", route: fallback.item, confidence: "guess", reason: "matched outside the hinted backends" };
  return { kind: "unresolved", reason: "no matching route" };
}

/** A call the user placed (an `env` answer: its base goes to `repo`): matched against that repo's routes only;
 * when none matches, against every backend, but only ever as a guess ("matched outside the hinted backends",
 * which map_gaps then asks about); else unresolved. Never another service, never another repo for sure. */
function resolveHinted(
  call: LinkedCall, clients: HttpClient[], allBackends: RepoData[], effectiveByRepo: Map<string, EffectiveRoute[]>, repo: string,
): UiLink["target"] {
  if (call.kind === "unknown") return { kind: "unresolved", reason: "url has no literal text" };
  const path = ownHostOf(call) !== undefined ? call.path : callPathWithClient(call, clients);
  const pick = (repos: RepoData[]) => pickRoute(call.method, path, repos.flatMap((b) =>
    (effectiveByRepo.get(b.ref.id) ?? []).map(routeCandidate),
  ));
  const picked = pick(allBackends.filter((b) => b.ref.id === repo));
  if (picked) return { kind: "route", route: picked.item, confidence: picked.match.confidence, reason: picked.match.reason ?? ANSWERED };
  const fallback = pick(allBackends);
  if (fallback) return { kind: "route", route: fallback.item, confidence: "guess", reason: "matched outside the hinted backends" };
  return { kind: "unresolved", reason: "no matching route" };
}

/** `from`, trailing "/" trimmed (except "/" itself) — the schema already requires a leading "/" (review
 * fix: no more silently inserting one for a bad value; a `from` that doesn't start with "/" is now a
 * workspace-file validation error, never guessed at). */
function normalizeProxyFrom(from: string): string {
  const trimmed = from.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** `call.path` with `proxy.from`'s prefix stripped (default) or kept (`stripPrefix: false`), when the
 * call's URL starts with that prefix at a path-segment boundary (so "/api/core" never matches
 * "/api/core-x"); undefined when it does not — this rule simply does not apply to the call. */
export function proxyPathFor(callPath: string, proxy: Pick<ProxyRule, "from" | "stripPrefix">): string | undefined {
  const prefix = normalizeProxyFrom(proxy.from);
  const stripped = callPath === prefix ? "/" : callPath.startsWith(`${prefix}/`) ? callPath.slice(prefix.length) : undefined;
  if (stripped === undefined) return undefined;
  return proxy.stripPrefix === false ? callPath : stripped;
}

/** `effectiveByRepo`'s routes turned into `pickRoute` candidates once per repo (review fix: previously
 * rebuilt on every call, for every proxy rule). Built once in `linkUi` and reused by every call's
 * `resolveProxyTargets`. */
export function routeCandidatesByRepo(effectiveByRepo: Map<string, EffectiveRoute[]>): Map<string, RouteCandidate<EffectiveRoute>[]> {
  const out = new Map<string, RouteCandidate<EffectiveRoute>[]>();
  for (const [id, routes] of effectiveByRepo) {
    out.set(id, routes.map(routeCandidate));
  }
  return out;
}

/** Extra route match for `call` through `ref.proxies` (spec §4): the rule whose prefix matches and is
 * *longest* (review fix: overlapping rules, e.g. "/api" and "/api/core" both configured, must not both
 * fire — the most specific one wins, the rest are not tried at all) is run, via the same pickRoute
 * matching as any other UI call, against the named repo's routes; at most one entry, or `[]` when no
 * rule matches, the matched rule's repo has no matching route, or (review fix) the call plainly isn't
 * same-origin: proxies are a same-origin, relative-URL convention, so this returns `[]` outright when
 * `call` has its own absolute host or a stripped `base` of its own, when its client's own baseURL is
 * absolute (`baseHost`) or unresolved (`baseExpr`), or when `target` (the call's own-repo resolution,
 * already computed by `resolveTarget`) says the call is third-party (`kind: "external"`) — any of these
 * means the call's destination is not decided by a simple path prefix, so a `from` that happens to match
 * the call's (host-stripped) path text must never invent a link. An unknown-kind call has no literal URL
 * to match either. */
export function resolveProxyTargets(
  call: LinkedCall, ref: RepoRef, clients: HttpClient[], candidatesByRepo: Map<string, RouteCandidate<EffectiveRoute>[]>,
  target: UiLink["target"],
  /** 0.6 §2: proxy rules read from the repo's own code (see derivedProxies), tried after the workspace file's. */
  derived: LinkProxy[] = [],
): RouteTarget[] {
  if (call.kind === "unknown" || target.kind === "external") return [];
  if (ownHostOf(call) !== undefined || call.base !== undefined) return [];
  const client = clientFor(call, clients);
  if (client?.baseHost !== undefined || client?.baseExpr !== undefined) return [];
  const effectivePath = callPathWithClient(call, clients);
  /** The call's own target is the catch-all route this rule was read from (one rule per method it exports). */
  const isVia = (proxy: LinkProxy) => proxy.route !== undefined && target.kind === "route" && target.route.route.at.file === proxy.route.file
    && target.route.route.at.line === proxy.route.line;
  let best: { proxy: LinkProxy; stripped: string } | undefined;
  for (const proxy of [...(ref.proxies ?? []), ...derived]) {
    const stripped = proxyPathFor(effectivePath, proxy);
    if (stripped === undefined) continue;
    const len = normalizeProxyFrom(proxy.from).length;
    const bestLen = best ? normalizeProxyFrom(best.proxy.from).length : -1;
    // Longest prefix wins; among equal ones the first (the workspace file's before code's), unless a later one to the
    // same repo was read from the very route the call reaches.
    if (len > bestLen || (best && len === bestLen && proxy.to === best.proxy.to && isVia(proxy) && !isVia(best.proxy))) {
      best = { proxy, stripped };
    }
  }
  if (!best) return [];
  const forwarded = best.proxy.prefix !== undefined ? joinPaths(best.proxy.prefix, best.stripped) : best.stripped;
  const picked = pickRoute(call.method, forwarded, candidatesByRepo.get(best.proxy.to) ?? []);
  if (!picked) return [];
  const via = isVia(best.proxy) ? (target as Extract<UiLink["target"], { kind: "route" }>).route : undefined;
  return [{
    kind: "route", route: picked.item, confidence: picked.match.confidence,
    ...(picked.match.reason !== undefined ? { reason: picked.match.reason } : {}), ...(via ? { via } : {}),
  }];
}

/** A proxy rule as the linker applies it: a workspace file rule, or one read from code (0.6 §2), which may
 * put a literal `prefix` before the forwarded rest of the path (`/api/billing/x` → `/billing/x`). */
export type LinkProxy = ProxyRule & {
  prefix?: string;
  /** A rule read from a Next.js catch-all route: where that route is registered. */
  route?: { file: string; line: number };
};

/** What every part of linking shares, built once per link run. */
interface LinkSetup {
  effectiveByRepo: Map<string, EffectiveRoute[]>;
  candidatesByRepo: Map<string, RouteCandidate<EffectiveRoute>[]>;
  knownHosts: Set<string>;
  hints: HintCtx;
  /** Proxy rules read from each repo's own Next.js catch-all routes (see derivedProxies). */
  derived: Map<string, LinkProxy[]>;
  /** callKey of every call such a route forwards with: the proxy itself, never a service call. */
  forwarders: Set<string>;
  /** Each repo's HTTP calls (see linkedCalls), read once. */
  calls: Map<string, LinkedCall[]>;
  /** 0.6 §5: the user's answers about call bases (answers.json), applied before any hint. */
  answers: AnswerHint[];
}

function callKey(repo: string, c: HttpCall): string {
  return [repo, c.at.file, String(c.at.line), c.method, c.path].join("\0");
}

function linkSetup(input: LinkInput): LinkSetup {
  const effectiveByRepo = new Map(input.ws.repos.map((r) => [r.ref.id, effectiveRoutes(r.endpoints)]));
  const hints: HintCtx = { repos: input.ws.repos, external: input.ws.external ?? [], named: namedRepos(input.ws.repos) };
  return {
    effectiveByRepo, candidatesByRepo: routeCandidatesByRepo(effectiveByRepo), knownHosts: apiBaseHosts(input.ws.repos), hints,
    ...derivedProxies(input.ws.repos, hints, input.ws.baseHints ?? []),
    calls: new Map(input.ws.repos.map((r) => [r.ref.id, linkedCalls(input, r)])),
    answers: input.ws.baseHints ?? [],
  };
}

const SPLAT_TAIL_RE = /\/:[^/]+\*$/;
const isDynamic = (seg: string) => seg.startsWith(":") || seg === "*";

/** A catch-all route's forward (route.forwards, read across imports at index time) as the HTTP call it makes. */
function forwardCall(route: Route, fw: RouteForward & { path: string }): HttpCall {
  return {
    method: route.method, path: fw.path, raw: fw.raw, resolved: true, client: "fetch", at: fw.at, kind: "template",
    ...(fw.base !== undefined ? { base: fw.base } : {}),
  };
}

/** A Next.js catch-all route that forwards (route.forwards) somewhere codeloom could not place: no readable base,
 * or a base naming no single repo here. A question for the user (map/gaps.ts), answered with a `proxy` answer. */
export interface UnplacedProxy {
  repo: string;
  /** The route's prefix (`/api/billing`). */
  from: string;
  routes: Route[];
  forwards: RouteForward;
  /** Why: no readable base; a base naming several repos (`candidates`); one naming none here; or a forwarded path
   * codeloom cannot read (`path`: unreadable parts, or literal text after the catch-all). */
  reason: "no-base" | "ambiguous" | "unknown" | "path";
  /** The repos the base's name could mean (more than one), if any. */
  candidates?: string[];
}

/** 0.6 §2: a Next.js catch-all API route (`app/api/billing/[...path]/route.ts`) whose handler forwards to a base
 * naming exactly one other repo is a proxy rule for that repo, applied like a workspace file `proxies` entry:
 * a UI call under the route's prefix also matches that repo's routes. The forwarding call is the one the indexer
 * found by following the handler through the functions it calls, across imports (route.forwards); for an
 * endpoints.json written before that, a forwarding call in the handler itself. The forwarded path is the call's
 * literal path before its dynamic rest: none → the prefix is stripped; the route's own prefix → kept; any other →
 * swapped for it. A route whose forwarding calls name no single repo, or end in literal text after the dynamic
 * rest, gives no rule; when it has a route.forwards, it is `unplaced` (unless an answer or the workspace file
 * already says where its prefix goes). The user's answer about a base (an `env` answer) places it too. */
function derivedProxies(
  repos: RepoData[], hints: HintCtx, answers: AnswerHint[] = [],
): { derived: Map<string, LinkProxy[]>; forwarders: Set<string>; unplaced: UnplacedProxy[] } {
  const derived = new Map<string, LinkProxy[]>();
  const forwarders = new Set<string>();
  const unplaced = new Map<string, UnplacedProxy>();
  for (const repo of repos) {
    const clients = repo.endpoints.httpClients;
    for (const route of repo.endpoints.routes) {
      if (route.framework !== "next-api" || !route.handlerFile || !SPLAT_TAIL_RE.test(route.path)) continue;
      const from = route.path.replace(SPLAT_TAIL_RE, "") || "/";
      const fw = route.forwards;
      if (fw) {
        // The forwarding call itself is the proxy, never a service call.
        for (const c of repo.endpoints.httpCalls) if (c.at.file === fw.at.file && c.at.line === fw.at.line) forwarders.add(callKey(repo.ref.id, c));
      }
      const calls = fw
        ? (fw.path !== undefined ? [forwardCall(route, fw as RouteForward & { path: string })] : [])
        : repo.endpoints.httpCalls.filter((c) => c.at.file === route.handlerFile && c.at.symbol === route.handler && c.kind !== "unknown");
      const rules: Array<{ call: HttpCall; rule: LinkProxy }> = [];
      let candidates: string[] | undefined;
      let pathUnreadable = fw !== undefined && fw.base !== undefined && fw.path === undefined;
      for (const call of calls) {
        const answer = hintFor(answers, repo.ref.id, call, clients);
        if (answer?.external !== undefined) continue;
        const dest = destinationOf(call, clients);
        let to = answer?.repo;
        if (to === undefined) {
          if (dest.kind !== "base" || externalNameFor(dest.base.text, hints.external) !== undefined) continue;
          const configured = configuredRepos(dest.base, hints.repos);
          if (configured.length === 0 && dest.base.kind === "host" && !looksInternal(dest.base.text)) continue;
          const match = configured.length > 0 ? undefined : matchBase(dest.base, hints.named);
          to = configured.length === 1 ? configured[0]!.ref.id : match?.kind === "one" ? match.repo : undefined;
          if (match?.kind === "ambiguous") candidates = match.candidates.filter((id) => id !== repo.ref.id);
        }
        if (to === undefined || to === repo.ref.id) continue;
        const segs = call.path.split("/").filter(Boolean);
        const k = segs.findIndex(isDynamic);
        if (k === -1 || !segs.slice(k).every(isDynamic)) {
          pathUnreadable = true;
          continue;
        }
        const prefix = k === 0 ? "" : `/${segs.slice(0, k).join("/")}`;
        const at = { route: { file: route.at.file, line: route.at.line } };
        const rule: LinkProxy = prefix === "" ? { from, to, ...at } : prefix === from ? { from, to, stripPrefix: false, ...at } : { from, to, prefix, ...at };
        rules.push({ call, rule });
      }
      const targets = new Set(rules.map((r) => JSON.stringify(r.rule)));
      if (targets.size === 1) {
        if (!fw) for (const r of rules) forwarders.add(callKey(repo.ref.id, r.call));
        derived.set(repo.ref.id, [...(derived.get(repo.ref.id) ?? []), rules[0]!.rule]);
        continue;
      }
      const answered = fw === undefined || calls.some((c) => hintFor(answers, repo.ref.id, c, clients)?.external !== undefined)
        || (repo.ref.proxies ?? []).some((p) => proxyPathFor(from, p) !== undefined);
      if (answered) continue;
      const key = `${repo.ref.id}\0${from}`;
      const seen = unplaced.get(key);
      if (seen) seen.routes.push(route);
      else {
        const several = candidates && candidates.length > 1 ? candidates : undefined;
        const reason = fw.base === undefined ? "no-base" : several ? "ambiguous" : pathUnreadable ? "path" : "unknown";
        unplaced.set(key, { repo: repo.ref.id, from, routes: [route], forwards: fw, reason, ...(several ? { candidates: several } : {}) });
      }
    }
  }
  return { derived, forwarders, unplaced: [...unplaced.values()] };
}

/** The group's catch-all routes that forward somewhere codeloom could not place (see derivedProxies). */
export function unplacedProxies(ws: Pick<WorkspaceData, "repos" | "external" | "baseHints">): UnplacedProxy[] {
  const hints: HintCtx = { repos: ws.repos, external: ws.external ?? [], named: namedRepos(ws.repos) };
  return derivedProxies(ws.repos, hints, ws.baseHints ?? []).unplaced;
}

export const FORWARDING = "a proxy route's own forwarding call";

/** For each HttpCall: the UI pages that reach it, and the route (or external/unresolved) it targets. */
export function linkUi(input: LinkInput): UiLink[] {
  return linkUiWith(input, linkSetup(input));
}

function linkUiWith(input: LinkInput, setup: LinkSetup): UiLink[] {
  const allBackends = input.ws.repos.filter((r) => r.endpoints.routes.length > 0);
  const { effectiveByRepo, candidatesByRepo, knownHosts, hints } = setup;
  const links: UiLink[] = [];
  for (const repo of input.ws.repos) {
    const answers = (input.ws.baseHints ?? []).filter((h) => h.from === undefined || h.from === repo.ref.id);
    for (const call of setup.calls.get(repo.ref.id) ?? []) {
      if (setup.forwarders.has(callKey(repo.ref.id, call))) {
        // A proxy route's own forwarding call is the proxy (derivedProxies), never a call of its own to some route.
        links.push({ repo: repo.ref.id, call, pages: reachingPages(input, repo.ref.id, call), target: { kind: "unresolved", reason: FORWARDING }, proxied: [] });
        continue;
      }
      const answer = hintFor(answers, repo.ref.id, call, repo.endpoints.httpClients);
      const target = resolveTarget(call, repo.endpoints.httpClients, allBackends, effectiveByRepo, knownHosts, hints, answer);
      links.push({
        repo: repo.ref.id,
        call,
        pages: reachingPages(input, repo.ref.id, call),
        target,
        proxied: resolveProxyTargets(call, repo.ref, repo.endpoints.httpClients, candidatesByRepo, target, setup.derived.get(repo.ref.id)),
      });
    }
  }
  links.sort((a, b) => compare(a.repo, b.repo) || compare(a.call.at.file, b.call.at.file) || a.call.at.line - b.call.at.line
    || compare(a.call.method, b.call.method) || compare(a.call.path, b.call.path));
  return links;
}

/** A repo's HTTP calls: the adapter's, plus those derived from calls to its HTTP wrappers. A wrapper call on a
 * line where the adapter already sees an HTTP call (e.g. `api.get("/x")` on an object named like a client) is
 * the same call: the adapter's is kept. Keyed on file, line, method and path so a different call sharing the
 * line is kept. */
function linkedCalls(input: LinkInput, repo: RepoData): LinkedCall[] {
  const resolver = input.resolvers.get(repo.ref.id);
  const key = (c: HttpCall) => `${c.at.file}:${c.at.line}:${c.method}:${c.path}`;
  const seen = new Set(repo.endpoints.httpCalls.map(key));
  // Calls through a wrapper made from test, e2e or mock files are never the system's (0.6).
  const derived = resolver ? wrapperCalls(resolver, repo.endpoints.httpCalls).filter((c) => !seen.has(key(c)) && !isTestFile(c.at.file)) : [];
  return [...repo.endpoints.httpCalls, ...derived];
}

// ---------------------------------------------------------------------------------------------------
// 0.6 §3: service-to-service HTTP. A backend's outgoing call continues the chain into the route it reaches.
// ---------------------------------------------------------------------------------------------------

/** One outgoing call of a repo, with the route it reaches (`target`) or, when its base names no single repo,
 * that base (`gap`, an unresolved base). Neither: it goes nowhere in the group (a third party, an unreadable
 * base, a proxy's own forwarding call, no route matching). */
export interface ServiceCall {
  call: LinkedCall;
  target?: RouteTarget;
  gap?: BaseHint;
}

/** A service call a handler's walk reaches, like a store hit. */
export interface ServiceHit {
  call: LinkedCall;
  target: RouteTarget;
  viaPath: WalkStep[];
}

/** A service call with an unresolved base that a handler's walk reaches. */
export interface ServiceGap {
  repo: string;
  call: LinkedCall;
  gap: BaseHint;
}

const hasLiteralSegment = (path: string) => path.split("/").some((seg) => seg !== "" && !isDynamic(seg));

/** Where a backend's call goes (precision first; a backend has no origin, so its base was set somewhere):
 * - a base the workspace file names (`apiBase`) → those repos; one in `external` → nowhere;
 * - a trusted named base (env var, config key, identifier, internal-looking host) → the one repo it names; one
 *   naming several → the one candidate with an exact or param route, if exactly one has;
 * - a gap (an unresolved base) when it cannot be settled: a relative URL (the base was set elsewhere:
 *   `axios.defaults`, a DI module), a loopback host no `apiBase` names (listen ports are not recorded), an
 *   unreadable base expression, a name matching no repo or several, a public-looking host naming a repo;
 * - nowhere, silently: a public host naming no repo (a third party), a call with no literal path segment, a
 *   proxy route's own forwarding call.
 * Never another repo's route by a path guess alone. */
function serviceTarget(repo: RepoData, call: LinkedCall, setup: LinkSetup): ServiceCall {
  if (call.kind === "unknown" || setup.forwarders.has(callKey(repo.ref.id, call))) return { call };
  const clients = repo.endpoints.httpClients;
  const path = ownHostOf(call) !== undefined ? call.path : callPathWithClient(call, clients);
  if (!hasLiteralSegment(path)) return { call };
  // 0.6 §5: the user said where this repo's calls through this base go (a relative URL's client counts as its
  // base here). Another service: nowhere, and no question. A repo: that repo's routes only, never a path guess
  // elsewhere; none matching leaves the call where map_gaps asks about it again.
  const answer = hintFor(setup.answers, repo.ref.id, call, clients, { relative: true });
  if (answer?.external !== undefined) return { call };
  if (answer?.repo !== undefined) {
    const picked = toTarget(pickRoute(call.method, path, setup.candidatesByRepo.get(answer.repo) ?? []));
    return picked ? { call, target: { ...picked, reason: picked.reason ?? ANSWERED } } : { call };
  }
  const dest = destinationOf(call, clients);
  const gap = (base: CallBase, match: BaseMatch = { kind: "unknown" }, trusted = true): ServiceCall =>
    ({ call, gap: { base, match, ...(trusted ? {} : { trusted: false }) } });
  if (dest.kind === "opaque") return gap({ kind: "expr", text: dest.expr });
  if (dest.kind === "relative") return gap({ kind: "relative", text: call.client || "fetch" });
  const base: CallBase = dest.kind === "loopback" ? { kind: "host", text: dest.host } : dest.base;
  if (externalNameFor(base.text, setup.hints.external) !== undefined) return { call };
  const configured = configuredRepos(base, setup.hints.repos);
  let target: RouteTarget | undefined;
  if (configured.length > 0) {
    target = toTarget(pickRoute(call.method, path, configured.flatMap((r) => setup.candidatesByRepo.get(r.ref.id) ?? [])));
  } else {
    if (dest.kind === "loopback") return gap(base);
    const hint: BaseHint = { base, match: matchBase(base, setup.hints.named) };
    const trusted = base.kind !== "host" || looksInternal(base.text);
    if (!trusted) return hint.match.kind === "unknown" ? { call } : gap(base, hint.match, false);
    if (hint.match.kind === "unknown") return gap(base);
    target = hint.match.kind === "one"
      ? toTarget(pickRoute(call.method, path, setup.candidatesByRepo.get(hint.match.repo) ?? []))
      : pickAmong(hint.match.candidates, call.method, path, setup.candidatesByRepo);
    if (!target && hint.match.kind === "ambiguous") return gap(base, hint.match);
  }
  return target ? { call, target } : { call };
}

function toTarget(picked: { item: EffectiveRoute; match: { confidence: Confidence; reason?: string } } | null): RouteTarget | undefined {
  if (!picked) return undefined;
  return { kind: "route", route: picked.item, confidence: picked.match.confidence, ...(picked.match.reason !== undefined ? { reason: picked.match.reason } : {}) };
}

/** Every repo's outgoing calls with where each goes (see serviceTarget). Store walks pick the ones a handler reaches. */
function serviceCalls(input: LinkInput, setup: LinkSetup): Map<string, ServiceCall[]> {
  return new Map(input.ws.repos.map((repo) => [
    repo.ref.id,
    (setup.calls.get(repo.ref.id) ?? []).map((call) => serviceTarget(repo, call, setup)).filter((s) => s.target !== undefined || s.gap !== undefined),
  ]));
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
  /** 0.6 §3: calls to another route of the group (or this repo's own, for a relative URL) the walk reaches. */
  calls?: ServiceHit[];
  /** 0.6 §2: reached calls whose base names no single repo. */
  gaps?: ServiceGap[];
}

export interface ConsumerLink {
  repo: string; consume: QueueOp; handler: SymbolRef; hits: StoreHit[]; unresolved: Array<{ at: Loc; reason: string }>;
  /** "exact" when the handler is the function the consume call hands over (by name, `this.x`, or an inline
   * callback); "guess" when it could not be found and the walk starts at the enclosing function instead. */
  handlerConfidence?: Confidence;
  calls?: ServiceHit[];
  gaps?: ServiceGap[];
}

/** A workspace `links` entry, validated. When resolved and `to` is a symbol, `target` is that symbol walked
 * like a handler (its calls -> store hits), so buildChains can continue a chain from it. */
export interface ManualLink {
  from: string; to: string; resolved: boolean; reason?: string; source?: "answers";
  target?: { handler: SymbolRef; hits: StoreHit[]; unresolved: Array<{ at: Loc; reason: string }> };
}

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
  const scope = namedHandlerScope(input, r, idx, name);
  // A handler whose controller another file may have re-namespaced (Route.handlerGuess) stays a guess.
  return route.handlerGuess ? { ...scope, confidence: "guess" } : scope;
}

function namedHandlerScope(input: LinkInput, r: EffectiveRoute, idx: FileCodeIndex | undefined, name: string): HandlerScope {
  const route = r.route as EffectiveRoute["route"] & { handlerFile: string };
  const resolver = input.resolvers.get(r.repo);
  if (idx?.symbols.some((s) => s.name === name)) {
    return { ref: { repo: r.repo, file: route.handlerFile, symbol: name }, confidence: "exact" };
  }
  // Not declared in handlerFile under that name: maybe re-exported / aliased from there.
  const viaExport = resolver?.resolveExport(route.handlerFile, name);
  if (viaExport) return { ref: viaExport, confidence: "exact" };
  // Adonis loads a controller module's default export, whatever the class calls itself
  // (`"Admin/CustomersController.index"` -> `export default class AdminCustomersController`).
  const method = route.framework === "adonis" ? /^[^.]+(\.[^.]+)$/.exec(name)?.[1] : undefined;
  const viaDefault = method !== undefined ? resolver?.resolveExport(route.handlerFile, `default${method}`) : undefined;
  if (viaDefault) return { ref: viaDefault, confidence: "exact" };
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
      // A JSX reference is not a call: an unresolved one (`<ReactMarkdown>`) is no lost call.
      if (site.kind !== undefined || resolver.resolve(step.ref.file, site)) continue;
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
function storeHits(
  resolver: CallResolver, repoId: string, scope: HandlerScope, access: DbAccess[], queues: QueueOp[], services: ServiceCall[] = [],
): { steps: WalkStep[]; hits: StoreHit[]; calls: ServiceHit[]; gaps: ServiceGap[] } {
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
  const calls: ServiceHit[] = [];
  const gaps: ServiceGap[] = [];
  for (const s of services) {
    const viaPath = viaPathTo(s.call.at);
    if (!viaPath) continue;
    if (s.target) calls.push({ call: s.call, target: s.target, viaPath });
    else if (s.gap) gaps.push({ repo: repoId, call: s.call, gap: s.gap });
  }
  const callLabel = (c: ServiceHit) => `${c.call.at.file}:${String(c.call.at.line).padStart(8, "0")}:${c.call.method} ${c.call.path}`;
  calls.sort((a, b) => a.viaPath.length - b.viaPath.length || compare(callLabel(a), callLabel(b)));
  return { steps, hits, calls, gaps };
}

/** `calls` / `gaps` as optional link fields: present only when non-empty. */
function serviceFields(calls: ServiceHit[], gaps: ServiceGap[]): { calls?: ServiceHit[]; gaps?: ServiceGap[] } {
  return { ...(calls.length > 0 ? { calls } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
}

/** Route -> handler -> walkCalls -> every DbAccess / publish QueueOp reached, and (0.6 §3, `services` given)
 * every outgoing call that reaches a route. */
export function linkBackend(input: LinkInput, services: Map<string, ServiceCall[]> = new Map()): BackendLink[] {
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
      const { steps, hits, calls, gaps } = storeHits(
        resolver, repo.ref.id, scope, repo.endpoints.dbAccess, repo.endpoints.queues, services.get(repo.ref.id),
      );
      out.push({
        repo: repo.ref.id, route: er, handler: scope.ref, handlerConfidence: scope.confidence,
        hits, unresolved: collectUnresolved(resolver, steps, scope, knownAt), ...serviceFields(calls, gaps),
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

/** RabbitMQ's built-in exchanges, whose type needs no `assertExchange`. */
const BUILT_IN_EXCHANGES: ReadonlyMap<string, string> = new Map([
  ["amq.topic", "topic"], ["amq.direct", "direct"], ["amq.fanout", "fanout"], ["amq.headers", "headers"], ["amq.match", "headers"],
]);

/** "conflict": an exchange declared with two different types. */
const CONFLICT = "conflict";

/** Every exchange's type across the group: the built-in `amq.*` ones, and each `assertExchange` (in any repo).
 * An exchange declared two different ways is a "conflict". */
export function exchangeTypes(ws: WorkspaceData): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const r of ws.repos) {
    for (const x of r.endpoints.exchanges ?? []) {
      seen.set(x.name, new Set([...(seen.get(x.name) ?? []), x.type.toLowerCase()]));
    }
  }
  const out = new Map(BUILT_IN_EXCHANGES);
  for (const [name, types] of seen) out.set(name, types.size === 1 ? [...types][0]! : CONFLICT);
  return out;
}

/** How a binding on an exchange of `type` matches a publish's routing key (0.6 §3), and how sure that is.
 * fanout: every binding, whatever the key; direct: the same key only; topic: `*` / `#` patterns (a wildcard
 * match is "param"); headers: the key is not used and headers are not read, so every binding is a guess.
 * Never declared: the same key, and a key with `*` / `#` as a topic pattern ("param": the wildcard is itself the
 * sign of a topic exchange). Declared two different ways: the same key only. */
function bindingMatch(type: string | undefined, bindKey: string, pubKey: string): { confidence: Confidence; reason?: string } | null {
  switch (type) {
    case "fanout": return { confidence: "exact" };
    case "headers": return { confidence: "guess", reason: "headers exchange: the headers a binding matches are not read" };
    case "direct":
    case CONFLICT:
      return bindKey === pubKey ? { confidence: "exact" } : null;
    default:
      if (bindKey === pubKey) return { confidence: "exact" };
      return /[*#]/.test(bindKey) && routingKeyMatches(bindKey, pubKey) ? { confidence: "param" } : null;
  }
}

/** The hop reason of a link made from the user's answer (0.6 §5, answers.json). */
export const ANSWERED = "from your answer";

/** Memo (f): sendToQueue <-> consume on the same queue -> exact; exchange publish -> bind(exchange, key)
 * -> consume(bound queue) by the exchange's type (see bindingMatch); no binding -> consume on a queue named
 * like the routing key or exchange -> guess. Publisher and consumer may be in any repos of the group. */
export function pairQueues(ws: WorkspaceData): QueuePair[] {
  const pairs = new Map<string, QueuePair>();
  const types = exchangeTypes(ws);
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
      const type = types.get(publish.exchange);
      const matches = binds.flatMap((b) => {
        if (b.q.exchange !== publish.exchange) return [];
        const m = bindingMatch(type, b.q.routingKey ?? "", publish.routingKey ?? "");
        return m ? [{ b, m }] : [];
      });
      if (matches.length > 0) {
        for (const { b, m } of matches) {
          for (const c of consumers.filter((c) => c.q.queue === b.q.queue)) add(from.ref.id, publish, c, m.confidence, m.reason);
        }
        continue;
      }
      for (const c of consumers.filter((c) => c.q.queue === publish.routingKey || c.q.queue === publish.exchange)) {
        add(from.ref.id, publish, c, "guess", "no binding found; matched by exchange/routing-key heuristic");
      }
    }
  }
  // 0.6 §5 answers: the user said messages published as `publish` arrive on `consume` (a binding made where
  // codeloom cannot see it). Exact, with the answer as the reason; a pair codeloom found itself is kept as is.
  for (const alias of ws.queueAliases ?? []) {
    for (const from of ws.repos) {
      for (const publish of from.endpoints.queues.filter((q) => q.op === "publish" && q.queue === alias.publish)) {
        for (const c of consumers.filter((c) => c.q.queue === alias.consume)) {
          if (!pairs.has(`${opKey(from.ref.id, publish)}|${opKey(c.repo, c.q)}`)) add(from.ref.id, publish, c, "exact", ANSWERED);
        }
      }
    }
  }
  return [...pairs.entries()].sort(([a], [b]) => compare(a, b)).map(([, p]) => p);
}

const CONSUME_ARG = 1;

function calleeProp(c: CallSite["callee"]): string | undefined {
  return c.kind === "ident" ? undefined : c.prop;
}

/** Does the call site record something at argument `index` (a function name, `this.x`, an inline function)? */
function hasHandlerArg(site: CallSite, index: number): boolean {
  return !!(site.refArgs?.some((a) => a.index === index) || site.thisArgs?.some((a) => a.index === index) || site.inlineArgs?.includes(index));
}

/** The consume callback's own symbol. QueueOp records only the consume call site, and a callback passed by
 * reference is never *called* there, so it is read from that call site's recorded arguments: the argument at
 * the op's `handlerArg` (a consume through a wrapper, whatever its method name), else argument 1 of a literal
 * `consume(...)`. A function name -> whatever it binds to in that file (local function or import);
 * `this.handleX` (or `this.handleX.bind(this)`) -> that method of the enclosing class; an inline callback ->
 * the call's own enclosing symbol (the callback's code is inside it), exact. Anything else (no such call site,
 * an argument that names no function) -> the enclosing symbol, but only as a guess: it is not the handler. */
function consumeHandlerRef(resolver: CallResolver, repoId: string, q: QueueOp): { ref: SymbolRef; confidence: Confidence } {
  // The adapter knew the handler exactly (a subclass method a base consume loop hands over to, or the callback
  // inside a wrapper): taken as is.
  if (q.handler) return { ref: { repo: repoId, file: q.handler.file, symbol: q.handler.symbol }, confidence: "exact" };
  const fallback: SymbolRef = { repo: repoId, file: q.at.file, symbol: q.at.symbol };
  const handlerArg = q.handlerArg;
  const sites = (resolver.fileIndex(q.at.file)?.calls ?? []).filter((s) => s.line === q.at.line && s.kind === undefined);
  let site: CallSite | undefined;
  let index = CONSUME_ARG;
  if (handlerArg !== undefined) {
    index = handlerArg;
    const withArg = sites.filter((s) => hasHandlerArg(s, index));
    site = withArg.length === 1 ? withArg[0] : undefined;
  } else {
    site = sites.find((s) => calleeProp(s.callee) === "consume");
  }
  const name = site?.refArgs?.find((a) => a.index === index)?.name;
  const resolved = name !== undefined ? resolver.resolveName(q.at.file, name) : null;
  if (resolved) return { ref: resolved, confidence: "exact" };
  const member = site?.thisArgs?.find((a) => a.index === index);
  if (member) return { ref: { repo: repoId, file: q.at.file, symbol: `${member.cls}.${member.member}` }, confidence: "exact" };
  if (site?.inlineArgs?.includes(index)) return { ref: fallback, confidence: "exact" };
  return { ref: fallback, confidence: "guess" };
}

export const HANDLER_NOT_FOUND = "could not find the handler this consume hands over: walked from the enclosing function";

/** Every `consume` op -> its handler -> walkCalls -> store hits (and, `services` given, service calls); each
 * consumer starts its own chain. A handler that could not be found is a guess, with an unresolved entry. */
export function linkConsumers(input: LinkInput, services: Map<string, ServiceCall[]> = new Map()): ConsumerLink[] {
  const out: ConsumerLink[] = [];
  for (const repo of input.ws.repos) {
    const resolver = input.resolvers.get(repo.ref.id);
    if (!resolver) continue;
    const knownAt = knownAtKeys(repo.endpoints.dbAccess, repo.endpoints.queues);
    for (const q of repo.endpoints.queues) {
      if (q.op !== "consume") continue;
      const handler = consumeHandlerRef(resolver, repo.ref.id, q);
      const scope: HandlerScope = { ref: handler.ref, confidence: handler.confidence };
      const { steps, hits, calls, gaps } = storeHits(
        resolver, repo.ref.id, scope, repo.endpoints.dbAccess, repo.endpoints.queues, services.get(repo.ref.id),
      );
      const unresolved = collectUnresolved(resolver, steps, scope, knownAt);
      if (handler.confidence !== "exact") unresolved.push({ at: q.at, reason: HANDLER_NOT_FOUND });
      out.push({
        repo: repo.ref.id, consume: q, handler: scope.ref, handlerConfidence: handler.confidence, hits,
        unresolved: sortUnresolved(unresolved), ...serviceFields(calls, gaps),
      });
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
  return input.ws.links.map((l): ManualLink => {
    const src = l.source !== undefined ? { source: l.source } : {};
    const from = parseLinkRef(l.from);
    const to = parseLinkRef(l.to);
    if (!from || !to) return { from: l.from, to: l.to, resolved: false, reason: "could not parse link reference", ...src };
    if (!refExists(input, from)) return { from: l.from, to: l.to, resolved: false, reason: `"${l.from}" was not found`, ...src };
    if (!refExists(input, to)) return { from: l.from, to: l.to, resolved: false, reason: `"${l.to}" was not found`, ...src };
    if (to.kind !== "symbol") return { from: l.from, to: l.to, resolved: true, ...src };
    return { from: l.from, to: l.to, resolved: true, target: walkSymbol(input, { repo: to.repo, file: to.file, symbol: to.symbol }), ...src };
  });
}

/** A manual link's `to` symbol walked like a handler: its calls -> every db access / publish reached. */
function walkSymbol(input: LinkInput, ref: SymbolRef): NonNullable<ManualLink["target"]> {
  const repo = input.ws.repos.find((r) => r.ref.id === ref.repo)!;
  const resolver = input.resolvers.get(ref.repo)!;
  const scope: HandlerScope = { ref, confidence: "exact" };
  const { steps, hits } = storeHits(resolver, ref.repo, scope, repo.endpoints.dbAccess, repo.endpoints.queues);
  const knownAt = knownAtKeys(repo.endpoints.dbAccess, repo.endpoints.queues);
  return { handler: ref, hits, unresolved: collectUnresolved(resolver, steps, scope, knownAt) };
}


export function uiReachKey(f: { repo: string; file: string; line: number; method: string; path: string }): string {
  return [f.repo, f.file, String(f.line), f.method, f.path].join("\0");
}

/** Where backend code starts: every route handler and consumer handler, with an inline callback's lines. */
interface BackendEntry { ref: SymbolRef; lines?: [number, number] }

function backendEntries(input: LinkInput, backend: BackendLink[], consumers: ConsumerLink[]): BackendEntry[] {
  const out: BackendEntry[] = [];
  for (const b of backend) {
    const scope = handlerScope(input, b.route);
    if (scope) out.push(scope.lines ? { ref: scope.ref, lines: scope.lines } : { ref: scope.ref });
  }
  for (const c of consumers) out.push({ ref: c.handler });
  return out;
}

/** A call is backend code when its repo has no UI pages (unless the repo is declared `role: "ui"`), when
 * it sits inside an inline route callback, or when walking its callers (≤6 hops) reaches a route handler
 * or a consumer handler. The walk never crosses a guessed (unique-method) edge: a backend `cache.all()`
 * that only guess-resolves to UI code must not turn that UI call into backend code. */
function isBackendCall(input: LinkInput, repo: RepoData, call: LinkedCall, entries: BackendEntry[], handlerKeys: Set<string>): boolean {
  if (repo.endpoints.pages.length === 0 && repo.ref.role !== "ui") return true;
  const id = repo.ref.id;
  if (entries.some((e) => e.ref.repo === id && e.lines && e.ref.file === call.at.file && within(call.at.line, e.lines))) return true;
  const resolver = input.resolvers.get(id);
  const start: SymbolRef = { repo: id, file: call.at.file, symbol: call.at.symbol };
  if (handlerKeys.has(stepKey(start))) return true;
  return !!resolver && walkCallers(resolver, start, 6, (c) => c.confidence !== "guess")
    .some((s) => handlerKeys.has(stepKey(s.ref)));
}

/** Reach facts (a UI-side call: readable URL, not third-party, not backend; reached by ≥1 page?) for every UI-side call, from linkUi's results (never from deduplicated chains). Skipped:
 * calls with no literal URL (check's "unresolved-url"), third-party calls, and backend calls (see
 * isBackendCall). Sorted by repo, file, line, method, path; one fact per key (reached if any link is). */
export function uiReachFacts(input: LinkInput, ui: UiLink[], backend: BackendLink[], consumers: ConsumerLink[]): UiReachFact[] {
  const entries = backendEntries(input, backend, consumers);
  const handlerKeys = new Set(entries.map((e) => stepKey(e.ref)));
  const byKey = new Map<string, UiReachFact>();
  for (const link of ui) {
    if (link.call.kind === "unknown" || link.target.kind === "external") continue;
    const repo = input.ws.repos.find((r) => r.ref.id === link.repo);
    if (!repo || isBackendCall(input, repo, link.call, entries, handlerKeys)) continue;
    const fact: UiReachFact = {
      repo: link.repo, file: link.call.at.file, line: link.call.at.line, symbol: link.call.at.symbol,
      method: link.call.method, path: link.call.path, reached: link.pages.length > 0,
    };
    const key = uiReachKey(fact);
    const prev = byKey.get(key);
    if (!prev || (!prev.reached && fact.reached)) byKey.set(key, fact);
  }
  return [...byKey.values()].sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file) || a.line - b.line
    || compare(a.method, b.method) || compare(a.path, b.path) || compare(a.symbol, b.symbol));
}

export interface LinkResult {
  ui: UiLink[]; backend: BackendLink[]; consumers: ConsumerLink[]; queuePairs: QueuePair[]; manual: ManualLink[];
  /** UI-side calls and whether a page reaches them (see uiReachFacts). */
  uiReach: UiReachFact[];
  /** 0.6 §2: call bases that name no single repo (see unresolvedBases). Absent when there are none. */
  unresolvedBases?: UnresolvedBase[];
}

export function linkAll(input: LinkInput): LinkResult {
  const setup = linkSetup(input);
  const ui = linkUiWith(input, setup);
  const services = serviceCalls(input, setup);
  const backend = linkBackend(input, services);
  const consumers = linkConsumers(input, services);
  const uiReach = uiReachFacts(input, ui, backend, consumers);
  const bases = unresolvedBases(input, setup, ui, uiReach, [...backend, ...consumers].flatMap((l) => l.gaps ?? []));
  return {
    ui, backend, consumers,
    queuePairs: pairQueues(input.ws),
    manual: resolveManualLinks(input),
    uiReach,
    ...(bases.length > 0 ? { unresolvedBases: bases } : {}),
  };
}

/** 0.6 §2 (read by §5's gaps): every base that names no single repo, with the calls through it — a UI call
 * whose base names two or more repos (it links nothing), or names none and matched no route; a backend call
 * reached from a route or consumer handler whose base names two or more repos or none (it links nothing).
 * One entry per base and reason, calls sorted and deduplicated; entries sorted by base, then kind, then reason. */
function unresolvedBases(input: LinkInput, setup: LinkSetup, ui: UiLink[], uiReach: UiReachFact[], backendGaps: ServiceGap[]): UnresolvedBase[] {
  const uiSide = new Set(uiReach.map(uiReachKey));
  const gaps: ServiceGap[] = [...backendGaps];
  for (const link of ui) {
    const at = link.call.at;
    // UI-side calls (uiReach leaves out third-party ones: a public host naming a repo is one, when a page reaches it).
    const uiCall = uiSide.has(uiReachKey({ repo: link.repo, file: at.file, line: at.line, method: link.call.method, path: link.call.path }))
      || (link.target.kind === "external" && link.pages.length > 0);
    if (!uiCall) continue;
    const clients = input.ws.repos.find((r) => r.ref.id === link.repo)?.endpoints.httpClients ?? [];
    const hint = baseHint(link.call, clients, setup.hints);
    if (!hint) continue;
    if (hint.trusted === false) {
      // A public-looking host that names a repo: never linked by name, so the question is asked.
      if (hint.match.kind !== "unknown") gaps.push({ repo: link.repo, call: link.call, gap: hint });
      continue;
    }
    if (hint.match.kind === "one") continue;
    if (link.target.kind !== "unresolved" || (link.proxied?.length ?? 0) > 0) continue;
    gaps.push({ repo: link.repo, call: link.call, gap: hint });
  }
  const byBase = new Map<string, UnresolvedBase>();
  for (const g of gaps) {
    const candidates = g.gap.match.kind === "ambiguous" ? g.gap.match.candidates : g.gap.match.kind === "one" ? [g.gap.match.repo] : [];
    const reason = g.gap.trusted === false ? "unconfirmed" : g.gap.match.kind === "ambiguous" ? "ambiguous" : "unknown";
    const key = [g.gap.base.text, g.gap.base.kind, reason, candidates.join(",")].join("\0");
    const entry = byBase.get(key) ?? { base: g.gap.base.text, kind: g.gap.base.kind, reason, candidates, calls: [] };
    entry.calls.push({ repo: g.repo, file: g.call.at.file, line: g.call.at.line, symbol: g.call.at.symbol, method: g.call.method, path: g.call.path });
    byBase.set(key, entry);
  }
  const callOrder = (a: UnresolvedBase["calls"][number], b: UnresolvedBase["calls"][number]) => compare(a.repo, b.repo)
    || compare(a.file, b.file) || a.line - b.line || compare(a.method, b.method) || compare(a.path, b.path) || compare(a.symbol, b.symbol);
  return [...byBase.values()].map((e) => {
    const calls = [...e.calls].sort(callOrder).filter((c, i, all) => i === 0 || callOrder(c, all[i - 1]!) !== 0);
    return { ...e, calls };
  }).sort((a, b) => compare(a.base, b.base) || compare(a.kind, b.kind) || compare(a.reason, b.reason) || compare(a.candidates.join(","), b.candidates.join(",")));
}
