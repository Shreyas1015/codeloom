import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { GraphLevel, JourneyRow, JourneysResponse, Overview, SpecCoverage, SpecsResponse, ViewFile, ViewResponse, ViewsResponse, Widget } from "@/api/types";
import { createAppRouter } from "@/router";
import { progress } from "./fixtures/progress";

beforeAll(async () => {
  await import("@/screens/views/MapWidget");
  // React Flow reads the viewport transform through DOMMatrixReadOnly, which jsdom lacks.
  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    class DOMMatrixReadOnly {
      m22 = 1;
      constructor(_init?: string) {}
    }
    (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnly;
  }
});

const overview: Overview = {
  name: "demo-shop",
  repos: [
    { id: "api", path: "api", role: "api", files: 120, nodes: 300, edges: 500, pages: 0, routes: 14, calls: 0, tables: 5, queues: 1 },
    { id: "web", path: "web", role: "ui", files: 80, nodes: 150, edges: 200, pages: 9, routes: 0, calls: 22, tables: 0, queues: 0 },
  ],
  chains: { total: 12, complete: 9, byConfidence: { exact: 8, param: 3, guess: 1 } },
  journeys: { total: 3, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

function row(p: Partial<JourneyRow> & { id: string; name: string }): JourneyRow {
  return {
    area: "",
    note: "",
    status: "ok",
    chainIds: [],
    repos: [],
    stops: { ui: 1, api: 1, code: 0, db: 1, queue: 0 },
    confidence: "exact",
    complete: true,
    apiOnly: false,
    tables: [],
    ...p,
  };
}

const journeys: JourneysResponse = {
  journeys: [
    row({ id: "j_signup", name: "Customer signs up", area: "Customers", repos: ["api", "web"] }),
    row({ id: "j_void", name: "Admin voids an invoice", area: "Invoices", repos: ["api"] }),
    row({ id: "j_email", name: "Invoice is emailed", area: "Invoices", repos: ["api"] }),
  ],
  unnamedChains: [],
};

const cov = (total: number, linked: number, candidates: number): SpecCoverage => ({ total, linked, candidates, none: total - linked - candidates, checked: linked });
const specRow = (journeyId: string, name: string, area: string, state: "linked" | "candidates" | "none") => ({
  journeyId,
  name,
  area,
  repos: ["api"],
  state,
  checked: state !== "candidates",
  links: [],
  candidates: { docs: 0, tickets: 0 },
});
const specs: SpecsResponse = {
  journeys: [
    specRow("j_signup", "Customer signs up", "Customers", "linked"),
    specRow("j_void", "Admin voids an invoice", "Invoices", "none"),
    specRow("j_email", "Invoice is emailed", "Invoices", "candidates"),
  ],
  totals: { all: cov(3, 1, 1), byRepo: { api: cov(3, 1, 1), web: cov(1, 1, 0) }, byArea: { Customers: cov(1, 1, 0), Invoices: cov(2, 0, 1) } },
  olderJourneys: [],
  candidatesIndexed: true,
};

const level: GraphLevel = {
  repo: "api",
  dir: "",
  folders: [{ path: "app", name: "app", files: 5, layer: "api" }],
  files: [],
  edges: [],
};

const viewFile = (id: string, widgets: Widget[], title = "No-spec audit"): ViewFile => ({ version: 1, id, title, description: "Journeys still missing a spec.", widgets });
const ok = (id: string, widgets: Widget[], title?: string): ViewResponse => ({ id, url: id === "home" ? "/" : `/views/${id}`, view: viewFile(id, widgets, title) });

const viewsList: ViewsResponse = {
  views: [
    { id: "audit", url: "/views/audit", title: "No-spec audit", widgets: 2 },
    { id: "broken", url: "/views/broken", error: "views/broken.json: widgets.0.type: unknown widget" },
  ],
};

type Bodies = Record<string, { status?: number; body: unknown } | "pending">;

function stubApi(extra: Bodies = {}) {
  const bodies: Bodies = {
    "/api/overview": { body: overview },
    "/api/journeys": { body: journeys },
    "/api/progress": { body: progress },
    "/api/specs": { body: specs },
    "/api/views": { body: viewsList },
    "/api/graph": { body: level },
    ...extra,
  };
  const fetch = vi.fn((url: string) => {
    const path = url.split("?")[0]!;
    const hit = bodies[path];
    if (hit === "pending") return new Promise<Response>(() => {});
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string, extra: Bodies = {}) {
  stubApi(extra);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const ALL: Widget[] = [
  { type: "note", markdown: "## Why\n\nJourneys with **no spec** yet." },
  { type: "counts", show: ["journeys", "specLinked", "understood"] },
  { type: "journeys", title: "Invoices without a spec", filter: { area: "Invoices", spec: "none" } },
  { type: "progress", by: "area" },
  { type: "checks", limit: 2 },
  { type: "specCoverage", by: "repo" },
  { type: "map", repo: "api" },
];

describe("/views/$id", () => {
  it("renders the view's title, description and every widget type", async () => {
    renderAt("/views/audit", { "/api/views/audit": { body: ok("audit", ALL) } });
    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: "No-spec audit" })).toBeInTheDocument();
    expect(within(main).getByText("Journeys still missing a spec.")).toBeInTheDocument();
    // note
    expect(within(main).getByRole("heading", { name: "Why" })).toBeInTheDocument();
    // counts: in the order asked
    const strip = await within(main).findByRole("list", { name: "Totals" });
    await waitFor(() => expect(strip).toHaveTextContent("3User journeys1With a spec"));
    expect(strip).toHaveTextContent("1Understood");
    // journeys: filtered by area and spec
    const list = await within(main).findByRole("list", { name: "Invoices without a spec" });
    expect(within(list).getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringContaining("Admin voids an invoice")]);
    expect(within(list).getByText("No spec")).toBeInTheDocument();
    // progress by area
    expect(await within(main).findByRole("list", { name: "Progress by area" })).toHaveTextContent("Invoices");
    // checks: newest first, limited
    const checks = await within(main).findByRole("list", { name: "Recent checks" });
    expect(within(checks).getAllByRole("listitem")).toHaveLength(2);
    // spec coverage by repo
    const coverage = await within(main).findByRole("table", { name: "Spec coverage by repo" });
    expect(within(coverage).getByText("api")).toBeInTheDocument();
    // map: the repo's level, and a way to the full map
    const map = await within(main).findByRole("region", { name: "Map of api" });
    expect(within(map).getByRole("link", { name: /Open in Map/ })).toHaveAttribute("href", "/map?repo=api");
  });

  it("a broken view file shows an error card with the doctor hint, inside the shell", async () => {
    renderAt("/views/broken", {
      "/api/views/broken": { body: { id: "broken", url: "/views/broken", view: null, error: "views/broken.json: widgets.0.type: unknown widget. Run codeloom doctor." } },
    });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view can't be read" })).toBeInTheDocument();
    expect(alert).toHaveTextContent("unknown widget");
    expect(alert).toHaveTextContent("codeloom doctor");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("a view that does not exist says so", async () => {
    renderAt("/views/gone");
    expect(await screen.findByRole("heading", { level: 1, name: "No view called gone" })).toBeInTheDocument();
    expect(screen.getByText("/mcp__codeloom__make-view")).toBeInTheDocument();
  });

  it("widgets naming an unknown repo or journey show an empty card, not a crash", async () => {
    renderAt("/views/audit", {
      "/api/views/audit": {
        body: ok("audit", [
          { type: "map", repo: "billing" },
          { type: "journeys", filter: { repo: "billing" } },
        ]),
      },
    });
    expect(await screen.findByText((_, el) => el?.tagName === "P" && /^billing is not a repo in this workspace/.test(el.textContent ?? ""))).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open in Map/ })).toBeNull();
    expect(await screen.findByText("No journeys match this widget's filter.")).toBeInTheDocument();
  });

  it("a broken specs.json shows a local card in the spec widgets", async () => {
    renderAt("/views/audit", {
      "/api/views/audit": { body: ok("audit", [{ type: "specCoverage" }, { type: "note", markdown: "still here" }]) },
      "/api/specs": { status: 409, body: { error: "specs.json: bad JSON", code: "bad-data" } },
    });
    expect(await screen.findByText("The spec links file can't be read")).toBeInTheDocument();
    expect(screen.getByText("still here")).toBeInTheDocument();
  });
});

describe("rail Views section", () => {
  it("lists every view, marks broken ones and the current one", async () => {
    renderAt("/views/audit", { "/api/views/audit": { body: ok("audit", []) } });
    const nav = await screen.findByRole("list", { name: "Views" });
    const audit = await within(nav).findByRole("link", { name: /No-spec audit/ });
    expect(audit).toHaveAttribute("href", "/views/audit");
    expect(audit).toHaveAttribute("aria-current", "page");
    const broken = within(nav).getByRole("link", { name: /broken/ });
    expect(broken).toHaveTextContent("can't be read");
    // Home is not current on a view
    expect(screen.getByRole("link", { name: /^Home/ })).not.toHaveAttribute("aria-current");
  });

  it("is left out when there are no views", async () => {
    renderAt("/", { "/api/views": { body: { views: [] } } });
    await screen.findByRole("heading", { level: 1, name: "demo-shop" });
    expect(screen.queryByRole("list", { name: "Views" })).toBeNull();
  });
});

describe("views design pass", () => {
  it("a widget's data error is a dashed oxblood card on white, like every other failure card", async () => {
    renderAt("/views/audit", {
      "/api/views/audit": { body: ok("audit", [{ type: "progress" }]) },
      "/api/progress": { status: 409, body: { error: "progress file broken", code: "bad-data" } },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.className).toMatch(/border-dashed/);
    expect(alert.className).toMatch(/bg-card/);
    expect(alert.className).not.toMatch(/bg-destructive-soft/);
  });

  it("a broken view file's card has a dashed oxblood edge", async () => {
    renderAt("/views/broken", { "/api/views/broken": { body: { id: "broken", url: "/views/broken", view: null, error: "bad" } } });
    const card = await screen.findByRole("alert");
    expect(card.className).toMatch(/border-dashed/);
  });

  it("journey rows in a spec-filtered widget open the journey's Specs tab", async () => {
    renderAt("/views/audit", { "/api/views/audit": { body: ok("audit", [{ type: "journeys", title: "No spec", filter: { spec: "none" } }]) } });
    const list = await screen.findByRole("list", { name: "No spec" });
    const link = await within(list).findByRole("link", { name: /Admin voids an invoice/ });
    expect(link.getAttribute("href")).toMatch(/\/journeys\/j_void\?tab=specs$/);
  });

  it("the home view's caption reads as a sentence before the workspace name loads", async () => {
    renderAt("/", { "/api/overview": "pending", "/api/views/home": { body: ok("home", [{ type: "note", markdown: "Hi." }], "Team home") } });
    await screen.findByRole("heading", { level: 1, name: "Team home" });
    expect(screen.getByText(/custom Home made by your agent/).textContent).toMatch(/^A custom Home/);
  });
});

describe("Home and the home view", () => {
  it("renders the home view when it is valid", async () => {
    renderAt("/", { "/api/views/home": { body: ok("home", [{ type: "note", markdown: "Welcome to **demo-shop**." }], "Team home") } });
    expect(await screen.findByRole("heading", { level: 1, name: "Team home" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("demo-shop", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "User journeys" })).toBeNull();
  });

  it("renders the built-in Home when there is no home view", async () => {
    renderAt("/", { "/api/views/home": { body: { id: "home", url: "/", view: null } } });
    expect(await screen.findByRole("heading", { level: 1, name: "demo-shop" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "User journeys" })).toBeInTheDocument();
    expect(screen.queryByText(/home view can't be read/)).toBeNull();
  });

  it("shows one neutral loading state, never the built-in Home skeleton, while the home view loads", async () => {
    renderAt("/", { "/api/views/home": "pending" });
    const loading = await screen.findByTestId("home-view-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("home-loading")).toBeNull();
    expect(screen.queryByTestId("screen-home")).toBeNull();
    expect(screen.queryByRole("list", { name: "User journeys" })).toBeNull();
  });

  it("goes straight from the loading state to a valid home view, never through the built-in Home", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = stubApi({ "/api/views/home": { body: ok("home", [{ type: "note", markdown: "Hello." }], "Team home") } });
    const real = fetch.getMockImplementation()!;
    fetch.mockImplementation((url: string) => (url.split("?")[0] === "/api/views/home" ? gate.then(() => real(url)) : real(url)));
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="home-loading"]')) seen.push("skeleton");
      if (document.querySelector('[aria-label="User journeys"]')) seen.push("list");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<App router={router} queryClient={queryClient} />);
    await screen.findByTestId("home-view-loading");
    release();
    expect(await screen.findByRole("heading", { level: 1, name: "Team home" })).toBeInTheDocument();
    observer.disconnect();
    expect(seen).toEqual([]);
  });

  it("does not loop when the overview fails: the view request and the overview request each go out once", async () => {
    const fetch = stubApi({
      "/api/overview": { status: 500, body: { error: "boom" } },
      "/api/views/home": { body: ok("home", [{ type: "note", markdown: "Hello." }], "Team home") },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<App router={router} queryClient={queryClient} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Team home" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    const calls = (path: string) => fetch.mock.calls.filter(([u]) => String(u).split("?")[0] === path).length;
    expect(calls("/api/views/home")).toBe(1);
    expect(calls("/api/overview")).toBeLessThanOrEqual(2);
  });

  it("falls back to the built-in Home when the view request itself fails, even with a failing overview", async () => {
    const fetch = stubApi({
      "/api/overview": { status: 500, body: { error: "boom" } },
      "/api/views/home": { status: 500, body: { error: "boom" } },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<App router={router} queryClient={queryClient} />);
    expect(await screen.findByTestId("screen-home")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("home-view-loading")).toBeNull();
    expect(fetch.mock.calls.filter(([u]) => String(u).split("?")[0] === "/api/views/home").length).toBe(1);
  });

  it("falls back to the built-in Home with a quiet notice when home.json is broken", async () => {
    renderAt("/", { "/api/views/home": { body: { id: "home", url: "/", view: null, error: "views/home.json: bad JSON. Run codeloom doctor." } } });
    expect(await screen.findByRole("list", { name: "User journeys" })).toBeInTheDocument();
    const notice = screen.getByRole("status", { name: "Home view" });
    expect(notice).toHaveTextContent("Your home view can't be read");
    expect(notice).toHaveTextContent("codeloom doctor");
  });
});
