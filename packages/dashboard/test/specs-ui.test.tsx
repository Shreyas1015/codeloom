import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { JourneyRow, JourneysResponse, Overview } from "@/api/types";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { coverageParts, parseDocRef, specMark } from "@/lib/specs";
import { createAppRouter } from "@/router";
import { filterJourneys, NO_FILTER } from "@/screens/home/filter";
import { journeyResult } from "./fixtures/journey";
import { progress } from "./fixtures/progress";
import { coverage, invoiceCandidates, invoiceLinked, invoicesDoc, specsList } from "./fixtures/specs";

const overview: Overview = {
  name: "demo-shop",
  repos: [
    { id: "api", path: "api", role: "api", files: 120, nodes: 300, edges: 500, pages: 0, routes: 14, calls: 0, tables: 5, queues: 1 },
    { id: "web", path: "web", role: "ui", files: 80, nodes: 150, edges: 200, pages: 9, routes: 0, calls: 22, tables: 0, queues: 0 },
  ],
  chains: { total: 4, complete: 3, byConfidence: { exact: 3, param: 1, guess: 0 } },
  journeys: { total: 3, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

function row(p: Partial<JourneyRow> & { id: string; name: string }): JourneyRow {
  return {
    area: "", note: "", status: "ok", chainIds: [], repos: ["api"], stops: { ui: 1, api: 1, code: 0, db: 1, queue: 0 },
    confidence: "exact", complete: true, apiOnly: false, tables: [], ...p,
  };
}

const journeys: JourneysResponse = {
  journeys: [
    row({ id: "j_void", name: "Admin voids an invoice", area: "Invoices" }),
    row({ id: "j_signup", name: "Customer signs up", area: "Customers" }),
    row({ id: "j_email", name: "Invoice is emailed", area: "Invoices" }),
    row({ id: "j_refund", name: "Customer gets a refund", area: "Invoices" }),
  ],
  unnamedChains: [],
};

const withRefund = {
  ...specsList,
  journeys: [...specsList.journeys, { journeyId: "j_refund", name: "Customer gets a refund", area: "Invoices", repos: ["api"], state: "none" as const, checked: false, links: [], candidates: { docs: 0, tickets: 0 } }],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const badData = () => json({ error: "specs.json: journeys.j_void.links.0.kind: invalid value", code: "bad-data" }, 409);

type Routes = Record<string, (url: URL) => Response>;

function renderAt(path: string, routes: Routes) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const hit = routes[decodeURIComponent(url.pathname)];
    return hit ? hit(url) : json({ error: "nope" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return { router, fetch };
}

describe("spec marks", () => {
  it("tells the four states apart: linked, candidates, confirmed none, not checked", () => {
    expect(specMark({ state: "linked", checked: true })).toBe("linked");
    expect(specMark({ state: "candidates", checked: false })).toBe("candidates");
    expect(specMark({ state: "none", checked: true })).toBe("none");
    expect(specMark({ state: "none", checked: false })).toBe("unchecked");
  });

  it("splits a coverage total into the four marks that add up to it", () => {
    expect(coverageParts(coverage({ total: 10, linked: 3, candidates: 2, none: 5, checked: 5 }))).toEqual({
      linked: 3, candidates: 2, none: 2, unchecked: 3,
    });
  });

  it("reads a doc ref as repo and path, and refuses anything else", () => {
    expect(parseDocRef("api:docs/invoices.md")).toEqual({ repo: "api", file: "docs/invoices.md" });
    expect(parseDocRef("docs/invoices.md")).toBeNull();
    expect(parseDocRef("api:")).toBeNull();
  });
});

describe("SpecBadge", () => {
  it("says its state in words, with a tone per state", () => {
    const { rerender } = render(<SpecBadge state="linked" checked />);
    expect(screen.getByText("Spec linked")).toHaveAttribute("data-spec", "linked");
    rerender(<SpecBadge state="candidates" checked={false} />);
    const c = screen.getByText("Spec candidates");
    // ochre fill is a stop's alone: candidates wear the ochre wash, never `bg-accent`
    expect(c.className).toMatch(/bg-accent-soft/);
    expect(c.className).not.toMatch(/bg-accent(\s|$)/);
    rerender(<SpecBadge state="none" checked />);
    const none = screen.getByText("No spec");
    // oxblood always carries a second cue: the word and a dashed edge
    expect(none.className).toMatch(/border-dashed/);
    expect(none.className).toMatch(/text-destructive/);
    rerender(<SpecBadge state="none" checked={false} />);
    expect(screen.getByText("Spec not checked")).toHaveAttribute("data-spec", "unchecked");
  });
});

describe("Home: spec badges and the Spec filter", () => {
  const routes: Routes = {
    "/api/overview": () => json(overview),
    "/api/journeys": () => json(journeys),
    "/api/specs": () => json(withRefund),
  };

  it("filters by spec state (no filter = every journey)", () => {
    const marks = new Map([
      ["j_void", "linked" as const],
      ["j_signup", "candidates" as const],
      ["j_email", "none" as const],
      ["j_refund", "unchecked" as const],
    ]);
    const names = (spec: typeof NO_FILTER.spec) => filterJourneys(journeys.journeys, { ...NO_FILTER, spec }, marks).map((r) => r.id);
    expect(names("")).toEqual(["j_void", "j_signup", "j_email", "j_refund"]);
    expect(names("linked")).toEqual(["j_void"]);
    expect(names("candidates")).toEqual(["j_signup"]);
    expect(names("none")).toEqual(["j_email"]);
    expect(names("unchecked")).toEqual(["j_refund"]);
    // without spec data the filter has nothing to go on: it does not hide journeys
    expect(filterJourneys(journeys.journeys, { ...NO_FILTER, spec: "linked" }).length).toBe(4);
  });

  it("shows each journey's badge and filters the list by Spec", async () => {
    renderAt("/", routes);
    const list = await screen.findByRole("list", { name: "User journeys" });
    await waitFor(() => expect(within(list).getByText("Spec linked")).toBeInTheDocument());
    const rowOf = (name: string) => within(list).getByText(name).closest("li")!;
    expect(rowOf("Admin voids an invoice")).toHaveTextContent("Spec linked");
    expect(rowOf("Customer signs up")).toHaveTextContent("Spec candidates");
    expect(rowOf("Invoice is emailed")).toHaveTextContent("No spec");
    expect(rowOf("Customer gets a refund")).toHaveTextContent("Spec not checked");

    await userEvent.selectOptions(screen.getByLabelText("Spec"), "none");
    expect(within(screen.getByRole("list", { name: "User journeys" })).getAllByRole("link").map((a) => a.dataset.name)).toEqual(["Invoice is emailed"]);
    await userEvent.selectOptions(screen.getByLabelText("Spec"), "");
    expect(within(screen.getByRole("list", { name: "User journeys" })).getAllByRole("link")).toHaveLength(4);
  });

  it("without spec data (a broken specs.json), shows no badges and no Spec filter, and the list still works", async () => {
    renderAt("/", { ...routes, "/api/specs": badData });
    const list = await screen.findByRole("list", { name: "User journeys" });
    expect(within(list).getAllByRole("link")).toHaveLength(4);
    await waitFor(() => expect(screen.getByLabelText("Area")).toBeInTheDocument());
    expect(screen.queryByLabelText("Spec")).not.toBeInTheDocument();
    expect(within(list).queryByText(/spec/i)).not.toBeInTheDocument();
  });
});

describe("Journey: spec badge and the Specs tab", () => {
  const routes = (spec: () => Response): Routes => ({
    "/api/overview": () => json(overview),
    "/api/journeys/j_invoice": () => json(journeyResult),
    "/api/specs/j_invoice": spec,
    "/api/docs": (url) =>
      url.searchParams.get("repo") === "api" && url.searchParams.get("file") === "docs/invoices.md" ? json(invoicesDoc) : json({ error: "nope" }, 404),
  });

  it("puts the spec badge on the nameplate", async () => {
    renderAt("/journeys/j_invoice", routes(() => json(invoiceLinked)));
    const header = (await screen.findByRole("heading", { level: 1, name: "Customer creates an invoice" })).closest("header")!;
    await waitFor(() => expect(within(header).getByText("Spec linked")).toBeInTheDocument());
  });

  it("lists linked docs and tickets with Claude's reason, and opens a doc read-only", async () => {
    renderAt("/journeys/j_invoice?tab=specs", routes(() => json(invoiceLinked)));
    const panel = await screen.findByRole("tabpanel", { name: "Specs" });
    await waitFor(() => expect(within(panel).getByText("SHOP-12")).toBeInTheDocument());
    expect(panel).toHaveTextContent("Added invoice creation for customers.");
    expect(panel).toHaveTextContent("Describes POST /api/invoices and the invoices table.");
    // the stop inspector is for stops: it is not beside the specs
    expect(screen.queryByRole("complementary", { name: /stop/i })).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Open docs/invoices.md" }));
    const viewer = await within(panel).findByRole("region", { name: /docs\/invoices\.md, lines 1–5/ });
    expect(viewer).toHaveTextContent("POST /api/invoices creates an invoice.");
    expect(within(panel).getByText("/mcp__codeloom__match-specs j_invoice")).toBeInTheDocument();
  });

  it("before a check, lists candidates with their evidence and the command to check them", async () => {
    renderAt("/journeys/j_invoice?tab=specs", routes(() => json(invoiceCandidates)));
    const panel = await screen.findByRole("tabpanel", { name: "Specs" });
    const docs = await within(panel).findByRole("list", { name: "Candidate docs" });
    expect(docs).toHaveTextContent("docs/invoices.md");
    expect(docs).toHaveTextContent("POST /api/invoices");
    expect(docs).toHaveTextContent("line 3");
    const tickets = within(panel).getByRole("list", { name: "Candidate tickets" });
    expect(tickets).toHaveTextContent("SHOP-12");
    expect(tickets).toHaveTextContent("a1b2c3d");
    expect(tickets).toHaveTextContent("SHOP-12 create invoices for a customer");
    expect(within(panel).getByText("/mcp__codeloom__match-specs j_invoice")).toBeInTheDocument();

    // opening a candidate at its evidence marks that line
    await userEvent.click(within(docs).getByRole("button", { name: "Open docs/invoices.md at line 3" }));
    const viewer = await within(panel).findByRole("region", { name: /docs\/invoices\.md/ });
    await waitFor(() => expect(viewer.querySelector('[data-line="3"]')).toHaveAttribute("data-highlighted"));
  });

  it("design pass: counts docs and tickets apart, wraps a prose doc, marks the open doc, keeps 'read only' out of mono", async () => {
    renderAt("/journeys/j_invoice?tab=specs", routes(() => json(invoiceLinked)));
    const panel = await screen.findByRole("tabpanel", { name: "Specs" });
    const state = await within(panel).findByRole("region", { name: "Spec state" });
    expect(state).toHaveTextContent("Claude linked 1 doc and 1 ticket");
    const open = within(panel).getByRole("button", { name: "Open docs/invoices.md" });
    expect(open).not.toHaveAttribute("aria-current");
    await userEvent.click(open);
    const viewer = await within(panel).findByRole("region", { name: /docs\/invoices\.md, lines/ });
    expect(viewer).toHaveAttribute("data-wrap", "true");
    expect(within(panel).getByRole("button", { name: "Open docs/invoices.md" })).toHaveAttribute("aria-current", "true");
    const readOnly = within(panel).getByText(/read only/);
    expect(readOnly.className).not.toMatch(/font-mono/);
  });

  it("design pass: an evidence line names its line, not the doc again, and the term wraps instead of truncating", async () => {
    renderAt("/journeys/j_invoice?tab=specs", routes(() => json(invoiceCandidates)));
    const docs = await within(await screen.findByRole("tabpanel", { name: "Specs" })).findByRole("list", { name: "Candidate docs" });
    const evidence = within(docs).getByRole("button", { name: "Open docs/invoices.md at line 3" });
    expect(evidence).toHaveTextContent(/^line 3$/);
    expect(docs.querySelector(".truncate")).toBeNull();
  });

  it("a broken specs.json is an error card in the tab, not a broken screen", async () => {
    renderAt("/journeys/j_invoice?tab=specs", routes(badData));
    const panel = await screen.findByRole("tabpanel", { name: "Specs" });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("can't be read");
    expect(alert).toHaveTextContent("codeloom doctor");
    expect(screen.getByRole("heading", { level: 1, name: "Customer creates an invoice" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Lanes" }));
    expect(await screen.findByRole("tabpanel", { name: "Lanes" })).toBeInTheDocument();
  });

  it("switching tabs keeps the place in the URL", async () => {
    const { router } = renderAt("/journeys/j_invoice", routes(() => json(invoiceLinked)));
    await userEvent.click(await screen.findByRole("tab", { name: "Specs" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: "specs" }));
  });
});

describe("Progress: spec coverage", () => {
  const routes: Routes = {
    "/api/overview": () => json({ ...overview, journeys: { total: 5, orphaned: 0 } }),
    "/api/journeys": () => json({ journeys: [], unnamedChains: [] }),
    "/api/progress": () => json(progress),
    "/api/specs": () => json(specsList),
  };

  it("counts linked, candidates, no spec and not checked per repo, and per area on request", async () => {
    renderAt("/progress", routes);
    const section = (await screen.findByRole("heading", { name: "Spec coverage" })).closest("section")!;
    await waitFor(() => expect(within(section).getByRole("table", { name: "Spec coverage by repo" })).toBeInTheDocument());
    expect(section).toHaveTextContent("1 of 3 journeys have a linked spec");
    const rows = within(within(section).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["api", "1", "1", "1", "0", "3"],
      ["web", "1", "1", "0", "0", "2"],
    ]);
    await userEvent.click(within(section).getByRole("radio", { name: "By area" }));
    const areaRows = within(within(section).getByRole("table", { name: "Spec coverage by area" })).getAllByRole("row").slice(1);
    expect(areaRows.map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["Customers", "Invoices"]);
    expect(within(section).getByText("/mcp__codeloom__match-specs")).toBeInTheDocument();
  });

  it("a broken specs.json is a local card: your progress still shows", async () => {
    renderAt("/progress", { ...routes, "/api/specs": badData });
    expect(await screen.findByRole("heading", { level: 1, name: "You understand 1 of 5 journeys" })).toBeInTheDocument();
    const section = (await screen.findByRole("heading", { name: "Spec coverage" })).closest("section")!;
    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent("codeloom doctor");
    expect(screen.getByRole("table", { name: "Progress by repo" })).toBeInTheDocument();
  });
});
