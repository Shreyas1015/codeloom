import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeGraph } from "@codeloom/core";
import { stepKey } from "./link.js";
import type { BackendLink, ConsumerLink, LinkResult, PageReach, StoreHit, UiLink } from "./link.js";
import type { SymbolRef, WalkStep } from "./resolve-calls.js";
import type { EffectiveRoute } from "./mounts.js";
import { routeKey } from "./mounts.js";
import { worse } from "./paths.js";
import type { WorkspaceData } from "../store/read.js";
import {
  type Chain, type ChainStop, type ChainsFile, type Confidence, type Hop, type Journey, type JourneysFile,
  JourneysFileSchema, type Unresolved,
} from "../store/schemas.js";
import { readJson, writeJsonAtomic, writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { compare } from "../util.js";

/** Memo (g): `ch_` + sha256(`entry|routeKey`)[:12]. */
export function chainId(entry: string, routeKey: string): string {
  return `ch_${createHash("sha256").update(`${entry}|${routeKey}`).digest("hex").slice(0, 12)}`;
}

/** Memo (g): `j_` + sha256(sorted chain ids)[:12]; fixed when a journey is created. */
export function journeyId(chainIds: string[]): string {
  const sorted = [...chainIds].sort(compare).join(",");
  return `j_${createHash("sha256").update(sorted).digest("hex").slice(0, 12)}`;
}

/** Nearest graph.json node: function node, else class node, else file node. */
export function nearestNodeId(graph: KnowledgeGraph, file: string, symbol: string): string | undefined {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const fnId = `function:${file}:${symbol}`;
  if (ids.has(fnId)) return fnId;
  const cls = symbol.includes(".") ? symbol.slice(0, symbol.indexOf(".")) : symbol;
  const clsId = `class:${file}:${cls}`;
  if (ids.has(clsId)) return clsId;
  const fileId = `file:${file}`;
  return ids.has(fileId) ? fileId : undefined;
}

function nodeLine(graph: KnowledgeGraph, nodeId: string | undefined): number {
  const node = nodeId ? graph.nodes.find((n) => n.id === nodeId) : undefined;
  return node?.lineRange?.[0] ?? 1;
}

const EMPTY_GRAPH: KnowledgeGraph = {
  version: "1",
  project: { name: "", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
  nodes: [], edges: [], layers: [], tour: [],
};

function graphOf(ws: WorkspaceData, repoId: string): KnowledgeGraph {
  return ws.repos.find((r) => r.ref.id === repoId)?.graph ?? EMPTY_GRAPH;
}

/** First line of a symbol in the linker's code index (`CodeSymbol.lines[0]`), when it knows the symbol. */
export type SymbolLineLookup = (repo: string, file: string, symbol: string) => number | undefined;

/** Per-build context: the workspace plus the code index's symbol lines. */
interface Ctx { ws: WorkspaceData; symbolLine: SymbolLineLookup }

/** A stop for a bare SymbolRef (no Loc of its own). Line: `line` when given (the page stop's
 * UiPage.line, an inline handler's first line), else the symbol's own first line from the code index,
 * else the nearest graph node's line (the graph has no method nodes, so that may be the class or file). */
function refStop(ctx: Ctx, lane: ChainStop["lane"], kind: "function" | "handler" | "page", ref: SymbolRef, hop: Hop, line?: number): ChainStop {
  const graph = graphOf(ctx.ws, ref.repo);
  const nodeId = nearestNodeId(graph, ref.file, ref.symbol);
  const at = line ?? ctx.symbolLine(ref.repo, ref.file, ref.symbol) ?? nodeLine(graph, nodeId);
  return withoutUndefined({ lane, kind, repo: ref.repo, nodeId, file: ref.file, line: at, symbol: ref.symbol, hop });
}

/** Drop `undefined` optional fields so serialized stops have one stable shape. */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function hop(confidence: Confidence, reason?: string): Hop {
  return reason === undefined ? { confidence } : { confidence, reason };
}

/** Page, intermediate functions, then the HTTP call. `PageReach.path[i].confidence` is the confidence of
 * path[i]'s call to path[i+1], so it is the hop *into* stop i+1 (the page itself is the entry: exact). */
function uiStops(ctx: Ctx, link: UiLink, page: PageReach): ChainStop[] {
  const graph = graphOf(ctx.ws, link.repo);
  const stops: ChainStop[] = page.path.map((ref, i) => {
    const sym: SymbolRef = { repo: ref.repo, file: ref.file, symbol: ref.symbol };
    return i === 0
      ? refStop(ctx, "ui", "page", sym, hop("exact"), page.page.line)
      : refStop(ctx, "ui", "function", sym, hop(page.path[i - 1]!.confidence));
  });
  stops.push(withoutUndefined({
    lane: "ui" as const, kind: "call" as const, repo: link.repo,
    nodeId: nearestNodeId(graph, link.call.at.file, link.call.at.symbol),
    file: link.call.at.file, line: link.call.at.line, symbol: link.call.at.symbol,
    op: link.call.method, label: link.call.path, hop: hop("exact"),
  }));
  return stops;
}

function routeStop(ws: WorkspaceData, er: EffectiveRoute, h: Hop): ChainStop {
  const graph = graphOf(ws, er.repo);
  return withoutUndefined({
    lane: "api" as const, kind: "route" as const, repo: er.repo,
    nodeId: nearestNodeId(graph, er.route.at.file, er.route.at.symbol),
    file: er.route.at.file, line: er.route.at.line, symbol: er.route.handler, op: er.route.method,
    label: `${er.route.method} ${er.effectivePath}`, hop: h,
  });
}

function dbStop(repo: string, hit: StoreHit & { kind: "db" }): ChainStop {
  return {
    lane: "db", kind: "db", repo,
    file: hit.access.at.file, line: hit.access.at.line, symbol: hit.access.at.symbol,
    op: hit.access.op, label: hit.access.table ?? hit.access.model ?? "", hop: hop("exact"),
  };
}

function publishStop(repo: string, hit: StoreHit & { kind: "queue" }): ChainStop {
  return {
    lane: "queue", kind: "publish", repo,
    file: hit.op.at.file, line: hit.op.at.line, symbol: hit.op.at.symbol,
    op: "publish", label: hit.op.queue, hop: hop("exact"),
  };
}

function hopFromStep(step: WalkStep): Hop {
  return step.via ? hop(step.via.confidence, `via ${step.via.via}`) : hop("exact");
}

/** Intermediate "function" stops for every hit's viaPath (deduped by symbol across all of a link's
 * hits), then each hit's own terminal db/publish stop. `emitted` starts containing the entry symbol
 * (handler, or the consume call's own symbol) so it is never re-emitted as a redundant function stop. */
function hitStops(ctx: Ctx, repo: string, hits: StoreHit[], emitted: Set<string>): ChainStop[] {
  const stops: ChainStop[] = [];
  for (const hit of hits) {
    for (const step of hit.viaPath.slice(1)) {
      const key = stepKey(step.ref);
      if (emitted.has(key)) continue;
      emitted.add(key);
      stops.push(refStop(ctx, "code", "function", step.ref, hopFromStep(step)));
    }
    stops.push(hit.kind === "db" ? dbStop(repo, hit) : publishStop(repo, hit));
  }
  return stops;
}

/** A handler the code index could not place (BackendLink.handlerConfidence "guess") is still shown, as a
 * guessed hop; a route with no handler file at all stops at the route (check's "handler-not-found"). */
function backendStops(ctx: Ctx, link: BackendLink): ChainStop[] {
  if (!link.handler) return [];
  const handlerHop = link.handlerConfidence === "exact"
    ? hop("exact")
    : hop(link.handlerConfidence, `handler "${link.handler.symbol}" not found in ${link.handler.file}`);
  // An inline callback has no graph node of its own: point at its first line instead of the file's.
  const inlineLine = link.route.route.inline && link.handler.file === link.route.route.handlerFile
    ? link.route.route.handlerLines?.[0] : undefined;
  const stops: ChainStop[] = [refStop(ctx, "code", "handler", link.handler, handlerHop, inlineLine)];
  stops.push(...hitStops(ctx, link.repo, link.hits, new Set([stepKey(link.handler)])));
  return stops;
}

function consumerStops(ctx: Ctx, link: ConsumerLink): ChainStop[] {
  const graph = graphOf(ctx.ws, link.repo);
  const consumeRef: SymbolRef = { repo: link.repo, file: link.consume.at.file, symbol: link.consume.at.symbol };
  const stops: ChainStop[] = [withoutUndefined({
    lane: "queue" as const, kind: "consume" as const, repo: link.repo,
    nodeId: nearestNodeId(graph, consumeRef.file, consumeRef.symbol),
    file: consumeRef.file, line: link.consume.at.line, symbol: consumeRef.symbol,
    op: "consume", label: link.consume.queue, hop: hop("exact"),
  })];
  const emitted = new Set([stepKey(consumeRef)]);
  if (stepKey(link.handler) !== stepKey(consumeRef)) {
    stops.push(refStop(ctx, "code", "handler", link.handler, hop("exact")));
    emitted.add(stepKey(link.handler));
  }
  stops.push(...hitStops(ctx, link.repo, link.hits, emitted));
  return stops;
}

function toUnresolved(repo: string, u: { at: { file: string; line: number; symbol: string }; reason: string }): Unresolved {
  return { at: { repo, file: u.at.file, line: u.at.line, symbol: u.at.symbol }, reason: u.reason };
}

function sortUnresolved(list: Unresolved[]): Unresolved[] {
  return list.sort((a, b) => compare(a.at.repo, b.at.repo) || compare(a.at.file, b.at.file) || a.at.line - b.at.line
    || compare(a.at.symbol, b.at.symbol) || compare(a.reason, b.reason));
}

/** Complete = reaches a database table or publishes to a queue. Unresolved calls (often framework calls
 * such as `res.json(...)`) are reported on the chain but never affect completeness. */
function isComplete(stops: ChainStop[]): boolean {
  return stops.some((s) => s.kind === "db" || s.kind === "publish");
}

function worstConfidence(stops: ChainStop[]): Confidence {
  return stops.reduce<Confidence>((acc, s) => worse(acc, s.hop.confidence), "exact");
}

/** "POST /api/customers · NewCustomerPage" (page); "POST /billing/invoices/:id/pay" (route-only, uses the
 * route stop's label); "consume emails · handleEmail" (consumer: the consume stop's label, then the
 * handler stop's symbol, or the consume stop's own symbol for an inline callback); a page chain whose call
 * matched no route: "POST /api/x (unmatched) · NewXPage". */
export function defaultChainName(c: Pick<Chain, "entry" | "stops">): string {
  if (c.entry.startsWith("consumer:")) {
    const consume = c.stops.find((s) => s.kind === "consume");
    const handler = c.stops.find((s) => s.kind === "handler") ?? consume;
    return `consume ${consume?.label ?? ""} · ${handler?.symbol ?? ""}`;
  }
  const route = c.stops.find((s) => s.kind === "route");
  if (c.entry.startsWith("page:")) {
    const page = c.stops.find((s) => s.kind === "page");
    if (!route) {
      const call = c.stops.find((s) => s.kind === "call");
      return `${call?.op ?? ""} ${call?.label ?? ""} (unmatched) · ${page?.symbol ?? ""}`;
    }
    return `${route.label ?? ""} · ${page?.symbol ?? ""}`;
  }
  return route?.label ?? c.entry;
}

function makeChain(entry: string, rKey: string, stops: ChainStop[], unresolved: Unresolved[]): Chain {
  return {
    id: chainId(entry, rKey), entry, routeKey: rKey, name: defaultChainName({ entry, stops }), stops,
    unresolved: sortUnresolved(unresolved), confidence: worstConfidence(stops), complete: isComplete(stops),
  };
}

type RouteTarget = Extract<UiLink["target"], { kind: "route" }>;

/** A route's identity: repo + where it is registered + method + effective path. Two routers that both
 * register `GET /:id` share a routeKey but never an identity. */
function routeIdentity(er: EffectiveRoute): string {
  return [er.repo, er.route.at.file, String(er.route.at.line), er.route.method, er.effectivePath].join("\0");
}

/** Chain route key per route identity (author-approved amendment to memo (g)): the plain routeKey when
 * no other route shares it; otherwise `<routeKey>@<at.file>#<n>`, n = 1-based position of the route
 * among the colliding routes ordered by (at.file, at.line). */
function chainRouteKeys(routes: EffectiveRoute[]): Map<string, string> {
  const byIdentity = new Map<string, EffectiveRoute>();
  for (const er of routes) if (!byIdentity.has(routeIdentity(er))) byIdentity.set(routeIdentity(er), er);
  const groups = new Map<string, EffectiveRoute[]>();
  for (const er of byIdentity.values()) {
    const key = routeKey(er);
    groups.set(key, [...(groups.get(key) ?? []), er]);
  }
  const out = new Map<string, string>();
  for (const [key, group] of groups) {
    if (group.length === 1) {
      out.set(routeIdentity(group[0]!), key);
      continue;
    }
    group.sort((a, b) => compare(a.route.at.file, b.route.at.file) || a.route.at.line - b.route.at.line
      || compare(routeIdentity(a), routeIdentity(b)));
    group.forEach((er, i) => out.set(routeIdentity(er), `${key}@${er.route.at.file}#${i + 1}`));
  }
  return out;
}

/** One chain per (entry, routeKey), memo (g) as amended:
 * - each page reaching a call that targets a route -> `page:<repo>:<route>` chain;
 * - each page reaching a call that matches no route -> a partial `page:` chain with routeKey "" carrying
 *   one unresolved entry per unmatched call (calls with no literal URL text are left to check's
 *   "unresolved-url"; external calls are third-party, not broken);
 * - each route that no page chain covers -> `route:<chain route key>` chain (see chainRouteKeys);
 * - each consumer -> `consumer:<repo>:<queue>#<handler file>#<handler symbol>` chain, so two consumers of
 *   one queue in one repo are two chains.
 * The backend half of a page chain is looked up by route identity, never by routeKey alone.
 * Inputs from linkAll are sorted, so when two sources produce the same id the first one wins.
 * `symbolLine` (from runLinker's code index) gives function/handler stops their own first line. */
export function buildChains(ws: WorkspaceData, links: LinkResult, symbolLine: SymbolLineLookup = () => undefined): Chain[] {
  const ctx: Ctx = { ws, symbolLine };
  const uiTargets = links.ui.flatMap((l) => (l.target.kind === "route" ? [l.target.route] : []));
  const keys = chainRouteKeys([...links.backend.map((b) => b.route), ...uiTargets]);
  const keyOf = (er: EffectiveRoute) => keys.get(routeIdentity(er)) ?? routeKey(er);
  const backendByIdentity = new Map<string, BackendLink>();
  for (const b of links.backend) if (!backendByIdentity.has(routeIdentity(b.route))) backendByIdentity.set(routeIdentity(b.route), b);
  const byId = new Map<string, Chain>();
  const add = (c: Chain) => {
    if (!byId.has(c.id)) byId.set(c.id, c);
  };
  const pageRoutes = new Set<string>();

  for (const uiLink of links.ui) {
    if (uiLink.target.kind !== "route") continue;
    const target: RouteTarget = uiLink.target;
    const rKey = keyOf(target.route);
    const backend = backendByIdentity.get(routeIdentity(target.route));
    for (const page of uiLink.pages) {
      const entry = `page:${uiLink.repo}:${page.page.route}`;
      const stops = [
        ...uiStops(ctx, uiLink, page),
        routeStop(ws, target.route, hop(target.confidence, target.reason)),
        ...(backend ? backendStops(ctx, backend) : []),
      ];
      pageRoutes.add(routeIdentity(target.route));
      add(makeChain(entry, rKey, stops, (backend?.unresolved ?? []).map((u) => toUnresolved(backend!.repo, u))));
    }
  }

  // Unmatched UI calls: one partial chain per page, collecting every unmatched call it reaches.
  for (const uiLink of links.ui) {
    if (uiLink.target.kind !== "unresolved" || uiLink.call.kind === "unknown") continue;
    const u = toUnresolved(uiLink.repo, {
      at: uiLink.call.at, reason: `${uiLink.target.reason} for ${uiLink.call.method} ${uiLink.call.path}`,
    });
    for (const page of uiLink.pages) {
      const entry = `page:${uiLink.repo}:${page.page.route}`;
      const existing = byId.get(chainId(entry, ""));
      if (existing) {
        if (!existing.unresolved.some((x) => JSON.stringify(x) === JSON.stringify(u))) {
          existing.unresolved = sortUnresolved([...existing.unresolved, u]);
        }
        continue;
      }
      add(makeChain(entry, "", uiStops(ctx, uiLink, page), [u]));
    }
  }

  for (const b of links.backend) {
    if (pageRoutes.has(routeIdentity(b.route))) continue;
    const rKey = keyOf(b.route);
    const entry = `route:${rKey}`;
    const routeHop = b.route.mountsKnown ? hop("exact") : hop("guess", "mount prefix unknown");
    const stops = [routeStop(ws, b.route, routeHop), ...backendStops(ctx, b)];
    add(makeChain(entry, rKey, stops, b.unresolved.map((u) => toUnresolved(b.repo, u))));
  }

  for (const c of links.consumers) {
    const entry = `consumer:${c.repo}:${c.consume.queue}#${c.handler.file}#${c.handler.symbol}`;
    add(makeChain(entry, "", consumerStops(ctx, c), c.unresolved.map((u) => toUnresolved(c.repo, u))));
  }

  return [...byId.values()];
}

/** Sort chains by id; stops keep walk order; unresolved is sorted when each chain is built. */
export function sortChains(chains: Chain[]): Chain[] {
  return chains.sort((a, b) => compare(a.id, b.id));
}

export function writeChains(wsRoot: string, chains: Chain[]): boolean {
  const file: ChainsFile = { version: 1, chains };
  return writeJsonIfChanged(join(wsRoot, CODELOOM_DIR, FILES.chains), file);
}

/** Orphaned only when the code behind a journey is entirely gone: it names chains and none of them is in
 * `ids`. A journey that lost some (not all) of its chains stays "ok" — one sub-chain changing must not
 * flip it. An empty chainIds list is never orphaned. */
function isOrphaned(j: Journey, ids: Set<string>): boolean {
  return j.chainIds.length > 0 && j.chainIds.every((id) => !ids.has(id));
}

/** Create journeys.json if missing; otherwise set each journey's status to "orphaned" when all of its
 * chainIds are gone and back to "ok" when any returns, writing only if some status actually changed. Never
 * touches order or any other field. A malformed existing file throws (via readJson, telling the user to
 * fix it by hand) and is left untouched. */
export function syncJourneys(wsRoot: string, ids: Set<string>): { created: boolean; orphaned: number; changed: boolean } {
  const path = join(wsRoot, CODELOOM_DIR, FILES.journeys);
  const existing = readJson(path, JourneysFileSchema, { handWritten: true });
  if (!existing) {
    const empty: JourneysFile = { version: 1, journeys: [] };
    writeJsonAtomic(path, empty);
    return { created: true, orphaned: 0, changed: true };
  }
  // Edit the raw file, not the zod-parsed copy: zod drops keys the schema does not know, and this
  // writer must never touch anything but `status`.
  const raw = JSON.parse(readFileSync(path, "utf8")) as { journeys: Array<Record<string, unknown>> };
  let changed = false;
  let orphaned = 0;
  existing.journeys.forEach((j: Journey, i) => {
    const status: Journey["status"] = isOrphaned(j, ids) ? "orphaned" : "ok";
    if (status === "orphaned") orphaned++;
    if (status !== j.status) {
      changed = true;
      raw.journeys[i]!.status = status;
    }
  });
  if (changed) writeJsonAtomic(path, raw);
  return { created: false, orphaned, changed };
}
