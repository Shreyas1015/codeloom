import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { CodeResponse, NeighborsResult, NodeResult, Overview } from "@/api/types";
import { createAppRouter } from "@/router";
import { chainResult, journeyResult, orphanedResult } from "./fixtures/journey";

const overview: Overview = {
  name: "demo-shop",
  repos: [],
  chains: { total: 2, complete: 1, byConfidence: { exact: 0, param: 1, guess: 1 } },
  journeys: { total: 1, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

const storeNode: NodeResult = {
  ref: "api::fn:app/controllers/invoices_controller.ts:InvoicesController.store",
  node: { type: "function", name: "InvoicesController.store", filePath: "app/controllers/invoices_controller.ts", lineRange: [41, 52] },
  summary: "Validates the invoice and saves it for the customer.",
  edges: { out: [], in: [], truncated: false },
  chains: ["ch_aaaa"],
  journeys: [
    { id: "j_invoice", name: "Customer creates an invoice" },
    { id: "j_edit", name: "Customer edits an invoice" },
  ],
};
const storeNeighbors: NeighborsResult = {
  root: storeNode.ref,
  neighbors: [
    { ref: "api::fn:start/routes.ts:routes", name: "routes", type: "function", depth: 1, via: { type: "calls", direction: "in" } },
    { ref: "api::fn:app/services/invoice.ts:InvoiceService.create", name: "InvoiceService.create", type: "function", depth: 1, via: { type: "calls", direction: "out" } },
    { ref: "api::file:app/models/invoice.ts", name: "invoice.ts", type: "file", depth: 1, via: { type: "imports", direction: "out" } },
  ],
  truncated: false,
};

function codeFor(url: URL): CodeResponse {
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));
  const lines = Array.from({ length: end - start + 1 }, (_, i) => `// line ${start + i}`);
  return { file: url.searchParams.get("file")!, startLine: start, endLine: end, text: lines.join("\n"), truncated: false };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubApi(journeys: Record<string, unknown> = { j_invoice: journeyResult, ch_aaaa: chainResult }) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);
    if (p === "/api/overview") return json(overview);
    if (p.startsWith("/api/journeys/")) {
      const body = journeys[p.slice("/api/journeys/".length)];
      return body ? json(body) : json({ error: "Unknown journey" }, 404);
    }
    if (p === "/api/code") return json(codeFor(url));
    if (p === `/api/node/${storeNode.ref}`) return json(storeNode);
    if (p === `/api/neighbors/${storeNode.ref}`) return json(storeNeighbors);
    if (p.startsWith("/api/node/")) return json({ ...storeNode, ref: p.slice(10), summary: null, journeys: [] });
    if (p.startsWith("/api/neighbors/")) return json({ root: p.slice(15), neighbors: [], truncated: false });
    return json({ error: "nope" }, 404);
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

const lane = (name: string) => screen.getByRole("region", { name });
const urls = (fetch: ReturnType<typeof stubApi>) => fetch.mock.calls.map((c) => decodeURIComponent(String(c[0])));

describe("Journey screen", () => {
  it("shows the nameplate with name, area, note, confidence, completeness and counts", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    const title = await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    const plate = title.closest("header")!;
    expect(within(plate).getByText("Invoices")).toBeInTheDocument();
    expect(within(plate).getByText("From the new-invoice form down to the invoices table.")).toBeInTheDocument();
    expect(within(plate).getByText("7 stops · 2 repos · 1 table")).toBeInTheDocument();
    expect(within(plate).getByText("2 chains")).toBeInTheDocument();
    expect(within(plate).getByText("Has guesses")).toBeInTheDocument();
    expect(within(plate).getByText("Incomplete")).toBeInTheDocument();
  });

  it("lays the stops out in UI / API / Code / DB lanes, numbered in chain order; no Queue lane without queue stops", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    const names = (r: HTMLElement) => within(r).queryAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names(lane("UI"))).toEqual(["Stop 1: /invoices/new", "Stop 2: POST /api/invoices", "Stop 6: GET /api/customers"]);
    expect(names(lane("API"))).toEqual([
      "Stop 3: POST /api/invoices",
      "Stop 4: InvoicesController.store",
      "Stop 7: GET /api/customers (unresolved)",
    ]);
    expect(names(lane("DB"))).toEqual(["Stop 5: invoices"]);
    expect(within(lane("Code")).getByText("No stops in this lane")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Queue" })).toBeNull();
  });

  it("draws a connector for every hop, styled by its confidence", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    const wires = document.querySelectorAll<SVGPathElement>('[data-slot="journey-wire"]');
    const byHop = new Map([...wires].map((w) => [`${w.dataset.from}>${w.dataset.to}`, w]));
    // cross-lane hops (and the same-lane hop that skips a stop) are SVG wires
    expect([...byHop.keys()].sort()).toEqual(["1>6", "2>3", "4>5", "6>7"]);
    expect(byHop.get("2>3")!.dataset.confidence).toBe("param");
    expect(byHop.get("2>3")!.getAttribute("stroke-width")).toBe("1.25");
    expect(byHop.get("2>3")!.getAttribute("stroke-dasharray")).toBeNull();
    expect(byHop.get("4>5")!.dataset.confidence).toBe("exact");
    expect(byHop.get("4>5")!.getAttribute("stroke-width")).toBe("2");
    expect(byHop.get("6>7")!.dataset.confidence).toBe("guess");
    expect(byHop.get("6>7")!.getAttribute("stroke-dasharray")).toBe("4 3");

    // neighbouring stops in one lane use the lane's own line: 1→2 is an exact hop, 3→4 too
    const uiLines = lane("UI").querySelectorAll('[data-slot="confidence-line"]');
    expect(uiLines[0]).toHaveAttribute("data-confidence", "exact");
    // 2 and 6 sit next to each other but no chain goes 2 → 6: never drawn as a solid fact
    expect(uiLines[1]).toHaveAttribute("data-stroke", "dashed");
  });

  it("lists unresolved hops under the lanes with file:line and reason", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    const list = await screen.findByRole("list", { name: "Unresolved hops" });
    expect(within(list).getByText("api · start/routes.ts:12")).toBeInTheDocument();
    expect(within(list).getByText("No handler found for GET /api/customers")).toBeInTheDocument();
  });

  it("selects the stop from the URL and loads its code ±12 lines with the stop line highlighted", async () => {
    const fetch = stubApi();
    renderAt("/journeys/j_invoice?stop=4");
    const inspector = await screen.findByRole("complementary", { name: "Stop inspector" });
    expect(await within(inspector).findByRole("heading", { name: "InvoicesController.store" })).toBeInTheDocument();
    expect(within(inspector).getByText("app/controllers/invoices_controller.ts:41")).toBeInTheDocument();
    const block = await within(inspector).findByRole("region", { name: /invoices_controller\.ts, lines 29–53/ });
    const hl = block.querySelectorAll("[data-highlighted='']");
    expect([...hl].map((e) => e.getAttribute("data-line"))).toEqual(["41"]);
    expect(urls(fetch)).toContain("/api/code?repo=api&file=app/controllers/invoices_controller.ts&start=29&end=53");
    expect(within(lane("API")).getByRole("button", { name: "Stop 4: InvoicesController.store" })).toHaveAttribute("aria-current", "step");
  });

  it("shows the summary, callers, callees and other journeys for a stop with a ref", async () => {
    stubApi();
    renderAt("/journeys/j_invoice?stop=4");
    const inspector = await screen.findByRole("complementary", { name: "Stop inspector" });
    expect(await within(inspector).findByText("Validates the invoice and saves it for the customer.")).toBeInTheDocument();
    const calledBy = await within(inspector).findByRole("list", { name: "Called by" });
    expect(within(calledBy).getByText("routes")).toBeInTheDocument();
    const calls = within(inspector).getByRole("list", { name: "Calls" });
    expect(within(calls).getByText("InvoiceService.create")).toBeInTheDocument();
    expect(within(calls).queryByText("invoice.ts")).toBeNull();
    const also = within(inspector).getByRole("list", { name: "Also in journeys" });
    const link = within(also).getByRole("link", { name: "Customer edits an invoice" });
    expect(link).toHaveAttribute("href", "/journeys/j_edit");
    expect(within(also).queryByText("Customer creates an invoice")).toBeNull();
  });

  it("clicking a stop selects it and puts it in the URL", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice");
    await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    await userEvent.click(within(lane("DB")).getByRole("button", { name: "Stop 5: invoices" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 5 }));
    const inspector = screen.getByRole("complementary", { name: "Stop inspector" });
    expect(within(inspector).getByRole("heading", { name: "invoices" })).toBeInTheDocument();
  });

  it("←/→ move between stops", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice?stop=2");
    await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    act(() => void fireEvent.keyDown(document.body, { key: "ArrowRight" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 3 }));
    act(() => void fireEvent.keyDown(document.body, { key: "ArrowLeft" }));
    act(() => void fireEvent.keyDown(document.body, { key: "ArrowLeft" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 1 }));
    act(() => void fireEvent.keyDown(document.body, { key: "ArrowLeft" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 1 }));
  });

  it("the Chains tab lists each chain's stops with per-hop confidence and its unresolved hops", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });
    await userEvent.click(screen.getByRole("tab", { name: "Chains" }));
    const b = screen.getByRole("region", { name: "GET /api/customers" });
    const steps = within(b).getByRole("list", { name: "Stops" });
    expect(within(steps).getAllByRole("button").map((x) => x.getAttribute("aria-label"))).toEqual([
      "Stop 1: /invoices/new",
      "Stop 6: GET /api/customers",
      "Stop 7: GET /api/customers (unresolved)",
    ]);
    const guess = within(steps).getByRole("img", { name: /Guessed link: URL built at runtime/ });
    expect(guess).toHaveAttribute("data-stroke", "dashed");
    expect(within(b).getByText("No handler found for GET /api/customers")).toBeInTheDocument();
    const a = screen.getByRole("region", { name: "POST /api/invoices" });
    expect(within(a).getByRole("img", { name: "Matched with a path parameter" })).toHaveAttribute("data-stroke", "thin");
  });

  it("a chain id shows the chain, marked as not in a journey yet", async () => {
    stubApi();
    renderAt("/journeys/ch_aaaa");
    const title = await screen.findByRole("heading", { level: 1, name: "POST /api/invoices" });
    expect(within(title.closest("header")!).getByText("Not in a journey yet")).toBeInTheDocument();
    expect(within(lane("UI")).getAllByRole("button")).toHaveLength(2);
  });

  it("an unknown id shows a not-found state", async () => {
    stubApi();
    renderAt("/journeys/j_nope");
    expect(await screen.findByRole("heading", { name: "Journey not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to all journeys" })).toHaveAttribute("href", "/");
  });

  it("an orphaned journey shows the banner", async () => {
    stubApi({ j_invoice: orphanedResult });
    renderAt("/journeys/j_invoice");
    expect(await screen.findByText(/This journey's code is gone/)).toBeInTheDocument();
    expect(screen.getByText(/re-name or delete it through your agent/i)).toBeInTheDocument();
  });

  it("remembers the journey as last opened for Home's continue band", async () => {
    stubApi();
    const set = vi.spyOn(Storage.prototype, "setItem");
    renderAt("/journeys/j_invoice");
    await waitFor(() => expect(set).toHaveBeenCalledWith("codeloom:last-journey:demo-shop", "j_invoice"));
  });

  it("does not remember an unknown id", async () => {
    stubApi();
    const set = vi.spyOn(Storage.prototype, "setItem");
    renderAt("/journeys/j_nope");
    await screen.findByRole("heading", { name: "Journey not found" });
    expect(set).not.toHaveBeenCalledWith(expect.stringContaining("last-journey"), "j_nope");
  });

  it("still renders when storage throws", async () => {
    stubApi();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderAt("/journeys/j_invoice");
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(screen.getByRole("heading", { level: 1, name: "Customer creates an invoice" })).toBeInTheDocument();
  });
});
