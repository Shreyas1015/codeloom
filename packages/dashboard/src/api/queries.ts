import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "./client.js";
import type {
  CodeResponse,
  GraphLevel,
  JourneyResult,
  JourneysResponse,
  LayersResult,
  NeighborsResult,
  NodeResult,
  Overview,
  ProgressResponse,
  ProgressWriteResponse,
  SearchKind,
  SearchResult,
  TouredRequest,
  TourResponse,
} from "./types.js";

export type NeighborDirection = "in" | "out" | "both";

/** Query keys (the Plan 3 registry). api/events.ts invalidates by these prefixes, so keep the order:
 * the repo always comes right after the name where there is one. Absent optional parts are `null`. */
export const queryKeys = {
  overview: () => ["overview"] as const,
  journeys: () => ["journeys"] as const,
  journey: (id: string) => ["journey", id] as const,
  graph: (repo: string, dir: string) => ["graph", repo, dir] as const,
  node: (ref: string) => ["node", ref] as const,
  neighbors: (ref: string, depth: number, direction: NeighborDirection) => ["neighbors", ref, depth, direction] as const,
  layers: (repo: string | null) => ["layers", repo] as const,
  code: (repo: string, file: string, start: number | null, end: number | null) => ["code", repo, file, start, end] as const,
  search: (q: string, kinds: SearchKind[], repo: string | null) => ["search", q, kinds, repo] as const,
  progress: () => ["progress"] as const,
  tour: (journeyId: string) => ["tour", journeyId] as const,
};

const enc = encodeURIComponent;

/** Workspace name, repos, chain/journey counts, index status, MCP set-up. */
export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview(), queryFn: () => apiGet<Overview>("/api/overview") });
}

/** Every journey as a row, plus the chains no journey names yet. */
export function useJourneys() {
  return useQuery({ queryKey: queryKeys.journeys(), queryFn: () => apiGet<JourneysResponse>("/api/journeys") });
}

/** One journey (j_…) or chain (ch_…) with its stops. Disabled until `id` is known. */
export function useJourney(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.journey(id ?? ""),
    queryFn: () => apiGet<JourneyResult>(`/api/journeys/${enc(id!)}`),
    enabled: !!id,
  });
}

/** One folder level of one repo (`dir` "" = the repo root). Disabled until `repo` is known. */
export function useGraphLevel(repo: string | undefined, dir = "") {
  return useQuery({
    queryKey: queryKeys.graph(repo ?? "", dir),
    queryFn: () => apiGet<GraphLevel>("/api/graph", { repo: repo!, dir }),
    enabled: !!repo,
  });
}

/** One graph node by ref ("repo::nodeId"): its info, summary, edges, chains and journeys. */
export function useNode(ref: string | undefined) {
  return useQuery({
    queryKey: queryKeys.node(ref ?? ""),
    queryFn: () => apiGet<NodeResult>(`/api/node/${enc(ref!)}`),
    enabled: !!ref,
  });
}

/** The nodes within `depth` (1–3) hops of `ref`. */
export function useNeighbors(ref: string | undefined, depth = 1, direction: NeighborDirection = "both") {
  return useQuery({
    queryKey: queryKeys.neighbors(ref ?? "", depth, direction),
    queryFn: () => apiGet<NeighborsResult>(`/api/neighbors/${enc(ref!)}`, { depth, direction }),
    enabled: !!ref,
  });
}

/** Architecture layers of one repo, or of every repo when `repo` is left out. */
export function useLayers(repo?: string) {
  return useQuery({
    queryKey: queryKeys.layers(repo ?? null),
    queryFn: () => apiGet<LayersResult>("/api/layers", { repo }),
  });
}

/** Source lines of one file (1-based, inclusive; the server caps the size). No range = from the top. */
export function useCode(repo: string | undefined, file: string | undefined, start?: number, end?: number) {
  return useQuery({
    queryKey: queryKeys.code(repo ?? "", file ?? "", start ?? null, end ?? null),
    queryFn: () => apiGet<CodeResponse>("/api/code", { repo: repo!, file: file!, start, end }),
    enabled: !!repo && !!file,
  });
}

/** Your personal progress: every journey's level, needs-re-walk stops, last check, and totals. */
export function useProgress() {
  return useQuery({ queryKey: queryKeys.progress(), queryFn: () => apiGet<ProgressResponse>("/api/progress") });
}

/** One journey's tour (`tour: null` when none yet), its stale and removed stops. Disabled until `journeyId` is known. */
export function useTour(journeyId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tour(journeyId ?? ""),
    queryFn: () => apiGet<TourResponse>(`/api/tours/${enc(journeyId!)}`),
    enabled: !!journeyId,
  });
}

/** After a progress write: the screens that show levels refetch (the watcher would also say so, later). */
function useProgressWrite<V>(post: (v: V) => Promise<ProgressWriteResponse>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: post,
    onSuccess: () =>
      queryClient.invalidateQueries({ predicate: (q) => ["progress", "overview", "journeys"].includes(String(q.queryKey[0])) }),
  });
}

/** POST /api/progress/seen: the journey was opened. */
export function useMarkSeen() {
  return useProgressWrite((journey: string) => apiPost<ProgressWriteResponse>("/api/progress/seen", { journey }));
}

/** POST /api/progress/toured: all four tour phases were viewed (the journey needs a tour). */
export function useMarkToured() {
  return useProgressWrite((req: TouredRequest) => apiPost<ProgressWriteResponse>("/api/progress/toured", req));
}

/** Search files, functions, routes, pages, tables, queues, journeys and chains. A blank query does not
 * fetch; while a new query loads, the previous results stay on screen. */
export function useSearch(q: string, kinds: SearchKind[] = [], repo?: string) {
  const query = q.trim();
  return useQuery({
    queryKey: queryKeys.search(query, kinds, repo ?? null),
    queryFn: () => apiGet<SearchResult>("/api/search", { q: query, kinds: kinds.length ? kinds.join(",") : undefined, repo }),
    enabled: query !== "",
    placeholderData: keepPreviousData,
  });
}
