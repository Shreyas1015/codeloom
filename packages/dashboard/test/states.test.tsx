import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { Overview } from "@/api/types";
import { createAppRouter } from "@/router";

const overview: Overview = {
  name: "demo-shop",
  repos: [{ id: "api", path: "api", role: "api", files: 12, nodes: 30, edges: 50, pages: 0, routes: 4, calls: 0, tables: 2, queues: 0 }],
  chains: { total: 2, complete: 2, byConfidence: { exact: 2, param: 0, guess: 0 } },
  journeys: { total: 0, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [{ id: "api", head: "b2", indexedCommit: "b2", stale: false, changedFiles: [], truncated: false }] },
  mcpConnected: true,
};

const stale: Overview = {
  ...overview,
  indexStatus: {
    repos: [
      {
        id: "api",
        head: "c3",
        indexedCommit: "b2",
        stale: true,
        changedFiles: ["app/a.ts", "app/b.ts", "app/c.ts", "app/d.ts", "app/e.ts"],
        truncated: false,
      },
    ],
  },
};

type Reply = { status?: number; body: unknown };
let replies: Record<string, Reply>;

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0]!;
      const hit = replies[path] ?? { status: 404, body: { error: `Unknown API path ${path}` } };
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
}

interface FakeSource {
  url: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  listeners: Record<string, (e: MessageEvent) => void>;
}
let sources: FakeSource[];

function renderAt(path = "/") {
  stub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  const { unmount } = render(<App router={router} queryClient={queryClient} />);
  return { qc: queryClient, unmount };
}

const notIndexed: Reply = { status: 409, body: { error: 'Repo "api" has no .codeloom data yet. Run "codeloom index" first.', code: "not-indexed" } };
const emptyJourneys: Reply = { body: { journeys: [], unnamedChains: [] } };

// The Map screen is lazy-loaded; transform it up front so a busy run does not time out waiting for the chunk.
beforeAll(async () => {
  await Promise.all([import("@/screens/map/MapScreen"), import("@/screens/journey/JourneyScreen")]);
}, 60_000);

beforeEach(() => {
  replies = { "/api/overview": { body: overview }, "/api/journeys": emptyJourneys };
  sources = [];
  vi.stubGlobal(
    "EventSource",
    class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      listeners: Record<string, (e: MessageEvent) => void> = {};
      constructor(readonly url: string) {
        sources.push(this);
      }
      addEventListener(type: string, fn: (e: MessageEvent) => void) {
        this.listeners[type] = fn;
      }
      close() {}
    },
  );
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("full-screen states", () => {
  it("not indexed: the command with a copy button, and a note that the page updates by itself", async () => {
    replies["/api/overview"] = notIndexed;
    renderAt("/");
    const main = await screen.findByRole("main");
    const state = await within(main).findByRole("region", { name: /isn't mapped yet/ });
    expect(within(state).getByText("codeloom index")).toHaveClass("select-all");
    expect(within(state).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(state).toHaveTextContent("This page updates by itself when indexing finishes.");
    expect(state).toHaveTextContent('Repo "api" has no .codeloom data yet.');
    expect(within(main).queryByTestId("screen-home")).toBeNull();
    expect(within(main).queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });

  it("not indexed: shows the screen once a live update says indexing finished", async () => {
    replies["/api/overview"] = notIndexed;
    renderAt("/");
    await screen.findByRole("region", { name: /isn't mapped yet/ });
    replies["/api/overview"] = { body: overview };
    act(() => sources[0]!.listeners.change!(new MessageEvent("change", { data: JSON.stringify({ keys: ["repo:api"] }) })));
    expect(await screen.findByTestId("screen-home")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /isn't mapped yet/ })).toBeNull();
  });

  it("no workspace: tells you to run codeloom init", async () => {
    replies["/api/overview"] = { status: 409, body: { error: "No codeloom.workspace.json found.", code: "no-workspace" } };
    renderAt("/");
    const state = await screen.findByRole("region", { name: /No codeloom workspace here/ });
    expect(within(state).getByText("codeloom init")).toBeInTheDocument();
  });

  it("bad data: the server's message and codeloom doctor", async () => {
    replies["/api/overview"] = { status: 409, body: { error: "api/.codeloom/graph.json is not valid JSON.", code: "bad-data" } };
    renderAt("/");
    const state = await screen.findByRole("alert", { name: /can't read its map/ });
    expect(state).toHaveTextContent("api/.codeloom/graph.json is not valid JSON.");
    expect(within(state).getByText("codeloom doctor")).toBeInTheDocument();
  });

  it("session expired (401 on the overview): reopen the dashboard from your terminal", async () => {
    replies["/api/overview"] = { status: 401, body: { error: "no session" } };
    renderAt("/");
    const state = await screen.findByRole("alert", { name: /session expired/i });
    expect(state).toHaveTextContent("Reopen the dashboard from your terminal");
    expect(within(state).getByText("codeloom dashboard")).toBeInTheDocument();
  });

  it("session expired (401 on any screen request) takes over the whole screen", async () => {
    replies["/api/journeys"] = { status: 401, body: { error: "no session" } };
    renderAt("/");
    expect(await screen.findByRole("alert", { name: /session expired/i })).toBeInTheDocument();
    expect(screen.queryByTestId("screen-home")).toBeNull();
  });

  it("bad data on a screen request (overview fine) shows the shared state in the screen", async () => {
    replies["/api/journeys"] = { status: 409, body: { error: ".codeloom/journeys.json: duplicate journey id", code: "bad-data" } };
    renderAt("/");
    const home = await screen.findByTestId("screen-home");
    const state = await within(home).findByRole("alert", { name: /can't read its map/ });
    expect(state).toHaveTextContent("duplicate journey id");
    // embedded under the screen's own h1: one h1 on the page
    expect(within(state).getByRole("heading", { level: 2, name: /can't read its map/ })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("the journey screen embeds its state with an h2", async () => {
    replies["/api/journeys/j_x"] = notIndexed;
    renderAt("/journeys/j_x");
    expect(await screen.findByRole("heading", { level: 2, name: /isn't mapped yet/ })).toBeInTheDocument();
  });

  it("a 401 in mid-use replaces the screen and moves focus to the state's heading", async () => {
    const { qc } = renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "demo-shop" });
    replies["/api/journeys"] = { status: 401, body: { error: "no session" } };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["journeys"] });
    });
    const state = await screen.findByRole("alert", { name: /session expired/i });
    const h1 = within(state).getByRole("heading", { level: 1, name: /session expired/i });
    expect(h1).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(h1).toHaveFocus());
  });

  it("an idle viewer whose session expires sees it: the live stream's error refetches the overview once", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "demo-shop" });
    const fetch = vi.mocked(globalThis.fetch);
    const overviewCalls = () => fetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/overview")).length;
    const before = overviewCalls();
    act(() => sources[0]!.onopen?.());
    replies["/api/overview"] = { status: 401, body: { error: "no session" } };
    act(() => sources[0]!.onerror?.());
    expect(await screen.findByRole("alert", { name: /session expired/i })).toBeInTheDocument();
    expect(overviewCalls()).toBe(before + 1);
  });

  it("a stream that never opened does not refetch the overview on error", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "demo-shop" });
    const fetch = vi.mocked(globalThis.fetch);
    const before = fetch.mock.calls.length;
    act(() => sources[0]!.onerror?.());
    await new Promise((r) => setTimeout(r, 30));
    expect(fetch.mock.calls.length).toBe(before);
  });

  it("a state shown on first load does not steal focus", async () => {
    replies["/api/overview"] = notIndexed;
    renderAt("/");
    const state = await screen.findByRole("region", { name: /isn't mapped yet/ });
    expect(within(state).getByRole("heading", { level: 1 })).not.toHaveFocus();
  });

  it("not-indexed in mid-use (a live update) moves focus to the heading too", async () => {
    const { qc } = renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "demo-shop" });
    replies["/api/overview"] = notIndexed;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["overview"] });
    });
    // CI runners can be slow to settle the refetch + focus move: give both waits room.
    const state = await screen.findByRole("region", { name: /isn't mapped yet/ }, { timeout: 5000 });
    await waitFor(() => expect(within(state).getByRole("heading", { level: 1 })).toHaveFocus(), { timeout: 5000 });
  });

  it.each([
    ["/journeys/j_x", "/api/journeys/j_x"],
    ["/map?repo=api", "/api/graph"],
  ])("%s shows the shared not-indexed state for its own 409", async (path, api) => {
    replies[api] = notIndexed;
    renderAt(path);
    // the Map screen is lazy-loaded: allow for the chunk under a busy test run
    expect(await screen.findByRole("region", { name: /isn't mapped yet/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("banners", () => {
  it("index older than HEAD: says the map is behind and lists up to 3 changed files", async () => {
    replies["/api/overview"] = { body: stale };
    renderAt("/");
    const banner = await screen.findByRole("status", { name: "Map is behind your code" });
    expect(banner).toHaveTextContent("Map is behind your code — run codeloom index");
    const files = within(banner).getByRole("list", { name: "Changed files" });
    expect(within(files).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["api/app/a.ts", "api/app/b.ts", "api/app/c.ts"]);
    expect(banner).toHaveTextContent("and 2 more");
    expect(screen.getByTestId("screen-home")).toBeInTheDocument();
  });

  it("no banner when the index is current and the agent is connected", async () => {
    renderAt("/");
    await screen.findByTestId("screen-home");
    expect(screen.queryByRole("status", { name: "Map is behind your code" })).toBeNull();
    expect(screen.queryByRole("status", { name: "Agent not connected" })).toBeNull();
  });

  it("agent not connected: one setup line", async () => {
    replies["/api/overview"] = { body: { ...overview, mcpConnected: false } };
    renderAt("/");
    const banner = await screen.findByRole("status", { name: "Agent not connected" });
    expect(banner).toHaveTextContent("Add codeloom to your agent: codeloom init adds it to .mcp.json");
  });

  it("are dismissible for the session", async () => {
    replies["/api/overview"] = { body: { ...stale, mcpConnected: false } };
    const first = renderAt("/");
    const banner = await screen.findByRole("status", { name: "Map is behind your code" });
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss: Map is behind your code" }));
    expect(screen.queryByRole("status", { name: "Map is behind your code" })).toBeNull();
    expect(screen.getByRole("status", { name: "Agent not connected" })).toBeInTheDocument();

    // a reload in the same tab keeps it dismissed
    first.unmount();
    renderAt("/");
    await screen.findByRole("status", { name: "Agent not connected" });
    expect(screen.queryByRole("status", { name: "Map is behind your code" })).toBeNull();
  });

  it("come back when the code moves again after a dismiss", async () => {
    replies["/api/overview"] = { body: stale };
    const { qc } = renderAt("/");
    const banner = await screen.findByRole("status", { name: "Map is behind your code" });
    fireEvent.click(within(banner).getByRole("button", { name: /Dismiss/ }));
    const moved: Overview = { ...stale, indexStatus: { repos: [{ ...stale.indexStatus.repos[0]!, head: "d4" }] } };
    act(() => qc.setQueryData(["overview"], moved));
    expect(await screen.findByRole("status", { name: "Map is behind your code" })).toBeInTheDocument();
  });

  it("still dismiss when session storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    replies["/api/overview"] = { body: { ...overview, mcpConnected: false } };
    renderAt("/");
    const banner = await screen.findByRole("status", { name: "Agent not connected" });
    fireEvent.click(within(banner).getByRole("button", { name: /Dismiss/ }));
    expect(screen.queryByRole("status", { name: "Agent not connected" })).toBeNull();
  });
});
