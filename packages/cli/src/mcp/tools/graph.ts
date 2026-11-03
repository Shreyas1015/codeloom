import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type GraphNode, SearchEngine } from "@codeloom/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dataError } from "../../errors.js";
import type { RepoData } from "../../store/read.js";
import { readSummaries, writeSummary } from "../../store/summaries.js";
import { compare } from "../../util.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { chainsTouchingNode, findNode, formatNodeRef, journeysForChains, loadMapState, type MapState, parseNodeRef } from "../state.js";

// ---- search -----------------------------------------------------------------------------------

export const SEARCH_KINDS = ["file", "function", "class", "route", "page", "table", "queue", "journey", "chain"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchArgs {
  query: string;
  kinds?: SearchKind[];
  repo?: string;
  limit?: number;
}

interface SearchHit {
  kind: string;
  ref: string;
  name: string;
  repo?: string;
  file?: string;
  line?: number;
  score: number;
}

/** What a search hit points at, kept beside the synthetic GraphNode the engine indexes. */
type HitInfo = Omit<SearchHit, "score">;

/** Fuse matches everything; we only need far more candidates than any limit (max 100). */
const ENGINE_LIMIT = 100_000;
const roundScore = (s: number) => Math.round(s * 10_000) / 10_000;

function syntheticNode(id: string, name: string, extra: string[] = []): GraphNode {
  return { id, type: "concept", name, summary: extra.join(" "), tags: [], complexity: "simple" };
}

function repoOrThrow(state: MapState, repo: string): RepoData {
  const found = state.ws.repos.find((r) => r.ref.id === repo);
  if (!found) {
    const ids = state.ws.repos.map((r) => r.ref.id).join(", ");
    throw dataError(`Unknown repo "${repo}". Repos in this workspace: ${ids}.`);
  }
  return found;
}

/** Route keys as the linker wrote them (mounts applied), indexed by where the route is declared. */
function routeKeysByLocation(state: MapState): Map<string, string> {
  const out = new Map<string, string>();
  for (const chain of state.chains) {
    for (const stop of chain.stops) {
      if (stop.kind === "route" && stop.label) out.set(`${stop.repo}\0${stop.file}\0${stop.line}`, `${stop.repo}:${stop.label}`);
    }
  }
  return out;
}

/** Routes, pages, tables, queues, journeys and chains as searchable synthetic nodes. */
function syntheticEntries(state: MapState, repos: RepoData[], repoFilter?: string): Map<string, { node: GraphNode; info: HitInfo }> {
  const out = new Map<string, { node: GraphNode; info: HitInfo }>();
  const add = (info: HitInfo, extra: string[] = []) => {
    if (!out.has(info.ref)) out.set(info.ref, { node: syntheticNode(info.ref, info.name, extra), info });
  };
  const routeKeys = routeKeysByLocation(state);
  for (const r of repos) {
    const repo = r.ref.id;
    const e = r.endpoints;
    for (const route of e.routes) {
      const key = routeKeys.get(`${repo}\0${route.at.file}\0${route.at.line}`) ?? `${repo}:${route.method} ${route.path}`;
      add({ kind: "route", ref: `route:${key}`, name: key.slice(repo.length + 1), repo, file: route.at.file, line: route.at.line }, [route.handler]);
    }
    for (const page of e.pages) {
      add({ kind: "page", ref: `page:${repo}:${page.route}`, name: page.route, repo, file: page.file, line: page.line }, page.component ? [page.component.name] : []);
    }
    const tableLocs = [
      ...e.tables.map((t) => ({ name: t.name, file: t.file, line: t.line })),
      ...e.dbAccess.flatMap((a) => (a.table ? [{ name: a.table, file: a.at.file, line: a.at.line }] : [])),
    ];
    for (const t of tableLocs) add({ kind: "table", ref: `table:${repo}:${t.name}`, name: t.name, repo, file: t.file, line: t.line });
    for (const q of e.queues) add({ kind: "queue", ref: `queue:${repo}:${q.queue}`, name: q.queue, repo, file: q.at.file, line: q.at.line });
  }
  const chains = repoFilter === undefined ? state.chains : state.chains.filter((c) => c.stops.some((s) => s.repo === repoFilter));
  for (const c of chains) add({ kind: "chain", ref: c.id, name: c.name }, [c.routeKey, c.entry]);
  const chainIds = new Set(chains.map((c) => c.id));
  const journeys = repoFilter === undefined ? state.journeys : journeysForChains(state, chainIds);
  for (const j of journeys) add({ kind: "journey", ref: j.id, name: j.name }, [j.area, j.note]);
  return out;
}

/** search: graph nodes (file/function/class, with saved summaries) via core SearchEngine, plus routes,
 * pages, tables, queues, journeys and chains via a SearchEngine over synthetic nodes. */
export function search(start: string, args: SearchArgs): Record<string, unknown> {
  const state = loadMapState(start);
  const repos = args.repo === undefined ? state.ws.repos : [repoOrThrow(state, args.repo)];
  const kinds = new Set<string>(args.kinds && args.kinds.length > 0 ? args.kinds : SEARCH_KINDS);
  const limit = args.limit ?? 20;
  const hits: SearchHit[] = [];

  const graphNodes: GraphNode[] = [];
  const graphInfo = new Map<string, HitInfo>();
  for (const r of repos) {
    const summaries = readSummaries(r.abs);
    for (const n of r.graph.nodes) {
      if (!kinds.has(n.type)) continue;
      const ref = formatNodeRef({ repo: r.ref.id, nodeId: n.id });
      const saved = Object.hasOwn(summaries, n.id) ? summaries[n.id]! : "";
      graphNodes.push({ ...n, id: ref, summary: [n.summary, saved].filter(Boolean).join(" ") });
      graphInfo.set(ref, {
        kind: n.type,
        ref,
        name: n.name,
        repo: r.ref.id,
        ...(n.filePath !== undefined ? { file: n.filePath } : {}),
        ...(n.lineRange ? { line: n.lineRange[0] } : {}),
      });
    }
  }
  for (const res of new SearchEngine(graphNodes).search(args.query, { limit: ENGINE_LIMIT })) {
    hits.push({ ...graphInfo.get(res.nodeId)!, score: roundScore(res.score) });
  }

  const synthetic = [...syntheticEntries(state, repos, args.repo).values()].filter((s) => kinds.has(s.info.kind));
  const synthInfo = new Map(synthetic.map((s) => [s.info.ref, s.info]));
  for (const res of new SearchEngine(synthetic.map((s) => s.node)).search(args.query, { limit: ENGINE_LIMIT })) {
    hits.push({ ...synthInfo.get(res.nodeId)!, score: roundScore(res.score) });
  }

  hits.sort((a, b) => a.score - b.score || compare(a.ref, b.ref));
  return { results: hits.slice(0, limit), truncated: hits.length > limit };
}

// ---- node details -----------------------------------------------------------------------------

/** The layer holding the node. Layers list file nodes only, so a function or class takes its file's layer. */
function layerOf(repo: RepoData, node: GraphNode): string | undefined {
  const ids = [node.id, ...(node.filePath !== undefined ? [`file:${node.filePath}`] : [])];
  for (const id of ids) {
    const layer = repo.graph.layers.find((l) => l.nodeIds.includes(id));
    if (layer) return layer.id;
  }
  return undefined;
}

function nodeView(repo: RepoData, node: GraphNode): Record<string, unknown> {
  const layer = layerOf(repo, node);
  return {
    type: node.type,
    name: node.name,
    ...(node.filePath !== undefined ? { filePath: node.filePath } : {}),
    ...(node.lineRange ? { lineRange: node.lineRange } : {}),
    ...(layer !== undefined ? { layer } : {}),
  };
}

function savedSummary(repo: RepoData, node: GraphNode): string | null {
  const summaries = readSummaries(repo.abs);
  if (Object.hasOwn(summaries, node.id)) return summaries[node.id]!;
  return node.summary ? node.summary : null;
}

function chainsAndJourneys(state: MapState, ref: { repo: string; nodeId: string }) {
  const chains = chainsTouchingNode(state, ref).map((c) => c.id);
  const journeys = journeysForChains(state, new Set(chains)).map((j) => ({ id: j.id, name: j.name }));
  return { chains, journeys };
}

const EDGE_CAP = 100;

/** get_node: one graph node, its saved summary, its edges (≤ 100 each way), and the chains and
 * journeys it takes part in. */
export function getNode(start: string, nodeRef: string): Record<string, unknown> {
  const state = loadMapState(start);
  const ref = parseNodeRef(nodeRef);
  const { repo, node } = findNode(state, ref);
  const toRef = (id: string) => formatNodeRef({ repo: ref.repo, nodeId: id });
  const out = repo.graph.edges
    .filter((e) => e.source === node.id)
    .map((e) => ({ type: e.type, target: toRef(e.target) }))
    .sort((a, b) => compare(a.type, b.type) || compare(a.target, b.target));
  const inn = repo.graph.edges
    .filter((e) => e.target === node.id)
    .map((e) => ({ type: e.type, source: toRef(e.source) }))
    .sort((a, b) => compare(a.type, b.type) || compare(a.source, b.source));
  return {
    ref: formatNodeRef(ref),
    node: nodeView(repo, node),
    summary: savedSummary(repo, node),
    edges: { out: out.slice(0, EDGE_CAP), in: inn.slice(0, EDGE_CAP), truncated: out.length > EDGE_CAP || inn.length > EDGE_CAP },
    ...chainsAndJourneys(state, ref),
  };
}

// ---- neighbors --------------------------------------------------------------------------------

export interface NeighborsArgs {
  node: string;
  direction?: "in" | "out" | "both";
  depth?: number;
  edgeTypes?: string[];
  limit?: number;
}

interface Neighbor {
  ref: string;
  name: string;
  type: string;
  depth: number;
  via: { type: string; direction: "in" | "out" };
}

/** Breadth-first walk over one repo's graph edges. Each node keeps the depth (and edge) it was first
 * reached by; the frontier is walked in id order and each node's edges in (type, other id) order, so
 * the result is the same on every run. Sorted by depth then ref; the root itself is not listed. */
function neighbors(repo: RepoData, rootId: string, args: Required<Omit<NeighborsArgs, "node" | "edgeTypes">> & { edgeTypes?: string[] }) {
  const types = args.edgeTypes && args.edgeTypes.length > 0 ? new Set(args.edgeTypes) : undefined;
  const nodes = new Map(repo.graph.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Array<{ other: string; type: string; direction: "in" | "out" }>>();
  const push = (from: string, other: string, type: string, direction: "in" | "out") => {
    const list = adj.get(from) ?? [];
    list.push({ other, type, direction });
    adj.set(from, list);
  };
  for (const e of repo.graph.edges) {
    if (types && !types.has(e.type)) continue;
    if (args.direction !== "in") push(e.source, e.target, e.type, "out");
    if (args.direction !== "out") push(e.target, e.source, e.type, "in");
  }
  for (const list of adj.values()) {
    list.sort((a, b) => compare(a.type, b.type) || compare(a.other, b.other) || compare(a.direction, b.direction));
  }
  const seen = new Set([rootId]);
  const found: Array<Neighbor & { id: string }> = [];
  let frontier = [rootId];
  for (let depth = 1; depth <= args.depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adj.get(id) ?? []) {
        if (seen.has(edge.other)) continue;
        seen.add(edge.other);
        next.push(edge.other);
        const n = nodes.get(edge.other);
        found.push({
          id: edge.other,
          ref: formatNodeRef({ repo: repo.ref.id, nodeId: edge.other }),
          name: n?.name ?? edge.other,
          type: n?.type ?? "unknown",
          depth,
          via: { type: edge.type, direction: edge.direction },
        });
      }
    }
    frontier = next.sort(compare);
  }
  found.sort((a, b) => a.depth - b.depth || compare(a.ref, b.ref));
  const list = found.slice(0, args.limit).map(({ id: _id, ...rest }) => rest);
  return { neighbors: list, truncated: found.length > args.limit };
}

/** get_neighbors: the nodes around one node, up to `depth` hops, following edges in `direction`. */
export function getNeighbors(start: string, args: NeighborsArgs): Record<string, unknown> {
  const state = loadMapState(start);
  const ref = parseNodeRef(args.node);
  const { repo, node } = findNode(state, ref);
  const result = neighbors(repo, node.id, {
    direction: args.direction ?? "both",
    depth: args.depth ?? 1,
    limit: args.limit ?? 100,
    edgeTypes: args.edgeTypes,
  });
  return { root: formatNodeRef(ref), ...result };
}

// ---- explain_context --------------------------------------------------------------------------

interface CodeSlice {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

/** The node's source lines (the whole file for a file node), cut to maxChars. A node with no file, a
 * file outside the repo, or a file that cannot be read → { code: null, reason }. */
function codeOf(repo: RepoData, node: GraphNode, maxChars: number): { code: CodeSlice | null; reason?: string } {
  if (!node.filePath) return { code: null, reason: `Node "${node.id}" has no source file.` };
  const abs = resolve(repo.abs, node.filePath);
  const rel = relative(repo.abs, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return { code: null, reason: `${node.filePath} is outside repo "${repo.ref.id}".` };
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (err) {
    const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "cannot be read";
    return { code: null, reason: `${node.filePath} ${why} in repo "${repo.ref.id}" (the map may be stale; run reindex).` };
  }
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  const startLine = node.type === "file" || !node.lineRange ? 1 : node.lineRange[0];
  const lastLine = node.type === "file" || !node.lineRange ? lines.length : Math.min(node.lineRange[1], lines.length);
  const full = lines.slice(startLine - 1, lastLine).join("\n");
  const truncated = full.length > maxChars;
  const text = truncated ? full.slice(0, maxChars) : full;
  const endLine = truncated ? startLine + text.split("\n").length - 1 : Math.max(startLine, lastLine);
  return { code: { file: node.filePath, startLine, endLine, text, truncated } };
}

const EXPLAIN_NEIGHBORS = 30;

/** explain_context: everything an agent needs to explain one node in a single call. */
export function explainContext(start: string, nodeRef: string, maxChars = 12_000): Record<string, unknown> {
  const state = loadMapState(start);
  const ref = parseNodeRef(nodeRef);
  const { repo, node } = findNode(state, ref);
  const { code, reason } = codeOf(repo, node, maxChars);
  const near = neighbors(repo, node.id, { direction: "both", depth: 1, limit: EXPLAIN_NEIGHBORS });
  return {
    ref: formatNodeRef(ref),
    node: nodeView(repo, node),
    summary: savedSummary(repo, node),
    layer: layerOf(repo, node) ?? null,
    code,
    ...(reason !== undefined ? { codeUnavailable: reason } : {}),
    neighbors: near.neighbors,
    neighborsTruncated: near.truncated,
    ...chainsAndJourneys(state, ref),
  };
}

// ---- save_summary -----------------------------------------------------------------------------

/** save_summary: store (or, with empty text, remove) an agent-written summary for one graph node in
 * <repo>/.codeloom/summaries.json. The node must exist. */
export function saveSummary(start: string, nodeRef: string, summary: string): Record<string, unknown> {
  const state = loadMapState(start);
  const ref = parseNodeRef(nodeRef);
  const { repo, node } = findNode(state, ref);
  const text = summary.trim();
  const had = Object.hasOwn(readSummaries(repo.abs), node.id);
  const changed = writeSummary(repo.abs, node.id, text);
  return { ref: formatNodeRef(ref), saved: text !== "" && changed, removed: text === "" && had };
}

// ---- registration -----------------------------------------------------------------------------

const nodeArg = z.string().min(1).describe('A node reference "<repo>::<nodeId>", as returned by search or get_neighbors.');

export function registerGraphTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "search",
    {
      title: "Search the map",
      description:
        "Fuzzy search across the whole map: files, functions and classes (graph nodes, including saved summaries), " +
        "API routes, UI pages, database tables, queues, named journeys and request chains. Each result has a `ref` " +
        'to pass to other tools: "repo::nodeId" for graph nodes, "route:<repo>:<METHOD /path>", "page:<repo>:<route>", ' +
        '"table:<repo>:<name>", "queue:<repo>:<name>", or a journey / chain id. Best match first.',
      inputSchema: {
        query: z.string().min(1).max(200),
        kinds: z.array(z.enum(SEARCH_KINDS)).optional(),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    withErrors((args: SearchArgs) => search(opts.start, args)),
  );

  server.registerTool(
    "get_node",
    {
      title: "Get node",
      description:
        "One graph node (file, function or class): its type, name, file, lines and layer, its saved summary, its " +
        "incoming and outgoing edges, and the request chains and journeys it takes part in.",
      inputSchema: { node: nodeArg },
    },
    withErrors((args: { node: string }) => getNode(opts.start, args.node), "Call get_neighbors with a limit for its edges, or list_chains for its chains."),
  );

  server.registerTool(
    "get_neighbors",
    {
      title: "Get neighbors",
      description:
        "The nodes around one node, up to `depth` hops away (1-3), following edges in `direction` " +
        '("out" = what it contains/imports/calls, "in" = what contains/imports/calls it). Optionally only some edge types.',
      inputSchema: {
        node: nodeArg,
        direction: z.enum(["in", "out", "both"]).default("both"),
        depth: z.number().int().min(1).max(3).default(1),
        edgeTypes: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    withErrors((args: NeighborsArgs) => getNeighbors(opts.start, args), "Use a smaller limit or depth, one direction, or only some edgeTypes."),
  );

  server.registerTool(
    "explain_context",
    {
      title: "Explain context",
      description:
        "Everything needed to explain one node in a single call: the node, its saved summary and layer, its source " +
        "code (cut to maxChars), its direct neighbors, and the chains and journeys it takes part in. Pair with " +
        "save_summary to record what you learn.",
      inputSchema: { node: nodeArg, maxChars: z.number().int().min(1000).max(60000).default(12000) },
    },
    withErrors((args: { node: string; maxChars?: number }) => explainContext(opts.start, args.node, args.maxChars), "Use a smaller maxChars, or call get_node / get_neighbors."),
  );

  server.registerTool(
    "save_summary",
    {
      title: "Save summary",
      description:
        "Save a short plain-language summary of one node to the repo's .codeloom/summaries.json (committed with the " +
        "code, shown by get_node / explain_context and used by search). An empty summary removes the saved one.",
      inputSchema: { node: nodeArg, summary: z.string().max(4000) },
    },
    withErrors((args: { node: string; summary: string }) => saveSummary(opts.start, args.node, args.summary)),
  );
}
