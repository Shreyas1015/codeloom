import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { Overview } from "@/api/types";
import { keyIdentity } from "@/lib/journey-stops";
import { createAppRouter } from "@/router";
import { emptyProgress, K_STORE, noTour, progress, tour } from "./fixtures/progress";

// a stopId looks like JSON (it starts with `[`), so the router's default search codec re-wraps it in
// JSON.stringify to round-trip it symmetrically through parseSearch (see @tanstack/router-core/searchParams)
const storeStopId = encodeURIComponent(JSON.stringify(keyIdentity(K_STORE)!));

const overview: Overview = {
  name: "demo-shop",
  repos: [
    { id: "api", path: "api", role: "api", files: 120, nodes: 300, edges: 500, pages: 0, routes: 14, calls: 0, tables: 5, queues: 1 },
    { id: "docs", path: "docs", role: "lib", files: 4, nodes: 4, edges: 0, pages: 0, routes: 0, calls: 0, tables: 0, queues: 0 },
    { id: "web", path: "web", role: "ui", files: 80, nodes: 150, edges: 200, pages: 9, routes: 0, calls: 22, tables: 0, queues: 0 },
  ],
  chains: { total: 8, complete: 6, byConfidence: { exact: 6, param: 2, guess: 0 } },
  journeys: { total: 5, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubApi(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const p = decodeURIComponent(new URL(String(input), "http://127.0.0.1").pathname);
    const hit = routes[p];
    return hit ? hit() : json({ error: "nope" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const base = {
  "/api/overview": () => json(overview),
  "/api/journeys": () => json({ journeys: [], unnamedChains: [] }),
  "/api/progress": () => json(progress),
  "/api/tours/j_invoice": () => json(tour("j_invoice", [])),
};

function renderAt(path: string, routes: Record<string, () => Response> = base) {
  stubApi(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

describe("Progress screen (/progress)", () => {
  it("says how many journeys you understand, with the legend and where the file lives", async () => {
    renderAt("/progress");
    expect(await screen.findByRole("heading", { level: 1, name: "You understand 1 of 5 journeys" })).toBeInTheDocument();
    const s = screen.getByTestId("screen-progress");
    expect(s).toHaveTextContent("4 journeys left across 2 repos"); // only repos with something left
    expect(within(s).getByRole("list", { name: "Legend" })).toBeInTheDocument();
    expect(s).toHaveTextContent("/home/dev/.codeloom/progress/0123456789abcdef.json");
  });

  it("is the current rail item, with the understood share as its count", async () => {
    renderAt("/progress");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const link = await within(nav).findByRole("link", { name: /Progress/ });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("href", "/progress");
    await waitFor(() => expect(link).toHaveTextContent("20%"));
    expect(within(nav).getByRole("link", { name: /Home/ })).not.toHaveAttribute("aria-current");
  });

  it("lists every repo on one shared scale: strip, understood, toured and left", async () => {
    renderAt("/progress");
    const table = await screen.findByRole("table", { name: "Progress by repo" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["api", "", "1 / 4", "3 / 4", "3 journeys"],
      ["docs", "", "0 / 0", "0 / 0", "No journeys"],
      ["web", "", "1 / 3", "2 / 3", "2 journeys"],
    ]);
    expect(within(rows[0]!).getByRole("img", { name: "1 understood, 2 toured, 1 seen, of 4 journeys" })).toBeInTheDocument();
    const tracks = rows.map((r) => (r.querySelector("[data-slot=progress-track]") as HTMLElement).style.width);
    expect(tracks).toEqual(["100%", "0%", "75%"]);
  });

  it("shows every area with its understood count and strip", async () => {
    renderAt("/progress");
    const areas = await screen.findByRole("list", { name: "Progress by area" });
    const items = within(areas).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Customers1 of 2 understood", "Invoices0 of 3 understood"]);
    expect(within(items[1]!).getByRole("img", { name: "2 toured, 1 seen, of 3 journeys" })).toBeInTheDocument();
  });

  it("lists journeys that need a re-walk with their changed stops, linked to those tour stops", async () => {
    renderAt("/progress");
    const panel = await screen.findByRole("region", { name: "Needs a re-walk" });
    expect(panel).toHaveTextContent("Customer creates an invoice");
    expect(panel).toHaveTextContent("1 stop changed");
    const stop = await within(panel).findByRole("link", { name: /InvoicesController\.store/ });
    expect(stop).toHaveAttribute("href", `/journeys/j_invoice/tour?phase=flow&stop=2&stopId=${storeStopId}`);
    expect(stop).toHaveTextContent("app/controllers/invoices_controller.ts:41");
    expect(within(panel).getByRole("link", { name: "Re-walk Customer creates an invoice" })).toHaveAttribute(
      "href",
      `/journeys/j_invoice/tour?phase=flow&stop=2&stopId=${storeStopId}`,
    );
  });

  it("sends a re-walk to the journey when it has no tour", async () => {
    renderAt("/progress", { ...base, "/api/tours/j_invoice": () => json(noTour("j_invoice")) });
    const panel = await screen.findByRole("region", { name: "Needs a re-walk" });
    await waitFor(() =>
      expect(within(panel).getByRole("link", { name: "Re-walk Customer creates an invoice" })).toHaveAttribute("href", "/journeys/j_invoice"),
    );
  });

  it("lists recent checks newest first, a failure said in words", async () => {
    renderAt("/progress");
    const checks = await screen.findByRole("list", { name: "Recent checks" });
    const items = within(checks).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Admin voids an invoiceNot passed · 25 Oct",
      "Customer signs upPassed · 22 Oct",
      "Customer creates an invoicePassed — needs re-walk · 21 Oct", // its code changed since the pass
    ]);
    expect(within(items[0]!).getByText("Not passed · 25 Oct")).toHaveAttribute("data-verdict", "fail");
  });

  it("lists what's left by area, each journey with its level, linked to it", async () => {
    renderAt("/progress");
    const left = await screen.findByRole("region", { name: "What's left" });
    const groups = within(left).getAllByRole("list");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Customers", "Invoices"]);
    expect(within(groups[0]!).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Customer edits a profileNot started"]);
    expect(within(groups[1]!).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Admin voids an invoiceToured",
      "Customer creates an invoiceNeeds re-walk",
      "Invoice is emailedSeen",
    ]);
    expect(within(groups[1]!).getByRole("link", { name: "Admin voids an invoice" })).toHaveAttribute("href", "/journeys/j_void");
  });

  it("suggests the furthest-along unfinished journey next", async () => {
    renderAt("/progress");
    const next = await screen.findByRole("link", { name: /Next suggested: Admin voids an invoice/ });
    expect(next).toHaveAttribute("href", "/journeys/j_void");
  });

  it("keeps progress for older journeys and says how to get a new tour", async () => {
    renderAt("/progress");
    const older = await screen.findByRole("region", { name: "For older journeys" });
    expect(older).toHaveTextContent("j_oldinvoice");
    expect(older).toHaveTextContent("/mcp__codeloom__write-tour");
    // a renamed journey's tour still opens in Tour mode; progress alone has nothing to open
    expect(within(older).getByRole("link", { name: /j_oldtour/ })).toHaveAttribute("href", "/journeys/j_oldtour/tour");
    expect(within(older).queryByRole("link", { name: /j_oldinvoice/ })).toBeNull();
  });

  it("has a plain empty state when there are no journeys", async () => {
    renderAt("/progress", { ...base, "/api/progress": () => json(emptyProgress) });
    expect(await screen.findByRole("heading", { level: 1, name: "No journeys to understand yet" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("screen-progress")).toHaveTextContent("/mcp__codeloom__name-journeys");
  });

  it("says when the progress file cannot be read, and the command that checks it", async () => {
    renderAt("/progress", {
      ...base,
      "/api/progress": () => json({ error: "progress file /home/dev/.codeloom/progress/x.json is not valid JSON", code: "bad-data" }, 409),
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your progress file can't be read");
    expect(alert).toHaveTextContent("is not valid JSON");
    expect(alert).toHaveTextContent("codeloom doctor");
    // the rest of the dashboard still works: the rail is there
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("shows a loading state while progress loads", async () => {
    renderAt("/progress", { ...base, "/api/progress": () => new Promise<Response>(() => {}) as unknown as Response });
    expect(await screen.findByTestId("progress-loading")).toHaveAttribute("aria-busy", "true");
  });
});
