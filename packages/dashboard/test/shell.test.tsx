import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createAppRouter } from "@/router";
import type { Overview } from "@/api/types";

const overview: Overview = {
  name: "demo-workspace",
  repos: [
    { id: "api", path: "api", role: "api", files: 1204, nodes: 3000, edges: 5000, pages: 0, routes: 40, calls: 0, tables: 12, queues: 2 },
    { id: "web", path: "web", role: "ui", files: 612, nodes: 1500, edges: 2000, pages: 30, routes: 0, calls: 55, tables: 0, queues: 0 },
  ],
  chains: { total: 50, complete: 41, byConfidence: { exact: 30, param: 15, guess: 5 } },
  journeys: { total: 7, orphaned: 0 },
  unnamedChains: 9,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

function stubFetch(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

describe("shell", () => {
  it("renders the brand, workspace, nav with counts and the repo list from the overview", async () => {
    const fetch = stubFetch(overview);
    renderAt("/");

    const rail = await screen.findByRole("complementary", { name: "codeloom" });
    expect(within(rail).getByText("codeloom")).toBeInTheDocument();
    expect(await within(rail).findByText("demo-workspace")).toBeInTheDocument();
    expect(within(rail).getByText("workspace · 2 repos")).toBeInTheDocument();

    const nav = within(rail).getByRole("navigation", { name: "Main" });
    const home = within(nav).getByRole("link", { name: /Home/ });
    const map = within(nav).getByRole("link", { name: /Map/ });
    expect(home).toHaveTextContent("7");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(map).toHaveTextContent("1,816");
    expect(map).not.toHaveAttribute("aria-current");

    const repos = within(rail).getByRole("list", { name: "Repos" });
    const items = within(repos).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["api1,204 files", "web612 files"]);

    expect(within(rail).getByText("MCP set up")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/overview", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("links each repo to its map", async () => {
    stubFetch(overview);
    renderAt("/");
    const repos = await screen.findByRole("list", { name: "Repos" });
    const link = await within(repos).findByRole("link", { name: /web/ });
    expect(link).toHaveAttribute("href", "/map?repo=web");
  });

  it.each([
    ["/", "home"],
    ["/journeys/j_abc", "journey"],
    ["/map", "map"],
  ])("route %s renders its placeholder inside the shell", async (path, id) => {
    stubFetch(overview);
    renderAt(path);
    const main = await screen.findByRole("main");
    expect(within(main).getByTestId(`screen-${id}`)).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "codeloom" })).toBeInTheDocument();
  });

  it("marks Map current on /map", async () => {
    stubFetch(overview);
    renderAt("/map?repo=api");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: /Map/ })).toHaveAttribute("aria-current", "page");
  });

  it("says when MCP is not set up", async () => {
    stubFetch({ ...overview, mcpConnected: false });
    renderAt("/");
    expect(await screen.findByText("MCP not set up")).toBeInTheDocument();
  });

  it("still renders the rail when the overview fails", async () => {
    stubFetch({ error: "boom" }, 500);
    renderAt("/");
    const rail = await screen.findByRole("complementary", { name: "codeloom" });
    expect(within(rail).getByRole("link", { name: /Home/ })).toBeInTheDocument();
    expect(within(rail).queryByRole("list", { name: "Repos" })).not.toBeInTheDocument();
  });
});
