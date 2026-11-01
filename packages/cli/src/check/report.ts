import { apiBaseHosts, externalHost } from "../linker/link.js";
import { effectiveRoutes, type EffectiveRoute, routeKey } from "../linker/mounts.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { Chain, ChainStop, CheckItem, CheckReport } from "../store/schemas.js";
import { compare } from "../util.js";

function routeStopLoc(chain: Chain): { repo: string; file: string; line: number; symbol: string } {
  const stop = chain.stops.find((s) => s.kind === "route") ?? chain.stops[0];
  if (!stop) return { repo: chain.entry.split(":")[1] ?? "", file: "", line: 1, symbol: chain.entry };
  return { repo: stop.repo, file: stop.file, line: stop.line, symbol: stop.symbol };
}

function lastStop(chain: Chain): ChainStop | undefined {
  return chain.stops[chain.stops.length - 1];
}

function hasStoreStop(chain: Chain): boolean {
  return chain.stops.some((s) => s.kind === "db" || s.kind === "publish");
}

function hasHandlerStop(chain: Chain): boolean {
  return chain.stops.some((s) => s.kind === "handler" || s.kind === "function" || s.kind === "consume");
}

/** A page chain whose UI call matched no route: the linker gives it routeKey "" (one unresolved entry
 * per unmatched call). It is a journey broken at UI → API. */
function isUnmatchedPageChain(chain: Chain): boolean {
  return chain.entry.startsWith("page:") && chain.routeKey === "";
}

function unresolvedUrlItems(repos: RepoData[]): CheckItem[] {
  const items: CheckItem[] = [];
  for (const repo of repos) {
    for (const call of repo.endpoints.httpCalls) {
      if (call.kind !== "unknown") continue;
      items.push({
        kind: "unresolved-url",
        repo: repo.ref.id,
        file: call.at.file,
        line: call.at.line,
        symbol: call.at.symbol,
        detail: `cannot read URL from ${call.raw}`,
      });
    }
  }
  return items;
}

/** A `ui-unreached` item: an HTTP call at `at` that no page reaches. `label` names the call
 * (`"POST /api/post"`). Shared by every source of unreached calls (adapter calls here; call-entry
 * chains later), so they all print in one group. */
export function uiUnreachedItem(repo: string, at: { file: string; line: number; symbol: string }, label: string): CheckItem {
  return {
    kind: "ui-unreached", repo, file: at.file, line: at.line, symbol: at.symbol,
    detail: `${label}: call at ${at.file}:${at.line} is not reached from any page`,
  };
}

function locKey(repo: string, file: string, line: number): string {
  return [repo, file, String(line)].join("\0");
}

/** HTTP calls (with a readable URL; unreadable ones are `unresolved-url`) that no page chain reaches.
 * A call is reached when a page chain carries it as its call stop or as an unresolved (no-route) entry.
 * Not listed: third-party calls (the linker writes no chain for them), and backend calls — in a file
 * that holds a route handler, or in a symbol that is a stop of a route / consumer chain. Per call, never
 * part of the chain buckets. */
function uiUnreachedItems(repos: RepoData[], chains: Chain[]): CheckItem[] {
  const reached = new Set<string>();
  const backendSymbols = new Set<string>();
  for (const c of chains) {
    if (c.entry.startsWith("page:")) {
      for (const s of c.stops) if (s.kind === "call") reached.add(locKey(s.repo, s.file, s.line));
      for (const u of c.unresolved) reached.add(locKey(u.at.repo, u.at.file, u.at.line));
    } else {
      for (const s of c.stops) backendSymbols.add([s.repo, s.file, s.symbol].join("\0"));
    }
  }
  const knownHosts = apiBaseHosts(repos);
  const items: CheckItem[] = [];
  for (const repo of repos) {
    const id = repo.ref.id;
    const handlerFiles = new Set(repo.endpoints.routes.flatMap((r) => (r.handlerFile ? [r.handlerFile] : [])));
    for (const call of repo.endpoints.httpCalls) {
      if (call.kind === "unknown" || reached.has(locKey(id, call.at.file, call.at.line))) continue;
      if (handlerFiles.has(call.at.file) || backendSymbols.has([id, call.at.file, call.at.symbol].join("\0"))) continue;
      if (externalHost(call, repo.endpoints.httpClients, knownHosts) !== undefined) continue;
      items.push(uiUnreachedItem(id, call.at, `${call.method} ${call.path}`));
    }
  }
  return items;
}

/** A route stop's identity as the linker writes it (repo, registration site, method, effective path). */
function stopIdentity(repo: string, file: string, line: number, method: string, label: string): string {
  return [repo, file, String(line), method, label].join("\0");
}

function routeIdentity(r: EffectiveRoute): string {
  return stopIdentity(r.repo, r.route.at.file, r.route.at.line, r.route.method, `${r.route.method} ${r.effectivePath}`);
}

/** Computed from endpoints, not from route chains, so a route the linker silently dropped is still
 * caught. A route has a UI caller when a page chain carries its plain routeKey, or — because the linker
 * suffixes colliding keys with `@<file>#<n>` — when a page chain's route stop is that very route. */
function routeNoCallerItems(repos: RepoData[], chains: Chain[]): CheckItem[] {
  const pageChains = chains.filter((c) => c.entry.startsWith("page:"));
  const pageRouteKeys = new Set(pageChains.map((c) => c.routeKey));
  const pageRouteStops = new Set(
    pageChains.flatMap((c) => c.stops.filter((s) => s.kind === "route")
      .map((s) => stopIdentity(s.repo, s.file, s.line, s.op ?? "", s.label ?? ""))),
  );
  const items: CheckItem[] = [];
  for (const repo of repos) {
    for (const r of effectiveRoutes(repo.endpoints)) {
      if (pageRouteKeys.has(routeKey(r)) || pageRouteStops.has(routeIdentity(r))) continue;
      items.push({
        kind: "route-no-caller",
        repo: r.repo,
        file: r.route.at.file,
        line: r.route.at.line,
        symbol: r.route.handler,
        detail: `${r.route.method} ${r.effectivePath} has no UI caller`,
      });
    }
  }
  return items;
}

/** The one bucket a chain falls into. Every chain lands in exactly one, so
 *   chains = complete + missingDb + brokenUiApi
 * - complete: reaches a database table or queue (a db or publish stop);
 * - brokenUiApi: a page chain whose UI call matched no route, or a chain whose handler was not found
 *   (its walk stops at the route);
 * - missingDb: everything else.
 * Unreadable URLs (`unresolved-url`) are per call, not per chain, and are never part of these buckets. */
type Bucket = "complete" | "brokenUiApi" | "missingDb";

function bucketOf(chain: Chain): Bucket {
  if (hasStoreStop(chain)) return "complete";
  if (isUnmatchedPageChain(chain) || lastStop(chain)?.kind === "route") return "brokenUiApi";
  return "missingDb";
}

/** A page chain whose UI call matched no route yields `ui-no-route` items — one per unmatched call the
 * linker recorded, or one at the call stop if it recorded none — decided by the chain's shape, never by
 * the linker's reason text. Every other unresolved entry is an `unmatched-call`, listed for information
 * only: many are framework or library calls (`res.json`, `logger.info`) and never decide a bucket. */
function chainLevelItems(chain: Chain): CheckItem[] {
  const items: CheckItem[] = [];
  const unmatchedPage = isUnmatchedPageChain(chain);
  for (const u of chain.unresolved) {
    items.push({
      kind: unmatchedPage ? "ui-no-route" : "unmatched-call",
      repo: u.at.repo, file: u.at.file, line: u.at.line, symbol: u.at.symbol, detail: u.reason,
    });
  }
  if (unmatchedPage && chain.unresolved.length === 0) {
    const at = chain.stops.find((s) => s.kind === "call") ?? chain.stops[0];
    if (at) items.push({ kind: "ui-no-route", repo: at.repo, file: at.file, line: at.line, symbol: at.symbol, detail: `${chain.name}: UI call matches no route` });
  }
  for (const stop of chain.stops) {
    if (stop.hop.confidence !== "guess") continue;
    items.push({
      kind: "guess-link",
      repo: stop.repo,
      file: stop.file,
      line: stop.line,
      symbol: stop.symbol,
      detail: `${stop.hop.reason ?? "guessed match"} (${chain.name})`,
    });
  }
  const last = lastStop(chain);
  if (last && last.kind === "route") {
    const loc = routeStopLoc(chain);
    items.push({ kind: "handler-not-found", repo: loc.repo, file: loc.file, line: loc.line, symbol: loc.symbol, detail: `${chain.name}: handler could not be located` });
  } else if (last && hasHandlerStop(chain) && !hasStoreStop(chain)) {
    items.push({ kind: "no-store", repo: last.repo, file: last.file, line: last.line, symbol: last.symbol, detail: `${chain.name} reaches no database table or queue` });
  }
  return items;
}

function sortItems(items: CheckItem[]): CheckItem[] {
  return [...items].sort(
    (a, b) =>
      compare(a.kind, b.kind) ||
      compare(a.repo, b.repo) ||
      compare(a.file, b.file) ||
      a.line - b.line ||
      compare(a.detail, b.detail),
  );
}

export function buildCheckReport(chains: Chain[], ws: WorkspaceData): CheckReport {
  const items = sortItems([
    ...unresolvedUrlItems(ws.repos),
    ...routeNoCallerItems(ws.repos, chains),
    ...uiUnreachedItems(ws.repos, chains),
    ...chains.flatMap(chainLevelItems),
  ]);

  const byConfidence = { exact: 0, param: 0, guess: 0 };
  for (const chain of chains) for (const stop of chain.stops) byConfidence[stop.hop.confidence]++;

  const count = (kind: CheckItem["kind"]) => items.filter((i) => i.kind === kind).length;
  const buckets: Record<Bucket, number> = { complete: 0, brokenUiApi: 0, missingDb: 0 };
  for (const chain of chains) buckets[bucketOf(chain)]++;

  return {
    version: 1,
    summary: {
      // chains = complete + missingDb + brokenUiApi (see bucketOf); unresolvedCalls is a separate per-call
      // count of unreadable URLs and is never added into the journey buckets.
      chains: chains.length,
      complete: buckets.complete,
      missingDb: buckets.missingDb,
      brokenUiApi: buckets.brokenUiApi,
      unresolvedCalls: count("unresolved-url"),
      uncalledRoutes: count("route-no-caller"),
      byConfidence,
    },
    items,
  };
}

export function completePercent(r: CheckReport): number {
  if (r.summary.chains === 0) return 100;
  return Math.round((r.summary.complete / r.summary.chains) * 100);
}
