import { symbolAt } from "./code-index.js";
import type { FileCodeIndex } from "./code-index.js";
import type { CallResolver, SymbolRef, WalkStep } from "./resolve-calls.js";
import { walkCallers } from "./resolve-calls.js";
import { joinPaths, pickRoute, worse } from "./paths.js";
import type { RouteCandidate } from "./paths.js";
import { effectiveRoutes } from "./mounts.js";
import type { EffectiveRoute } from "./mounts.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { Confidence, HttpCall, HttpClient, UiPage } from "../store/schemas.js";
import { compare } from "../util.js";

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
  call: HttpCall;
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

/** Host (lowercased, port kept) of an absolute URL at the start of `text` (quotes/backtick allowed). */
function urlHost(text: string): string | undefined {
  return text.match(/^\s*[`'"]?[a-z][a-z0-9+.-]*:\/\/([^/'"`?#\s]+)/i)?.[1]?.toLowerCase();
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Hosts named in any repo's apiBase (entries may be env var names, bare hosts, or full URLs). */
function apiBaseHosts(repos: RepoData[]): Set<string> {
  const out = new Set<string>();
  for (const r of repos) {
    for (const entry of r.ref.apiBase ?? []) {
      const host = urlHost(entry) ?? entry.trim().split("/")[0]!.toLowerCase();
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
  const own = urlHost(call.raw);
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
  call: HttpCall, clients: HttpClient[], allBackends: RepoData[], effectiveByRepo: Map<string, EffectiveRoute[]>,
  knownHosts: Set<string>,
): UiLink["target"] {
  if (call.kind === "unknown") return { kind: "unresolved", reason: "url has no literal text" };
  // A hardcoded absolute URL (no stripped `base` expression) names its host outright; otherwise the
  // client's literal baseURL may. Loopback / apiBase hosts are ours (strip and match), others external.
  const ownHost = call.base === undefined ? urlHost(call.raw) : undefined;
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
    for (const call of repo.endpoints.httpCalls) {
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
