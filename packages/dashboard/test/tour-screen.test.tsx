import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { CodeResponse, Overview, ProgressResponse, TourResponse } from "@/api/types";
import { createAppRouter } from "@/router";
import { rememberTourPlace, tourPlaceKey } from "@/screens/tour/position";
import { journeyResult } from "./fixtures/journey";
import { invoiceProgress, noTourResponse, progressWith, removedKey, tourFile, tourResponse } from "./fixtures/tour";

const overview: Overview = {
  name: "demo-shop",
  repos: [],
  chains: { total: 2, complete: 1, byConfidence: { exact: 0, param: 1, guess: 1 } },
  journeys: { total: 1, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
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

interface Stub {
  tour?: TourResponse | null;
  journey?: unknown;
  progress?: ProgressResponse;
}

function stubApi({ tour = tourResponse, journey = journeyResult, progress = progressWith() }: Stub = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { journey: string };
      posts.push({ path: p, body });
      return json({ journey: { ...invoiceProgress, journeyId: body.journey } });
    }
    if (p === "/api/overview") return json(overview);
    if (p === "/api/progress") return json(progress);
    if (p === "/api/journeys/j_invoice") return journey ? json(journey) : json({ error: "Unknown journey" }, 404);
    if (p.startsWith("/api/journeys/")) return json({ error: "Unknown journey" }, 404);
    if (p.startsWith("/api/tours/")) return tour ? json(tour) : json({ error: "No such journey or tour" }, 404);
    if (p === "/api/code") return json(codeFor(url));
    if (p.startsWith("/api/node/")) return json({ ref: p.slice(10), node: null, summary: null, edges: { out: [], in: [], truncated: false }, chains: [], journeys: [] });
    if (p.startsWith("/api/neighbors/")) return json({ root: p.slice(15), neighbors: [], truncated: false });
    return json({ error: "nope" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, posts };
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const urls = (fetch: ReturnType<typeof stubApi>["fetch"]) => fetch.mock.calls.map((c) => decodeURIComponent(String(c[0])));
const pressKey = (key: string) => act(() => void fireEvent.keyDown(document.body, { key }));
const phases = () => screen.getByRole("navigation", { name: "Tour phases" });
const stopHeading = () => screen.findByRole("heading", { level: 2 });

beforeAll(async () => {
  await import("@/screens/tour/TourScreen");
  await import("@/screens/journey/JourneyScreen");
}, 60_000);

afterEach(() => {
  localStorage.clear();
});

describe("Tour mode", () => {
  it("opens on Flow stop 1: journey name, phases, the explanation beside the stop's code", async () => {
    const { fetch } = stubApi();
    renderAt("/journeys/j_invoice/tour");
    expect(await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" })).toBeInTheDocument();
    expect(await stopHeading()).toHaveTextContent("/invoices/new");
    expect(within(phases()).getByRole("link", { name: /Flow/ })).toHaveAttribute("aria-current", "step");
    expect(within(phases()).getAllByRole("link").map((a) => a.textContent)).toEqual(["Flow", "Data journey", "File notes", "Check yourself"]);
    expect(screen.getByText("The new-invoice form.")).toBeInTheDocument();
    expect(screen.getByText(/Tour stop 1 of 5/)).toBeInTheDocument();
    await waitFor(() => expect(urls(fetch)).toContain("/api/code?repo=web&file=app/invoices/new/page.tsx&start=1&end=24"));
    expect(await screen.findByRole("region", { name: /app\/invoices\/new\/page.tsx, lines 1–24/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Exit tour" })).toHaveAttribute("href", "/journeys/j_invoice");
  });

  it("steps with ←/→ and the buttons, in journey stop order, and keeps the place in the URL", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice/tour");
    await stopHeading();
    pressKey("ArrowRight");
    expect(await stopHeading()).toHaveTextContent("POST /api/invoices");
    expect(router.state.location.search).toEqual({ phase: "flow", stop: 2 });
    pressKey("ArrowLeft");
    expect(await stopHeading()).toHaveTextContent("/invoices/new");
    pressKey("ArrowLeft"); // already first: stays
    expect(router.state.location.search).toEqual({ phase: "flow", stop: 1 });
    await userEvent.click(screen.getByRole("button", { name: /Next: Stop 2/ }));
    expect(await stopHeading()).toHaveTextContent("POST /api/invoices");
    expect(screen.getByRole("button", { name: "Previous: Stop 1" })).toBeEnabled();
  });

  it("marks a stop whose file changed as may be out of date, and a removed stop without fetching code", async () => {
    const { fetch } = stubApi();
    renderAt("/journeys/j_invoice/tour?phase=flow&stop=3");
    expect(await stopHeading()).toHaveTextContent("InvoicesController.store");
    expect(screen.getByText("May be out of date")).toBeInTheDocument();
    expect(screen.getByText(/Then/).querySelector("strong")).toHaveTextContent("saves");
    pressKey("ArrowRight");
    pressKey("ArrowRight");
    expect(await stopHeading()).toHaveTextContent("LegacyInvoice.save");
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText(/no longer in this journey/)).toBeInTheDocument();
    expect(screen.getByText("The old save path.")).toBeInTheDocument();
    expect(urls(fetch).some((u) => u.includes("legacy_invoice"))).toBe(false);
    expect(screen.getByRole("button", { name: "Next: Data journey" })).toBeInTheDocument();
  });

  it("clamps a stop outside the tour", async () => {
    stubApi();
    const router = renderAt("/journeys/j_invoice/tour?phase=flow&stop=40");
    expect(await stopHeading()).toHaveTextContent("LegacyInvoice.save");
    await waitFor(() => expect(router.state.location.search).toEqual({ phase: "flow", stop: 5 }));
  });

  it("shows the data journey: sample input, steps with SQL, output, in mono", async () => {
    stubApi();
    renderAt("/journeys/j_invoice/tour?phase=data-journey");
    const input = await screen.findByRole("region", { name: "Sample input" });
    expect(within(input).getByText(/PANEL-400/).closest("pre")).toHaveClass("font-mono");
    const steps = screen.getByRole("list", { name: "Data journey steps" });
    const items = within(steps).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("POST /api/invoices");
    expect(items[0]).toHaveTextContent("The form becomes a POST body.");
    expect(within(items[1]!).getByText(/INSERT INTO invoices/).closest("pre")).toHaveClass("font-mono");
    expect(within(screen.getByRole("region", { name: "Output" })).getByText(/"id": 501/)).toBeInTheDocument();
  });

  it("lists file notes with traps set apart", async () => {
    stubApi();
    renderAt("/journeys/j_invoice/tour?phase=file-notes");
    const file = await screen.findByRole("region", { name: "api/app/controllers/invoices_controller.ts" });
    const trap = within(file).getByText("The total is computed here, not in the model.").closest("[data-kind]");
    expect(trap).toHaveAttribute("data-kind", "trap");
    expect(trap).toHaveTextContent("Trap");
    expect(within(file).getByText("Uses the customer's default currency.").closest("[data-kind]")).toHaveAttribute("data-kind", "note");
  });

  it("Check yourself: three questions, the last result and history, and a copy button for check-me", async () => {
    stubApi();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderAt("/journeys/j_invoice/tour?phase=check");
    const qs = await screen.findByRole("list", { name: "Questions" });
    expect(qs.children).toHaveLength(3);
    expect(within(qs).getByText("Where is the invoice total computed?")).toBeInTheDocument();
    const last = await screen.findByRole("region", { name: "Last check" });
    expect(within(last).getByText("Not passed")).toBeInTheDocument();
    expect(within(last).getByText("The total is computed in the controller.")).toBeInTheDocument();
    expect(within(last).getByText(/2 Nov 2026/)).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "History" });
    expect(within(history).getByText(/Seen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check me in Claude" }));
    expect(writeText).toHaveBeenCalledWith("/mcp__codeloom__check-me j_invoice");
    expect(screen.getByText("/mcp__codeloom__check-me j_invoice")).toBeInTheDocument();
  });

  it("Check yourself never shows what a good answer covers, even if a response carried expected points", async () => {
    const leaky = { ...tourFile, check: tourFile.check.map((q) => ({ ...q, expected: ["SECRET-POINT"] })) };
    stubApi({ tour: { ...tourResponse, tour: leaky as TourResponse["tour"] } });
    renderAt("/journeys/j_invoice/tour?phase=check");
    const qs = await screen.findByRole("list", { name: "Questions" });
    expect(qs.children).toHaveLength(3);
    expect(screen.queryByText(/good answer/i)).not.toBeInTheDocument();
    expect(screen.queryByText("SECRET-POINT")).not.toBeInTheDocument();
    expect(qs.querySelector("details")).toBeNull();
  });

  it("with no tour yet, offers the write-tour command", async () => {
    const { posts } = stubApi({ tour: noTourResponse });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderAt("/journeys/j_invoice/tour");
    expect(await screen.findByRole("heading", { name: "No tour for this journey yet" })).toBeInTheDocument();
    expect(screen.getByText("/mcp__codeloom__write-tour j_invoice")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith("/mcp__codeloom__write-tour j_invoice");
    expect(screen.queryByRole("navigation", { name: "Tour phases" })).toBeNull();
    await waitFor(() => expect(posts).toEqual([{ path: "/api/progress/seen", body: { journey: "j_invoice" } }]));
  });

  it("posts seen on open, and toured once when all four phases were viewed", async () => {
    const { posts } = stubApi();
    renderAt("/journeys/j_invoice/tour");
    await stopHeading();
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/progress/seen"]));
    for (let i = 0; i < 4; i++) pressKey("ArrowRight");
    expect(await stopHeading()).toHaveTextContent("LegacyInvoice.save");
    expect(within(phases()).getByRole("link", { name: /Flow/ })).toHaveAccessibleName("Flow (viewed)");
    pressKey("ArrowRight");
    await screen.findByRole("region", { name: "Sample input" });
    pressKey("ArrowRight");
    await screen.findByRole("region", { name: "api/app/controllers/invoices_controller.ts" });
    expect(posts.some((p) => p.path === "/api/progress/toured")).toBe(false);
    pressKey("ArrowRight");
    await screen.findByRole("list", { name: "Questions" });
    await waitFor(() =>
      expect(posts.filter((p) => p.path === "/api/progress/toured")).toEqual([
        { path: "/api/progress/toured", body: { journey: "j_invoice", phases: ["flow", "data-journey", "file-notes", "check"] } },
      ]),
    );
    expect(await screen.findByText(/You have walked all four phases/)).toBeInTheDocument();
    pressKey("ArrowLeft");
    pressKey("ArrowRight");
    await screen.findByRole("list", { name: "Questions" });
    expect(posts.filter((p) => p.path === "/api/progress/toured")).toHaveLength(1);
  });

  it("does not post toured for a journey already toured, and remembers where you are", async () => {
    const { posts } = stubApi({ progress: progressWith({ ...invoiceProgress, level: "toured", touredAt: "2026-11-01T11:00:00.000Z" }) });
    rememberTourPlace("demo-shop", "j_invoice", { phase: "file-notes", stop: 1, viewed: ["flow", "data-journey", "file-notes"] });
    renderAt("/journeys/j_invoice/tour?phase=check");
    await screen.findByRole("list", { name: "Questions" });
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/progress/seen"]));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(tourPlaceKey("demo-shop", "j_invoice"))!)).toMatchObject({ phase: "check", viewed: ["flow", "data-journey", "file-notes", "check"] }));
  });

  it("shows an older journey's tour with every stop removed, and writes no progress", async () => {
    const { posts } = stubApi({
      journey: null,
      tour: { ...tourResponse, journeyExists: false, staleStops: [], removedStops: tourFile.stops.map((s) => s.key) },
    });
    renderAt("/journeys/j_invoice/tour");
    expect(await screen.findByText(/for an older journey/)).toBeInTheDocument();
    expect(screen.getByText("/mcp__codeloom__write-tour <journey id>")).toBeInTheDocument();
    expect(await stopHeading()).toHaveTextContent("InvoicesController.store");
    expect(screen.getByText("Removed")).toBeInTheDocument();
    for (let i = 0; i < 8; i++) pressKey("ArrowRight");
    await screen.findByRole("list", { name: "Questions" });
    expect(posts).toEqual([]);
    expect(removedKey).toBeTruthy();
  });

  it("says when neither the journey nor a tour exists", async () => {
    stubApi({ journey: null, tour: null });
    renderAt("/journeys/j_gone/tour");
    expect(await screen.findByRole("heading", { name: "Journey not found" })).toBeInTheDocument();
  });
});

describe("Journey screen tour button", () => {
  it("offers Start tour, and posts seen when the journey opens", async () => {
    const { posts } = stubApi();
    renderAt("/journeys/j_invoice");
    const start = await screen.findByRole("link", { name: "Start tour" });
    expect(start).toHaveAttribute("href", "/journeys/j_invoice/tour");
    await waitFor(() => expect(posts).toEqual([{ path: "/api/progress/seen", body: { journey: "j_invoice" } }]));
  });

  it("offers Resume tour at the remembered place", async () => {
    stubApi();
    rememberTourPlace("demo-shop", "j_invoice", { phase: "data-journey", stop: 1, viewed: ["flow"] });
    renderAt("/journeys/j_invoice");
    const resume = await screen.findByRole("link", { name: "Resume tour" });
    expect(resume).toHaveAttribute("href", "/journeys/j_invoice/tour?phase=data-journey&stop=1");
  });
});
