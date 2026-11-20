import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeGraph } from "@codeloom/core";
import { isComplete } from "./completeness.js";
import { ANSWERED, HANDLER_NOT_FOUND, parseLinkRef, stepKey, uiReachKey } from "./link.js";
import type {
  BackendLink, ConsumerLink, LinkRef, LinkResult, ManualLink, PageReach, QueuePair, RouteTarget, ServiceHit, StoreHit, UiLink,
} from "./link.js";
import type { SymbolRef, WalkStep } from "./resolve-calls.js";
import type { EffectiveRoute } from "./mounts.js";
import { routeKey } from "./mounts.js";
import { worse } from "./paths.js";
import type { WorkspaceData } from "../store/read.js";
import {
  type Chain, type ChainStop, type ChainsFile, type Confidence, type Hop, type Journey, type JourneysFile,
  JourneysFileSchema, type ExternalCallFact, type ManualLinkStatus, type QueueOp, type UiReachFact, type Unresolved, type UnresolvedBase,
} from "../store/schemas.js";
import { readJson, writeJsonAtomic, writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { chainLookup, type ChainLookup } from "../mcp/state.js";
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

/** A queue op's identity: repo + site + op + queue. */
function queueKey(repo: string, q: QueueOp): string {
  return [repo, q.at.file, String(q.at.line), q.op, q.queue].join("\0");
}

/** Per-build context: the workspace, the code index's symbol lines, and the queue pairs (by publish op,
 * in pairQueues' sorted order) with the consumer links they lead to (by consume op). */
interface Ctx {
  ws: WorkspaceData; symbolLine: SymbolLineLookup;
  pairs: Map<string, QueuePair[]>; consumers: Map<string, ConsumerLink>;
  /** Backend links by route identity: where a service call's chain continues (0.6 §3). */
  backends: Map<string, BackendLink>;
  /** The id of a route's own chain (`route:<chain route key>`): where a service call that is not expanded continues. */
  routeChainId: (er: EffectiveRoute) => string;
  /** The chain being built (see startChain): the routes already expanded in it, and how many stops it has. */
  chain: { expanded: Set<string>; stops: number };
  /** Route identities some stop's `continues` names: each gets a `route:` chain of its own, even when a page
   * calls it too, so the pointer always resolves to that route's chain. */
  continued: Set<string>;
  /** Each built stop's parent: the stop it was reached from. Turned into `ChainStop.from` indices once a
   * chain's final stop order is known (see withFrom). */
  parents: WeakMap<ChainStop, ChainStop>;
}

/** Record that `child` was reached from `parent` (no-op when there is no parent: a chain's entry), and count it
 * towards the chain's stop budget. */
function reachedFrom<T extends ChainStop>(ctx: Ctx, child: T, parent: ChainStop | undefined): T {
  if (parent) ctx.parents.set(child, parent);
  ctx.chain.stops++;
  return child;
}

/** A new chain is being built: no route expanded yet, no stops counted. */
function startChain(ctx: Ctx): void {
  ctx.chain = { expanded: new Set(), stops: 0 };
}

/** Set every stop's `from` (index of its recorded parent in `stops`). Every builder records the parent,
 * and the parent always comes first. A stop with no recorded parent, or one listed at or after it, gets no
 * `from`: never guessed from list order. The first stop has no `from`. */
export function withFrom(parents: WeakMap<ChainStop, ChainStop>, stops: ChainStop[]): ChainStop[] {
  const index = new Map(stops.map((s, i) => [s, i]));
  return stops.map((s, i) => {
    const { from: _drop, ...rest } = s;
    const p = parents.get(s);
    const at = p ? index.get(p) : undefined;
    return at !== undefined && at < i ? { ...rest, from: at } : rest;
  });
}

/** Whether a publish stop continues into its paired consumers. `null`: it does not (a stop inside an
 * already-appended consumer: one level only, so no cycles). `skip`: a consume op not to append (a consumer
 * chain's own consume, when its handler publishes back to its own queue). */
type QueueFollow = { skip?: string } | null;

/** A stop for a bare SymbolRef (no Loc of its own). Line: `line` when given (the page stop's
 * UiPage.line, an inline handler's first line), else the symbol's own first line from the code index,
 * else the nearest graph node's line (the method node when the enriched graph has one, else the class or file). */
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
function uiStops(ctx: Ctx, link: UiLink, page: PageReach | undefined): ChainStop[] {
  const graph = graphOf(ctx.ws, link.repo);
  // A call-entry chain (no page) starts at the call stop itself.
  const stops: ChainStop[] = [];
  (page?.path ?? []).forEach((ref, i) => {
    const sym: SymbolRef = { repo: ref.repo, file: ref.file, symbol: ref.symbol };
    stops.push(reachedFrom(ctx, i === 0
      ? refStop(ctx, "ui", "page", sym, hop("exact"), page!.page.line)
      : refStop(ctx, "ui", "function", sym, hop(page!.path[i - 1]!.confidence), ref.line), stops[i - 1]));
  });
  stops.push(reachedFrom(ctx, withoutUndefined({
    lane: "ui" as const, kind: "call" as const, repo: link.repo,
    nodeId: nearestNodeId(graph, link.call.at.file, link.call.at.symbol),
    file: link.call.at.file, line: link.call.at.line, symbol: link.call.at.symbol,
    op: link.call.method, label: link.call.path,
    // An adapter call is seen directly (exact); a wrapper-derived one carries its own, at best "param".
    hop: link.call.via === "wrapper"
      ? hop(link.call.confidence ?? "param", `via wrapper ${link.call.wrapper ?? ""}`.trimEnd())
      : hop("exact"),
  }), stops.at(-1)));
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

function dbStop(repo: string, hit: StoreHit & { kind: "db" }, h: Hop): ChainStop {
  return {
    lane: "db", kind: "db", repo,
    file: hit.access.at.file, line: hit.access.at.line, symbol: hit.access.at.symbol,
    op: hit.access.op, label: hit.access.table ?? hit.access.model ?? "", hop: h,
  };
}

function publishStop(repo: string, hit: StoreHit & { kind: "queue" }, h: Hop): ChainStop {
  return {
    lane: "queue", kind: "publish", repo,
    file: hit.op.at.file, line: hit.op.at.line, symbol: hit.op.at.symbol,
    op: "publish", label: hit.op.queue, hop: h,
  };
}

/** A store stop's hop is the worst confidence on its own path: `base` (the route/consume stop through the
 * handler) folded with every step of the hit's viaPath. A store reached through a guessed call, or under a
 * guessed route, is itself only a guess (exact only when every link to it is exact). */
function storeHop(base: Confidence, hit: Pick<StoreHit, "viaPath">): Hop {
  const c = hit.viaPath.reduce<Confidence>((acc, step) => worse(acc, step.via?.confidence ?? "exact"), base);
  return c === "exact" ? hop("exact") : hop(c, "worst hop on the path to this store");
}

function hopFromStep(step: WalkStep): Hop {
  return step.via ? hop(step.via.confidence, `via ${step.via.via}`) : hop("exact");
}

/** Service calls (0.6 §3) a link's walk reached, and how many service hops were inlined on the way here. */
interface Services { calls: ServiceHit[]; depth: number }

const NO_SERVICES: Services = { calls: [], depth: 0 };

/** Service hops a chain inlines (UI → A → B → C); a deeper called route ends at its own stop, which names that
 * route's own chain (`continues`). */
const MAX_SERVICE_HOPS = 2;
/** A chain expands no further called route past its first service hop once it has this many stops... */
const EXPAND_BUDGET = 24;
/** ...and adds no further service call stop inside an expanded route once it has this many (the calls its own
 * entry makes are always shown). */
const CALL_BUDGET = 36;

/** Intermediate "function" stops for every hit's viaPath (deduped by symbol across all of a link's
 * hits), then each hit's own terminal db/publish stop; then (0.6 §3) each service call the walk reached —
 * the call stop, the route it reaches and that route's own backend stops; then, when `follow` allows, each
 * publish hit's paired consumers (consume, handler, its stores), in hit order then pairQueues order. `emitted`
 * starts containing the entry symbol (handler, or the consume call's own symbol) so it is never re-emitted as
 * a redundant function stop. */
function hitStops(
  ctx: Ctx, repo: string, hits: StoreHit[], emitted: Map<string, ChainStop>, base: Confidence, follow: QueueFollow, pairedOut?: ChainStop[],
  services: Services = NO_SERVICES,
): ChainStop[] {
  const stops: ChainStop[] = [];
  const paired: ChainStop[] = [];
  const called: ChainStop[] = [];
  // Each function stop is reached from the previous step of the walk path that first emitted it; the
  // store (or service call) from the last step (the symbol that holds it), never from a sibling store.
  const holderOf = (viaPath: WalkStep[]): ChainStop | undefined => {
    viaPath.forEach((step, k) => {
      const key = stepKey(step.ref);
      if (k === 0 || emitted.has(key)) return;
      const stop = refStop(ctx, "code", "function", step.ref, hopFromStep(step));
      emitted.set(key, reachedFrom(ctx, stop, emitted.get(stepKey(viaPath[k - 1]!.ref))));
      stops.push(stop);
    });
    const last = viaPath.at(-1);
    return last ? emitted.get(stepKey(last.ref)) : undefined;
  };
  for (const hit of hits) {
    const holder = holderOf(hit.viaPath);
    const h = storeHop(base, hit);
    if (hit.kind === "db") {
      stops.push(reachedFrom(ctx, dbStop(repo, hit, h), holder));
      continue;
    }
    const publish = reachedFrom(ctx, publishStop(repo, hit, h), holder);
    stops.push(publish);
    if (!follow) continue;
    // Publish hits continue into every paired consumer, in pairQueues' sorted order.
    for (const pair of ctx.pairs.get(queueKey(repo, hit.op)) ?? []) {
      const consumeKey = queueKey(pair.repoTo, pair.consume);
      const consumer = ctx.consumers.get(consumeKey);
      if (!consumer || consumeKey === follow.skip) continue;
      paired.push(...consumerStops(ctx, consumer, pairedHop(h.confidence, pair), null, publish, services.depth));
    }
  }
  for (const sc of services.calls) {
    if (services.depth > 0 && ctx.chain.stops >= CALL_BUDGET) break;
    const call = reachedFrom(ctx, serviceCallStop(ctx, repo, sc, storeHop(base, sc)), holderOf(sc.viaPath));
    called.push(call, ...serviceStops(ctx, sc, call, services.depth));
  }
  // Paired consumers go after all of this link's own stops, so each consume stop past the first starts a
  // block that runs to the next one (or the end) — the scorer keys those stores to the consumer.
  // `pairedOut` (a manual symbol block inserted mid-chain) collects them for the chain's end instead.
  if (pairedOut) {
    pairedOut.push(...paired);
    return [...stops, ...called];
  }
  return [...stops, ...called, ...paired];
}

/** A backend's outgoing HTTP call (0.6 §3): a "call" stop in the code lane (a UI call is in the ui lane). */
function serviceCallStop(ctx: Ctx, repo: string, sc: ServiceHit, h: Hop): ChainStop {
  return withoutUndefined({
    lane: "code" as const, kind: "call" as const, repo,
    nodeId: nearestNodeId(graphOf(ctx.ws, repo), sc.call.at.file, sc.call.at.symbol),
    file: sc.call.at.file, line: sc.call.at.line, symbol: sc.call.at.symbol, op: sc.call.method, label: sc.call.path, hop: h,
  });
}

/** The route a service call reaches, then — when that route is not yet expanded in this chain, the chain is
 * within MAX_SERVICE_HOPS and under EXPAND_BUDGET stops — that route's handler and stores (and its own service
 * calls). Otherwise the chain ends at the route's stop, whose `continues` names the route's own chain. */
function serviceStops(ctx: Ctx, sc: ServiceHit, call: ChainStop, depth: number): ChainStop[] {
  const id = routeIdentity(sc.target.route);
  const c = worse(call.hop.confidence, sc.target.confidence);
  const routeHop = c === "exact" ? hop("exact") : hop(c, sc.target.reason ?? "worst hop on the path to this route");
  const route = reachedFrom(ctx, routeStop(ctx.ws, sc.target.route, routeHop), call);
  const backend = ctx.backends.get(id);
  // The budget never cuts a call the chain's own entry makes (depth 0): UI → A → B → table stays whole however
  // many tables A touches. Deeper hops are budgeted.
  if (!backend || depth >= MAX_SERVICE_HOPS || ctx.chain.expanded.has(id) || (depth > 0 && ctx.chain.stops >= EXPAND_BUDGET)) {
    route.continues = ctx.routeChainId(sc.target.route);
    ctx.continued.add(id);
    return [route];
  }
  return [route, ...backendStops(ctx, backend, routeHop, route, depth + 1)];
}

/** The hop into a paired consumer: the pair's own confidence (exact; param for a topic-wildcard binding;
 * guess for the no-binding heuristic), folded with the publish stop's — never better than either. */
function pairedHop(publish: Confidence, pair: QueuePair): Hop {
  const c = worse(publish, pair.confidence);
  if (c === "exact") return pair.reason === ANSWERED ? hop("exact", ANSWERED) : hop("exact");
  if (c !== pair.confidence) return hop(c, "worst hop on the path to this consumer");
  return hop(c, pair.reason ?? "topic wildcard binding");
}

/** A handler the code index could not place (BackendLink.handlerConfidence "guess") is still shown, as a
 * guessed hop; a route with no handler file at all stops at the route (check's "handler-not-found"). */
function backendStops(ctx: Ctx, link: BackendLink, routeHop: Hop, route: ChainStop, depth = 0): ChainStop[] {
  ctx.chain.expanded.add(routeIdentity(link.route));
  if (!link.handler) return [];
  const handlerHop = link.handlerConfidence === "exact"
    ? hop("exact")
    : hop(link.handlerConfidence, `handler "${link.handler.symbol}" not found in ${link.handler.file}`);
  // An inline callback has no graph node of its own: point at its first line instead of the file's.
  const inlineLine = link.route.route.inline && link.handler.file === link.route.route.handlerFile
    ? link.route.route.handlerLines?.[0] : undefined;
  const handler = reachedFrom(ctx, refStop(ctx, "code", "handler", link.handler, handlerHop, inlineLine), route);
  const stops: ChainStop[] = [handler];
  const base = worse(routeHop.confidence, handlerHop.confidence);
  const services: Services = { calls: link.calls ?? [], depth };
  stops.push(...hitStops(ctx, link.repo, link.hits, new Map([[stepKey(link.handler), handler]]), base, {}, undefined, services));
  return stops;
}

/** Consume stop, handler stop (unless the callback is inline), then its store stops. `entryHop` is exact
 * for a consumer chain's own entry, or the pair's hop when appended after a publish (see pairedHop); every
 * stop of an appended consumer carries at most that confidence. A handler the linker could not find (the walk
 * starts at the consume call's enclosing function) makes every store after it a guess. */
function consumerStops(
  ctx: Ctx, link: ConsumerLink, entryHop: Hop, follow: QueueFollow, parent?: ChainStop, depth = 0,
): ChainStop[] {
  const graph = graphOf(ctx.ws, link.repo);
  const consumeRef: SymbolRef = { repo: link.repo, file: link.consume.at.file, symbol: link.consume.at.symbol };
  const consume: ChainStop = reachedFrom(ctx, withoutUndefined({
    lane: "queue" as const, kind: "consume" as const, repo: link.repo,
    nodeId: nearestNodeId(graph, consumeRef.file, consumeRef.symbol),
    file: consumeRef.file, line: link.consume.at.line, symbol: consumeRef.symbol,
    op: "consume", label: link.consume.queue, hop: entryHop,
  }), parent);
  const stops: ChainStop[] = [consume];
  const emitted = new Map([[stepKey(consumeRef), consume]]);
  const base = worse(entryHop.confidence, link.handlerConfidence ?? "exact");
  if (stepKey(link.handler) !== stepKey(consumeRef)) {
    const handlerHop = base === entryHop.confidence ? entryHop : hop(base, HANDLER_NOT_FOUND);
    const handler = reachedFrom(ctx, refStop(ctx, "code", "handler", link.handler, handlerHop), consume);
    stops.push(handler);
    emitted.set(stepKey(link.handler), handler);
  }
  stops.push(...hitStops(ctx, link.repo, link.hits, emitted, base, follow, undefined, { calls: link.calls ?? [], depth }));
  return stops;
}

function toUnresolved(repo: string, u: { at: { file: string; line: number; symbol: string }; reason: string }): Unresolved {
  return { at: { repo, file: u.at.file, line: u.at.line, symbol: u.at.symbol }, reason: u.reason };
}

function sortUnresolved(list: Unresolved[]): Unresolved[] {
  return list.sort((a, b) => compare(a.at.repo, b.at.repo) || compare(a.at.file, b.at.file) || a.at.line - b.at.line
    || compare(a.at.symbol, b.at.symbol) || compare(a.reason, b.reason));
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
    // Only the chain's own consumer: stops after a second consume belong to a paired (appended) consumer.
    const next = c.stops.findIndex((s, i) => i > 0 && s.kind === "consume");
    const own = next === -1 ? c.stops : c.stops.slice(0, next);
    const consume = own.find((s) => s.kind === "consume");
    const handler = own.find((s) => s.kind === "handler") ?? consume;
    return `consume ${consume?.label ?? ""} · ${handler?.symbol ?? ""}`;
  }
  const route = c.stops.find((s) => s.kind === "route");
  if (c.entry.startsWith("call:")) {
    const call = c.stops.find((s) => s.kind === "call");
    return `${route?.label ?? `${call?.op ?? ""} ${call?.label ?? ""}`} · ${call?.symbol ?? ""}`;
  }
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

/** H11: the ids this flow has under other entries, so a journey saved against one of them still finds
 * it after the chain gains (or loses) a UI step: for a chain with a routeKey, its route-only id; for a
 * page chain, also the call-entry id of each of its call stops and its own id while unlinked (routeKey ""). Sorted;
 * never the chain's own id. */
export function chainAliases(entry: string, rKey: string, stops: ChainStop[]): string[] {
  if (rKey === "") return [];
  const own = chainId(entry, rKey);
  const out = new Set<string>([chainId(`route:${rKey}`, rKey)]);
  if (entry.startsWith("page:")) {
    for (const s of stops) if (s.kind === "call") out.add(chainId(`call:${s.repo}:${s.file}#${s.symbol}`, rKey));
    // 0.6: the same page while its call matched no route yet (a group's frontend indexed before its backend): a
    // journey named then follows the page once it links.
    out.add(chainId(entry, ""));
  }
  out.delete(own);
  return [...out].sort(compare);
}

function makeChain(entry: string, rKey: string, stops: ChainStop[], unresolved: Unresolved[]): Chain {
  const aliases = chainAliases(entry, rKey, stops);
  return {
    id: chainId(entry, rKey), entry, routeKey: rKey, name: defaultChainName({ entry, stops }), stops,
    unresolved: sortUnresolved(unresolved), confidence: worstConfidence(stops), complete: isComplete(stops),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

/** A db access with neither a table nor a model names no store: it is not a db stop (no empty-label
 * hop). Nor is a mongoose access whose collection is unknown: a document model's name is not its
 * collection (H9). Either moves to the link's unresolved list instead, so the chain counts as missing its store. */
function dropUnlabeledDb<L extends BackendLink | ConsumerLink>(link: L): L {
  const unlabeled = (h: StoreHit) => h.kind === "db" && !h.access.table && (!h.access.model || h.access.via === "mongoose");
  if (!link.hits.some(unlabeled)) return link;
  const extra = link.hits.flatMap((h) => (h.kind === "db" && unlabeled(h)
    ? [{
      at: h.access.at,
      reason: h.access.model
        ? `mongoose model "${h.access.model}" (${h.access.op}): collection unknown`
        : `database access (${h.access.op}) with no table or model`,
    }] : []));
  return { ...link, hits: link.hits.filter((h) => !unlabeled(h)), unresolved: [...link.unresolved, ...extra] };
}

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

const MANUAL = "manual link";
const NO_HANDLER_LINK = "route has no handler link";

/** A resolved manual link with its parsed ends. `i` is its position in the workspace `links` list. */
interface Manual { i: number; link: ManualLink; from: LinkRef; to: LinkRef }

const SYMBOL_STOP_KINDS = new Set<ChainStop["kind"]>(["page", "function", "call", "handler", "consume"]);

/** Does a chain stop match a link's `from`? symbol: a page/function/call/handler/consume stop by
 * repo + file + symbol; route: a route stop by repo + method + effective path; queue: a publish/consume
 * stop by repo + queue. */
function matchesRef(ref: LinkRef, s: ChainStop): boolean {
  if (s.repo !== ref.repo) return false;
  if (ref.kind === "symbol") return SYMBOL_STOP_KINDS.has(s.kind) && s.file === ref.file && s.symbol === ref.symbol;
  if (ref.kind === "route") return s.kind === "route" && s.op === ref.method && s.label === `${ref.method} ${ref.path}`;
  return (s.kind === "publish" || s.kind === "consume") && s.label === ref.queue;
}

/** The backend link for a route ref (first in linkBackend's sorted order). */
function backendFor(backend: BackendLink[], ref: LinkRef & { kind: "route" }): BackendLink | undefined {
  return backend.find((b) => b.repo === ref.repo && b.route.route.method === ref.method && b.route.effectivePath === ref.path);
}

/** Where a symbol block goes: the end of the `from` stop's segment — before the next consume stop past the
 * first stop (a paired consumer) or the next route stop not reached by a UI call (an appended route), so its
 * stores are scored under the same route/consumer as `from`. */
function segmentEnd(stops: ChainStop[], at: number): number {
  for (let j = at + 1; j < stops.length; j++) {
    const s = stops[j]!;
    if (s.kind === "consume" || (s.kind === "route" && stops[j - 1]?.kind !== "call")) return j;
  }
  return stops.length;
}

function sameStop(a: ChainStop, b: ChainStop): boolean {
  if (b.kind === "handler" || b.kind === "function") {
    return (a.kind === "handler" || a.kind === "function") && a.repo === b.repo && a.file === b.file && a.symbol === b.symbol;
  }
  return a.kind === b.kind && a.repo === b.repo && a.file === b.file && a.line === b.line && a.label === b.label;
}

/** Add every resolved manual link whose `from` matches one of the chain's own stops (the last such stop).
 * The `to` target's hop is exact with reason "manual link"; the stops after it carry their own walk's
 * confidence. A symbol target (walked like a handler) is inserted at the end of the `from` stop's segment
 * (its paired consumers go to the chain's end); a route target (route, handler, stores, paired consumers)
 * and a queue target (the queue's consumers) are appended at the chain's end. One level: stops added by a
 * manual link are never matched by another link. A target already in the chain is not added again.
 * symbol -> route links are skipped here (see linkUnmatchedCalls), so a route block never follows a call
 * it is not that call's target. A route target with no backend link is broken ("route has no handler link"). */
function applyManualLinks(
  ctx: Ctx, manual: Manual[], backend: BackendLink[], used: Set<number>, broken: Map<number, string>,
  stops: ChainStop[], unresolved: Unresolved[],
): { stops: ChainStop[]; unresolved: Unresolved[] } {
  const own = new Set(stops);
  let out = [...stops];
  const tail: ChainStop[] = [];
  const extra: Unresolved[] = [];
  for (const m of manual) {
    // symbol -> route links are only ever applied to the one unmatched call they name (linkUnmatchedCalls).
    if (m.from.kind === "symbol" && m.to.kind === "route") continue;
    let at = -1;
    out.forEach((s, j) => {
      if (own.has(s) && matchesRef(m.from, s)) at = j;
    });
    if (at === -1) continue;
    const manualHop = hop("exact", MANUAL);
    const to = m.to;
    if (to.kind === "symbol") {
      const target = m.link.target;
      if (!target) continue;
      const block: ChainStop[] = [reachedFrom(ctx, refStop(ctx, "code", "handler", target.handler, manualHop), out[at])];
      used.add(m.i);
      if ([...out, ...tail].some((s) => sameStop(s, block[0]!))) continue;
      const paired: ChainStop[] = [];
      block.push(...hitStops(ctx, target.handler.repo, target.hits, new Map([[stepKey(target.handler), block[0]!]]), "exact", {}, paired));
      const end = segmentEnd(out, at);
      out = [...out.slice(0, end), ...block, ...out.slice(end)];
      tail.push(...paired);
      extra.push(...target.unresolved.map((u) => toUnresolved(target.handler.repo, u)));
    } else if (to.kind === "route") {
      const b = backendFor(backend, to);
      if (!b) {
        broken.set(m.i, NO_HANDLER_LINK);
        continue;
      }
      const route = reachedFrom(ctx, routeStop(ctx.ws, b.route, manualHop), out[at]);
      const block = [route, ...backendStops(ctx, b, manualHop, route)];
      used.add(m.i);
      if ([...out, ...tail].some((s) => sameStop(s, block[0]!))) continue;
      tail.push(...block);
    } else {
      const consumers = [...ctx.consumers.values()].filter((c) => c.repo === to.repo && c.consume.queue === to.queue);
      if (consumers.length === 0) continue;
      used.add(m.i);
      for (const c of consumers) {
        const block = consumerStops(ctx, c, manualHop, null, out[at]);
        if (![...out, ...tail].some((s) => sameStop(s, block[0]!))) tail.push(...block);
      }
    }
  }
  if (out.length === stops.length && tail.length === 0) return { stops, unresolved };
  return { stops: [...out, ...tail], unresolved: [...unresolved, ...extra] };
}

/** A symbol -> route manual link applies only to an internal UI call in that function that matched no
 * route, or matched one only as a guess (0.6 §5: a tie between two repos is answered with a link) — never a
 * third-party call, never one matched for sure — and only when the function has exactly one such call: the link
 * then supplies that call's route (exact, "manual link"), as if codeloom had matched it. Two or more such calls:
 * the link is ambiguous — broken, nothing linked. */
function linkUnmatchedCalls(
  ui: UiLink[], manual: Manual[], backend: BackendLink[], used: Set<number>, broken: Map<number, string>,
): UiLink[] {
  const relinked = new Map<UiLink, UiLink>();
  for (const m of manual) {
    if (m.from.kind !== "symbol" || m.to.kind !== "route") continue;
    const from = m.from;
    const calls = ui.filter((l) => (l.target.kind === "unresolved" || (l.target.kind === "route" && l.target.confidence === "guess"))
      && l.repo === from.repo && l.call.at.file === from.file && l.call.at.symbol === from.symbol);
    if (calls.length === 0) continue;
    if (calls.length > 1) {
      broken.set(m.i, `ambiguous: ${calls.length} unmatched calls in ${from.symbol}`);
      continue;
    }
    const call = calls[0]!;
    if (relinked.has(call)) continue;
    const b = backendFor(backend, m.to);
    if (!b) {
      broken.set(m.i, NO_HANDLER_LINK);
      continue;
    }
    used.add(m.i);
    relinked.set(call, { ...call, target: { kind: "route" as const, route: b.route, confidence: "exact" as const, reason: MANUAL } });
  }
  return ui.map((l) => relinked.get(l) ?? l);
}

/** One chain per (entry, routeKey), memo (g) as amended:
 * - each page reaching a call that targets a route -> `page:<repo>:<route>` chain;
 * - each page reaching a call that matches no route -> a partial `page:` chain with routeKey "" carrying
 *   one unresolved entry per unmatched call (calls with no literal URL text are left to check's
 *   "unresolved-url"; external calls are third-party, not broken);
 * - each UI-side call (LinkResult.uiReach) that targets a route but no page reaches -> a call-entry
 *   `call:<repo>:<file>#<symbol>` chain: the call stop (no page is invented), the route, then the backend
 *   half as usual; its route then needs no `route:` chain;
 * - each route that no page or call-entry chain covers -> `route:<chain route key>` chain (see chainRouteKeys);
 * - each consumer -> `consumer:<repo>:<queue>#<handler file>#<handler symbol>` chain, so two consumers of
 *   one queue in one repo are two chains.
 * The backend half of a page chain is looked up by route identity, never by routeKey alone.
 * Inputs from linkAll are sorted, so when two sources produce the same id the first one wins.
 * `symbolLine` (from runLinker's code index) gives function/handler stops their own first line. */
export function buildChains(ws: WorkspaceData, rawLinks: LinkResult, symbolLine: SymbolLineLookup = () => undefined): Chain[] {
  return buildChainsAndLinks(ws, rawLinks, symbolLine).chains;
}

/** buildChains, plus what became of each workspace `links` entry (see ManualLinkStatus). Manual links:
 * see linkUnmatchedCalls and applyManualLinks. */
export function buildChainsAndLinks(
  ws: WorkspaceData, rawLinks: LinkResult, symbolLine: SymbolLineLookup = () => undefined,
): { chains: Chain[]; manualLinks: ManualLinkStatus[] } {
  const backendLinks = rawLinks.backend.map(dropUnlabeledDb);
  const manual: Manual[] = rawLinks.manual.flatMap((link, i) => {
    const from = link.resolved ? parseLinkRef(link.from) : null;
    const to = link.resolved ? parseLinkRef(link.to) : null;
    return from && to ? [{ i, link, from, to }] : [];
  });
  const used = new Set<number>();
  const broken = new Map<number, string>();
  const links: LinkResult = {
    ...rawLinks, backend: backendLinks, consumers: rawLinks.consumers.map(dropUnlabeledDb),
    ui: linkUnmatchedCalls(rawLinks.ui, manual, backendLinks, used, broken),
  };
  const pairs = new Map<string, QueuePair[]>();
  for (const p of links.queuePairs) {
    const key = queueKey(p.repoFrom, p.publish);
    pairs.set(key, [...(pairs.get(key) ?? []), p]);
  }
  const consumers = new Map(links.consumers.map((c) => [queueKey(c.repo, c.consume), c]));
  const backends = new Map<string, BackendLink>();
  for (const b of links.backend) if (!backends.has(routeIdentity(b.route))) backends.set(routeIdentity(b.route), b);
  // Every route a UI link reaches: its own-repo match (target.kind === "route"), plus any found through
  // the repo's workspace `proxies` (spec §4) — the own match is untouched; proxied ones are extra.
  // A match through a Next.js catch-all route read as a proxy rule passes through that route (`via`): the route
  // alone, a dead end that only forwards, gets no chain of its own.
  const routeTargetsOf = (l: UiLink): RouteTarget[] => {
    const proxied = l.proxied ?? [];
    const passedThrough = l.target.kind === "route" && proxied.some((t) => t.via !== undefined);
    return l.target.kind === "route" && !passedThrough ? [l.target, ...proxied] : proxied;
  };
  /** The route stops of a UI call's match: the proxy route it passes through (if any), then the matched route. */
  const routeStopsOf = (target: RouteTarget, from: ChainStop | undefined): ChainStop[] => {
    if (!target.via) return [reachedFrom(ctx, routeStop(ws, target.route, hop(target.confidence, target.reason)), from)];
    const via = reachedFrom(ctx, routeStop(ws, target.via, hop("exact")), from);
    return [via, reachedFrom(ctx, routeStop(ws, target.route, hop(target.confidence, target.reason ?? "proxied by this route")), via)];
  };
  const uiTargets = links.ui.flatMap((l) => routeTargetsOf(l).map((t) => t.route));
  const keys = chainRouteKeys([...links.backend.map((b) => b.route), ...uiTargets]);
  const keyOf = (er: EffectiveRoute) => keys.get(routeIdentity(er)) ?? routeKey(er);
  const ctx: Ctx = {
    ws, symbolLine, pairs, consumers, backends, parents: new WeakMap(),
    routeChainId: (er) => chainId(`route:${keyOf(er)}`, keyOf(er)), chain: { expanded: new Set(), stops: 0 }, continued: new Set(),
  };
  const backendByIdentity = backends;
  const byId = new Map<string, Chain>();
  const add = (c: Chain) => {
    if (byId.has(c.id)) return;
    const withLinks = applyManualLinks(ctx, manual, links.backend, used, broken, c.stops, c.unresolved);
    const stops = withFrom(ctx.parents, withLinks.stops);
    byId.set(c.id, withLinks.stops === c.stops ? { ...c, stops } : {
      ...c, stops, unresolved: sortUnresolved(withLinks.unresolved),
      confidence: worstConfidence(stops), complete: isComplete(stops),
    });
  };
  const pageRoutes = new Set<string>();
  const callSiteKey = (l: UiLink) => [l.repo, l.call.at.file, String(l.call.at.line), l.call.method, l.call.path].join("\0");
  /** (call site, matched route) pairs that already have a page-entry chain (a page chain is one per
   * (page, route), so a second call to the same route from the same page is dropped there). Keyed by pair,
   * not call alone, so a call's own-repo route and a proxied route are tracked independently. */
  const inPageChain = new Set<string>();
  const pairKey = (l: UiLink, t: RouteTarget) => `${callSiteKey(l)}\0${routeIdentity(t.route)}`;

  for (const uiLink of links.ui) {
    for (const target of routeTargetsOf(uiLink)) {
      const rKey = keyOf(target.route);
      const backend = backendByIdentity.get(routeIdentity(target.route));
      for (const page of uiLink.pages) {
        const entry = `page:${uiLink.repo}:${page.page.route}`;
        startChain(ctx);
        const ui = uiStops(ctx, uiLink, page);
        const routes = routeStopsOf(target, ui.at(-1));
        const route = routes.at(-1)!;
        const stops = [...ui, ...routes, ...(backend ? backendStops(ctx, backend, hop(target.confidence), route) : [])];
        pageRoutes.add(routeIdentity(target.route));
        if (target.via) pageRoutes.add(routeIdentity(target.via));
        const chain = makeChain(entry, rKey, stops, (backend?.unresolved ?? []).map((u) => toUnresolved(backend!.repo, u)));
        if (!byId.has(chain.id)) inPageChain.add(pairKey(uiLink, target));
        add(chain);
      }
    }
  }

  // Call-entry chains: UI-side calls that match a route but that no page reaches — and (v0.2a §4) reached calls
  // whose call stop no page chain kept (another call to the same route took that page's chain), so every UI
  // call keeps a chain of its own.
  const unreached = new Set(links.uiReach.filter((f) => !f.reached).map(uiReachKey));
  for (const uiLink of links.ui) {
    const at = uiLink.call.at;
    for (const target of routeTargetsOf(uiLink)) {
      if (inPageChain.has(pairKey(uiLink, target))) continue;
      if (uiLink.pages.length === 0
        && !unreached.has(uiReachKey({ repo: uiLink.repo, file: at.file, line: at.line, method: uiLink.call.method, path: uiLink.call.path }))) continue;
      const backend = backendByIdentity.get(routeIdentity(target.route));
      startChain(ctx);
      const ui = uiStops(ctx, uiLink, undefined);
      const routes = routeStopsOf(target, ui.at(-1));
      const route = routes.at(-1)!;
      const stops = [...ui, ...routes, ...(backend ? backendStops(ctx, backend, hop(target.confidence), route) : [])];
      pageRoutes.add(routeIdentity(target.route));
      if (target.via) pageRoutes.add(routeIdentity(target.via));
      add(makeChain(`call:${uiLink.repo}:${at.file}#${at.symbol}`, keyOf(target.route), stops,
        (backend?.unresolved ?? []).map((u) => toUnresolved(backend!.repo, u))));
    }
  }

  // Unmatched UI calls: one partial chain per page, collecting every unmatched call it reaches. A call
  // whose own-repo target is unresolved (e.g. a Next `rewrites()` proxy with no route file of its own)
  // but that a workspace `proxies` rule DID match (review fix) is not unmatched at all — skipping it here
  // avoids a bogus "no matching route" partial chain alongside the real one the proxy loop above built.
  for (const uiLink of links.ui) {
    if (uiLink.target.kind !== "unresolved" || uiLink.call.kind === "unknown" || (uiLink.proxied?.length ?? 0) > 0) continue;
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
      startChain(ctx);
      add(makeChain(entry, "", uiStops(ctx, uiLink, page), [u]));
    }
  }

  const routeChain = (b: BackendLink) => {
    const rKey = keyOf(b.route);
    const entry = `route:${rKey}`;
    const routeHop = b.route.mountsKnown ? hop("exact") : hop("guess", "mount prefix unknown");
    startChain(ctx);
    const route = routeStop(ws, b.route, routeHop);
    const stops = [route, ...backendStops(ctx, b, routeHop, route)];
    add(makeChain(entry, rKey, stops, b.unresolved.map((u) => toUnresolved(b.repo, u))));
  };
  const routeChained = new Set<string>();
  for (const b of links.backend) {
    if (pageRoutes.has(routeIdentity(b.route))) continue;
    routeChained.add(routeIdentity(b.route));
    routeChain(b);
  }

  for (const c of links.consumers) {
    const entry = `consumer:${c.repo}:${c.consume.queue}#${c.handler.file}#${c.handler.symbol}`;
    startChain(ctx);
    const stops = consumerStops(ctx, c, hop("exact"), { skip: queueKey(c.repo, c.consume) });
    add(makeChain(entry, "", stops, c.unresolved.map((u) => toUnresolved(c.repo, u))));
  }

  // Every route a `continues` names gets its own `route:` chain (a route that pages call has none so far).
  // Building one may name further routes, so repeat until none is left; in backend order, so it is stable.
  for (let pending = true; pending;) {
    pending = false;
    for (const b of links.backend) {
      const id = routeIdentity(b.route);
      if (!ctx.continued.has(id) || routeChained.has(id)) continue;
      routeChained.add(id);
      routeChain(b);
      pending = true;
    }
  }

  const manualLinks: ManualLinkStatus[] = rawLinks.manual.map((l, i): ManualLinkStatus => {
    const src = l.source !== undefined ? { source: l.source } : {};
    if (!l.resolved) return { from: l.from, to: l.to, status: "broken", ...(l.reason !== undefined ? { reason: l.reason } : {}), ...src };
    if (used.has(i)) return { from: l.from, to: l.to, status: "used", ...src };
    const reason = broken.get(i);
    return reason !== undefined ? { from: l.from, to: l.to, status: "broken", reason, ...src } : { from: l.from, to: l.to, status: "unused", ...src };
  });
  return { chains: [...byId.values()], manualLinks };
}

/** Sort chains by id; stops keep walk order; unresolved is sorted when each chain is built. */
export function sortChains(chains: Chain[]): Chain[] {
  return chains.sort((a, b) => compare(a.id, b.id));
}

/** `uiReach` (the linker's per-call reach facts, already sorted) is written only when given;
 * `manualLinks` only when non-empty (a workspace with no `links` keeps its file unchanged). */
export function writeChains(
  wsRoot: string, chains: Chain[], uiReach?: UiReachFact[], manualLinks?: ManualLinkStatus[], external?: ExternalCallFact[],
  unresolvedBases?: UnresolvedBase[], wrapperCalls?: NonNullable<ChainsFile["wrapperCalls"]>,
): boolean {
  const file: ChainsFile = {
    version: 1, chains, ...(uiReach ? { uiReach } : {}), ...(manualLinks && manualLinks.length > 0 ? { manualLinks } : {}),
    ...(external && external.length > 0 ? { external } : {}),
    ...(unresolvedBases && unresolvedBases.length > 0 ? { unresolvedBases } : {}),
    ...(wrapperCalls && wrapperCalls.length > 0 ? { wrapperCalls } : {}),
  };
  return writeJsonIfChanged(join(wsRoot, CODELOOM_DIR, FILES.chains), file);
}

/** Orphaned only when the code behind a journey is entirely gone: it names chains and none of them
 * resolves, as an id or through an alias (H11). A journey that lost some (not all) of its chains stays
 * "ok" — one sub-chain changing must not flip it. An empty chainIds list is never orphaned. */
function isOrphaned(j: Journey, lookup: ChainLookup<unknown>): boolean {
  return j.chainIds.length > 0 && lookup.resolve(j.chainIds).missing.length === new Set(j.chainIds).size;
}

/** Create journeys.json if missing; otherwise set each journey's status to "orphaned" when none of its
 * chainIds resolves (directly or through a chain's alias) and back to "ok" when any does, writing only if
 * some status actually changed. Never touches order or any other field. A malformed existing file throws
 * (via readJson, telling the user to fix it by hand) and is left untouched. `chains`: the current chains
 * (a plain id set means no aliases). */
export function syncJourneys(
  wsRoot: string, chains: ReadonlyArray<Pick<Chain, "id" | "aliases">> | ReadonlySet<string>,
): { created: boolean; orphaned: number; changed: boolean } {
  const lookup = chainLookup(chains instanceof Set ? [...chains].map((id) => ({ id })) : [...(chains as ReadonlyArray<Pick<Chain, "id" | "aliases">>)]);
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
    const status: Journey["status"] = isOrphaned(j, lookup) ? "orphaned" : "ok";
    if (status === "orphaned") orphaned++;
    if (status !== j.status) {
      changed = true;
      raw.journeys[i]!.status = status;
    }
  });
  if (changed) writeJsonAtomic(path, raw);
  return { created: false, orphaned, changed };
}
