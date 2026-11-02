import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dataError } from "../../errors.js";
import { matchPath, methodMatches } from "../../linker/paths.js";
import { type JourneyOp, saveJourneys } from "../../store/journeys-edit.js";
import { type Chain, type ChainStop, type HttpMethod, HttpMethodSchema, type Lane } from "../../store/schemas.js";
import { compare } from "../../util.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { chainsTouchingNode, findNode, formatNodeRef, loadMapState, type MapState, parseNodeRef } from "../state.js";

// ---- shared views ------------------------------------------------------------------------------

/** A chain stop as tools show it: the hop flattened to confidence/reason, plus `ref` ("repo::nodeId") when
 * the stop sits on a graph node, ready for get_node / explain_context. */
function stopView(s: ChainStop): Record<string, unknown> {
  return {
    lane: s.lane, kind: s.kind, repo: s.repo, file: s.file, line: s.line, symbol: s.symbol,
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.op !== undefined ? { op: s.op } : {}),
    confidence: s.hop.confidence,
    ...(s.hop.reason !== undefined ? { reason: s.hop.reason } : {}),
    ...(s.nodeId !== undefined ? { ref: formatNodeRef({ repo: s.repo, nodeId: s.nodeId }) } : {}),
  };
}

/** chain id → ids of the journeys naming it (sorted). */
function journeyIndex(state: MapState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const j of [...state.journeys].sort((a, b) => compare(a.id, b.id))) {
    for (const c of j.chainIds) {
      const list = out.get(c) ?? [];
      if (!list.includes(j.id)) list.push(j.id);
      out.set(c, list);
    }
  }
  return out;
}

function chainView(c: Chain, journeys: Map<string, string[]>): Record<string, unknown> {
  return {
    id: c.id, name: c.name, entry: c.entry, routeKey: c.routeKey, confidence: c.confidence, complete: c.complete,
    journeys: journeys.get(c.id) ?? [], stops: c.stops.map(stopView), unresolved: c.unresolved,
  };
}

function sortedChains(state: MapState): Chain[] {
  return [...state.chains].sort((a, b) => compare(a.id, b.id));
}

// ---- list_chains -------------------------------------------------------------------------------

export interface ListChainsArgs {
  repo?: string;
  complete?: boolean;
  confidence?: "exact" | "param" | "guess";
  unnamed?: boolean;
  limit?: number;
  offset?: number;
}

export function listChains(start: string, args: ListChainsArgs): Record<string, unknown> {
  const state = loadMapState(start);
  if (args.repo !== undefined && !state.ws.repos.some((r) => r.ref.id === args.repo)) {
    throw dataError(`Unknown repo "${args.repo}". Repos in this workspace: ${state.ws.repos.map((r) => r.ref.id).join(", ")}.`);
  }
  const journeys = journeyIndex(state);
  const hits = sortedChains(state).filter(
    (c) =>
      (args.repo === undefined || c.stops.some((s) => s.repo === args.repo)) &&
      (args.complete === undefined || c.complete === args.complete) &&
      (args.confidence === undefined || c.confidence === args.confidence) &&
      (args.unnamed === undefined || args.unnamed === !journeys.has(c.id)),
  );
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  const page = hits.slice(offset, offset + limit);
  return { total: hits.length, chains: page.map((c) => chainView(c, journeys)), truncated: offset + page.length < hits.length };
}

// ---- get_journey -------------------------------------------------------------------------------

const LANES: Lane[] = ["ui", "api", "code", "db", "queue"];

export function getJourney(start: string, id: string): Record<string, unknown> {
  const state = loadMapState(start);
  const byId = new Map(state.chains.map((c) => [c.id, c]));
  let journey = null;
  let chains: Chain[];
  let missingChainIds: string[] = [];
  if (id.startsWith("j_")) {
    journey = state.journeys.find((j) => j.id === id) ?? null;
    if (!journey) throw dataError(`Unknown journey "${id}". list_chains shows chains and the journeys naming them.`);
    const chainIds = [...new Set(journey.chainIds)].sort(compare);
    chains = chainIds.flatMap((c) => byId.get(c) ?? []);
    missingChainIds = chainIds.filter((c) => !byId.has(c));
  } else if (id.startsWith("ch_")) {
    const chain = byId.get(id);
    if (!chain) throw dataError(`Unknown chain "${id}". list_chains shows every chain.`);
    chains = [chain];
  } else {
    throw dataError(`Unknown id "${id}": pass a journey id (j_…) or a chain id (ch_…).`);
  }

  const lanes: Record<string, Record<string, unknown>[]> = Object.fromEntries(LANES.map((l) => [l, []]));
  const seen = new Set<string>();
  const files = new Set<string>();
  const tables = new Set<string>();
  const queues = new Set<string>();
  for (const c of chains) {
    for (const s of c.stops) {
      files.add(`${s.repo}:${s.file}`);
      if (s.lane === "db" && s.label) tables.add(s.label);
      if (s.lane === "queue" && s.label) queues.add(s.label);
      const key = JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
      if (seen.has(key)) continue;
      seen.add(key);
      lanes[s.lane]!.push(stopView(s));
    }
  }
  const journeys = journeyIndex(state);
  return {
    journey,
    chains: chains.map((c) => chainView(c, journeys)),
    lanes,
    files: [...files].sort(compare),
    tables: [...tables].sort(compare),
    queues: [...queues].sort(compare),
    unresolved: chains.flatMap((c) => c.unresolved.map((u) => ({ chainId: c.id, ...u }))),
    missingChainIds,
  };
}

// ---- trace_route -------------------------------------------------------------------------------

const TRACE_LIMIT = 50;
const METHODS = new Set<string>(HttpMethodSchema.options);

type From =
  | { kind: "path"; method?: HttpMethod; path: string; repo?: string }
  | { kind: "table"; name: string; repo?: string }
  | { kind: "queue"; name: string; repo?: string }
  | { kind: "node"; ref: string };

/** `{id}` and `[id]` → `:id`; `[...slug]` / `[[...slug]]` → `:slug*` (the matcher's param/splat forms). */
export function normalisePath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      const splat = seg.match(/^\[\[?\.\.\.(.+?)\]?\]$/);
      if (splat) return `:${splat[1]}*`;
      const param = seg.match(/^\{(.+)\}$/) ?? seg.match(/^\[(.+)\]$/);
      return param ? `:${param[1]}` : seg;
    })
    .join("/");
}

/** `table:<name>` / `queue:<name>` (any repo), or the repo-qualified form `search` returns, `table:<repo>:<name>` /
 * `queue:<repo>:<name>` (that repo only). A queue label itself may contain ":" (`exchange:key`), so the segment
 * before the first ":" is only ever read as a repo id when it names a known repo; otherwise the whole remainder
 * is the name. Either form with a blank name is a tool error. */
function parseNamed(kind: "table" | "queue", rest: string, from: string, repoIds: Set<string>): From {
  const trimmed = rest.trim();
  if (!trimmed) throw dataError(`"${from}": the name after "${kind}:" is blank.`);
  const at = trimmed.indexOf(":");
  if (at >= 0) {
    const repo = trimmed.slice(0, at);
    const name = trimmed.slice(at + 1);
    if (repoIds.has(repo)) {
      if (!name) throw dataError(`"${from}": the name after "${kind}:${repo}:" is blank.`);
      return { kind, name, repo };
    }
  }
  return { kind, name: trimmed };
}

/** The refs `search` returns for routes and pages: "route:<repo>:<METHOD /path>" (matched in that repo
 * only) and "page:<repo>:<route>" (read as the bare "<route>"). Anything else → undefined. */
function parseSearchRef(s: string, from: string, repoIds: Set<string>): From | undefined {
  const m = s.match(/^(route|page):([^:]+):(.*)$/);
  if (!m) return undefined;
  const [, kind, repo, rest] = m as unknown as [string, "route" | "page", string, string];
  if (!repoIds.has(repo)) {
    throw dataError(`"${from}": unknown repo "${repo}". Repos in this workspace: ${[...repoIds].sort(compare).join(", ")}.`);
  }
  const f = parseFrom(rest, repoIds);
  if (f.kind !== "path") throw dataError(`"${from}": expected a route or page path after "${kind}:${repo}:".`);
  return kind === "route" ? { ...f, repo } : f;
}

function parseFrom(from: string, repoIds: Set<string>): From {
  const s = from.trim();
  const ref = parseSearchRef(s, from, repoIds);
  if (ref) return ref;
  const named = s.match(/^(table|queue):(.*)$/);
  if (named) return parseNamed(named[1] as "table" | "queue", named[2]!, from, repoIds);
  if (s.includes("::")) return { kind: "node", ref: s };
  const withMethod = s.match(/^([A-Za-z]+)\s+(\/\S*)$/);
  if (withMethod && METHODS.has(withMethod[1]!.toUpperCase())) {
    return { kind: "path", method: withMethod[1]!.toUpperCase() as HttpMethod, path: normalisePath(withMethod[2]!) };
  }
  if (s.startsWith("/") && !/\s/.test(s)) return { kind: "path", path: normalisePath(s) };
  throw dataError(
    `Cannot read "${from}". Use "METHOD /path", "/path", "table:<name>", "queue:<name>", "route:<repo>:<METHOD /path>", "page:<repo>:<route>" or a node reference "<repo>::<nodeId>".`,
  );
}

function pathMatches(fromPath: string, stopPath: string): boolean {
  const m = matchPath(fromPath, normalisePath(stopPath));
  return m !== null && m.confidence !== "guess";
}

/** A route stop's method and path: its label ("METHOD /path", the mounted route), else the chain's routeKey. */
function routeOf(c: Chain, s: ChainStop): { method: string; path: string } | undefined {
  const text = s.label ?? c.routeKey.slice(c.routeKey.indexOf(":") + 1);
  const m = text.match(/^(\S+)\s+(\/.*)$/);
  return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : undefined;
}

/** A page stop's route: the repo's endpoints.json page for that file, else the chain entry "page:<repo>:<route>". */
function pageRouteOf(state: MapState, c: Chain, s: ChainStop): string | undefined {
  const repo = state.ws.repos.find((r) => r.ref.id === s.repo);
  const page = repo?.endpoints.pages.find((p) => p.file === s.file);
  if (page) return page.route;
  const prefix = `page:${s.repo}:`;
  return c.entry.startsWith(prefix) ? c.entry.slice(prefix.length) : undefined;
}

function queueMatches(label: string | undefined, name: string): boolean {
  return label !== undefined && (label === name || label.endsWith(`:${name}`));
}

export function traceRoute(start: string, from: string): Record<string, unknown> {
  const state = loadMapState(start);
  const repoIds = new Set(state.ws.repos.map((r) => r.ref.id));
  const f = parseFrom(from, repoIds);
  let hits: Chain[];
  if (f.kind === "node") {
    const ref = parseNodeRef(f.ref);
    findNode(state, ref);
    hits = chainsTouchingNode(state, ref);
  } else {
    hits = sortedChains(state).filter((c) =>
      c.stops.some((s) => {
        switch (f.kind) {
          case "table":
            return (f.repo === undefined || s.repo === f.repo) && s.lane === "db" && s.label === f.name;
          case "queue":
            return (f.repo === undefined || s.repo === f.repo) && s.lane === "queue" && queueMatches(s.label, f.name);
          case "path": {
            if (f.repo !== undefined && s.repo !== f.repo) return false;
            if (s.kind === "route") {
              const r = routeOf(c, s);
              return r !== undefined && (f.method === undefined || methodMatches(f.method, r.method as HttpMethod)) && pathMatches(f.path, r.path);
            }
            if (s.kind === "page" && f.method === undefined) {
              const route = pageRouteOf(state, c, s);
              return route !== undefined && pathMatches(f.path, route);
            }
            return false;
          }
        }
      }),
    );
  }
  return {
    from,
    matches: hits.slice(0, TRACE_LIMIT).map((c) => ({ chainId: c.id, name: c.name, stops: c.stops.map(stopView) })),
    truncated: hits.length > TRACE_LIMIT,
  };
}

// ---- save_journeys -----------------------------------------------------------------------------

const nameArg = z.string().min(1).max(200);
const textArg = z.string().max(2000);
const chainIdsArg = z.array(z.string().min(1)).min(1).max(500);
const JourneyOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: nameArg, area: textArg.optional(), note: textArg.optional(), chainIds: chainIdsArg }),
  z.object({ op: z.literal("update"), id: z.string(), name: nameArg.optional(), area: textArg.optional(), note: textArg.optional() }),
  z.object({ op: z.literal("merge"), ids: z.array(z.string()).min(2).max(100), name: nameArg, area: textArg.optional(), note: textArg.optional() }),
  z.object({
    op: z.literal("split"),
    id: z.string(),
    parts: z.array(z.object({ name: nameArg, area: textArg.optional(), note: textArg.optional(), chainIds: chainIdsArg })).min(2).max(100),
  }),
  z.object({ op: z.literal("delete"), id: z.string() }),
]);

export function saveJourneysTool(start: string, ops: JourneyOp[]): Record<string, unknown> {
  return { ...saveJourneys(loadMapState(start), ops) };
}

// ---- registration ------------------------------------------------------------------------------

export function registerJourneyTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "list_chains",
    {
      title: "List chains",
      description:
        "Request chains found in the code: each one runs from an entry (a UI page, an API route or a queue consumer) " +
        "through ui → api → code → db / queue stops. Filter by repo, completeness, confidence, or `unnamed: true` for " +
        "chains no journey names yet. Sorted by id; page with limit/offset.",
      inputSchema: {
        repo: z.string().optional(),
        complete: z.boolean().optional(),
        confidence: z.enum(["exact", "param", "guess"]).optional(),
        unnamed: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
    },
    withErrors((args: ListChainsArgs) => listChains(opts.start, args)),
  );

  server.registerTool(
    "get_journey",
    {
      title: "Get journey",
      description:
        "One user journey (id j_…) or one chain (id ch_…) laid out by lane: its chains, the ui / api / code / db / " +
        "queue stops (shared stops shown once), the files, tables and queues it touches, and what the linker could not resolve.",
      inputSchema: { id: z.string().min(1).describe("A journey id (j_…) or a chain id (ch_…).") },
    },
    withErrors((args: { id: string }) => getJourney(opts.start, args.id)),
  );

  server.registerTool(
    "trace_route",
    {
      title: "Trace route",
      description:
        'Find the chains that pass through a point: "METHOD /path" or "/path" (an API route in any repo, or a UI page ' +
        'route; :id, {id} and [id] are treated alike, and concrete values like /users/42 match), "table:<name>" or ' +
        '"table:<repo>:<name>", "queue:<name>" or "queue:<repo>:<name>" (the repo-qualified forms, as `search` returns ' +
        'them, restrict matching to that repo), the route/page refs `search` returns ("route:<repo>:<METHOD /path>", ' +
        'that repo only; "page:<repo>:<route>"), or a node reference "<repo>::<nodeId>". At most 50 chains.',
      inputSchema: { from: z.string().min(1).max(500) },
    },
    withErrors((args: { from: string }) => traceRoute(opts.start, args.from)),
  );

  server.registerTool(
    "save_journeys",
    {
      title: "Save journeys",
      description:
        "Name and organise user journeys in .codeloom/journeys.json (committed with the code). Ops run in order, all or " +
        "nothing: create {name, area?, note?, chainIds}, update {id, name?, area?, note?}, merge {ids (≥2), name, …}, " +
        "split {id, parts: [{name, chainIds}, …] covering the journey's chains with no overlap}, delete {id}. A journey's " +
        "id comes from its chain ids and never changes; merge and split make new journeys and delete the old ones. " +
        "Unknown extra keys on a journey in journeys.json are not kept — the file is rewritten from the known fields.",
      inputSchema: { ops: z.array(JourneyOpSchema).min(1).max(100) },
    },
    withErrors((args: { ops: JourneyOp[] }) => saveJourneysTool(opts.start, args.ops)),
  );
}
