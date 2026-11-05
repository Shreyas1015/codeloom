import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createAppRouter } from "@/router";
import type {
  GraphLevel,
  JourneyResult,
  JourneysResponse,
  NeighborsResult,
  NodeResult,
  Overview,
  SearchResult,
  StopView,
} from "@/api/types";

// React Flow reads the viewport transform through DOMMatrixReadOnly, which jsdom lacks.
beforeAll(async () => {
  // the route lazy-loads the screen; load it once up front so the first test is not timed against the import
  await import("@/screens/map/MapScreen");
  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    class DOMMatrixReadOnly {
      m22 = 1;
      constructor(_init?: string) {}
    }
    vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnly);
    (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnly;
  }
});

const overview: Overview = {
  name: "demo-shop",
  repos: [
    { id: "api", path: "api", role: "api", files: 6, nodes: 30, edges: 40, pages: 0, routes: 4, calls: 0, tables: 2, queues: 0 },
    { id: "web", path: "web", role: "ui", files: 3, nodes: 10, edges: 12, pages: 2, routes: 0, calls: 2, tables: 0, queues: 0 },
  ],
  chains: { total: 2, complete: 2, byConfidence: { exact: 2, param: 0, guess: 0 } },
  journeys: { total: 1, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

const CUSTOMER_SERVICE = "api::file:app/customer_service.ts";

const levels: Record<string, GraphLevel> = {
  "api/": {
    repo: "api",
    dir: "",
    folders: [
      { path: "app", name: "app", files: 5 },
      { path: "start", name: "start", files: 1, layer: "api" },
    ],
    files: [],
    edges: [{ from: "start", to: "app", type: "calls", count: 2 }],
  },
  "api/app": {
    repo: "api",
    dir: "app",
    folders: [{ path: "app/controllers", name: "controllers", files: 2, layer: "api" }],
    files: [
      {
        ref: CUSTOMER_SERVICE,
        path: "app/customer_service.ts",
        name: "customer_service.ts",
        layer: "api",
        functions: [
          { ref: "api::function:app/customer_service.ts:create", name: "create", type: "function", line: 4 },
          { ref: "api::function:app/customer_service.ts:update", name: "update", type: "function", line: 20 },
        ],
        journeys: ["j_create_customer"],
      },
      { ref: "api::file:app/invoice_service.ts", path: "app/invoice_service.ts", name: "invoice_service.ts", layer: "data", functions: [], journeys: [] },
    ],
    edges: [],
  },
  "web/": {
    repo: "web",
    dir: "",
    folders: [{ path: "src", name: "src", files: 3, layer: "ui" }],
    files: [],
    edges: [],
  },
};

const stop = (lane: StopView["lane"], repo: string, file: string, line: number, symbol: string): StopView => ({
  lane,
  kind: "function",
  repo,
  file,
  line,
  symbol,
  confidence: "exact",
});

const journey = {
  journey: { id: "j_create_customer", name: "Create a customer", area: "Customers", note: "", chainIds: ["ch_1"], status: "ok" },
  chains: [
    {
      id: "ch_1",
      name: "POST /customers",
      entry: "src/pages/customers.tsx",
      routeKey: "POST /customers",
      confidence: "exact",
      complete: true,
      journeys: ["j_create_customer"],
      stops: [
        stop("ui", "web", "src/pages/customers.tsx", 3, "CustomersPage"),
        stop("api", "api", "app/controllers/customers_controller.ts", 8, "store"),
        stop("code", "api", "app/customer_service.ts", 4, "create"),
      ],
      unresolved: [],
    },
  ],
  lanes: { ui: [], api: [], code: [], db: [], queue: [] },
  files: [],
  tables: [],
  queues: [],
  unresolved: [],
  missingChainIds: [],
  movedChainIds: [],
} as unknown as JourneyResult;

const journeys: JourneysResponse = {
  journeys: [
    {
      id: "j_create_customer",
      name: "Create a customer",
      area: "Customers",
      note: "",
      status: "ok",
      chainIds: ["ch_1"],
      repos: ["api", "web"],
      stops: { ui: 1, api: 1, code: 1, db: 0, queue: 0 },
      confidence: "exact",
      complete: true,
      apiOnly: false,
      tables: [],
    },
  ],
  unnamedChains: [],
};

const node: NodeResult = {
  ref: CUSTOMER_SERVICE,
  node: { type: "file", name: "customer_service.ts", filePath: "app/customer_service.ts", layer: "api" },
  summary: "Creates and updates customers.",
  edges: { out: [], in: [], truncated: false },
  chains: ["ch_1"],
  journeys: [{ id: "j_create_customer", name: "Create a customer" }],
};

const neighbors: NeighborsResult = {
  root: CUSTOMER_SERVICE,
  neighbors: [
    { ref: "api::file:app/controllers/customers_controller.ts", name: "customers_controller.ts", type: "file", depth: 1, via: { type: "imports", direction: "in" } },
    { ref: "api::file:app/models/customer.ts", name: "customer.ts", type: "file", depth: 1, via: { type: "imports", direction: "out" } },
    // v0.2a: method nodes reached by resolved calls edges
    { ref: "api::function:app/billing.ts:Billing.charge", name: "Billing.charge", type: "function", depth: 1, via: { type: "calls", direction: "out", confidence: "exact" } },
    { ref: "api::function:app/routes.ts:Routes.show", name: "Routes.show", type: "function", depth: 1, via: { type: "calls", direction: "in", confidence: "param" } },
    { ref: "api::function:app/legacy.ts:Legacy.run", name: "Legacy.run", type: "function", depth: 1, via: { type: "calls", direction: "out", confidence: "unverified" } },
  ],
  truncated: false,
};

const search: SearchResult = {
  results: [{ kind: "file", ref: "api::file:app/invoice_service.ts", name: "invoice_service.ts", repo: "api", file: "app/invoice_service.ts", score: 1 }],
  truncated: false,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubApi(extra: Record<string, GraphLevel> = {}) {
  const all = { ...levels, ...extra };
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://127.0.0.1");
    const p = url.pathname;
    if (p === "/api/overview") return json(overview);
    if (p === "/api/graph") {
      const level = all[`${url.searchParams.get("repo")}/${url.searchParams.get("dir") ?? ""}`];
      return level ? json(level) : json({ error: "no such folder" }, 404);
    }
    if (p === "/api/journeys") return json(journeys);
    if (p === "/api/journeys/j_create_customer") return json(journey);
    if (p.startsWith("/api/node/")) return json(node);
    if (p.startsWith("/api/neighbors/")) return json(neighbors);
    if (p === "/api/search") return json(search);
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const searchOf = (router: ReturnType<typeof renderAt>) => router.state.location.search as Record<string, string | undefined>;

describe("Map screen", () => {
  it("defaults to the first repo and renders its folders as cards with file counts and layer tags", async () => {
    const fetch = stubApi();
    renderAt("/map");
    const canvas = await screen.findByRole("application", { name: "Map of api" });
    expect(await within(canvas).findByRole("button", { name: "app/ folder, 5 files" })).toBeInTheDocument();
    const start = within(canvas).getByRole("button", { name: "start/ folder, 1 file, layer api" });
    expect(start).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/graph?repo=api&dir=", expect.anything());
    expect(within(screen.getByRole("group", { name: "Repo" })).getByRole("button", { name: "api" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders files with their function counts, and expands a file's functions inline on click", async () => {
    stubApi();
    const router = renderAt("/map?repo=api&dir=app");
    const card = await screen.findByRole("button", { name: /^customer_service\.ts, 2 functions/ });
    expect(screen.queryByRole("button", { name: "create(), line 4" })).not.toBeInTheDocument();
    await userEvent.click(card);
    expect(await screen.findByRole("button", { name: "create(), line 4" })).toBeInTheDocument();
    expect(card).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(searchOf(router).node).toBe(CUSTOMER_SERVICE));
  });

  it("drills into a folder on double-click and climbs back up with the breadcrumb", async () => {
    stubApi();
    const router = renderAt("/map?repo=api");
    const app = await screen.findByRole("button", { name: "app/ folder, 5 files" });
    await userEvent.dblClick(app);
    await waitFor(() => expect(searchOf(router).dir).toBe("app"));
    expect(await screen.findByRole("button", { name: /^customer_service\.ts/ })).toBeInTheDocument();

    const crumbs = screen.getByRole("navigation", { name: "Folder" });
    expect(within(crumbs).getByText("app")).toHaveAttribute("aria-current", "location");
    await userEvent.click(within(crumbs).getByRole("button", { name: "api" }));
    await waitFor(() => expect(searchOf(router).dir).toBeUndefined());
  });

  it("reaches cards with Tab and drills in with Enter", async () => {
    stubApi();
    const router = renderAt("/map?repo=api");
    const app = await screen.findByRole("button", { name: "app/ folder, 5 files" });
    const start = screen.getByRole("button", { name: /^start\/ folder/ });
    // DOM (and Tab) order follows the layout's columns: layer "api" (start/) first, unlayered (app/) after
    start.focus();
    expect(start).toHaveFocus();
    await userEvent.tab();
    expect(app).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(start).toHaveFocus();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(searchOf(router).dir).toBe("app"));
  });

  it("journey overlay: outlines the stop files with their roundel numbers and dims the rest", async () => {
    stubApi();
    renderAt("/map?repo=api&dir=app&overlay=journey:j_create_customer");
    const service = await screen.findByRole("button", { name: /^customer_service\.ts/ });
    const serviceCard = service.closest("[data-card]")!;
    await waitFor(() => expect(serviceCard).toHaveAttribute("data-overlay", "stop"));
    expect(within(serviceCard as HTMLElement).getByRole("img", { name: "Stop 3: create" })).toBeInTheDocument();

    const invoiceCard = screen.getByRole("button", { name: /^invoice_service\.ts/ }).closest("[data-card]")!;
    expect(invoiceCard).toHaveAttribute("data-overlay", "dim");
    // the folder holding stop 2 is a stop too
    const controllers = screen.getByRole("button", { name: /^controllers\/ folder/ }).closest("[data-card]")!;
    expect(controllers).toHaveAttribute("data-overlay", "stop");
    expect(within(controllers as HTMLElement).getByRole("img", { name: "Stop 2: store" })).toBeInTheDocument();
  });

  it("picks a journey overlay from the toolbar and writes it to the URL", async () => {
    stubApi();
    const router = renderAt("/map?repo=api&dir=app");
    const picker = await screen.findByRole("combobox", { name: "Journey overlay" });
    await within(picker).findByRole("option", { name: "Create a customer" });
    await userEvent.selectOptions(picker, "j_create_customer");
    await waitFor(() => expect(searchOf(router).overlay).toBe("journey:j_create_customer"));
  });

  it("layer overlay colours cards by layer", async () => {
    stubApi();
    const router = renderAt("/map?repo=api&dir=app");
    await screen.findByRole("button", { name: /^customer_service\.ts/ });
    await userEvent.click(screen.getByRole("button", { name: "Layers" }));
    await waitFor(() => expect(searchOf(router).overlay).toBe("layer"));
    const card = (name: RegExp) => screen.getByRole("button", { name }).closest("[data-card]")!;
    await waitFor(() => expect(card(/^customer_service\.ts/)).toHaveAttribute("data-lane", "api"));
    expect(card(/^invoice_service\.ts/)).toHaveAttribute("data-lane", "db");
    expect(screen.getByRole("button", { name: "Layers" })).toHaveAttribute("aria-pressed", "true");
  });

  it("inspector: path, layer, summary, functions with lines, journeys and neighbors of the selected file", async () => {
    stubApi();
    renderAt(`/map?repo=api&dir=app&node=${encodeURIComponent(CUSTOMER_SERVICE)}`);
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    expect(await within(inspector).findByText("Creates and updates customers.")).toBeInTheDocument();
    expect(within(inspector).getByRole("heading", { name: "customer_service.ts" })).toBeInTheDocument();
    expect(within(inspector).getByText("api/app/customer_service.ts")).toHaveClass("font-mono");
    expect(within(inspector).getByText("layer api")).toBeInTheDocument();
    const fns = within(inspector).getByRole("list", { name: "Functions" });
    expect(within(fns).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["create():4", "update():20"]);
    expect(within(inspector).getByRole("heading", { name: "In 1 journey" })).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "Create a customer" })).toHaveAttribute("href", "/journeys/j_create_customer");
    const near = await within(inspector).findByRole("list", { name: "Neighbors" });
    expect(within(near).getByText("customers_controller.ts")).toBeInTheDocument();
    expect(within(near).getByText("customer.ts")).toBeInTheDocument();
    // v0.2a: a resolved call says how sure it is
    const rows = within(near).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toContain("Billing.chargecalls · exact");
    // param on a call edge is a likely call, never "path param" (that wording is for route matches)
    expect(rows).toContain("Routes.showcalls it · likely (passed or wired, not a direct call)");
    // a tree-sitter edge the resolver could not check: labelled and dashed
    expect(rows).toContain("Legacy.runcalls · unverified");
    expect(within(near).getByText("calls · unverified")).toHaveClass("decoration-dashed");
    expect(rows).toContain("customer.tsimports");
  });

  it("search jumps to the hit's folder and selects it", async () => {
    stubApi();
    const router = renderAt("/map?repo=api");
    await screen.findByRole("button", { name: "app/ folder, 5 files" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search this repo" }), "invoice");
    const hit = await screen.findByRole("option", { name: /invoice_service\.ts/ });
    await userEvent.click(hit);
    await waitFor(() => expect(searchOf(router)).toMatchObject({ dir: "app", node: "api::file:app/invoice_service.ts" }));
  });

  it(`groups everything past 150 cards into one "+ N more files" card`, async () => {
    const files = Array.from({ length: 200 }, (_, i) => {
      const name = `invoice_${String(i).padStart(3, "0")}.ts`;
      return { ref: `api::file:big/${name}`, path: `big/${name}`, name, functions: [], journeys: [] };
    });
    stubApi({ "api/big": { repo: "api", dir: "big", folders: [], files, edges: [] } });
    renderAt("/map?repo=api&dir=big");
    expect(await screen.findByText("+ 51 more files")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^invoice_\d+\.ts/ })).toHaveLength(149);
  });

  it("switches repos from the toolbar", async () => {
    stubApi();
    const router = renderAt("/map?repo=api&dir=app");
    await screen.findByRole("button", { name: /^customer_service\.ts/ });
    await userEvent.click(within(screen.getByRole("group", { name: "Repo" })).getByRole("button", { name: "web" }));
    await waitFor(() => expect(searchOf(router)).toEqual({ repo: "web" }));
    expect(await screen.findByRole("button", { name: "src/ folder, 3 files, layer ui" })).toBeInTheDocument();
  });

  it("shows a short inline message when the map is not indexed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.startsWith("/api/overview") ? json(overview) : json({ error: "Not indexed yet. Run codeloom index.", code: "not-indexed" }, 409),
      ),
    );
    renderAt("/map?repo=api");
    expect(await screen.findByRole("region", { name: /isn't mapped yet/ })).toHaveTextContent("Not indexed yet. Run codeloom index.");
  });
});
