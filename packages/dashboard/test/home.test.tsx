import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { JourneyRow, JourneysResponse, Overview } from "@/api/types";
import { createAppRouter } from "@/router";
import { lastJourneyKey } from "@/screens/home/lastJourney";

const overview: Overview = {
  name: "demo-shop",
  repos: [
    { id: "api", path: "api", role: "api", files: 120, nodes: 300, edges: 500, pages: 0, routes: 14, calls: 0, tables: 5, queues: 1 },
    { id: "web", path: "web", role: "ui", files: 80, nodes: 150, edges: 200, pages: 9, routes: 0, calls: 22, tables: 0, queues: 0 },
  ],
  chains: { total: 12, complete: 9, byConfidence: { exact: 8, param: 3, guess: 1 } },
  journeys: { total: 3, orphaned: 1 },
  unnamedChains: 2,
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
    stops: { ui: 0, api: 0, code: 0, db: 0, queue: 0 },
    confidence: "exact",
    complete: true,
    tables: [],
    ...p,
  };
}

const journeys: JourneysResponse = {
  journeys: [
    row({
      id: "j_void",
      name: "Admin voids an invoice",
      area: "Invoices",
      note: "soft delete",
      repos: ["api", "web"],
      stops: { ui: 1, api: 2, code: 0, db: 1, queue: 0 },
      confidence: "guess",
      complete: false,
      tables: ["invoices"],
    }),
    row({
      id: "j_signup",
      name: "Customer signs up",
      area: "Customers",
      note: "creates the customer row",
      repos: ["api", "web"],
      stops: { ui: 2, api: 1, code: 1, db: 1, queue: 0 },
      tables: ["customers"],
    }),
    row({
      id: "j_email",
      name: "Invoice is emailed",
      area: "Invoices",
      note: "worker sends the PDF",
      status: "orphaned",
      repos: ["api"],
      stops: { ui: 0, api: 1, code: 2, db: 1, queue: 1 },
      confidence: "param",
      tables: ["invoice_emails"],
    }),
  ],
  unnamedChains: [
    { id: "ch_aaa", name: "GET /api/customers/:id", entry: "web/src/pages/customer.tsx", confidence: "exact", complete: true, repos: ["api", "web"] },
    { id: "ch_bbb", name: "POST /api/invoices", entry: "api/src/routes/invoices.ts", confidence: "guess", complete: false, repos: ["api"] },
  ],
};

type Bodies = Record<string, { status?: number; body: unknown } | "pending">;

function stubApi(bodies: Bodies) {
  const fetch = vi.fn((url: string) => {
    const path = url.split("?")[0]!;
    const hit = bodies[path];
    if (hit === "pending") return new Promise<Response>(() => {});
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderHome(bodies: Bodies = { "/api/overview": { body: overview }, "/api/journeys": { body: journeys } }) {
  stubApi(bodies);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(<App router={router} queryClient={queryClient} />);
  return Object.assign(router, { queryClient });
}

async function list() {
  return screen.findByRole("list", { name: "User journeys" });
}
async function names() {
  const l = await list();
  return within(l)
    .getAllByRole("link")
    .map((a) => a.getAttribute("data-name"));
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("Home", () => {
  it("shows the workspace title, summary line and count strip", async () => {
    renderHome();
    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: "demo-shop" })).toBeInTheDocument();
    expect(within(main).getByText("3 journeys · 12 chains, 9 complete")).toBeInTheDocument();
    const strip = within(main).getByRole("list", { name: "Totals" });
    expect(strip).toHaveTextContent("200Files");
    expect(strip).toHaveTextContent("9UI pages");
    expect(strip).toHaveTextContent("14API routes");
    expect(strip).toHaveTextContent("5DB tables");
    expect(strip).toHaveTextContent("1Queues");
    expect(strip).toHaveTextContent("3User journeys");
  });

  it("renders a wall label per journey from /api/journeys", async () => {
    renderHome();
    expect(await names()).toEqual(["Admin voids an invoice", "Customer signs up", "Invoice is emailed"]);
    const l = await list();
    const signup = within(l).getByRole("link", { name: /Customer signs up/ });
    expect(signup).toHaveAttribute("href", "/journeys/j_signup");
    expect(signup).toHaveTextContent("Customers");
    expect(signup).toHaveTextContent("creates the customer row");
    expect(within(signup).getByLabelText("2 UI stops")).toBeInTheDocument();
    expect(within(signup).getByLabelText("1 API stop")).toBeInTheDocument();
    expect(within(signup).queryByLabelText(/Queue stop/)).toBeNull();
    expect(signup).toHaveTextContent("api, web");
    expect(signup).toHaveTextContent("Exact");
    expect(signup).toHaveTextContent("Complete");

    const vd = within(l).getByRole("link", { name: /Admin voids an invoice/ });
    expect(vd).toHaveTextContent("Guess");
    expect(vd).toHaveTextContent("Incomplete");
    const orphan = within(l).getByRole("link", { name: /Invoice is emailed/ });
    expect(orphan).toHaveTextContent("Orphaned");
    expect(vd).not.toHaveTextContent("Orphaned");
  });

  it.each([
    ["Area", "Customers", ["Customer signs up"]],
    ["Repo", "web", ["Admin voids an invoice", "Customer signs up"]],
    ["Confidence", "param", ["Invoice is emailed"]],
    ["Status", "incomplete", ["Admin voids an invoice"]],
    ["Status", "complete", ["Customer signs up", "Invoice is emailed"]],
  ])("filters by %s = %s", async (label, value, expected) => {
    renderHome();
    await list();
    await userEvent.selectOptions(screen.getByLabelText(label), value);
    expect(await names()).toEqual(expected);
  });

  it("names every lane in the stops column header", async () => {
    renderHome();
    const l = await list();
    expect(l.parentElement).toHaveTextContent("Stops · UI · API · Code · DB · Queue");
  });

  it("resets a filter to All when its value disappears after a live update", async () => {
    const { queryClient } = renderHome();
    await list();
    await userEvent.selectOptions(screen.getByLabelText("Area"), "Customers");
    expect(await names()).toEqual(["Customer signs up"]);
    act(() => {
      queryClient.setQueryData(["journeys"], { ...journeys, journeys: journeys.journeys.filter((j) => j.area !== "Customers") });
    });
    await waitFor(() => expect(screen.getByLabelText("Area")).toHaveValue(""));
    expect(await names()).toEqual(["Admin voids an invoice", "Invoice is emailed"]);
  });

  it("searches over name, area, note and tables", async () => {
    renderHome();
    await list();
    const box = screen.getByRole("searchbox", { name: "Search journeys" });
    await userEvent.type(box, "invoice_emails");
    expect(await names()).toEqual(["Invoice is emailed"]);
    await userEvent.clear(box);
    await userEvent.type(box, "soft delete");
    expect(await names()).toEqual(["Admin voids an invoice"]);
    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    expect(screen.getByText("No journeys match these filters.")).toBeInTheDocument();
  });

  it("sorts by stops and confidence", async () => {
    renderHome();
    await list();
    await userEvent.selectOptions(screen.getByLabelText("Sort"), "stops");
    expect(await names()).toEqual(["Customer signs up", "Invoice is emailed", "Admin voids an invoice"]);
    await userEvent.selectOptions(screen.getByLabelText("Sort"), "confidence");
    expect(await names()).toEqual(["Customer signs up", "Invoice is emailed", "Admin voids an invoice"]);
    await userEvent.selectOptions(screen.getByLabelText("Sort"), "area");
    expect(await names()).toEqual(["Customer signs up", "Admin voids an invoice", "Invoice is emailed"]);
  });

  it("moves focus with j/k and opens the focused journey with Enter", async () => {
    const router = renderHome();
    const l = await list();
    const links = within(l).getAllByRole("link");
    await userEvent.keyboard("j");
    expect(links[0]).toHaveFocus();
    await userEvent.keyboard("j");
    expect(links[1]).toHaveFocus();
    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    expect(links[2]).toHaveFocus();
    await userEvent.keyboard("k");
    expect(links[1]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/journeys/j_signup"));
  });

  it("does not steal j/k while typing in the search box", async () => {
    renderHome();
    await list();
    const box = screen.getByRole("searchbox", { name: "Search journeys" });
    await userEvent.type(box, "j");
    expect(box).toHaveFocus();
    expect(box).toHaveValue("j");
  });

  it("renders at most 200 rows, then 'Show more'", async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      row({ id: `j_${String(i).padStart(3, "0")}`, name: `Customer flow ${String(i).padStart(3, "0")}` }),
    );
    renderHome({ "/api/overview": { body: overview }, "/api/journeys": { body: { journeys: many, unnamedChains: [] } } });
    const l = await list();
    expect(within(l).getAllByRole("link")).toHaveLength(200);
    await userEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(within(l).getAllByRole("link")).toHaveLength(400);
    await userEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(within(l).getAllByRole("link")).toHaveLength(450);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  describe("continue band", () => {
    it("is hidden when nothing was opened", async () => {
      renderHome();
      await list();
      expect(screen.queryByRole("region", { name: /Continue/ })).toBeNull();
    });

    it("shows the last opened journey", async () => {
      localStorage.setItem(lastJourneyKey("demo-shop"), "j_signup");
      renderHome();
      const band = await screen.findByRole("region", { name: /Continue/ });
      expect(band).toHaveTextContent("Continue: Customer signs up");
      expect(within(band).getByRole("link", { name: /Open journey/ })).toHaveAttribute("href", "/journeys/j_signup");
    });

    it("says 'Open chain' for an unnamed chain", async () => {
      localStorage.setItem(lastJourneyKey("demo-shop"), "ch_aaa");
      renderHome();
      const band = await screen.findByRole("region", { name: /Continue/ });
      expect(within(band).getByRole("link", { name: /Open chain/ })).toHaveAttribute("href", "/journeys/ch_aaa");
    });

    it("is hidden when that journey no longer exists", async () => {
      localStorage.setItem(lastJourneyKey("demo-shop"), "j_gone");
      renderHome();
      await list();
      expect(screen.queryByRole("region", { name: /Continue/ })).toBeNull();
    });

    it("survives a storage that throws", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      renderHome();
      expect(await names()).toHaveLength(3);
      expect(screen.queryByRole("region", { name: /Continue/ })).toBeNull();
    });
  });

  describe("unnamed chains", () => {
    it("lists them with the agent hint and a copy button", async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderHome();
      const section = await screen.findByRole("region", { name: /Unnamed chains/ });
      expect(within(section).getByRole("heading", { name: /Unnamed chains/ })).toHaveTextContent("2");
      const items = within(section).getAllByRole("link");
      expect(items[0]).toHaveAttribute("href", "/journeys/ch_aaa");
      expect(items[0]).toHaveTextContent("GET /api/customers/:id");
      expect(items[0]).toHaveTextContent("web/src/pages/customer.tsx");
      expect(items[1]).toHaveTextContent("Guess");
      expect(items[1]).toHaveTextContent("Incomplete");
      expect(section).toHaveTextContent("Ask your agent: /codeloom:name-journeys");
      await act(async () => {
        fireEvent.click(within(section).getByRole("button", { name: /Copy/ }));
      });
      expect(writeText).toHaveBeenCalledWith("/codeloom:name-journeys");
      expect(await within(section).findByRole("button", { name: "Copied" })).toBeInTheDocument();
      expect(within(section).getByRole("status")).toHaveTextContent("Copied");
    });

    it("asks to select the text when the clipboard fails", async () => {
      const writeText = vi.fn(async () => {
        throw new Error("denied");
      });
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderHome();
      const section = await screen.findByRole("region", { name: /Unnamed chains/ });
      await act(async () => {
        fireEvent.click(within(section).getByRole("button", { name: /Copy/ }));
      });
      expect(within(section).getByRole("status")).toHaveTextContent("Copy failed — select the text");
      expect(within(section).getByText("/codeloom:name-journeys")).toHaveClass("select-all");
    });

    it("is hidden when every chain is named", async () => {
      renderHome({ "/api/overview": { body: overview }, "/api/journeys": { body: { ...journeys, unnamedChains: [] } } });
      await list();
      expect(screen.queryByRole("region", { name: /Unnamed chains/ })).toBeNull();
    });
  });

  describe("states", () => {
    it("shows a loading skeleton", async () => {
      renderHome({ "/api/overview": "pending", "/api/journeys": "pending" });
      expect(await screen.findByTestId("home-loading")).toHaveAttribute("aria-busy", "true");
    });

    it("shows 'No journeys found' with a Map link and the agent hint when there is nothing", async () => {
      renderHome({ "/api/overview": { body: overview }, "/api/journeys": { body: { journeys: [], unnamedChains: [] } } });
      const main = await screen.findByRole("main");
      expect(await within(main).findByText("No journeys found")).toBeInTheDocument();
      expect(within(main).getByRole("link", { name: /Open the map/ })).toHaveAttribute("href", "/map");
      expect(main).toHaveTextContent("/codeloom:name-journeys");
      expect(screen.queryByRole("list", { name: "User journeys" })).toBeNull();
    });

    it("shows the unnamed chains even with no named journeys", async () => {
      renderHome({ "/api/overview": { body: overview }, "/api/journeys": { body: { ...journeys, journeys: [] } } });
      expect(await screen.findByRole("region", { name: /Unnamed chains/ })).toBeInTheDocument();
      expect(screen.getByText("No named journeys yet.")).toBeInTheDocument();
    });

    it("shows the shared not-indexed state when the map is not usable", async () => {
      renderHome({
        "/api/overview": { status: 409, body: { error: "This folder is not indexed yet.", code: "not-indexed" } },
        "/api/journeys": { status: 409, body: { error: "This folder is not indexed yet.", code: "not-indexed" } },
      });
      const state = await screen.findByRole("region", { name: /isn't mapped yet/ });
      expect(state).toHaveTextContent("This folder is not indexed yet.");
      expect(within(state).getByText("codeloom index")).toBeInTheDocument();
    });

    it("shows the shared session-expired state", async () => {
      renderHome({
        "/api/overview": { status: 401, body: { error: "no session" } },
        "/api/journeys": { status: 401, body: { error: "no session" } },
      });
      expect(await screen.findByRole("region", { name: /session expired/i })).toHaveTextContent("Reopen the dashboard from your terminal");
    });
  });
});
