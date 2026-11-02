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

/** Every api route stop of the chains. A chain's first route stop is keyed by the chain's own routeKey
 * (which carries any `@file#n` suffix); another route stop (a cross-repo call) by `${repo}:${label}`,
 * unless that plain key belongs to several suffixed routes, when it is skipped (its own chains key it).
 * A route's stores are the db / publish stops in the route's own repo between that route stop and the
 * next route or consume stop of the chain: later stops belong to another route or to a paired consumer. */
function mapRoutes(chains: Chain[]): Map<string, MapRoute> {
  const routes = new Map<string, MapRoute>();
  const suffixed = new Set(chains.flatMap((c) => {
    const at = c.routeKey.indexOf("@");
    return at < 0 ? [] : [c.routeKey.slice(0, at)];
  }));
  for (const chain of chains) {
    chain.stops.forEach((stop, i) => {
      if (stop.kind !== "route" || !stop.label) return;
      const space = stop.label.indexOf(" ");
      if (space < 0) return;
      const plain = `${stop.repo}:${stop.label}`;
      const ownKey = chain.routeKey === plain || chain.routeKey.startsWith(`${plain}@`);
      if (!ownKey && suffixed.has(plain)) return;
      const routeKey = ownKey ? chain.routeKey : plain;
      let route = routes.get(routeKey);
      if (!route) {
        route = { routeKey, repo: stop.repo, method: stop.label.slice(0, space), path: stop.label.slice(space + 1), tables: [], queues: [] };
        routes.set(routeKey, route);
      }
      for (let j = i + 1; j < chain.stops.length; j++) {
        const s = chain.stops[j]!;
        if (s.kind === "route" || s.kind === "consume") break;
        if (s.repo !== stop.repo || !s.label) continue;
        if (s.kind === "db") route.tables.push({ table: s.label, op: s.op ?? "" });
        if (s.kind === "publish" && !route.queues.includes(s.label)) route.queues.push(s.label);
      }
    });
  }
  return routes;
}

/** The map publish labels a trace queue destination names, best tier first: an exact label, then the
 * routing key of an `exchange:key` label, then (only when neither matched) its exchange. More than one
 * label at the winning tier is ambiguous. */
function queueMatches(route: MapRoute, dest: string): string[] {
  const exact = route.queues.filter((q) => q === dest);
  if (exact.length > 0) return exact;
  const sides = route.queues.flatMap((q) => {
    const sep = q.indexOf(":");
    return sep < 0 ? [] : [{ q, exchange: q.slice(0, sep), key: q.slice(sep + 1) }];
  });
  const byKey = sides.filter((x) => x.key === dest);
  if (byKey.length > 0) return byKey.map((x) => x.q);
  return sides.filter((x) => x.exchange === dest).map((x) => x.q);
}

function tableInMap(route: MapRoute, table: string, op: string | undefined): boolean {
  return route.tables.some((t) => t.table === table && (op === undefined || t.op === op));
}

const rank = (m: PathMatch) => (m.confidence === "exact" ? 0 : m.confidence === "param" ? 1 : 2);

/** The best map route in `repo` for a server span, ranked by: the exact method before ANY, then (like
 * the linker's pickRoute) most literal segments, then the better confidence. A match that only works
 * by reading a span's variable segment as a literal route segment (a "guess") does not count. A true
 * tie at the top confirms nothing: `ambiguous` lists the tied routeKeys. */
function matchRoute(candidates: MapRoute[], method: string, path: string): { route: MapRoute } | { ambiguous: string[] } | undefined {
  const callPath = normalizeRoutePath(path);
  const scored: Array<{ route: MapRoute; score: [number, number, number] }> = [];
  for (const route of candidates) {
    if (!methodMatches(method as HttpMethod, route.method as HttpMethod)) continue;
    const match = matchPath(callPath, normalizeRoutePath(route.path));
    if (!match || match.confidence === "guess") continue;
    scored.push({ route, score: [route.method === method ? 0 : 1, -match.literals, rank(match)] });
  }
  if (scored.length === 0) return undefined;
  const cmp = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  scored.sort((a, b) => cmp(a.score, b.score) || compare(a.route.routeKey, b.route.routeKey));
  const tied = scored.filter((s) => cmp(s.score, scored[0]!.score) === 0);
  return tied.length > 1 ? { ambiguous: tied.map((t) => t.route.routeKey) } : { route: scored[0]!.route };
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
 * below a matched server span (same trace, down the parent links) that touch a table or publish to a
 * queue are checked against that route's own db / publish stops. The walk stops at a nested server
 * span, a consumer span, or a span of another service: their work belongs to another route. Every list
 * is sorted with `compare`. */
export function compareTraces(chains: Chain[], ws: WorkspaceData, spans: TraceSpan[], source: "tempo" | "otlp-file"): TracesReport {
  // Both trace sources may carry a services map (Task 10 adds it to otlp-file); read it defensively.
  const services = (ws.traces as { services?: Record<string, string> } | undefined)?.services ?? {};
  const repoIds = new Set(ws.repos.map((r) => r.ref.id));
  const repoOf = (service: string) => services[service] ?? service;

  const routes = mapRoutes(chains);
  const byRepo = new Map<string, MapRoute[]>();
  for (const route of routes.values()) {
    const list = byRepo.get(route.repo);
    if (list) list.push(route);
    else byRepo.set(route.repo, [route]);
  }

  const children = new Map<string, TraceSpan[]>(); // `${traceId}/${parentSpanId}` → child spans
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const key = `${span.traceId}/${span.parentSpanId}`;
    const list = children.get(key);
    if (list) list.push(span);
    else children.set(key, [span]);
  }
  const descendants = (server: TraceSpan): TraceSpan[] => {
    const out: TraceSpan[] = [];
    const seen = new Set<string>([server.spanId]);
    const queue = [server];
    for (let head = 0; head < queue.length; head++) {
      const span = queue[head]!;
      for (const c of children.get(`${span.traceId}/${span.spanId}`) ?? []) {
        if (seen.has(c.spanId) || c.kind === "server" || c.kind === "consumer" || c.service !== server.service) continue;
        seen.add(c.spanId);
        out.push(c);
        queue.push(c);
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

  for (const span of spans) if (span.service !== "" && !repoIds.has(repoOf(span.service))) unmatched.add(span.service);

  let serverSpans = 0;
  for (const span of spans) {
    if (span.kind !== "server") continue;
    serverSpans += 1;
    const path = span.http?.route ?? span.http?.path;
    if (!span.http?.method || !path) continue;
    const repo = repoOf(span.service);
    if (!repoIds.has(repo)) continue;
    const { method } = span.http;
    const matched = matchRoute(byRepo.get(repo) ?? [], method, path);
    if (!matched || "ambiguous" in matched) {
      const detail = matched ? `ambiguous: matches ${matched.ambiguous.join(", ")}` : "served in traffic, but the map has no matching route";
      bump(`route\0${repo}\0${method}\0${path}`, { repo, kind: "route", method, route: path, hits: 1, detail });
      continue;
    }
    const { route } = matched;
    hits.set(route.routeKey, (hits.get(route.routeKey) ?? 0) + 1);
    let stores = confirmedStores.get(route.routeKey);
    if (!stores) confirmedStores.set(route.routeKey, (stores = new Set<string>()));
    const seenInTrace = new Set<string>();
    for (const c of descendants(span)) {
      const store = storeOf(c);
      if (!store) continue;
      const name = store.kind === "table" ? `table:${store.table}${store.op ? ` ${store.op}` : ""}` : `queue:${store.dest} publish`;
      if (seenInTrace.has(name)) continue;
      seenInTrace.add(name);
      let confirmedAs: string | undefined;
      let detail = "no chain from this route reaches it";
      if (store.kind === "table") {
        if (tableInMap(route, store.table, store.op)) confirmedAs = name;
      } else {
        const labels = queueMatches(route, store.dest);
        if (labels.length === 1) confirmedAs = `queue:${labels[0]} publish`;
        else if (labels.length > 1) detail = `ambiguous: matches ${labels.map((l) => `queue:${l}`).sort(compare).join(", ")}`;
      }
      if (confirmedAs) stores.add(confirmedAs);
      else {
        bump(`store\0${route.routeKey}\0${name}`, {
          repo: route.repo, kind: "store", method: route.method, route: route.path, store: name, hits: 1, detail,
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
