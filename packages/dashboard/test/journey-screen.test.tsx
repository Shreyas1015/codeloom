import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { CodeResponse, NeighborsResult, NodeResult, Overview } from "@/api/types";
import { createAppRouter } from "@/router";
import { lastJourneyKey } from "@/screens/home/lastJourney";
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
  ref: "api::function:app/controllers/invoices_controller.ts:InvoicesController.store",
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
    { ref: "api::function:start/routes.ts:routes", name: "routes", type: "function", depth: 1, via: { type: "calls", direction: "in" } },
    { ref: "api::function:app/services/invoice.ts:InvoiceService.create", name: "InvoiceService.create", type: "function", depth: 1, via: { type: "calls", direction: "out" } },
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

const pressKey = (key: string, target: Element = document.body) => act(() => void fireEvent.keyDown(target, { key }));
const opened = () => screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" });

// The Journey screen is lazy-loaded; transform it up front so the first test does not time out on the chunk.
beforeAll(async () => {
  await import("@/screens/journey/JourneyScreen");
}, 60_000);

describe("Journey screen", () => {
  it("shows the nameplate with name, area, note, confidence, completeness and counts", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    const title = await opened();
    const plate = title.closest("header")!;
    expect(within(plate).getByText("Invoices")).toBeInTheDocument();
    expect(within(plate).getByText("From the new-invoice form down to the invoices table.")).toBeInTheDocument();
    expect(within(plate).getByText("9 stops · 2 repos · 2 tables")).toBeInTheDocument();
    expect(within(plate).getByText("2 chains")).toBeInTheDocument();
    expect(within(plate).getByText("Has guesses")).toBeInTheDocument();
    expect(within(plate).getByText("Incomplete")).toBeInTheDocument();
  });

  it("names the other services the journey's pages call, only when there are some", async () => {
    stubApi({
      j_invoice: {
        ...journeyResult,
        external: [
          { name: "Payments", repo: "web", file: "lib/pay.ts", line: 3, symbol: "charge", method: "POST", path: "/charges" },
          { name: "Payments", repo: "web", file: "lib/pay.ts", line: 8, symbol: "refund", method: "POST", path: "/refunds" },
        ],
      },
    });
    renderAt("/journeys/j_invoice");
    const plate = (await opened()).closest("header")!;
    const calls = within(plate).getByText("calls Payments");
    expect(calls).toHaveAttribute("title", "POST /charges (web/lib/pay.ts:3)\nPOST /refunds (web/lib/pay.ts:8)");
  });

  it("shows no other-service note when the journey calls none", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    const plate = (await opened()).closest("header")!;
    expect(within(plate).queryByText(/^calls /)).toBeNull();
  });

  it("lays the stops out in UI / API / Code / DB lanes, numbered in chain order; no Queue lane without queue stops", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await opened();
    const names = (r: HTMLElement) => within(r).queryAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names(lane("UI"))).toEqual(["Stop 1: /invoices/new", "Stop 2: POST /api/invoices", "Stop 7: GET /api/customers"]);
    expect(names(lane("API"))).toEqual(["Stop 3: POST /api/invoices", "Stop 8: GET /api/customers"]);
    expect(names(lane("Code"))).toEqual(["Stop 4: InvoicesController.store", "Stop 9: CustomersController.index"]);
    expect(names(lane("DB"))).toEqual(["Stop 5: invoices", "Stop 6: invoice_lines"]);
    expect(screen.queryByRole("region", { name: "Queue" })).toBeNull();
  });

  it("draws a wire for every recorded hop across lanes, styled by its confidence, and nothing else", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await opened();
    const wires = document.querySelectorAll<SVGPathElement>('[data-slot="journey-wire"]');
    const byHop = new Map([...wires].map((w) => [`${w.dataset.from}>${w.dataset.to}`, w]));
    // cross-lane hops, and the same-lane hop 1 → 7 that skips stop 2; the handler fans out to both tables
    expect([...byHop.keys()].sort()).toEqual(["1>7", "2>3", "3>4", "4>5", "4>6", "7>8"]);
    expect(byHop.get("2>3")!.dataset.confidence).toBe("param");
    expect(byHop.get("2>3")!.getAttribute("stroke-width")).toBe("1.25");
    expect(byHop.get("2>3")!.getAttribute("stroke-dasharray")).toBeNull();
    expect(byHop.get("4>5")!.dataset.confidence).toBe("exact");
    expect(byHop.get("4>5")!.getAttribute("stroke-width")).toBe("2");
    expect(byHop.get("7>8")!.dataset.confidence).toBe("guess");
    expect(byHop.get("7>8")!.getAttribute("stroke-dasharray")).toBe("4 3");
  });

  it("lane neighbours get their real hop's line, or a plain gap when no hop joins them", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await opened();
    const items = (name: string) => within(lane(name)).getAllByRole("listitem");
    const line = (li: HTMLElement) => li.querySelector('[data-slot="confidence-line"]');
    const gap = (li: HTMLElement) => li.querySelector('[data-slot="lane-gap"]');
    const ui = items("UI");
    expect(line(ui[1]!)).toHaveAttribute("data-confidence", "exact"); // 1 → 2
    expect(line(ui[2]!)).toBeNull(); // 2 and 7 only share the lane
    expect(gap(ui[2]!)).not.toBeNull();
    const db = items("DB");
    expect(line(db[1]!)).toBeNull(); // two stores of one handler: no line between them
    expect(gap(db[1]!)).not.toBeNull();
    expect(line(items("Code")[1]!)).toBeNull(); // stop 9 has no `from`
    expect(line(items("API")[1]!)).toBeNull();
  });

  it("lists the hops for assistive tech, with confidence and reason", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await opened();
    const hops = screen.getByRole("list", { name: "Hops" });
    const texts = within(hops).getAllByRole("listitem").map((li) => li.textContent);
    expect(texts).toHaveLength(7);
    expect(texts).toContain("Stop 2 to stop 3: matched with a path parameter.");
    expect(texts).toContain("Stop 7 to stop 8: guessed link. URL built at runtime; matched by prefix");
  });

  it("lists unresolved items only under the lanes, never marking a stop unresolved", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    const list = await screen.findByRole("list", { name: "Unresolved hops" });
    expect(within(list).getByText("api · start/routes.ts:12")).toBeInTheDocument();
    expect(within(list).getByText("No handler found for GET /api/customers")).toBeInTheDocument();
    expect(within(lane("API")).getByRole("button", { name: "Stop 8: GET /api/customers" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="stop-roundel"][data-state="unresolved"]')).toBeNull();
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
    expect(within(lane("Code")).getByRole("button", { name: "Stop 4: InvoicesController.store" })).toHaveAttribute("aria-current", "step");
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

  it("lists the linker's hops to and from the stop, each with its confidence", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice?stop=4");
    const inspector = await screen.findByRole("complementary", { name: "Stop inspector" });
    const from = await within(inspector).findByRole("list", { name: "Reached from" });
    expect(from.textContent).toBe("3 · POST /api/invoices (exact)");
    const to = within(inspector).getByRole("list", { name: "Leads to" });
    expect(within(to).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["5 · invoices (exact)", "6 · invoice_lines (exact)"]);
    await userEvent.click(within(to).getByRole("button", { name: "6 · invoice_lines" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 6 }));
  });

  it("words a guessed hop as a guess, with its reason", async () => {
    stubApi();
    renderAt("/journeys/j_invoice?stop=8");
    const inspector = await screen.findByRole("complementary", { name: "Stop inspector" });
    const from = await within(inspector).findByRole("list", { name: "Reached from" });
    expect(within(from).getByText("(guess)")).toHaveAttribute("data-confidence", "guess");
    expect(within(from).getByText("URL built at runtime; matched by prefix")).toBeInTheDocument();
  });

  it("never states 'None found' for a stop whose ref fell back to its class", async () => {
    const classRef = "api::class:app/controllers/invoices_controller.ts:InvoicesController";
    const fallback = {
      ...journeyResult,
      chains: journeyResult.chains.map((c) => ({ ...c, stops: c.stops.map((s) => (s.ref === storeNode.ref ? { ...s, ref: classRef } : s)) })),
    };
    const fetch = stubApi({ j_invoice: fallback });
    renderAt("/journeys/j_invoice?stop=4");
    const inspector = await screen.findByRole("complementary", { name: "Stop inspector" });
    expect(await within(inspector).findByText(/Call edges for methods aren't mapped yet/)).toBeInTheDocument();
    expect(within(inspector).queryByText("None found")).toBeNull();
    expect(within(inspector).queryByRole("heading", { name: "Called by" })).toBeNull();
    expect(within(inspector).queryByRole("heading", { name: "Calls" })).toBeNull();
    expect(within(inspector).getByRole("list", { name: "Leads to" })).toBeInTheDocument();
    expect(urls(fetch).filter((u) => u.startsWith("/api/neighbors/"))).toEqual([]);
  });

  it("asks for no node or neighbours for a stop without a ref", async () => {
    const fetch = stubApi();
    renderAt("/journeys/j_invoice?stop=2");
    const inspector = await screen.findByRole("complementary", { name: "Stop inspector" });
    await within(inspector).findByRole("region", { name: /lib\/api\.ts, lines/ });
    expect(urls(fetch).filter((u) => u.startsWith("/api/node/") || u.startsWith("/api/neighbors/"))).toEqual([]);
  });

  it("clicking a stop selects it and puts it in the URL", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice");
    await opened();
    await userEvent.click(within(lane("DB")).getByRole("button", { name: "Stop 5: invoices" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 5 }));
    const inspector = screen.getByRole("complementary", { name: "Stop inspector" });
    expect(within(inspector).getByRole("heading", { name: "invoices" })).toBeInTheDocument();
  });

  it("←/→ move between stops, stopping at the ends", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice?stop=2");
    await opened();
    pressKey("ArrowRight");
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 3 }));
    pressKey("ArrowLeft");
    pressKey("ArrowLeft");
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 1 }));
    pressKey("ArrowLeft");
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 1 }));
  });

  it("←/→ move focus to the new stop and announce it politely", async () => {
    stubApi();
    renderAt("/journeys/j_invoice?stop=2");
    await opened();
    pressKey("ArrowRight");
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-label", "Stop 3: POST /api/invoices"));
    const live = screen.getByRole("status", { name: "Selected stop" });
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Stop 3: POST /api/invoices");
    pressKey("ArrowRight", document.activeElement!);
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-label", "Stop 4: InvoicesController.store"));
    expect(live).toHaveTextContent("Stop 4: InvoicesController.store");
  });

  it("←/→ are left alone while typing in a text field", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice?stop=2");
    await opened();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    pressKey("ArrowRight", input);
    pressKey("ArrowLeft", input);
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.search).toEqual({ stop: 2 });
    input.remove();
  });

  it("holding ←/→ waits 150 ms before loading the inspector, so skipped stops cost no requests", async () => {
    const fetch = stubApi();
    const router = renderAt("/journeys/j_invoice?stop=2");
    await opened();
    for (const n of [3, 4, 5]) {
      pressKey("ArrowRight");
      // each stop renders in the inspector before the next key comes, well inside 150 ms
      await waitFor(() => expect(screen.getByRole("status", { name: "Selected stop" })).toHaveTextContent(`Stop ${n}:`), { interval: 5 });
    }
    expect(router.state.location.search).toEqual({ stop: 5 });
    await waitFor(() => expect(urls(fetch)).toContain("/api/code?repo=api&file=app/controllers/invoices_controller.ts&start=32&end=56"));
    const code = urls(fetch).filter((u) => u.startsWith("/api/code"));
    expect(code.some((u) => u.includes("start/routes.ts"))).toBe(false); // stop 3
    expect(code.some((u) => u.includes("start=29"))).toBe(false); // stop 4
    expect(urls(fetch).some((u) => u.startsWith("/api/node/api::"))).toBe(false); // stop 4's ref
  });

  it("replaces an out-of-range ?stop= in the URL once the journey loads", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice?stop=99");
    await opened();
    await waitFor(() => expect(router.state.location.search).toEqual({ stop: 1 }));
    expect(router.history.length).toBe(1);
  });

  it("the Chains tab lists each chain's stops with each recorded hop's confidence and its unresolved items", async () => {
    stubApi();
    renderAt("/journeys/j_invoice");
    await opened();
    await userEvent.click(screen.getByRole("tab", { name: "Chains" }));
    const b = screen.getByRole("region", { name: "GET /api/customers" });
    const steps = within(b).getByRole("list", { name: "Stops" });
    expect(within(steps).getAllByRole("button").map((x) => x.getAttribute("aria-label"))).toEqual([
      "Stop 1: /invoices/new",
      "Stop 7: GET /api/customers",
      "Stop 8: GET /api/customers",
      "Stop 9: CustomersController.index",
    ]);
    const guess = within(steps).getByRole("img", { name: /Guessed link: URL built at runtime/ });
    expect(guess).toHaveAttribute("data-stroke", "dashed");
    const bItems = within(steps).getAllByRole("listitem");
    expect(bItems[3]!.querySelector('[data-slot="confidence-line"]')).toBeNull(); // no `from`
    expect(within(b).getByText("No handler found for GET /api/customers")).toBeInTheDocument();

    const a = screen.getByRole("region", { name: "POST /api/invoices" });
    expect(within(a).getByRole("img", { name: "Matched with a path parameter" })).toHaveAttribute("data-stroke", "thin");
    const aItems = within(within(a).getByRole("list", { name: "Stops" })).getAllByRole("listitem");
    // invoice_lines comes from the handler (stop 4), not from the invoices insert above it
    expect(aItems[5]!.querySelector('[data-slot="confidence-line"]')).toBeNull();
    expect(aItems[5]).toHaveTextContent("From stop 4 · exact link");
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

  it("remembers the journey (or chain) as last opened, under Home's key", async () => {
    stubApi();
    const set = vi.spyOn(Storage.prototype, "setItem");
    renderAt("/journeys/j_invoice");
    await waitFor(() => expect(set).toHaveBeenCalledWith(lastJourneyKey("demo-shop"), "j_invoice"));
    expect(lastJourneyKey("demo-shop")).toBe("codeloom:last-journey:demo-shop");
  });

  it("remembers a chain id too", async () => {
    stubApi();
    const set = vi.spyOn(Storage.prototype, "setItem");
    renderAt("/journeys/ch_aaaa");
    await waitFor(() => expect(set).toHaveBeenCalledWith(lastJourneyKey("demo-shop"), "ch_aaaa"));
  });

  it("remembers the named journey, not the chain, when a chain that belongs to one is opened", async () => {
    stubApi({ ch_aaaa: { ...chainResult, chains: [{ ...chainResult.chains[0]!, journeys: ["j_invoice"] }] } });
    const set = vi.spyOn(Storage.prototype, "setItem");
    renderAt("/journeys/ch_aaaa");
    await waitFor(() => expect(set).toHaveBeenCalledWith(lastJourneyKey("demo-shop"), "j_invoice"));
    expect(set).not.toHaveBeenCalledWith(lastJourneyKey("demo-shop"), "ch_aaaa");
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
