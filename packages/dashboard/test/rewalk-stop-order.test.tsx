// TDD for the fix: Progress re-walk links and the Home Continue band must land on the changed stop's
// identity, not on whatever position the tour file happens to list it at. A journey with several chains
// (or a tour with removed stops) can list its stops in a different order than Tour mode's own numbering
// (`numberStops`), so building a `?stop=N` link from the tour file's own order can open the wrong stop.
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { CodeResponse, JourneyProgressView, JourneyRow, JourneysResponse, Overview, ProgressResponse, TourFile, TourResponse } from "@/api/types";
import { stopKey } from "@/lib/journey-stops";
import { createAppRouter } from "@/router";
import { chainA, chainB, journeyResult } from "./fixtures/journey";

// demo-shop "Customer creates an invoice" numbers stops 1 page, 2 postCall, 3 postRoute, 4 store,
// 5 insertInvoice, 6 insertLines, 7 getCall, 8 getRoute, 9 indexHandler (see fixtures/journey.ts).
const pageKey = stopKey(chainA.stops[0]!);
const postCallKey = stopKey(chainA.stops[1]!); // n=2, label "POST /api/invoices" — the changed stop
const storeKey = stopKey(chainA.stops[3]!); // n=4
const insertInvoiceKey = stopKey(chainA.stops[4]!); // n=5
const getCallKey = stopKey(chainB.stops[1]!); // n=7, label "GET /api/customers"

/** The tour's own stops, in file order — NOT journey stop-number order: postCall (n=2, the changed stop)
 * sits last in the file, after stops from both chains. By raw file position alone it would look like
 * stop 5 (1-based), which Tour mode (sorted by journey number) shows as getCall (n=7), not postCall. */
const tourFile: TourFile = {
  version: 1,
  journeyId: "j_invoice",
  writtenAt: "2026-11-01T10:00:00.000Z",
  writtenAtCommit: { api: "abc1234", web: "def5678" },
  stops: [insertInvoiceKey, pageKey, getCallKey, storeKey, postCallKey].map((key, i) => ({
    chainId: i === 2 ? "ch_bbbb" : "ch_aaaa",
    stopIndex: 0,
    key,
    fileHash: "h",
    explanation: "x",
  })),
  dataJourney: { input: "{}", steps: [], output: "{}" },
  fileNotes: [],
  check: [{ question: "a" }, { question: "b" }, { question: "c" }],
};

const tourResponse: TourResponse = { journeyId: "j_invoice", journeyExists: true, tour: tourFile, staleStops: [], removedStops: [] };

const invoiceView: JourneyProgressView = {
  journeyId: "j_invoice",
  name: "Customer creates an invoice",
  area: "Invoices",
  repos: ["api", "web"],
  level: "understood",
  needsReWalk: [postCallKey],
  lastCheck: null,
  seenAt: "2026-10-19T12:00:00.000Z",
  touredAt: "2026-10-20T12:00:00.000Z",
  understoodAt: "2026-10-21T12:00:00.000Z",
};

const counts = { total: 1, none: 0, seen: 0, toured: 0, understood: 1, needsReWalk: 1 };
const progressResponse: ProgressResponse = {
  workspaceId: "0123456789abcdef",
  path: "/home/dev/.codeloom/progress/0123456789abcdef.json",
  journeys: [invoiceView],
  totals: { all: counts, byRepo: { api: counts, web: counts }, byArea: { Invoices: counts } },
  olderJourneys: [],
  olderTours: [],
};

const overview: Overview = {
  name: "demo-shop",
  // empty: the Rail's own "Repos" heading (h2) would otherwise collide with the tour stop's h2 heading
  repos: [],
  chains: { total: 2, complete: 1, byConfidence: { exact: 1, param: 1, guess: 0 } },
  journeys: { total: 1, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

function journeyRow(): JourneyRow {
  return {
    id: "j_invoice",
    name: "Customer creates an invoice",
    area: "Invoices",
    note: "",
    status: "ok",
    chainIds: ["ch_aaaa", "ch_bbbb"],
    repos: ["api", "web"],
    stops: { ui: 2, api: 2, code: 1, db: 2, queue: 0 },
    confidence: "guess",
    complete: false,
    apiOnly: false,
    tables: ["invoice_lines", "invoices"],
  };
}

const journeysResponse: JourneysResponse = { journeys: [journeyRow()], unnamedChains: [] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function codeFor(url: URL): CodeResponse {
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));
  return { file: url.searchParams.get("file")!, startLine: start, endLine: end, text: "// code", truncated: false };
}

function stubApi() {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);
    if (init?.method === "POST") return json({ journey: invoiceView });
    if (p === "/api/overview") return json(overview);
    if (p === "/api/journeys") return json(journeysResponse);
    if (p === "/api/journeys/j_invoice") return json(journeyResult);
    if (p === "/api/progress") return json(progressResponse);
    if (p === "/api/tours/j_invoice") return json(tourResponse);
    if (p === "/api/code") return json(codeFor(url));
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

const stopHeading = () => screen.findByRole("heading", { level: 2 });

beforeAll(async () => {
  await import("@/screens/tour/TourScreen");
  await import("@/screens/journey/JourneyScreen");
}, 60_000);

describe("A re-walk link lands on the changed stop's identity, not its raw position in the tour file", () => {
  it("Progress screen: the re-walk row opens Tour mode on the changed stop, not whatever the tour file order would pick", async () => {
    stubApi();
    renderAt("/progress");
    const panel = await screen.findByRole("region", { name: "Needs a re-walk" });
    const go = await within(panel).findByRole("link", { name: "Re-walk Customer creates an invoice" });
    await userEvent.click(go);
    expect(await stopHeading()).toHaveTextContent("POST /api/invoices");
    expect(screen.queryByRole("heading", { level: 2, name: "GET /api/customers" })).toBeNull();
  });

  it("Progress screen: the changed stop's own link in the list opens the same, correct stop", async () => {
    stubApi();
    renderAt("/progress");
    const panel = await screen.findByRole("region", { name: "Needs a re-walk" });
    const stopLink = await within(panel).findByRole("link", { name: /createInvoice/ });
    await userEvent.click(stopLink);
    expect(await stopHeading()).toHaveTextContent("POST /api/invoices");
  });

  it("Home Continue band: a journey needing a re-walk opens Tour mode on its changed stop", async () => {
    stubApi();
    renderAt("/");
    const band = await screen.findByRole("region", { name: "Continue: Customer creates an invoice" });
    const go = await within(band).findByRole("link", { name: /Re-walk/ });
    await userEvent.click(go);
    expect(await stopHeading()).toHaveTextContent("POST /api/invoices");
    expect(screen.queryByRole("heading", { level: 2, name: "GET /api/customers" })).toBeNull();
  });
});
