import { type PathMatch, matchPath, methodMatches } from "../../linker/paths.js";
import type { WorkspaceData } from "../../store/read.js";
import type { Chain, HttpMethod, TracesReport } from "../../store/schemas.js";
import { compare } from "../../util.js";
import type { TraceSpan } from "./otlp.js";

/** A route stop of the map: its repo, method and path come from the stop label ("METHOD /path"). */
interface MapRoute {
  routeKey: string; // `${repo}:${label}`, the same string as the chain's routeKey
  repo: string;
  method: string;
  path: string;
  /** "table:<name> <op>" and "queue:<label> publish" stops of every chain through this route. */
  tables: Array<{ table: string; op: string }>;
  queues: string[];
}

/** `{id}` and `[id]` (and `[...rest]` / `[[...rest]]`) → the linker's `:id` / `:rest*` form, so paths.ts
 * can match them. */
export function normalizeRoutePath(path: string): string {
  return path
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, ":$1*")
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1*")
    .replace(/\[([^\]]+)\]/g, ":$1")
    .replace(/\{([^}]+)\}/g, ":$1");
}

/** A trace db operation in the map's vocabulary (read | insert | update | delete); anything else is kept
 * lower-cased. */
function normalizeOp(op: string): string {
  const o = op.toLowerCase();
  if (/^(select|find|get|count|aggregate|read|query|scan)/.test(o)) return "read";
  if (/^(insert|create|add|put)/.test(o)) return "insert";
  if (/^(update|replace|upsert|set|modify)/.test(o)) return "update";
  if (/^(delete|remove|drop)/.test(o)) return "delete";
  return o;
}

function mapRoutes(chains: Chain[]): Map<string, MapRoute> {
  const routes = new Map<string, MapRoute>();
  for (const chain of chains) {
    for (const stop of chain.stops) {
      if (stop.kind !== "route" || !stop.label) continue;
      const space = stop.label.indexOf(" ");
      if (space < 0) continue;
      const routeKey = `${stop.repo}:${stop.label}`;
      let route = routes.get(routeKey);
      if (!route) {
        route = { routeKey, repo: stop.repo, method: stop.label.slice(0, space), path: stop.label.slice(space + 1), tables: [], queues: [] };
        routes.set(routeKey, route);
      }
      for (const s of chain.stops) {
        if (s.kind === "db" && s.label) route.tables.push({ table: s.label, op: s.op ?? "" });
        if (s.kind === "publish" && s.label) route.queues.push(s.label);
      }
    }
  }
  return routes;
}

/** A queue destination from a trace names a map publish stop when equal, or when the stop label is
 * "<exchange>:<routing key>" and the destination is either side. */
function queueInMap(route: MapRoute, dest: string): boolean {
  return route.queues.some((q) => q === dest || q.startsWith(`${dest}:`) || q.endsWith(`:${dest}`));
}

function tableInMap(route: MapRoute, table: string, op: string | undefined): boolean {
  return route.tables.some((t) => t.table === table && (op === undefined || t.op === op));
}

const rank = (m: PathMatch) => (m.confidence === "exact" ? 0 : m.confidence === "param" ? 1 : 2);

/** The best map route in `repo` for a server span: methods agree (ANY matches all) and the paths match
 * after normalising params. A match that only works by reading a span's variable segment as a literal
 * route segment (a "guess") does not count. Ties go to the first routeKey in code-point order. */
function matchRoute(candidates: MapRoute[], method: string, path: string): MapRoute | undefined {
  let best: { route: MapRoute; match: PathMatch } | undefined;
  const callPath = normalizeRoutePath(path);
  for (const route of candidates) {
    if (!methodMatches(method as HttpMethod, route.method as HttpMethod)) continue;
    const match = matchPath(callPath, normalizeRoutePath(route.path));
    if (!match || match.confidence === "guess") continue;
    if (!best || match.literals > best.match.literals || (match.literals === best.match.literals && rank(match) < rank(best.match))) {
      best = { route, match };
    }
  }
  return best?.route;
}

/** The store a span touches, as "table:<name> <op>" / "queue:<dest> publish", or undefined. */
function storeOf(span: TraceSpan): { kind: "table"; table: string; op?: string } | { kind: "queue"; dest: string } | undefined {
  if (span.db?.table) return { kind: "table", table: span.db.table, op: span.db.op ? normalizeOp(span.db.op) : undefined };
  if (span.messaging && (span.kind === "producer" || /^(publish|send|create)$/i.test(span.messaging.op ?? ""))) {
    return { kind: "queue", dest: span.messaging.destination };
  }
  return undefined;
}

/** Compare runtime spans with the map. A server span with an HTTP method and a route (or path) belongs
 * to the repo `traces.services[service] ?? service`; matching a map route there confirms it. Spans
 * below a matched server span (same trace, up the parent chain, not crossing another server span) that
 * touch a table or publish to a queue are checked against the db / publish stops of that route's
 * chains. Every list is sorted with `compare`. */
export function compareTraces(chains: Chain[], ws: WorkspaceData, spans: TraceSpan[], source: "tempo" | "otlp-file"): TracesReport {
  const services = ws.traces?.kind === "tempo" ? (ws.traces.services ?? {}) : {};
  const repoIds = new Set(ws.repos.map((r) => r.ref.id));
  const repoOf = (service: string) => services[service] ?? service;

  const routes = mapRoutes(chains);
  const byRepo = new Map<string, MapRoute[]>();
  for (const route of [...routes.values()].sort((a, b) => compare(a.routeKey, b.routeKey))) {
    byRepo.set(route.repo, [...(byRepo.get(route.repo) ?? []), route]);
  }

  const children = new Map<string, TraceSpan[]>(); // `${traceId}/${parentSpanId}` → child spans
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const key = `${span.traceId}/${span.parentSpanId}`;
    children.set(key, [...(children.get(key) ?? []), span]);
  }
  const descendants = (server: TraceSpan): TraceSpan[] => {
    const out: TraceSpan[] = [];
    const seen = new Set<string>([server.spanId]);
    const queue = [server];
    while (queue.length > 0) {
      const span = queue.shift()!;
      for (const child of children.get(`${span.traceId}/${span.spanId}`) ?? []) {
        if (seen.has(child.spanId) || child.kind === "server") continue;
        seen.add(child.spanId);
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  };

  const hits = new Map<string, number>();
  const confirmedStores = new Map<string, Set<string>>();
  const missing = new Map<string, TracesReport["missingInMap"][number]>();
  const unmatched = new Set<string>();
  const bump = (key: string, item: TracesReport["missingInMap"][number]) => {
    const prev = missing.get(key);
    if (prev) prev.hits += 1;
    else missing.set(key, item);
  };

  for (const span of spans) if (!repoIds.has(repoOf(span.service))) unmatched.add(span.service);

  let serverSpans = 0;
  for (const span of spans) {
    if (span.kind !== "server") continue;
    serverSpans += 1;
    const path = span.http?.route ?? span.http?.path;
    if (!span.http?.method || !path) continue;
    const repo = repoOf(span.service);
    if (!repoIds.has(repo)) continue;
    const { method } = span.http;
    const route = matchRoute(byRepo.get(repo) ?? [], method, path);
    if (!route) {
      bump(`route\0${repo}\0${method}\0${path}`, { repo, kind: "route", method, route: path, hits: 1, detail: "served in traffic, but the map has no matching route" });
      continue;
    }
    hits.set(route.routeKey, (hits.get(route.routeKey) ?? 0) + 1);
    const stores = confirmedStores.get(route.routeKey) ?? new Set<string>();
    confirmedStores.set(route.routeKey, stores);
    const seenInTrace = new Set<string>();
    for (const child of descendants(span)) {
      const store = storeOf(child);
      if (!store) continue;
      const name = store.kind === "table" ? `table:${store.table}${store.op ? ` ${store.op}` : ""}` : `queue:${store.dest} publish`;
      if (seenInTrace.has(name)) continue;
      seenInTrace.add(name);
      const present = store.kind === "table" ? tableInMap(route, store.table, store.op) : queueInMap(route, store.dest);
      if (present) stores.add(name);
      else {
        bump(`store\0${route.routeKey}\0${name}`, {
          repo: route.repo, kind: "store", method: route.method, route: route.path, store: name, hits: 1,
          detail: `seen under ${route.routeKey}, but no chain from that route reaches it`,
        });
      }
    }
  }

  const sortKey = (m: TracesReport["missingInMap"][number]) => [m.repo, m.kind, m.method ?? "", m.route ?? "", m.store ?? ""].join("\0");
  return {
    source,
    spans: spans.length,
    serverSpans,
    confirmed: [...hits.entries()]
      .map(([routeKey, n]) => ({ routeKey, hits: n, stores: [...(confirmedStores.get(routeKey) ?? [])].sort(compare) }))
      .sort((a, b) => compare(a.routeKey, b.routeKey)),
    missingInMap: [...missing.values()].sort((a, b) => compare(sortKey(a), sortKey(b))),
    neverHit: [...routes.keys()].filter((k) => !hits.has(k)).sort(compare),
    unmatchedServices: [...unmatched].sort(compare),
  };
}
