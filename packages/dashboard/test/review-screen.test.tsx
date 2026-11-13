import { createHash } from "node:crypto";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { detectSnapshot } from "@/api/static";
import type { Overview, Review, ReviewNodeChange } from "@/api/types";
import { createAppRouter } from "@/router";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OVERVIEW: Overview = {
  name: "demo-shop",
  repos: [
    { id: "api", path: "api", role: "api", files: 10, nodes: 5, edges: 0, pages: 0, routes: 2, calls: 0, tables: 1, queues: 1 },
    { id: "web", path: "web", role: "ui", files: 8, nodes: 3, edges: 0, pages: 2, routes: 0, calls: 0, tables: 0, queues: 0 },
  ],
  chains: { total: 1, complete: 1, byConfidence: { exact: 1, param: 0, guess: 0 } },
  journeys: { total: 2, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

const CREATE_REF = "api::function:app/services/customer_service.ts:CustomerService.create";

const CREATE_NODE: ReviewNodeChange = {
  ref: CREATE_REF,
  repo: "api",
  file: "app/services/customer_service.ts",
  symbol: "CustomerService.create",
  before: {
    start: 22,
    end: 27,
    text: [
      "async create(input: NewCustomer) {",
      "  const data = await customerSchema.validate(input);",
      "  const customer = await Customer.create(input);",
      '  await audit.publish("customer.created", { id: customer.id });',
      "  return customer;",
      "}",
    ].join("\n"),
  },
  after: {
    start: 22,
    end: 30,
    text: [
      "async create(input: NewCustomer) {",
      "  const data = await customerSchema.validate(input);",
      "  if (data.gstin && !isValidGstin(data.gstin)) {",
      '    throw new ValidationError("gstin", "Not a valid GST number");',
      "  }",
      "  const customer = await Customer.create(data);",
      '  await audit.publish("customer.created", { id: customer.id });',
      "  return customer;",
      "}",
    ].join("\n"),
  },
  hunks: [
    {
      oldStart: 22,
      oldLines: 6,
      newStart: 22,
      newLines: 9,
      lines: [
        " async create(input: NewCustomer) {",
        "   const data = await customerSchema.validate(input);",
        "+  if (data.gstin && !isValidGstin(data.gstin)) {",
        '+    throw new ValidationError("gstin", "Not a valid GST number");',
        "+  }",
        "-  const customer = await Customer.create(input);",
        "+  const customer = await Customer.create(data);",
        '   await audit.publish("customer.created", { id: customer.id });',
        "   return customer;",
        " }",
      ],
    },
  ],
  added: 4,
  removed: 1,
  journeys: ["j_bulk", "j_create"],
};

const REVIEW: Review = {
  version: 1,
  base: "0000000000000000000000000000000000000000",
  head: "a41c9e2abcdef0123456789abcdef0123456789",
  baseRef: "main",
  files: [
    { repo: "api", file: "app/services/customer_service.ts", added: 18, removed: 3, onJourney: true },
    { repo: "api", file: "lib/gst.ts", added: 41, removed: 0, onJourney: false },
    { repo: "web", file: "components/CustomerForm.tsx", added: 6, removed: 1, onJourney: true },
  ],
  nodes: [CREATE_NODE],
  journeys: [
    { id: "j_create", name: "Create customer", changedStops: [CREATE_REF], spec: "linked", chains: ["ch_create"] },
    { id: "j_bulk", name: "Bulk import customers", changedStops: [CREATE_REF], spec: "none", chains: ["ch_create"] },
  ],
  chains: ["ch_create"],
  chainStops: {
    ch_create: [
      { ref: "web::page:app/customers/new/page.tsx", repo: "web", lane: "ui", label: "/customers/new", file: "app/customers/new/page.tsx", changed: false },
      { ref: "web::function:lib/api.ts:createCustomer", repo: "web", lane: "ui", label: "createCustomer()", file: "lib/api.ts", changed: false, from: 0 },
      { ref: "api::route:POST /api/customers", repo: "api", lane: "api", label: "POST /api/customers", changed: false, from: 1 },
      {
        ref: "api::function:app/controllers/customers_controller.ts:CustomersController.store",
        repo: "api",
        lane: "code",
        label: "CustomersController.store",
        file: "app/controllers/customers_controller.ts",
        changed: false,
        from: 2,
      },
      { ref: CREATE_REF, repo: "api", lane: "code", label: "CustomerService.create", file: "app/services/customer_service.ts", changed: true, from: 3 },
      { ref: "api::db:customers", repo: "api", lane: "db", label: "customers", changed: false, from: 4 },
      { ref: "api::queue:audit", repo: "api", lane: "queue", label: "queue: audit", changed: false, from: 4 },
    ],
  },
  chainNames: { ch_create: "POST /api/customers" },
  tables: ["customers"],
  queues: ["audit"],
  truncated: false,
  notes: [],
};

const WHOLE_FILE_TEXT = Array.from({ length: 60 }, (_, i) => `// controller line ${i + 1}`).join("\n");

/** Stubs `fetch` for every `./data/*.json` request the Review screen and its panel make, detects the
 * snapshot from the same stub (so `isSnapshot()` is true by the time `createAppRouter` runs), and returns
 * the mock for assertions on what was requested. */
async function enterSnapshot(opts: { pr?: number | undefined; repoSlug?: string | undefined } = {}): Promise<ReturnType<typeof vi.fn>> {
  const manifest = {
    version: 1,
    codeloom: "0.4.0",
    head: REVIEW.head,
    base: "main",
    builtAt: "2026-11-13T00:00:00.000Z",
    files: [],
    omitted: { mapFolders: [], codeFiles: [] },
    bytes: 0,
    ...("pr" in opts ? { pr: opts.pr } : { pr: 12 }),
    ...("repoSlug" in opts ? { repoSlug: opts.repoSlug } : { repoSlug: "acme/widgets" }),
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "./data/manifest.json") return json(manifest);
    if (url === "./data/overview.json") return json(OVERVIEW);
    if (url === "./data/review.json") return json(REVIEW);
    if (url === "./data/files~api~app~controllers~customers_controller.ts.json") {
      return json({ file: "app/controllers/customers_controller.ts", text: WHOLE_FILE_TEXT });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const info = await detectSnapshot();
  expect(info).not.toBeNull();
  return fetchMock;
}

/** Resets module-level snapshot state to "not a snapshot" (static.ts: a 404 on the manifest clears it),
 * for the one test that checks live-mode behaviour. */
async function leaveSnapshot(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "not found" }, 404)),
  );
  expect(await detectSnapshot()).toBeNull();
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

// Waits for the h1 (synchronous) and for review.json's data to have landed (the journeys list only
// renders once useReview() resolves) — otherwise a synchronous query right after could run before the
// fetch's promise settles.
async function opened() {
  await screen.findByRole("heading", { level: 1, name: "What this PR touches" });
  return screen.findByRole("list", { name: "Journeys affected" });
}

describe("Review screen", () => {
  it("shows counts for files, functions, journeys, tables and queues", async () => {
    await enterSnapshot();
    renderAt("/review");
    await opened();
    const totals = screen.getByRole("list", { name: "PR totals" });
    const cells = within(totals).getAllByRole("listitem");
    expect(cells[0]).toHaveTextContent("3 files changed");
    // singular below 2, so a substring check against the plural word would hide a regression
    expect(cells[1]).toHaveTextContent("1 function");
    expect(cells[1]).not.toHaveTextContent("functions");
    expect(cells[2]).toHaveTextContent("2 journeys");
    expect(cells[3]).toHaveTextContent("1 table");
    expect(cells[3]).not.toHaveTextContent("tables");
    expect(cells[4]).toHaveTextContent("1 queue");
    expect(cells[4]).not.toHaveTextContent("queues");
  });

  it("lists each affected journey with its changed-stop count and spec pill", async () => {
    await enterSnapshot();
    renderAt("/review");
    await opened();
    const list = screen.getByRole("list", { name: "Journeys affected" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Create customer")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("1 stop changed")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Spec linked")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Bulk import customers")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("No spec")).toBeInTheDocument();
  });

  it("selecting a journey shows its lanes, with the changed stop styled data-changed=true", async () => {
    await enterSnapshot();
    renderAt("/review");
    await opened();
    // the first journey is selected by default
    expect(screen.getByRole("button", { name: /^Create customer/ })).toHaveAttribute("aria-pressed", "true");
    const ui = screen.getByRole("region", { name: "UI" });
    expect(within(ui).getByRole("button", { name: "Stop 1: /customers/new" })).toHaveAttribute("data-changed", "false");
    const code = screen.getByRole("region", { name: "Code" });
    const changed = within(code).getByRole("button", { name: "Stop 5: CustomerService.create" });
    expect(changed).toHaveAttribute("data-changed", "true");
    expect(within(code).getByRole("button", { name: "Stop 4: CustomersController.store" })).toHaveAttribute("data-changed", "false");
  });

  it("clicking a changed stop opens the code panel on Change, with +/- lines in insertion/deletion roles and the diff note", async () => {
    await enterSnapshot();
    renderAt("/review");
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Stop 5: CustomerService.create" }));
    const panel = await screen.findByRole("complementary", { name: "Code panel" });
    expect(within(panel).getByRole("tab", { name: "Change", selected: true })).toBeInTheDocument();
    expect(within(panel).getAllByRole("insertion")).toHaveLength(4);
    expect(within(panel).getAllByRole("deletion")).toHaveLength(1);
    // the note's "+4 −1" is bolded inside the sentence, so the text spans more than one node
    expect(panel.textContent).toContain("+4 −1 lines inside this function. Also on journey Bulk import customers.");
  });

  it("Code now / Code before tabs show the node's after/before text", async () => {
    await enterSnapshot();
    renderAt("/review");
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Stop 5: CustomerService.create" }));
    const panel = await screen.findByRole("complementary", { name: "Code panel" });
    await userEvent.click(within(panel).getByRole("tab", { name: "Code now" }));
    // syntax highlighting can split a line across several token spans, so check the panel's full text
    expect(panel.textContent).toContain("isValidGstin");
    expect(panel.textContent).not.toContain("Customer.create(input)");
    await userEvent.click(within(panel).getByRole("tab", { name: "Code before" }));
    expect(panel.textContent).toContain("Customer.create(input)");
    expect(panel.textContent).not.toContain("isValidGstin");
  });

  it("an unchanged stop with a file opens on Code now, with no Change or Code before tab", async () => {
    const fetch = await enterSnapshot();
    renderAt("/review");
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Stop 4: CustomersController.store" }));
    const panel = await screen.findByRole("complementary", { name: "Code panel" });
    expect(within(panel).getByRole("tab", { name: "Code now", selected: true })).toBeInTheDocument();
    expect(within(panel).queryByRole("tab", { name: "Change" })).toBeNull();
    expect(within(panel).queryByRole("tab", { name: "Code before" })).toBeNull();
    await waitFor(() => expect(panel.textContent).toContain("// controller line 1"));
    expect(fetch.mock.calls.map((c) => String(c[0]))).toContain("./data/files~api~app~controllers~customers_controller.ts.json");
  });

  it('"Comment on GitHub" links to the PR\'s Files changed tab, hashed from the repo-relative path', async () => {
    await enterSnapshot({ pr: 12, repoSlug: "acme/widgets" });
    renderAt("/review");
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Stop 5: CustomerService.create" }));
    const panel = await screen.findByRole("complementary", { name: "Code panel" });
    const hex = createHash("sha256").update("api/app/services/customer_service.ts").digest("hex");
    const link = await within(panel).findByRole("link", { name: "Comment on GitHub ↗" });
    expect(link).toHaveAttribute("href", `https://github.com/acme/widgets/pull/12/files#diff-${hex}`);
  });

  it("hides the GitHub link when the snapshot carries no pr or repoSlug", async () => {
    await enterSnapshot({ pr: undefined, repoSlug: undefined });
    renderAt("/review");
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Stop 5: CustomerService.create" }));
    const panel = await screen.findByRole("complementary", { name: "Code panel" });
    await waitFor(() => expect(within(panel).getAllByRole("insertion")).toHaveLength(4));
    expect(within(panel).queryByRole("link", { name: /Comment on GitHub/ })).toBeNull();
  });

  it("lists changed files with +/- counts and marks the one not on any journey", async () => {
    await enterSnapshot();
    renderAt("/review");
    await opened();
    const files = screen.getByRole("list", { name: "Files changed" });
    const items = within(files).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("app/services/customer_service.ts +18 −3");
    expect(items[1]).toHaveTextContent("lib/gst.ts +41");
    expect(items[1]).toHaveTextContent("not on a journey");
    expect(items[2]).toHaveTextContent("components/CustomerForm.tsx +6 −1");
    expect(items[2]).not.toHaveTextContent("not on a journey");
  });

  it("outside a snapshot, visiting /review redirects to Home", async () => {
    await leaveSnapshot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://127.0.0.1");
        if (url.pathname === "/api/overview") {
          return json({ ...OVERVIEW, repos: [] });
        }
        if (url.pathname === "/api/journeys") return json({ journeys: [], unnamedChains: [] });
        return json({ error: "not found" }, 404);
      }),
    );
    renderAt("/review");
    expect(await screen.findByTestId("screen-home")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-review")).not.toBeInTheDocument();
  });
});
