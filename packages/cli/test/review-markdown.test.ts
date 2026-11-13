import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MapState } from "../src/mcp/state.js";
import { escapeMermaidLabel, renderMermaid } from "../src/review/mermaid.js";
import { renderReviewMarkdown } from "../src/review/markdown.js";
import type { Review, ReviewNodeChange } from "../src/review/types.js";
import type { Chain, ChainStop } from "../src/store/schemas.js";

const GOLDEN_DIR = join(import.meta.dirname, "golden");

function readGolden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, name), "utf8");
}

/** Capture-and-compare: writes the golden file the first time (or when CODELOOM_UPDATE_GOLDEN=1), else
 * compares against it — the same pattern test/docs.test.ts uses for packages/cli/README.md. */
function expectGolden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name);
  if (process.env.CODELOOM_UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, actual);
  expect(actual).toBe(readGolden(name));
}

function emptyState(chains: Chain[]): MapState {
  return {
    ws: { root: "/repo", name: "demo", repos: [], links: [] },
    chains,
    uiReach: [],
    manualLinks: [],
    external: [],
    journeys: [],
    chainsPath: "/repo/.codeloom/chains.json",
    journeysPath: "/repo/.codeloom/journeys.json",
  };
}

const hop = { confidence: "exact" as const };

function stop(partial: Partial<ChainStop> & Pick<ChainStop, "lane" | "kind" | "repo" | "file" | "line" | "symbol">): ChainStop {
  return { hop, ...partial };
}

/** page -> call -> route -> handler -> function (CustomerService.create) -> db(customers). */
function createCustomerChain(id = "ch_1"): Chain {
  return {
    id,
    entry: "page:web:/customers/new",
    routeKey: "api:POST /api/customers",
    name: "POST /api/customers · NewCustomerPage",
    confidence: "exact",
    complete: true,
    unresolved: [],
    stops: [
      stop({ lane: "ui", kind: "page", repo: "web", file: "app/customers/new/page.tsx", line: 1, symbol: "NewCustomerPage" }),
      stop({ lane: "ui", kind: "call", repo: "web", file: "lib/use-create-customer.ts", line: 5, symbol: "useCreateCustomer", from: 0 }),
      stop({
        lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 7, symbol: "CustomersController.store",
        op: "POST", label: "POST /api/customers", from: 1,
      }),
      stop({
        lane: "code", kind: "handler", repo: "api", file: "app/controllers/customers_controller.ts", line: 9,
        symbol: "CustomersController.store",
        nodeId: "function:app/controllers/customers_controller.ts:CustomersController.store", from: 2,
      }),
      stop({
        lane: "code", kind: "function", repo: "api", file: "app/services/customer_service.ts", line: 5,
        symbol: "CustomerService.create", nodeId: "function:app/services/customer_service.ts:CustomerService.create", from: 3,
      }),
      stop({ lane: "db", kind: "db", repo: "api", file: "app/services/customer_service.ts", line: 6, symbol: "CustomerService.create", op: "insert", label: "customers", from: 4 }),
    ],
  };
}

const CHANGED_REF = "api::function:app/services/customer_service.ts:CustomerService.create";

function changedNode(partial: Partial<ReviewNodeChange> = {}): ReviewNodeChange {
  return {
    ref: CHANGED_REF,
    repo: "api",
    file: "app/services/customer_service.ts",
    symbol: "CustomerService.create",
    before: { start: 5, end: 9, text: 'async create() {\n  await db.table("audit_logs").insert(...);\n  return x;\n}' },
    after: { start: 5, end: 11, text: 'async create() {\n  if (!x) throw new Error("bad");\n  return x;\n}' },
    hunks: [{ oldStart: 5, oldLines: 5, newStart: 5, newLines: 7, lines: [" context", "-old", "+new1", "+new2", "+new3", " context"] }],
    added: 3,
    removed: 1,
    journeys: ["j_1"],
    ...partial,
  };
}

function baseReview(partial: Partial<Review> = {}): Review {
  return {
    version: 1,
    base: "a".repeat(40),
    head: "b".repeat(40),
    baseRef: "main",
    files: [
      { repo: "api", file: "app/services/customer_service.ts", added: 3, removed: 1, onJourney: true },
      { repo: "api", file: "lib/gst.ts", added: 1, removed: 0, onJourney: false },
    ],
    nodes: [changedNode()],
    journeys: [{ id: "j_1", name: "Create a customer", changedStops: [CHANGED_REF], spec: "unchecked", chains: ["ch_1"] }],
    chains: ["ch_1"],
    tables: ["customers"],
    queues: [],
    truncated: false,
    notes: [],
    ...partial,
  };
}

describe("escapeMermaidLabel", () => {
  it.each([
    ['say "hi"', "say &quot;hi&quot;"],
    ["a[b]", "a#91;b#93;"],
    ["a|b", "a#124;b"],
    ["back`tick", "back&#96;tick"],
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
  ])("escapes %s", (input, expected) => {
    expect(escapeMermaidLabel(input)).toBe(expected);
  });
});

describe("renderMermaid", () => {
  it("draws the chain's stops in order, marking the changed one", () => {
    const state = emptyState([createCustomerChain()]);
    const out = renderMermaid(baseReview(), state);
    expect(out.startsWith("```mermaid\nflowchart LR\n")).toBe(true);
    expect(out.endsWith("```")).toBe(true);
    expect(out).toContain('["✏️ CustomerService.create"]:::changed');
    expect(out).toContain("classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px");
    expect(out).toContain('["customers (insert)"]');
    expect(out).toContain("n1 --> n2");
  });

  it("caps at maxNodes and notes how many more there are", () => {
    const stops: ChainStop[] = [];
    for (let i = 0; i < 45; i++) {
      stops.push(stop({ lane: "code", kind: "function", repo: "api", file: `f${i}.ts`, line: 1, symbol: `fn${i}`, from: i > 0 ? i - 1 : undefined }));
    }
    const chain: Chain = { ...createCustomerChain(), stops };
    const out = renderMermaid(baseReview({ chains: [chain.id] }), emptyState([chain]), 30);
    expect(out).toContain("+15 more — see the full map");
    expect(out.match(/\bn\d+\[/g)?.length).toBe(31); // 30 real stops + the "+N more" node
  });

  it("is deterministic", () => {
    const state = emptyState([createCustomerChain()]);
    const review = baseReview();
    expect(renderMermaid(review, state)).toBe(renderMermaid(review, state));
  });
});

describe("renderReviewMarkdown", () => {
  it("golden: the normal PR block", () => {
    const state = emptyState([createCustomerChain()]);
    const out = renderReviewMarkdown(baseReview(), state, { link: "https://x.github.io/demo/pr-1/", builtFor: "a41c9e2" });
    expect(out).toContain("### 🗺 codeloom review map");
    expect(out).toContain("This PR touches 1 journeys, 1 chains, 1 tables, 0 queues.");
    expect(out).toContain("```mermaid");
    expect(out).toContain("Not on any journey:");
    expect(out).toContain("lib/gst.ts");
    expect(out).toContain("→ Open the full review map: https://x.github.io/demo/pr-1/ (built for a41c9e2)");
    expectGolden("review-basic.md", out);
  });

  it("is deterministic", () => {
    const state = emptyState([createCustomerChain()]);
    const review = baseReview();
    expect(renderReviewMarkdown(review, state, { link: "https://x" })).toBe(renderReviewMarkdown(review, state, { link: "https://x" }));
  });

  it("falls back to a chains table when no journeys are named yet", () => {
    const state = emptyState([createCustomerChain()]);
    const out = renderReviewMarkdown(baseReview({ journeys: [] }), state, {});
    expect(out).toContain("| Chain | Changed stops |");
    expect(out).toContain("POST /api/customers · NewCustomerPage");
    expect(out).not.toContain("| Journey | Changed stops | Spec |");
  });

  it("says no journeys were touched and lists the changed files when no chain is touched", () => {
    const out = renderReviewMarkdown(
      baseReview({ journeys: [], chains: [], tables: [], nodes: [] }),
      emptyState([]),
      {},
    );
    expect(out).toContain("No journeys touched.");
    expect(out).toContain("app/services/customer_service.ts");
    expect(out).toContain("lib/gst.ts");
    expect(out).not.toContain("```mermaid");
  });

  it("shows only the heading and the error line when the build failed (review is null)", () => {
    const out = renderReviewMarkdown(null, null, { error: "codeloom index failed: see the run log." });
    expect(out).toBe("### 🗺 codeloom review map\n\ncodeloom index failed: see the run log.");
  });

  it("links the last good map next to the error", () => {
    const out = renderReviewMarkdown(null, null, {
      error: "codeloom index failed: see the run log.",
      previous: { link: "https://x.github.io/demo/pr-1/", builtFor: "a41c9e2" },
    });
    expect(out).toContain("codeloom index failed: see the run log.");
    expect(out).toContain("Last good map (a41c9e2): https://x.github.io/demo/pr-1/");
  });

  it("reports a too-large snapshot after the summary and diagram, with no link", () => {
    const state = emptyState([createCustomerChain()]);
    const out = renderReviewMarkdown(baseReview(), state, { tooLarge: { bytes: 38_000_000, max: 25_000_000 }, link: "https://should-not-appear" });
    expect(out).toContain("```mermaid");
    expect(out).toContain("Full map too large to host (38 MB > 25 MB).");
    expect(out).not.toContain("should-not-appear");
    expect(out).not.toContain("Open the full review map");
  });
});
