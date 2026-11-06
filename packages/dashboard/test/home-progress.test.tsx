import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { JourneyRow, JourneysResponse, Overview } from "@/api/types";
import { rememberTourStop } from "@/lib/tourPosition";
import { createAppRouter } from "@/router";
import { lastJourneyKey } from "@/screens/home/lastJourney";
import { journeyResult } from "./fixtures/journey";
import { noTour, progress, tour } from "./fixtures/progress";

const overview: Overview = {
  name: "demo-shop",
  repos: [{ id: "api", path: "api", role: "api", files: 120, nodes: 300, edges: 500, pages: 0, routes: 14, calls: 0, tables: 5, queues: 1 }],
  chains: { total: 8, complete: 6, byConfidence: { exact: 6, param: 2, guess: 0 } },
  journeys: { total: 5, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

function row(id: string, name: string, area: string): JourneyRow {
  return {
    id,
    name,
    area,
    note: "",
    status: "ok",
    chainIds: [],
    repos: ["api"],
    stops: { ui: 1, api: 1, code: 1, db: 1, queue: 0 },
    confidence: "exact",
    complete: true,
    apiOnly: false,
    tables: [],
  };
}

const journeys: JourneysResponse = {
  journeys: [
    row("j_void", "Admin voids an invoice", "Invoices"),
    row("j_invoice", "Customer creates an invoice", "Invoices"),
    row("j_edit", "Customer edits a profile", "Customers"),
    row("j_signup", "Customer signs up", "Customers"),
    row("j_email", "Invoice is emailed", "Invoices"),
  ],
  unnamedChains: [],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Routes = Record<string, () => Response>;
const base: Routes = {
  "/api/overview": () => json(overview),
  "/api/journeys": () => json(journeys),
  "/api/progress": () => json(progress),
  "/api/tours/j_void": () => json(tour("j_void")),
  "/api/tours/j_invoice": () => json(tour("j_invoice")),
  "/api/tours/j_email": () => json(noTour("j_email")),
  "/api/journeys/j_invoice": () => json(journeyResult),
};

function renderAt(path: string, routes: Routes = base) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const p = decodeURIComponent(new URL(String(input), "http://127.0.0.1").pathname);
      if (p === "/api/code") return json({ file: "x", startLine: 1, endLine: 1, text: "", truncated: false });
      const hit = routes[p];
      return hit ? hit() : json({ error: "nope" }, 404);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
});

describe("Home: understood %", () => {
  it("shows the understood share in the header", async () => {
    renderAt("/");
    const under = await screen.findByTestId("home-understood");
    expect(under).toHaveTextContent("20%");
    expect(under).toHaveTextContent("1 of 5 journeys understood");
  });

  it("leaves it out when progress cannot load", async () => {
    renderAt("/", { ...base, "/api/progress": () => json({ error: "nope" }, 500) });
    await screen.findByRole("list", { name: "User journeys" });
    expect(screen.queryByTestId("home-understood")).toBeNull();
    expect(screen.queryByText("Your progress")).toBeNull();
  });

  it("puts the share on the rail's Progress item, Home staying current", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const link = within(nav).getByRole("link", { name: /Progress/ });
    await waitFor(() => expect(link).toHaveTextContent("20%"));
    expect(link).not.toHaveAttribute("aria-current");
    expect(within(nav).getByRole("link", { name: /Home/ })).toHaveAttribute("aria-current", "page");
  });
});

describe("Home: a progress strip per journey row", () => {
  it("shows every journey's level as three steps", async () => {
    renderAt("/");
    const list = await screen.findByRole("list", { name: "User journeys" });
    await waitFor(() => expect(list.querySelectorAll("[data-level]")).toHaveLength(5));
    const level = (name: string) => within(list).getByRole("link", { name: new RegExp(name) }).querySelector("[data-level]");
    expect(level("Admin voids")).toHaveAttribute("data-level", "toured");
    expect(level("Admin voids")).toHaveTextContent("Toured");
    expect(level("Customer creates an invoice")).toHaveAttribute("data-level", "re-walk");
    expect(level("Customer creates an invoice")).toHaveTextContent("Re-walk 1 stop");
    expect(level("Customer edits")).toHaveTextContent("Not started");
    expect(level("Customer signs up")).toHaveTextContent("Understood");
    expect(level("Invoice is emailed")).toHaveTextContent("Seen");
  });
});

describe("Home: the Continue band resumes the next unfinished tour stop", () => {
  it("resumes the last opened journey at the remembered tour stop", async () => {
    localStorage.setItem(lastJourneyKey("demo-shop"), "j_void");
    rememberTourStop("demo-shop", "j_void", { phase: "check", stop: 3 });
    renderAt("/");
    const band = await screen.findByRole("region", { name: "Continue: Admin voids an invoice" });
    const go = await within(band).findByRole("link", { name: /Resume tour/ });
    expect(go).toHaveAttribute("href", "/journeys/j_void/tour?phase=check&stop=3");
    expect(band).toHaveTextContent("Stop 3 of 3 · Check yourself");
  });

  it("starts the tour at stop 1 when nothing was remembered, and goes there on click", async () => {
    localStorage.setItem(lastJourneyKey("demo-shop"), "j_void");
    const router = renderAt("/");
    const band = await screen.findByRole("region", { name: "Continue: Admin voids an invoice" });
    const go = await within(band).findByRole("link", { name: /Start tour/ });
    expect(go).toHaveAttribute("href", "/journeys/j_void/tour?phase=flow&stop=1");
    expect(band).toHaveTextContent("Stop 1 of 3 · NewInvoicePage");
    await userEvent.click(go);
    await waitFor(() => expect(router.state.location.href).toBe("/journeys/j_void/tour?phase=flow&stop=1"));
  });

  it("picks the unfinished journey touched last when the last opened one is understood", async () => {
    localStorage.setItem(lastJourneyKey("demo-shop"), "j_signup");
    renderAt("/");
    expect(await screen.findByRole("region", { name: "Continue: Admin voids an invoice" })).toBeInTheDocument();
  });

  it("sends a journey that needs a re-walk to its first changed stop", async () => {
    localStorage.setItem(lastJourneyKey("demo-shop"), "j_invoice");
    renderAt("/");
    const band = await screen.findByRole("region", { name: "Continue: Customer creates an invoice" });
    const go = await within(band).findByRole("link", { name: /Re-walk/ });
    expect(go).toHaveAttribute("href", "/journeys/j_invoice/tour?phase=flow&stop=2");
    expect(band).toHaveTextContent("1 stop changed · InvoicesController.store");
  });

  it("opens the journey when it has no tour yet", async () => {
    localStorage.setItem(lastJourneyKey("demo-shop"), "j_email");
    renderAt("/");
    const band = await screen.findByRole("region", { name: "Continue: Invoice is emailed" });
    await waitFor(() => expect(band).toHaveTextContent("No tour yet"));
    expect(within(band).getByRole("link", { name: /Open journey/ })).toHaveAttribute("href", "/journeys/j_email");
  });
});

describe("Journey nameplate: level badge", () => {
  // The Journey screen is lazy (it brings Shiki): load it once up front so the first test does not time out.
  beforeAll(async () => {
    await import("@/screens/journey/JourneyScreen");
  }, 60_000);

  it("says the journey needs a re-walk and how many stops changed", async () => {
    renderAt("/journeys/j_invoice");
    const title = await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    const header = title.closest("header")!;
    await waitFor(() => expect(within(header).getByText("Needs re-walk · 1 stop changed")).toHaveAttribute("data-level", "re-walk"));
  });

  it("shows no badge when progress cannot load", async () => {
    renderAt("/journeys/j_invoice", { ...base, "/api/progress": () => json({ error: "nope" }, 500) });
    const title = await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    expect(title.closest("header")!.querySelector("[data-level]")).toBeNull();
  });
});
