import { chainReach, hasUiStop, reachesStore } from "../linker/completeness.js";
import { effectiveRoutes, type EffectiveRoute, routeKey } from "../linker/mounts.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import { WORKSPACE_FILE } from "../store/paths.js";
import type { Chain, ChainStop, CheckItem, CheckReport, ManualLinkStatus, UiReachFact } from "../store/schemas.js";
import { compare } from "../util.js";
import { calleeOf, isBuiltinCallee } from "./noise.js";

function routeStopLoc(chain: Chain): { repo: string; file: string; line: number; symbol: string } {
  const stop = chain.stops.find((s) => s.kind === "route") ?? chain.stops[0];
  if (!stop) return { repo: chain.entry.split(":")[1] ?? "", file: "", line: 1, symbol: chain.entry };
  return { repo: stop.repo, file: stop.file, line: stop.line, symbol: stop.symbol };
}

function lastStop(chain: Chain): ChainStop | undefined {
  return chain.stops[chain.stops.length - 1];
}

function hasHandlerStop(chain: Chain): boolean {
  return chain.stops.some((s) => s.kind === "handler" || s.kind === "function" || s.kind === "consume");
}

/** A page chain whose UI call matched no route: the linker gives it routeKey "" (one unresolved entry
 * per unmatched call). It is a journey broken at UI → API. */
function isUnmatchedPageChain(chain: Chain): boolean {
  return chain.entry.startsWith("page:") && chain.routeKey === "";
}

/** Calls that some chain shows reaching a route: a route stop whose `from` is the call stop (in a legacy
 * chain, where no stop has `from`, a call stop directly followed by a route stop). An unreadable-URL call
 * gets there only through a manual link, so it is no longer unresolved. */
function routedCalls(chains: Chain[]): Set<string> {
  const out = new Set<string>();
  for (const c of chains) {
    if (c.routeKey === "") continue;
    const legacy = !c.stops.some((s) => s.from !== undefined);
    c.stops.forEach((s, i) => {
      if (s.kind !== "route" || i === 0) return;
      const call = c.stops[legacy ? i - 1 : s.from ?? -1];
      if (call?.kind === "call") out.add([call.repo, call.file, String(call.line), call.symbol].join("\0"));
    });
  }
  return out;
}

function unresolvedUrlItems(repos: RepoData[], chains: Chain[]): CheckItem[] {
  const routed = routedCalls(chains);
  const items: CheckItem[] = [];
  for (const repo of repos) {
    for (const call of repo.endpoints.httpCalls) {
      if (call.kind !== "unknown") continue;
      if (routed.has([repo.ref.id, call.at.file, String(call.at.line), call.at.symbol].join("\0"))) continue;
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
 * (`"POST /api/post"`). */
export function uiUnreachedItem(repo: string, at: { file: string; line: number; symbol: string }, label: string): CheckItem {
  return {
    kind: "ui-unreached", repo, file: at.file, line: at.line, symbol: at.symbol,
    detail: `${label}: call at ${at.file}:${at.line} is not reached from any page`,
  };
}

/** A call site's identity: repo, file, line, symbol. */
function siteKey(repo: string, at: { file: string; line: number; symbol: string }): string {
  return [repo, at.file, String(at.line), at.symbol].join("\0");
}

/** Built ONLY from the linker's reach facts (chains.json `uiReach`): every UI-side call no page reaches,
 * whether or not it matched a route (a matched one also has a `call:` chain). The linker already left
 * out backend, third-party and unreadable-URL calls. Never derived from chain stops, which are deduped
 * per (entry, route) and so cannot say which calls a page reaches. One item per call site (H6), its
 * labels sorted and joined; never part of the buckets. */
function uiUnreachedItems(uiReach: UiReachFact[]): CheckItem[] {
  const bySite = new Map<string, { fact: UiReachFact; labels: Set<string> }>();
  for (const f of uiReach) {
    if (f.reached) continue;
    const key = siteKey(f.repo, f);
    const entry = bySite.get(key) ?? { fact: f, labels: new Set<string>() };
    entry.labels.add(`${f.method} ${f.path}`);
    bySite.set(key, entry);
  }
  return [...bySite.values()].map(({ fact, labels }) => uiUnreachedItem(fact.repo, fact, [...labels].sort(compare).join(", ")));
}

/** A route stop's identity as the linker writes it (repo, registration site, method, effective path). */
function stopIdentity(repo: string, file: string, line: number, method: string, label: string): string {
  return [repo, file, String(line), method, label].join("\0");
}

function routeIdentity(r: EffectiveRoute): string {
  return stopIdentity(r.repo, r.route.at.file, r.route.at.line, r.route.method, `${r.route.method} ${r.effectivePath}`);
}

/** Computed from endpoints, not from route chains, so a route the linker silently dropped is still
 * caught. A route has a UI caller when a page or call-entry chain carries its plain routeKey, or —
 * because the linker suffixes colliding keys with `@<file>#<n>` — when such a chain's route stop is that
 * very route. (A call-entry chain's call is UI code that no page reaches; it is listed as ui-unreached.) */
function routeNoCallerItems(repos: RepoData[], chains: Chain[]): CheckItem[] {
  const pageChains = chains.filter((c) => c.entry.startsWith("page:") || c.entry.startsWith("call:"));
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
 *   chains = complete + apiOnly + missingDb + brokenUiApi
 * Decided from the stops (linker/completeness.ts), never from the chain's stored `complete` flag:
 * - complete: has a UI stop (page or call) and reaches a database table or queue (a db or publish stop);
 * - apiOnly: reaches a store but has no UI stop — a route or consumer no UI code calls (API → DB only);
 * - brokenUiApi: a page chain whose UI call matched no route, or a chain whose handler was not found
 *   (its walk stops at the route);
 * - missingDb: everything else.
 * Unreadable URLs (`unresolved-url`) are per call, not per chain, and are never part of these buckets. */
type Bucket = "complete" | "apiOnly" | "brokenUiApi" | "missingDb";

function bucketOf(chain: Chain): Bucket {
  const reach = chainReach(chain.stops);
  if (reach === "complete") return "complete";
  if (reach === "api-only") return "apiOnly";
  if (isUnmatchedPageChain(chain) || lastStop(chain)?.kind === "route") return "brokenUiApi";
  return "missingDb";
}

/** The page a page chain starts at: its entry is `page:<repo>:<route>`. */
function pageOf(chain: Chain): string {
  return chain.entry.split(":").slice(2).join(":");
}

/** A page chain whose UI call matched no route yields `ui-no-route` items — decided by the chain's shape,
 * never by the linker's reason text: one per unmatched call the linker recorded, or one at the call stop
 * if it recorded none. Grouped by call site (H6): one item per call and reason, its detail naming every
 * page that reaches it. */
function uiNoRouteItems(chains: Chain[]): CheckItem[] {
  const bySite = new Map<string, { item: CheckItem; pages: Set<string> }>();
  const add = (repo: string, at: { file: string; line: number; symbol: string }, reason: string, page: string) => {
    const key = `${siteKey(repo, at)}\0${reason}`;
    const entry = bySite.get(key) ?? {
      item: { kind: "ui-no-route" as const, repo, file: at.file, line: at.line, symbol: at.symbol, detail: reason },
      pages: new Set<string>(),
    };
    entry.pages.add(page);
    bySite.set(key, entry);
  };
  for (const chain of chains) {
    if (!isUnmatchedPageChain(chain)) continue;
    for (const u of chain.unresolved) add(u.at.repo, u.at, u.reason, pageOf(chain));
    if (chain.unresolved.length > 0) continue;
    const at = chain.stops.find((s) => s.kind === "call") ?? chain.stops[0];
    if (at) add(at.repo, at, "UI call matches no route", pageOf(chain));
  }
  return [...bySite.values()].map(({ item, pages }) => {
    const list = [...pages].sort(compare);
    return { ...item, detail: `${item.detail} (${list.length === 1 ? "page" : "pages"}: ${list.join(", ")})` };
  });
}

/** Every unresolved entry outside an unmatched page chain is an `unmatched-call`, listed for information
 * only: many are framework or library calls (`res.json`, `logger.info`) and never decide a bucket.
 * H6: listed once per repo + file + line + callee however many chains walk through it, and calls on
 * global built-ins or of built-in method names (`console.log`, `items.map`) are left out. */
function unmatchedCallItems(chains: Chain[]): CheckItem[] {
  const seen = new Set<string>();
  const items: CheckItem[] = [];
  for (const chain of chains) {
    if (isUnmatchedPageChain(chain)) continue;
    for (const u of chain.unresolved) {
      const callee = calleeOf(u.reason);
      if (callee !== undefined && isBuiltinCallee(callee)) continue;
      const key = [u.at.repo, u.at.file, String(u.at.line), callee ?? u.reason].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ kind: "unmatched-call", repo: u.at.repo, file: u.at.file, line: u.at.line, symbol: u.at.symbol, detail: u.reason });
    }
  }
  return items;
}

/** Per-chain items: guessed hops, a handler that could not be found, a walk that reaches no store. */
function chainLevelItems(chain: Chain): CheckItem[] {
  const items: CheckItem[] = [];
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
  } else if (last && hasHandlerStop(chain) && !reachesStore(chain.stops)) {
    items.push({ kind: "no-store", repo: last.repo, file: last.file, line: last.line, symbol: last.symbol, detail: `${chain.name} reaches no database table or queue` });
  }
  return items;
}

/** Workspace `links` entries that are broken (`manual-link-broken`, with the reason) or valid but matched
 * no chain stop (`manual-link-unused`, info only). They point at the workspace file and never decide a
 * bucket. `repo` is the repo the link's `from` names, when it names one. */
function manualLinkItems(links: ManualLinkStatus[]): CheckItem[] {
  return links.flatMap((l): CheckItem[] => {
    if (l.status === "used") return [];
    const repo = l.from.match(/^(?:route:|queue:)?([^:#]+):/)?.[1] ?? "";
    const base = { repo, file: WORKSPACE_FILE, line: 1, symbol: l.from };
    return l.status === "broken"
      ? [{ kind: "manual-link-broken", ...base, detail: `${l.from} -> ${l.to}: ${l.reason ?? "not resolved"}` }]
      : [{ kind: "manual-link-unused", ...base, detail: `${l.from} -> ${l.to}: its from matches no chain stop` }];
  });
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

/** `uiReach`: the linker's reach facts from chains.json (absent in an older file: no ui-unreached items).
 * `manualLinks`: chains.json's manual link statuses (absent when the workspace has no links). */
export function buildCheckReport(
  chains: Chain[], ws: WorkspaceData, uiReach: UiReachFact[] = [], manualLinks: ManualLinkStatus[] = [],
): CheckReport {
  const items = sortItems([
    ...manualLinkItems(manualLinks),
    ...unresolvedUrlItems(ws.repos, chains),
    ...routeNoCallerItems(ws.repos, chains),
    ...uiUnreachedItems(uiReach),
    ...uiNoRouteItems(chains),
    ...unmatchedCallItems(chains),
    ...chains.flatMap(chainLevelItems),
  ]);

  const byConfidence = { exact: 0, param: 0, guess: 0 };
  for (const chain of chains) for (const stop of chain.stops) byConfidence[stop.hop.confidence]++;

  const count = (kind: CheckItem["kind"]) => items.filter((i) => i.kind === kind).length;
  const buckets: Record<Bucket, number> = { complete: 0, apiOnly: 0, brokenUiApi: 0, missingDb: 0 };
  for (const chain of chains) buckets[bucketOf(chain)]++;
  const routes = ws.repos.reduce((n, repo) => n + effectiveRoutes(repo.endpoints).length, 0);

  return {
    version: 1,
    summary: {
      // chains = complete + apiOnly + missingDb + brokenUiApi (see bucketOf); unresolvedCalls is a separate
      // per-call count of unreadable URLs and is never added into the journey buckets.
      chains: chains.length,
      complete: buckets.complete,
      apiOnly: buckets.apiOnly,
      missingDb: buckets.missingDb,
      brokenUiApi: buckets.brokenUiApi,
      uiChains: chains.filter((c) => hasUiStop(c.stops)).length,
      routes,
      routesWithUiCaller: routes - count("route-no-caller"),
      unresolvedCalls: count("unresolved-url"),
      uncalledRoutes: count("route-no-caller"),
      byConfidence,
    },
    items,
  };
}

/** Complete chains over the chains that start in the UI (have a UI stop), as an unrounded percentage.
 * Route-only and consumer chains are not in the ratio: no UI journey can be complete without a UI stop.
 * 100 when no chain has a UI stop (nothing for `--fail-under` to fail on). */
export function completeRatio(r: CheckReport): number {
  if (r.summary.uiChains === 0) return 100;
  return (r.summary.complete / r.summary.uiChains) * 100;
}

/** `--fail-under N` fails on the unrounded ratio: 94.6% is below 95 even though it prints as 95%. */
export function belowFailUnder(r: CheckReport, failUnder: number): boolean {
  return completeRatio(r) < failUnder;
}

/** completeRatio as a whole percentage, for display only. */
export function completePercent(r: CheckReport): number {
  return Math.round(completeRatio(r));
}
