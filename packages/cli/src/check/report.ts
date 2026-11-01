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

/** Unresolved entries become `unmatched-call` items, listed for information only: many are framework or
 * library calls (`res.json`, `logger.info`) and they never decide whether a chain is complete. */
function chainLevelItems(chain: Chain): CheckItem[] {
  const items: CheckItem[] = [];
  for (const u of chain.unresolved) {
    items.push({ kind: "unmatched-call", repo: u.at.repo, file: u.at.file, line: u.at.line, symbol: u.at.symbol, detail: u.reason });
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
    ...chains.flatMap(chainLevelItems),
  ]);

  const byConfidence = { exact: 0, param: 0, guess: 0 };
  for (const chain of chains) for (const stop of chain.stops) byConfidence[stop.hop.confidence]++;

  const count = (kind: CheckItem["kind"]) => items.filter((i) => i.kind === kind).length;

  return {
    version: 1,
    summary: {
      chains: chains.length,
      complete: chains.filter((c) => c.complete).length,
      missingDb: count("no-store"),
      brokenUiApi: count("unresolved-url") + count("handler-not-found") + chains.filter(isUnmatchedPageChain).length,
      unresolvedCalls: count("unmatched-call"),
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
