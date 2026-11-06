import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  queryKeys,
  useCode,
  useGraphLevel,
  useJourney,
  useJourneys,
  useLayers,
  useMarkSeen,
  useMarkToured,
  useNeighbors,
  useNode,
  useOverview,
  useProgress,
  useSearch,
  useTour,
} from "@/api/queries";

function stubFetch(body: unknown = { ok: true }) {
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, wrapper };
}

/** Render `hook`, wait for its data, and return the URL it fetched plus the cache keys now present. */
async function run<T>(hook: () => { data: T | undefined; isSuccess: boolean }, body: unknown = { ok: true }) {
  const fetch = stubFetch(body);
  const { queryClient, wrapper } = setup();
  const { result } = renderHook(hook, { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  return { url: fetch.mock.calls[0]![0], data: result.current.data, keys: queryClient.getQueryCache().getAll().map((q) => q.queryKey) };
}

describe("query hooks", () => {
  it("useOverview → /api/overview, key [overview]", async () => {
    const r = await run(() => useOverview(), { name: "ws" });
    expect(r.url).toBe("/api/overview");
    expect(r.data).toEqual({ name: "ws" });
    expect(r.keys).toEqual([["overview"]]);
  });

  it("useJourneys → /api/journeys, key [journeys]", async () => {
    const r = await run(() => useJourneys(), { journeys: [], unnamedChains: [] });
    expect(r.url).toBe("/api/journeys");
    expect(r.data).toEqual({ journeys: [], unnamedChains: [] });
    expect(r.keys).toEqual([["journeys"]]);
  });

  it("useJourney(id) → /api/journeys/<encoded id>, key [journey, id]", async () => {
    const r = await run(() => useJourney("j_check out"));
    expect(r.url).toBe("/api/journeys/j_check%20out");
    expect(r.keys).toEqual([["journey", "j_check out"]]);
  });

  it("useGraphLevel(repo, dir) → /api/graph?repo=&dir=, key [graph, repo, dir]; dir defaults to the root", async () => {
    const r = await run(() => useGraphLevel("api", "app/controllers"));
    expect(r.url).toBe("/api/graph?repo=api&dir=app%2Fcontrollers");
    expect(r.keys).toEqual([["graph", "api", "app/controllers"]]);
    const root = await run(() => useGraphLevel("web"));
    expect(root.url).toBe("/api/graph?repo=web&dir=");
    expect(root.keys).toEqual([["graph", "web", ""]]);
  });

  it("useNode(ref) → /api/node/<encoded ref>, key [node, ref]", async () => {
    const r = await run(() => useNode("api::file:app/x.ts"));
    expect(r.url).toBe("/api/node/api%3A%3Afile%3Aapp%2Fx.ts");
    expect(r.keys).toEqual([["node", "api::file:app/x.ts"]]);
  });

  it("useNeighbors(ref, depth, direction) → /api/neighbors/<ref>?depth=&direction=, key [neighbors, ref, depth, direction]", async () => {
    const r = await run(() => useNeighbors("api::file:a.ts", 2, "out"));
    expect(r.url).toBe("/api/neighbors/api%3A%3Afile%3Aa.ts?depth=2&direction=out");
    expect(r.keys).toEqual([["neighbors", "api::file:a.ts", 2, "out"]]);
    const d = await run(() => useNeighbors("api::file:a.ts"));
    expect(d.url).toBe("/api/neighbors/api%3A%3Afile%3Aa.ts?depth=1&direction=both");
    expect(d.keys).toEqual([["neighbors", "api::file:a.ts", 1, "both"]]);
  });

  it("useLayers(repo) → /api/layers?repo=, key [layers, repo]; no repo = every repo", async () => {
    const r = await run(() => useLayers("api"));
    expect(r.url).toBe("/api/layers?repo=api");
    expect(r.keys).toEqual([["layers", "api"]]);
    const all = await run(() => useLayers());
    expect(all.url).toBe("/api/layers");
    expect(all.keys).toEqual([["layers", null]]);
  });

  it("useCode(repo, file, start, end) → /api/code?…, key [code, repo, file, start, end]", async () => {
    const r = await run(() => useCode("api", "app/x.ts", 10, 40));
    expect(r.url).toBe("/api/code?repo=api&file=app%2Fx.ts&start=10&end=40");
    expect(r.keys).toEqual([["code", "api", "app/x.ts", 10, 40]]);
    const whole = await run(() => useCode("api", "app/x.ts"));
    expect(whole.url).toBe("/api/code?repo=api&file=app%2Fx.ts");
    expect(whole.keys).toEqual([["code", "api", "app/x.ts", null, null]]);
  });

  it("useSearch(q, kinds, repo) → /api/search?q=&kinds=a,b&repo=, key [search, q, kinds, repo]", async () => {
    const r = await run(() => useSearch("cart", ["file", "route"], "api"));
    expect(r.url).toBe("/api/search?q=cart&kinds=file%2Croute&repo=api");
    expect(r.keys).toEqual([["search", "cart", ["file", "route"], "api"]]);
    const plain = await run(() => useSearch("cart"));
    expect(plain.url).toBe("/api/search?q=cart");
    expect(plain.keys).toEqual([["search", "cart", [], null]]);
  });

  it("hooks with a missing id, repo, file or blank query do not fetch", async () => {
    const fetch = stubFetch();
    const { wrapper } = setup();
    renderHook(
      () => {
        useJourney(undefined);
        useGraphLevel(undefined);
        useNode(undefined);
        useNeighbors(undefined);
        useCode(undefined, "a.ts");
        useCode("api", undefined);
        useSearch("   ");
      },
      { wrapper },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queryKeys builds the registry keys", () => {
    expect(queryKeys.overview()).toEqual(["overview"]);
    expect(queryKeys.journeys()).toEqual(["journeys"]);
    expect(queryKeys.journey("j")).toEqual(["journey", "j"]);
    expect(queryKeys.graph("api", "")).toEqual(["graph", "api", ""]);
    expect(queryKeys.node("r")).toEqual(["node", "r"]);
    expect(queryKeys.neighbors("r", 1, "both")).toEqual(["neighbors", "r", 1, "both"]);
    expect(queryKeys.layers("api")).toEqual(["layers", "api"]);
    expect(queryKeys.code("api", "f", 1, 2)).toEqual(["code", "api", "f", 1, 2]);
    expect(queryKeys.search("q", ["file"], "api")).toEqual(["search", "q", ["file"], "api"]);
  });
});

describe("tours and progress hooks", () => {
  it("useProgress → /api/progress, key [progress]", async () => {
    const r = await run(() => useProgress(), { journeys: [] });
    expect(r.url).toBe("/api/progress");
    expect(r.keys).toEqual([["progress"]]);
  });

  it("useTour(id) → /api/tours/<encoded id>, key [tour, id]", async () => {
    const r = await run(() => useTour("j_000000000001"), { tour: null });
    expect(r.url).toBe("/api/tours/j_000000000001");
    expect(r.keys).toEqual([["tour", "j_000000000001"]]);
    expect(queryKeys.tour("j")).toEqual(["tour", "j"]);
    expect(queryKeys.progress()).toEqual(["progress"]);
  });

  it("useTour with no id does not fetch", async () => {
    const fetch = stubFetch();
    const { wrapper } = setup();
    renderHook(() => useTour(undefined), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("useMarkSeen / useMarkToured POST the body, then make progress, overview and journeys stale", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ journey: { journeyId: "j_000000000001", level: "seen" } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const { queryClient, wrapper } = setup();
    for (const k of [["progress"], ["overview"], ["journeys"], ["graph", "api", ""]]) queryClient.setQueryData(k, { cached: true });
    const { result } = renderHook(() => ({ seen: useMarkSeen(), toured: useMarkToured() }), { wrapper });
    await result.current.seen.mutateAsync("j_000000000001");
    expect(fetch.mock.calls[0]![0]).toBe("/api/progress/seen");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ journey: "j_000000000001" }) });
    await result.current.toured.mutateAsync({ journey: "j_000000000001", phases: ["flow", "data-journey", "file-notes", "check"] });
    expect(fetch.mock.calls[1]![0]).toBe("/api/progress/toured");
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ journey: "j_000000000001", phases: ["flow", "data-journey", "file-notes", "check"] });
    const stale = queryClient.getQueryCache().getAll().filter((q) => q.state.isInvalidated).map((q) => String(q.queryKey[0])).sort();
    expect(stale).toEqual(["journeys", "overview", "progress"]);
  });
});
