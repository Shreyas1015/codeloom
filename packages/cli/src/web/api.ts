import { readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GraphNode, KnowledgeGraph } from "@codeloom/core";
import { mcpEntryState } from "../commands/init.js";
import { CodeloomError } from "../errors.js";
import { chainReach } from "../linker/completeness.js";
import { chainLookup, formatNodeRef, journeysByChain, loadMapState, type MapState } from "../mcp/state.js";
import { getNeighbors, getNode, type NeighborsArgs, search, type SearchArgs, SEARCH_KINDS, type SearchKind } from "../mcp/tools/graph.js";
import { getJourney, listChains, type ListChainsArgs } from "../mcp/tools/journeys.js";
import { getLayers, indexStatusAsync, workspaceOverview } from "../mcp/tools/workspace.js";
import type { Chain } from "../store/schemas.js";
import { compare } from "../util.js";
import { loadWorkspace } from "../workspace/repos.js";
import type {
  ChainRow,
  ChainsResult,
  CodeResponse,
  Confidence,
  GraphEdgeAgg,
  GraphFile,
  GraphFolder,
  GraphLevel,
  JourneyResult,
  JourneyRow,
  JourneysResponse,
  Lane,
  LayersResult,
  NeighborsResult,
  NodeResult,
  OverviewResponse,
  SearchResult,
} from "./api-types.js";
import { sendJson } from "./http.js";

/** An error with an HTTP status, thrown by a route handler (bad query → 400, unknown id → 404). */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (code) this.code = code;
  }
}

/** What a route handler gets: the workspace start folder, the parsed URL (for query params) and the
 * `:name` path params, already URL-decoded. */
export interface ApiContext {
  start: string;
  url: URL;
  params: Record<string, string>;
}

export type ApiHandler = (ctx: ApiContext) => unknown | Promise<unknown>;

/** One GET route: `path` is a pattern like "/api/journeys/:id" (a `:name` segment matches one
 * non-empty path segment). Every route returns JSON; the SSE stream is handled by the server. */
export interface ApiRoute {
  path: string;
  handler: ApiHandler;
}

/** /api/overview: workspaceOverview & { indexStatus, mcpConnected } — mcpConnected is whether .mcp.json
 * at the workspace root has a codeloom entry (the same read-only check `codeloom doctor` uses). The git
 * calls behind indexStatus run async (execFile), so a slow git never blocks other requests. */
export async function overview(start: string): Promise<OverviewResponse> {
  const base = workspaceOverview(start);
  const root = loadWorkspace(start).root;
  const mcp = mcpEntryState(root);
  return { ...as<OverviewResponse>(base), indexStatus: await indexStatusAsync(start), mcpConnected: mcp === "present" || mcp === "kept-custom" };
}

// ---- query params (a bad value → 400) -------------------------------------------------------------

function strParam(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v === null || v === "" ? undefined : v;
}

function requiredParam(url: URL, name: string): string {
  const v = strParam(url, name);
  if (v === undefined) throw new HttpError(400, `Bad request: the "${name}" query parameter is required.`);
  return v;
}

function intParam(url: URL, name: string, min: number, max: number): number | undefined {
  const v = strParam(url, name);
  if (v === undefined) return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new HttpError(400, `Bad "${name}": expected a whole number from ${min} to ${max}, got "${v}".`);
  }
  return n;
}

function boolParam(url: URL, name: string): boolean | undefined {
  const v = strParam(url, name);
  if (v === undefined) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new HttpError(400, `Bad "${name}": expected true or false, got "${v}".`);
}

function enumParam<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const v = strParam(url, name);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new HttpError(400, `Bad "${name}": expected one of ${allowed.join(", ")}, got "${v}".`);
  return v as T;
}

/** A comma-separated (and/or repeated) list param; empty items dropped. */
function listParam(url: URL, name: string): string[] | undefined {
  const items = url.searchParams.getAll(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

// ---- /api/journeys: JourneyRow / ChainRow ---------------------------------------------------------

const RANK: Record<Confidence, number> = { exact: 0, param: 1, guess: 2 };
const worst = (a: Confidence, b: Confidence): Confidence => (RANK[b] > RANK[a] ? b : a);
const sortedSet = (xs: Iterable<string>) => [...new Set(xs)].sort(compare);

/** H3: reaches a store but has no UI stop ("API → DB"). Never true for a complete chain. */
function isApiOnly(c: Chain): boolean {
  return !c.complete && chainReach(c.stops) === "api-only";
}

function chainRow(c: Chain): ChainRow {
  return {
    id: c.id, name: c.name, entry: c.entry, confidence: c.confidence, complete: c.complete, apiOnly: isApiOnly(c),
    repos: sortedSet(c.stops.map((s) => s.repo)),
  };
}

/** Home's lists: every journey summarised over its chains (stops deduped the way get_journey does),
 * sorted by name then id; and the chains no journey names, sorted by id. */
export function journeyRows(state: Pick<MapState, "chains" | "journeys">): JourneysResponse {
  const lookup = chainLookup(state.chains);
  const journeys = state.journeys.map((j): JourneyRow => {
    const chainIds = sortedSet(j.chainIds);
    // H11: ids first, then aliases — a chain that gained a UI step still counts as present.
    const resolved = lookup.resolve(chainIds);
    const chains = resolved.chains;
    const stops: Record<Lane, number> = { ui: 0, api: 0, code: 0, db: 0, queue: 0 };
    const seen = new Set<string>();
    const repos = new Set<string>();
    const tables = new Set<string>();
    let confidence: Confidence = "exact";
    for (const c of chains) {
      confidence = worst(confidence, c.confidence);
      for (const s of c.stops) {
        repos.add(s.repo);
        if (s.lane === "db" && s.label) tables.add(s.label);
        const key = JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
        if (seen.has(key)) continue;
        seen.add(key);
        stops[s.lane]++;
      }
    }
    const allPresent = chains.length > 0 && resolved.missing.length === 0;
    const complete = allPresent && chains.every((c) => c.complete);
    return {
      id: j.id, name: j.name, area: j.area, note: j.note, status: j.status, chainIds,
      repos: sortedSet(repos), stops, confidence, complete,
      apiOnly: !complete && allPresent && chains.every((c) => c.complete || isApiOnly(c)),
      tables: sortedSet(tables),
    };
  });
  journeys.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
  const named = journeysByChain(state);
  const unnamedChains = state.chains.filter((c) => !named.has(c.id)).sort((a, b) => compare(a.id, b.id)).map(chainRow);
  return { journeys, unnamedChains };
}

// ---- /api/graph: GraphLevel -----------------------------------------------------------------------

const LEVEL_EDGE_TYPES = new Set(["imports", "calls"]);

/** One folder level of one repo's graph: its direct child folders (recursive file counts, a layer when
 * every file under the folder shares one), its direct files (with the functions/classes in each — by
 * `contains` edge or filePath — and the journeys with a stop in it), and the imports/calls edges between
 * those children, aggregated per (from, to, type) with counts. `dir` "" (or "/") = the repo root; a
 * folder holding no indexed file → 404. */
export function graphLevel(
  repo: { id: string; graph: Pick<KnowledgeGraph, "nodes" | "edges" | "layers"> },
  state: Pick<MapState, "chains" | "journeys">,
  dirArg: string,
): GraphLevel {
  const dir = dirArg.replace(/^\/+|\/+$/g, "");
  const prefix = dir === "" ? "" : `${dir}/`;
  const { nodes, edges, layers } = repo.graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fileNodes = nodes.filter((n) => n.type === "file");
  const pathOf = (n: GraphNode) => n.filePath ?? n.id.replace(/^file:/, "");
  const layerOf = new Map<string, string>();
  for (const l of layers) for (const id of l.nodeIds) if (!layerOf.has(id)) layerOf.set(id, l.id);

  if (dir !== "" && !fileNodes.some((n) => pathOf(n).startsWith(prefix))) {
    throw new HttpError(404, `Unknown folder "${dir}" in repo "${repo.id}".`);
  }
  /** The child of this level holding `path`: a direct file (key = its path) or a child folder (key = folder path). */
  const childOf = (path: string): { kind: "file" | "folder"; key: string } | null => {
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    const at = rest.indexOf("/");
    return at < 0 ? { kind: "file", key: path } : { kind: "folder", key: prefix + rest.slice(0, at) };
  };

  // journeys per file in this repo
  const journeysOfChain = journeysByChain(state);
  const journeysOfFile = new Map<string, Set<string>>();
  for (const c of state.chains) {
    const js = journeysOfChain.get(c.id);
    if (!js) continue;
    for (const s of c.stops) {
      if (s.repo !== repo.id) continue;
      const set = journeysOfFile.get(s.file) ?? new Set<string>();
      for (const j of js) set.add(j);
      journeysOfFile.set(s.file, set);
    }
  }

  // functions/classes per file: by `contains` edge from the file node, or by filePath
  const membersOf = new Map<string, Map<string, GraphNode>>();
  const addMember = (path: string, n: GraphNode) => {
    if (n.type !== "function" && n.type !== "class") return;
    const m = membersOf.get(path) ?? new Map<string, GraphNode>();
    m.set(n.id, n);
    membersOf.set(path, m);
  };
  for (const n of nodes) if (n.filePath !== undefined) addMember(n.filePath, n);
  for (const e of edges) {
    if (e.type !== "contains") continue;
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    if (from?.type === "file" && to) addMember(pathOf(from), to);
  }

  const folders = new Map<string, { files: number; layers: Set<string> }>();
  const files: GraphFile[] = [];
  for (const n of fileNodes) {
    const path = pathOf(n);
    const child = childOf(path);
    if (!child) continue;
    const layer = layerOf.get(n.id);
    if (child.kind === "folder") {
      const f = folders.get(child.key) ?? { files: 0, layers: new Set<string>() };
      f.files++;
      f.layers.add(layer ?? "");
      folders.set(child.key, f);
      continue;
    }
    const functions = [...(membersOf.get(path)?.values() ?? [])]
      .map((m) => ({
        ref: formatNodeRef({ repo: repo.id, nodeId: m.id }),
        name: m.name,
        type: m.type as "function" | "class",
        ...(m.lineRange ? { line: m.lineRange[0] } : {}),
      }))
      .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || compare(a.name, b.name) || compare(a.ref, b.ref));
    files.push({
      ref: formatNodeRef({ repo: repo.id, nodeId: n.id }),
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      ...(layer !== undefined ? { layer } : {}),
      functions,
      journeys: sortedSet(journeysOfFile.get(path) ?? []),
    });
  }
  files.sort((a, b) => compare(a.path, b.path));

  const agg = new Map<string, GraphEdgeAgg>();
  for (const e of edges) {
    if (!LEVEL_EDGE_TYPES.has(e.type)) continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    const sp = s ? (s.type === "file" ? pathOf(s) : s.filePath) : undefined;
    const tp = t ? (t.type === "file" ? pathOf(t) : t.filePath) : undefined;
    if (sp === undefined || tp === undefined) continue;
    const from = childOf(sp);
    const to = childOf(tp);
    if (!from || !to || from.key === to.key) continue;
    const key = JSON.stringify([from.key, to.key, e.type]);
    const a = agg.get(key) ?? { from: from.key, to: to.key, type: e.type, count: 0 };
    a.count++;
    agg.set(key, a);
  }

  return {
    repo: repo.id,
    dir,
    folders: [...folders.entries()]
      .map(([path, f]): GraphFolder => {
        const only = f.layers.size === 1 ? [...f.layers][0]! : "";
        return { path, name: path.slice(path.lastIndexOf("/") + 1), files: f.files, ...(only ? { layer: only } : {}) };
      })
      .sort((a, b) => compare(a.path, b.path)),
    files,
    edges: [...agg.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.type, b.type)),
  };
}

// ---- /api/code ------------------------------------------------------------------------------------

export const CODE_MAX_LINES = 400;
export const CODE_MAX_CHARS = 60_000;
const CODE_MAX_BYTES = 10 * 1024 * 1024;

/** Lines start..end (1-based, inclusive; no end = to the end of the file) of `source`, capped at 400
 * lines and 60 000 chars (cut on a line boundary; a single longer line is cut mid-line). `truncated`
 * when less than the asked range came back. A start past the last line, or end < start → 400. */
export function sliceCode(file: string, source: string, start: number, end: number | undefined): CodeResponse {
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  if (start > lines.length) throw new HttpError(400, `Bad range: ${file} has ${lines.length} lines; start ${start} is past the end.`);
  if (end !== undefined && end < start) throw new HttpError(400, `Bad range: end ${end} is before start ${start}.`);
  const wantEnd = Math.min(end ?? lines.length, lines.length);
  const capEnd = Math.min(wantEnd, start + CODE_MAX_LINES - 1);
  let text = lines[start - 1]!;
  let endLine = start;
  let cut = false;
  if (text.length > CODE_MAX_CHARS) {
    text = text.slice(0, CODE_MAX_CHARS);
    cut = true;
  } else {
    for (let n = start + 1; n <= capEnd; n++) {
      const next = lines[n - 1]!;
      if (text.length + 1 + next.length > CODE_MAX_CHARS) break;
      text += `\n${next}`;
      endLine = n;
    }
  }
  return { file, startLine: start, endLine, text, truncated: cut || endLine < wantEnd };
}

/** /api/code: a slice of one file, resolved inside the repo root (the explain_context check, plus a
 * realpath check so a symlink cannot lead outside). Escape / absolute path → 400; missing → 404. */
export function readCode(start: string, url: URL): CodeResponse {
  const repoId = requiredParam(url, "repo");
  const file = requiredParam(url, "file");
  const from = intParam(url, "start", 1, Number.MAX_SAFE_INTEGER) ?? 1;
  const to = intParam(url, "end", 1, Number.MAX_SAFE_INTEGER);
  const ws = loadWorkspace(start);
  const ref = ws.repos.find((r) => r.id === repoId);
  if (!ref) throw new HttpError(404, `Unknown repo "${repoId}". Repos in this workspace: ${ws.repos.map((r) => r.id).join(", ")}.`);
  const root = resolve(ws.root, ref.path);
  const outside = new HttpError(400, `Bad file "${file}": it is outside repo "${repoId}".`);
  const inside = (base: string, p: string) => {
    const rel = relative(base, p);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (isAbsolute(file) || file.includes("\0")) throw outside;
  const abs = resolve(root, file);
  if (!inside(root, abs)) throw outside;
  // Never show git internals or env files, even though they sit inside the repo.
  const segments = relative(root, abs).split(sep);
  if (segments.includes(".git") || /^\.env(\..*)?$/.test(segments[segments.length - 1]!)) {
    throw new HttpError(400, `Bad file "${file}": codeloom does not show git internals or .env files.`);
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new HttpError(404, `${file} does not exist in repo "${repoId}" (the map may be stale; run codeloom index).`);
  }
  if (!inside(realpathSync(root), real)) throw outside;
  const st = statSync(real);
  if (!st.isFile()) throw new HttpError(400, `Bad file "${file}": not a file.`);
  if (st.size > CODE_MAX_BYTES) throw new HttpError(400, `Bad file "${file}": too large to show (${st.size} bytes).`);
  return sliceCode(file, readFileSync(real, "utf8"), from, to);
}

// ---- route table ----------------------------------------------------------------------------------

/** The dashboard is local HTTP, not MCP: it always gets list_chains' full rows (stops included). */
function listChainsArgs(url: URL): ListChainsArgs {
  const args: ListChainsArgs = { detail: true };
  const repo = strParam(url, "repo");
  const complete = boolParam(url, "complete");
  const confidence = enumParam(url, "confidence", ["exact", "param", "guess"] as const);
  const unnamed = boolParam(url, "unnamed");
  const limit = intParam(url, "limit", 1, 500);
  const offset = intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER);
  if (repo !== undefined) args.repo = repo;
  if (complete !== undefined) args.complete = complete;
  if (confidence !== undefined) args.confidence = confidence;
  if (unnamed !== undefined) args.unnamed = unnamed;
  if (limit !== undefined) args.limit = limit;
  if (offset !== undefined) args.offset = offset;
  return args;
}

function neighborsArgs(node: string, url: URL): NeighborsArgs {
  const args: NeighborsArgs = { node };
  const direction = enumParam(url, "direction", ["in", "out", "both"] as const);
  const depth = intParam(url, "depth", 1, 3);
  const limit = intParam(url, "limit", 1, 500);
  const edgeTypes = listParam(url, "edgeTypes");
  if (direction !== undefined) args.direction = direction;
  if (depth !== undefined) args.depth = depth;
  if (limit !== undefined) args.limit = limit;
  if (edgeTypes !== undefined) args.edgeTypes = edgeTypes;
  return args;
}

function searchArgs(url: URL): SearchArgs {
  const query = requiredParam(url, "q");
  if (query.length > 200) throw new HttpError(400, `Bad "q": at most 200 characters.`);
  const args: SearchArgs = { query };
  const kinds = listParam(url, "kinds");
  if (kinds !== undefined) {
    const bad = kinds.filter((k) => !(SEARCH_KINDS as readonly string[]).includes(k));
    if (bad.length > 0) throw new HttpError(400, `Bad "kinds": ${bad.join(", ")}. Use any of ${SEARCH_KINDS.join(", ")}.`);
    args.kinds = kinds as SearchKind[];
  }
  const repo = strParam(url, "repo");
  const limit = intParam(url, "limit", 1, 100);
  if (repo !== undefined) args.repo = repo;
  if (limit !== undefined) args.limit = limit;
  return args;
}

function graphFor(start: string, url: URL): GraphLevel {
  const repoId = requiredParam(url, "repo");
  const state = loadMapState(start);
  const repo = state.ws.repos.find((r) => r.ref.id === repoId);
  if (!repo) throw new HttpError(404, `Unknown repo "${repoId}". Repos in this workspace: ${state.ws.repos.map((r) => r.ref.id).join(", ")}.`);
  return graphLevel({ id: repo.ref.id, graph: repo.graph }, state, url.searchParams.get("dir") ?? "");
}

/** The MCP tool results, typed as api-types declares them (test/web-endpoints.test.ts checks the match). */
const as = <T>(x: Record<string, unknown>) => x as unknown as T;

/** The route table. Every handler reads the store fresh on each request (no cache), like the MCP tools,
 * and none runs git (overview's git calls are async). */
export const API_ROUTES: ApiRoute[] = [
  { path: "/api/overview", handler: ({ start }) => overview(start) },
  { path: "/api/journeys", handler: ({ start }): JourneysResponse => journeyRows(loadMapState(start)) },
  { path: "/api/journeys/:id", handler: ({ start, params }) => as<JourneyResult>(getJourney(start, params.id!)) },
  { path: "/api/chains", handler: ({ start, url }) => as<ChainsResult>(listChains(start, listChainsArgs(url))) },
  { path: "/api/graph", handler: ({ start, url }) => graphFor(start, url) },
  { path: "/api/node/:ref", handler: ({ start, params }) => as<NodeResult>(getNode(start, params.ref!)) },
  { path: "/api/neighbors/:ref", handler: ({ start, url, params }) => as<NeighborsResult>(getNeighbors(start, neighborsArgs(params.ref!, url))) },
  { path: "/api/layers", handler: ({ start, url }) => as<LayersResult>(getLayers(start, strParam(url, "repo"))) },
  { path: "/api/search", handler: ({ start, url }) => as<SearchResult>(search(start, searchArgs(url))) },
  { path: "/api/code", handler: ({ start, url }) => readCode(start, url) },
];

/** The route matching `pathname` and its decoded params, or null. A param that does not decode → no match. */
export function matchRoute(
  routes: ApiRoute[],
  pathname: string,
): { route: ApiRoute; params: Record<string, string> } | null {
  const segs = pathname.split("/");
  for (const route of routes) {
    const pat = route.path.split("/");
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length && ok; i++) {
      const p = pat[i]!;
      const s = segs[i]!;
      if (p.startsWith(":")) {
        try {
          const v = decodeURIComponent(s);
          if (v) params[p.slice(1)] = v;
          else ok = false;
        } catch {
          ok = false;
        }
      } else if (p !== s) ok = false;
    }
    if (ok) return { route, params };
  }
  return null;
}

/** The HTTP status and body for an error thrown by a handler: HttpError keeps its own; a store
 * dataError (exit 2) → 409 with its code: "not-indexed" (run codeloom index), "no-workspace" (run
 * codeloom init), else "bad-data" (a bad file),
 * except "Unknown …" (an id/repo that does not exist) → 404 and "Bad …" (a malformed argument) → 400;
 * anything else → 500. */
export function errorResponse(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } };
  }
  if (err instanceof CodeloomError) {
    if (err.code) return { status: 409, body: { error: err.message, code: err.code } };
    if (err.message.startsWith("Unknown ")) return { status: 404, body: { error: err.message } };
    if (err.message.startsWith("Bad ")) return { status: 400, body: { error: err.message } };
    if (err.exitCode === 2) return { status: 409, body: { error: err.message, code: "bad-data" } };
    return { status: 500, body: { error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: `codeloom hit an unexpected error: ${message}` } };
}

/** Answer one (already authenticated) /api/* GET from the route table. Unknown path → 404. */
export async function handleApi(
  res: ServerResponse,
  start: string,
  url: URL,
  opts: { head?: boolean; routes?: ApiRoute[] } = {},
): Promise<void> {
  const found = matchRoute(opts.routes ?? API_ROUTES, url.pathname);
  if (!found) {
    sendJson(res, 404, { error: `Unknown API path ${url.pathname}` }, opts.head);
    return;
  }
  try {
    const body = await found.route.handler({ start, url, params: found.params });
    sendJson(res, 200, body, opts.head);
  } catch (err) {
    const { status, body } = errorResponse(err);
    sendJson(res, status, body, opts.head);
  }
}
