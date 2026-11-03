import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeGraph } from "@codeloom/core";
import { isComplete } from "./completeness.js";
import { parseLinkRef, stepKey, uiReachKey } from "./link.js";
import type { BackendLink, ConsumerLink, LinkRef, LinkResult, ManualLink, PageReach, QueuePair, StoreHit, UiLink } from "./link.js";
import type { SymbolRef, WalkStep } from "./resolve-calls.js";
import type { EffectiveRoute } from "./mounts.js";
import { routeKey } from "./mounts.js";
import { worse } from "./paths.js";
import type { WorkspaceData } from "../store/read.js";
import {
  type Chain, type ChainStop, type ChainsFile, type Confidence, type Hop, type Journey, type JourneysFile,
  JourneysFileSchema, type ManualLinkStatus, type QueueOp, type UiReachFact, type Unresolved,
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

/** A queue op's identity: repo + site + op + queue. */
function queueKey(repo: string, q: QueueOp): string {
  return [repo, q.at.file, String(q.at.line), q.op, q.queue].join("\0");
}

/** Per-build context: the workspace, the code index's symbol lines, and the queue pairs (by publish op,
 * in pairQueues' sorted order) with the consumer links they lead to (by consume op). */
interface Ctx {
  ws: WorkspaceData; symbolLine: SymbolLineLookup;
  pairs: Map<string, QueuePair[]>; consumers: Map<string, ConsumerLink>;
  /** Each built stop's parent: the stop it was reached from. Turned into `ChainStop.from` indices once a
   * chain's final stop order is known (see withFrom). */
  parents: WeakMap<ChainStop, ChainStop>;
}

/** Record that `child` was reached from `parent` (no-op when there is no parent: a chain's entry). */
function reachedFrom<T extends ChainStop>(ctx: Ctx, child: T, parent: ChainStop | undefined): T {
  if (parent) ctx.parents.set(child, parent);
  return child;
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
function uiStops(ctx: Ctx, link: UiLink, page: PageReach | undefined): ChainStop[] {
  const graph = graphOf(ctx.ws, link.repo);
  // A call-entry chain (no page) starts at the call stop itself.
  const stops: ChainStop[] = [];
  (page?.path ?? []).forEach((ref, i) => {
    const sym: SymbolRef = { repo: ref.repo, file: ref.file, symbol: ref.symbol };
    stops.push(reachedFrom(ctx, i === 0
      ? refStop(ctx, "ui", "page", sym, hop("exact"), page!.page.line)
      : refStop(ctx, "ui", "function", sym, hop(page!.path[i - 1]!.confidence)), stops[i - 1]));
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
function storeHop(base: Confidence, hit: StoreHit): Hop {
  const c = hit.viaPath.reduce<Confidence>((acc, step) => worse(acc, step.via?.confidence ?? "exact"), base);
  return c === "exact" ? hop("exact") : hop(c, "worst hop on the path to this store");
}

function hopFromStep(step: WalkStep): Hop {
  return step.via ? hop(step.via.confidence, `via ${step.via.via}`) : hop("exact");
}

/** Intermediate "function" stops for every hit's viaPath (deduped by symbol across all of a link's
 * hits), then each hit's own terminal db/publish stop; then, when `follow` allows, each publish hit's
 * paired consumers (consume, handler, its stores), in hit order then pairQueues order. `emitted` starts containing the entry symbol
 * (handler, or the consume call's own symbol) so it is never re-emitted as a redundant function stop. */
function hitStops(
  ctx: Ctx, repo: string, hits: StoreHit[], emitted: Map<string, ChainStop>, base: Confidence, follow: QueueFollow, pairedOut?: ChainStop[],
): ChainStop[] {
  const stops: ChainStop[] = [];
  const paired: ChainStop[] = [];
  for (const hit of hits) {
    // Each function stop is reached from the previous step of the walk path that first emitted it; the
    // store from the last step (the symbol that holds the access), never from a sibling store.
    hit.viaPath.forEach((step, k) => {
      const key = stepKey(step.ref);
      if (k === 0 || emitted.has(key)) return;
      const stop = refStop(ctx, "code", "function", step.ref, hopFromStep(step));
      emitted.set(key, reachedFrom(ctx, stop, emitted.get(stepKey(hit.viaPath[k - 1]!.ref))));
      stops.push(stop);
    });
    const last = hit.viaPath.at(-1);
    const holder = last ? emitted.get(stepKey(last.ref)) : undefined;
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
      paired.push(...consumerStops(ctx, consumer, pairedHop(h.confidence, pair), null, publish));
    }
  }
  // Paired consumers go after all of this link's own stops, so each consume stop past the first starts a
  // block that runs to the next one (or the end) — the scorer keys those stores to the consumer.
  // `pairedOut` (a manual symbol block inserted mid-chain) collects them for the chain's end instead.
  if (pairedOut) {
    pairedOut.push(...paired);
    return stops;
  }
  return [...stops, ...paired];
}

/** The hop into a paired consumer: the pair's own confidence (exact; param for a topic-wildcard binding;
 * guess for the no-binding heuristic), folded with the publish stop's — never better than either. */
function pairedHop(publish: Confidence, pair: QueuePair): Hop {
  const c = worse(publish, pair.confidence);
  if (c === "exact") return hop("exact");
  if (c !== pair.confidence) return hop(c, "worst hop on the path to this consumer");
  return hop(c, pair.reason ?? "topic wildcard binding");
}

/** A handler the code index could not place (BackendLink.handlerConfidence "guess") is still shown, as a
 * guessed hop; a route with no handler file at all stops at the route (check's "handler-not-found"). */
function backendStops(ctx: Ctx, link: BackendLink, routeHop: Hop, route: ChainStop): ChainStop[] {
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
  stops.push(...hitStops(ctx, link.repo, link.hits, new Map([[stepKey(link.handler), handler]]), base, {}));
  return stops;
}

/** Consume stop, handler stop (unless the callback is inline), then its store stops. `entryHop` is exact
 * for a consumer chain's own entry, or the pair's hop when appended after a publish (see pairedHop); every
 * stop of an appended consumer carries at most that confidence. */
function consumerStops(ctx: Ctx, link: ConsumerLink, entryHop: Hop, follow: QueueFollow, parent?: ChainStop): ChainStop[] {
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
  if (stepKey(link.handler) !== stepKey(consumeRef)) {
    const handler = reachedFrom(ctx, refStop(ctx, "code", "handler", link.handler, entryHop), consume);
    stops.push(handler);
    emitted.set(stepKey(link.handler), handler);
  }
  stops.push(...hitStops(ctx, link.repo, link.hits, emitted, entryHop.confidence, follow));
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

function makeChain(entry: string, rKey: string, stops: ChainStop[], unresolved: Unresolved[]): Chain {
  return {
    id: chainId(entry, rKey), entry, routeKey: rKey, name: defaultChainName({ entry, stops }), stops,
    unresolved: sortUnresolved(unresolved), confidence: worstConfidence(stops), complete: isComplete(stops),
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
 * route (never a third-party call, never one that matched a route at any confidence), and only when the
 * function has exactly one such call: the link then supplies that call's route (exact, "manual link"), as
 * if codeloom had matched it. Two or more such calls: the link is ambiguous — broken, nothing linked. */
function linkUnmatchedCalls(
  ui: UiLink[], manual: Manual[], backend: BackendLink[], used: Set<number>, broken: Map<number, string>,
): UiLink[] {
  const relinked = new Map<UiLink, UiLink>();
  for (const m of manual) {
    if (m.from.kind !== "symbol" || m.to.kind !== "route") continue;
    const from = m.from;
    const calls = ui.filter((l) => l.target.kind === "unresolved"
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
  const ctx: Ctx = { ws, symbolLine, pairs, consumers, parents: new WeakMap() };
  const uiTargets = links.ui.flatMap((l) => (l.target.kind === "route" ? [l.target.route] : []));
  const keys = chainRouteKeys([...links.backend.map((b) => b.route), ...uiTargets]);
  const keyOf = (er: EffectiveRoute) => keys.get(routeIdentity(er)) ?? routeKey(er);
  const backendByIdentity = new Map<string, BackendLink>();
  for (const b of links.backend) if (!backendByIdentity.has(routeIdentity(b.route))) backendByIdentity.set(routeIdentity(b.route), b);
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

  for (const uiLink of links.ui) {
    if (uiLink.target.kind !== "route") continue;
    const target: RouteTarget = uiLink.target;
    const rKey = keyOf(target.route);
    const backend = backendByIdentity.get(routeIdentity(target.route));
    for (const page of uiLink.pages) {
      const entry = `page:${uiLink.repo}:${page.page.route}`;
      const ui = uiStops(ctx, uiLink, page);
      const route = reachedFrom(ctx, routeStop(ws, target.route, hop(target.confidence, target.reason)), ui.at(-1));
      const stops = [...ui, route, ...(backend ? backendStops(ctx, backend, hop(target.confidence), route) : [])];
      pageRoutes.add(routeIdentity(target.route));
      add(makeChain(entry, rKey, stops, (backend?.unresolved ?? []).map((u) => toUnresolved(backend!.repo, u))));
    }
  }

  // Call-entry chains: UI-side calls that match a route but that no page reaches.
  const unreached = new Set(links.uiReach.filter((f) => !f.reached).map(uiReachKey));
  for (const uiLink of links.ui) {
    if (uiLink.target.kind !== "route" || uiLink.pages.length > 0) continue;
    const at = uiLink.call.at;
    if (!unreached.has(uiReachKey({ repo: uiLink.repo, file: at.file, line: at.line, method: uiLink.call.method, path: uiLink.call.path }))) continue;
    const target: RouteTarget = uiLink.target;
    const backend = backendByIdentity.get(routeIdentity(target.route));
    const ui = uiStops(ctx, uiLink, undefined);
    const route = reachedFrom(ctx, routeStop(ws, target.route, hop(target.confidence, target.reason)), ui.at(-1));
    const stops = [...ui, route, ...(backend ? backendStops(ctx, backend, hop(target.confidence), route) : [])];
    pageRoutes.add(routeIdentity(target.route));
    add(makeChain(`call:${uiLink.repo}:${at.file}#${at.symbol}`, keyOf(target.route), stops,
      (backend?.unresolved ?? []).map((u) => toUnresolved(backend!.repo, u))));
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
    const route = routeStop(ws, b.route, routeHop);
    const stops = [route, ...backendStops(ctx, b, routeHop, route)];
    add(makeChain(entry, rKey, stops, b.unresolved.map((u) => toUnresolved(b.repo, u))));
  }

  for (const c of links.consumers) {
    const entry = `consumer:${c.repo}:${c.consume.queue}#${c.handler.file}#${c.handler.symbol}`;
    const stops = consumerStops(ctx, c, hop("exact"), { skip: queueKey(c.repo, c.consume) });
    add(makeChain(entry, "", stops, c.unresolved.map((u) => toUnresolved(c.repo, u))));
  }

  const manualLinks: ManualLinkStatus[] = rawLinks.manual.map((l, i) => {
    if (!l.resolved) return { from: l.from, to: l.to, status: "broken", ...(l.reason !== undefined ? { reason: l.reason } : {}) };
    if (used.has(i)) return { from: l.from, to: l.to, status: "used" };
    const reason = broken.get(i);
    return reason !== undefined ? { from: l.from, to: l.to, status: "broken", reason } : { from: l.from, to: l.to, status: "unused" };
  });
  return { chains: [...byId.values()], manualLinks };
}

/** Sort chains by id; stops keep walk order; unresolved is sorted when each chain is built. */
export function sortChains(chains: Chain[]): Chain[] {
  return chains.sort((a, b) => compare(a.id, b.id));
}

/** `uiReach` (the linker's per-call reach facts, already sorted) is written only when given;
 * `manualLinks` only when non-empty (a workspace with no `links` keeps its file unchanged). */
export function writeChains(wsRoot: string, chains: Chain[], uiReach?: UiReachFact[], manualLinks?: ManualLinkStatus[]): boolean {
  const file: ChainsFile = {
    version: 1, chains, ...(uiReach ? { uiReach } : {}), ...(manualLinks && manualLinks.length > 0 ? { manualLinks } : {}),
  };
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
