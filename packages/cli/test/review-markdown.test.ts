import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escapeMarkdownCell, escapeMarkdownInline, renderReviewMarkdown } from "../src/review/markdown.js";
import { escapeMermaidLabel, renderMermaid } from "../src/review/mermaid.js";
import type { Review, ReviewNodeChange, ReviewStop } from "../src/review/types.js";

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

const CHANGED_REF = "api::function:app/services/customer_service.ts:CustomerService.create";

/** page -> call -> route -> handler -> function (CustomerService.create, changed) -> db(customers), each
 * with `from` wired to its real predecessor (I1: no stop is identified only by position). */
function createCustomerStops(): ReviewStop[] {
  return [
    { ref: "web::function:app/customers/new/page.tsx:NewCustomerPage", repo: "web", lane: "ui", label: "NewCustomerPage", file: "app/customers/new/page.tsx", changed: false },
    { ref: "web::call:lib/use-create-customer.ts:5", repo: "web", lane: "ui", label: "useCreateCustomer", file: "lib/use-create-customer.ts", changed: false, from: 0 },
    { ref: "api::route:POST POST /api/customers", repo: "api", lane: "api", label: "POST /api/customers", file: "start/routes.ts", changed: false, from: 1 },
    { ref: "api::function:app/controllers/customers_controller.ts:CustomersController.store", repo: "api", lane: "code", label: "CustomersController.store", file: "app/controllers/customers_controller.ts", changed: false, from: 2 },
    { ref: CHANGED_REF, repo: "api", lane: "code", label: "CustomerService.create", file: "app/services/customer_service.ts", changed: true, from: 3 },
    { ref: "api::db:customers:insert", repo: "api", lane: "db", label: "customers (insert)", file: "app/services/customer_service.ts", changed: false, from: 4 },
  ];
}

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
    chainStops: { ch_1: createCustomerStops() },
    chainNames: { ch_1: "POST /api/customers · NewCustomerPage" },
    tables: ["customers"],
    queues: [],
    truncated: false,
    notes: [],
    ...partial,
  };
}

describe("escapeMermaidLabel", () => {
  it.each([
    ['say "hi"', "say #quot;hi#quot;"],
    ["a[b]", "a#91;b#93;"],
    ["a|b", "a#124;b"],
    ["back`tick", "back#96;tick"],
    ["<script>alert(1)</script>", "#lt;script#gt;alert(1)#lt;/script#gt;"],
  ])("escapes %s", (input, expected) => {
    expect(escapeMermaidLabel(input)).toBe(expected);
  });

  it("[FIX ROUND 2 RED PROBE] flattens a newline to a space (a raw newline inside a quoted Mermaid label breaks the diagram)", () => {
    expect(escapeMermaidLabel("line1\nline2")).toBe("line1 line2");
    expect(escapeMermaidLabel("line1\r\nline2")).toBe("line1 line2");
  });

  it("escapes a literal # first, so pre-existing text can't be decoded as an entity Mermaid understands", () => {
    // If a literal "#91;" survived unescaped, Mermaid's own decoder would turn it into "[".
    expect(escapeMermaidLabel("already #91; looks like a bracket")).toBe("already #35;91; looks like a bracket");
    expect(escapeMermaidLabel("already #35;")).toBe("already #35;35;");
  });
});

describe("escapeMarkdownInline / escapeMarkdownCell", () => {
  it.each([
    ["a|b", "a\\|b"],
    ["[link](url)", "\\[link\\]\\(url\\)"],
    ["back`tick", "back\\`tick"],
    ["under_score", "under\\_score"],
    ["star*risk", "star\\*risk"],
    ["<b>html</b>", "\\<b\\>html\\<\\/b\\>".replace("\\/", "/")], // "/" itself is not escaped
    ["@mention #123 !image", "\\@mention \\#123 \\!image"],
    ["line1\nline2", "line1 line2"],
    ["back\\slash", "back\\\\slash"],
  ])("escapes %s", (input, expected) => {
    expect(escapeMarkdownInline(input)).toBe(expected);
  });

  it("escapeMarkdownCell replaces an empty result with a literal underscore, so the cell is never blank", () => {
    expect(escapeMarkdownCell("")).toBe("\\_");
  });
});

describe("renderMermaid", () => {
  it("draws the chain's stops in order, marking the changed one", () => {
    const out = renderMermaid(baseReview());
    expect(out.startsWith("```mermaid\nflowchart LR\n")).toBe(true);
    expect(out.endsWith("```")).toBe(true);
    expect(out).toContain('["✏️ CustomerService.create"]:::changed');
    expect(out).toContain("classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px");
    expect(out).toContain('["customers (insert)"]');
    expect(out).toContain("n1 --> n2");
  });

  it("caps at maxNodes and notes how many more there are", () => {
    const stops: ReviewStop[] = Array.from({ length: 45 }, (_, i) => ({
      ref: `api::function:f${i}.ts:fn${i}`, repo: "api", lane: "code", label: `fn${i}`, file: `f${i}.ts`, changed: false,
    }));
    const out = renderMermaid(baseReview({ chains: ["ch_1"], chainStops: { ch_1: stops } }), 30);
    expect(out).toContain("+15 more — see the full map");
    expect(out.match(/\bn\d+\[/g)?.length).toBe(31); // 30 real stops + the "+N more" node
  });

  it("escapes a stop label that could break the diagram or inject a script tag", () => {
    const evil: ReviewStop = { ref: "api::evil", repo: "api", lane: "code", label: '<script>"a|b[c]`d</script>', changed: false };
    const out = renderMermaid(baseReview({ chains: ["ch_1"], chainStops: { ch_1: [evil] } }));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('"a|b[c]');
  });

  it("is deterministic", () => {
    const review = baseReview();
    expect(renderMermaid(review)).toBe(renderMermaid(review));
  });
});

describe("renderReviewMarkdown", () => {
  it("golden: the normal PR block", () => {
    const out = renderReviewMarkdown(baseReview(), { link: "https://x.github.io/demo/pr-1/", builtFor: "a41c9e2" });
    expect(out).toContain("### 🗺 codeloom review map");
    expect(out).toContain("This PR touches 1 journey, 1 chain, 1 table, 0 queues.");
    expect(out).toContain("```mermaid");
    expect(out).toContain("Not on any journey:");
    expect(out).toContain("lib/gst.ts");
    expect(out).toContain("→ Open the full review map: https://x.github.io/demo/pr-1/ (built for a41c9e2)");
    expectGolden("review-basic.md", out);
  });

  it("is deterministic", () => {
    const review = baseReview();
    expect(renderReviewMarkdown(review, { link: "https://x" })).toBe(renderReviewMarkdown(review, { link: "https://x" }));
  });

  it("[FIX ROUND 2 RED PROBE] falls back to a chains table showing the chain's NAME (not an opaque id) when no journeys are named yet", () => {
    const out = renderReviewMarkdown(baseReview({ journeys: [] }), {});
    expect(out).toContain("| Chain | Changed stops |");
    expect(out).toContain("POST /api/customers · NewCustomerPage"); // chainNames, displayed (and escaped like any label)
    expect(out).not.toContain("| ch"); // never the bare id as the visible cell
    expect(out).toContain("CustomerService.create");
    expect(out).not.toContain("| Journey | Changed stops | Spec |");
  });

  it("says no journeys were touched and lists the changed files when no chain is touched", () => {
    const out = renderReviewMarkdown(baseReview({ journeys: [], chains: [], chainStops: {}, tables: [], nodes: [] }), {});
    expect(out).toContain("No journeys touched.");
    // The file path is in a code span: CommonMark never processes backslash escapes there, so there must
    // be none — a literal backslash would otherwise show up in the rendered path.
    expect(out).toContain("customer_service.ts");
    expect(out).not.toContain("customer\\_service.ts");
    expect(out).toContain("lib/gst.ts");
    expect(out).not.toContain("```mermaid");
  });

  it("[FIX ROUND 2 RED PROBE] a backtick in a file path cannot close its own code span early", () => {
    const out = renderReviewMarkdown(baseReview({ files: [{ repo: "api", file: "evil`.ts` injected", added: 1, removed: 0, onJourney: false }] }), {});
    // A single-backtick-fenced span ("`evil`") would close right after "evil", leaving ".ts` injected`"
    // as plain text outside any span — i.e. the raw backtick survives OUTSIDE a code span. The fix must
    // use a longer fence so the whole path stays inside one span and no bare "`" escapes it.
    const line = out.split("\n").find((l) => l.includes("evil"))!;
    expect(line).not.toMatch(/`evil`/);
  });

  it("shows only the heading and the error line when the build failed (review is null)", () => {
    const out = renderReviewMarkdown(null, { error: "codeloom index failed: see the run log." });
    expect(out).toBe("### 🗺 codeloom review map\n\ncodeloom index failed: see the run log.");
  });

  it("links the last good map next to the error", () => {
    const out = renderReviewMarkdown(null, {
      error: "codeloom index failed: see the run log.",
      previous: { link: "https://x.github.io/demo/pr-1/", builtFor: "a41c9e2" },
    });
    expect(out).toContain("codeloom index failed: see the run log.");
    expect(out).toContain("Last good map (a41c9e2): https://x.github.io/demo/pr-1/");
  });

  it("reports a too-large snapshot after the summary and diagram, with no link", () => {
    const out = renderReviewMarkdown(baseReview(), { tooLarge: { bytes: 38_000_000, max: 25_000_000 }, link: "https://should-not-appear" });
    expect(out).toContain("```mermaid");
    expect(out).toContain("Full map too large to host (38 MB > 25 MB).");
    expect(out).not.toContain("should-not-appear");
    expect(out).not.toContain("Open the full review map");
  });

  it("renders a caveat line for notes and a truncated result, so an approximate/cut map is visible", () => {
    const out = renderReviewMarkdown(baseReview({ truncated: true, notes: ["api: map indexed at abc1234, not at def5678; line matches are approximate"] }), {});
    expect(out).toContain("Some results were truncated.");
    expect(out).toContain("map indexed at abc1234");
  });

  it("pluralizes correctly at 0 and 1", () => {
    const out = renderReviewMarkdown(baseReview({ journeys: [{ id: "j_1", name: "Create a customer", changedStops: [CHANGED_REF], spec: "unchecked", chains: ["ch_1"] }], queues: [] }), {});
    expect(out).toContain("This PR touches 1 journey, 1 chain, 1 table, 0 queues.");
  });

  /** A table cell's own escaped "\|" is still textually two characters (backslash, pipe); a real GFM
   * renderer reads the backslash and does not treat it as a new column, but a naive `.split("|")` would —
   * so count only pipes NOT preceded by a backslash, the actual column separators. */
  const realPipes = (line: string): number => (line.match(/(?<!\\)\|/g) ?? []).length;

  it("escapes an attacker-controlled journey name so it can't break the table or inject a link", () => {
    const evil = "Evil](https://evil.example) | injected [cell";
    const out = renderReviewMarkdown(baseReview({ journeys: [{ id: "j_1", name: evil, changedStops: [CHANGED_REF], spec: "unchecked", chains: ["ch_1"] }] }), {});
    const tableLine = out.split("\n").find((l) => l.includes("Evil"))!;
    expect(tableLine).toContain("\\|"); // the name's own "|" survives, but escaped
    // 3 columns (name, stops, spec) = 4 real (unescaped) pipes: leading + 2 separators + trailing.
    expect(realPipes(tableLine)).toBe(4);
    expect(out).not.toContain("](https://evil.example)");
  });

  it("keeps an attacker-controlled file path inert inside its code span (CommonMark never reads link/image syntax inside one)", () => {
    const out = renderReviewMarkdown(baseReview({ files: [{ repo: "api", file: "evil](https://evil.example)|x.ts", added: 1, removed: 0, onJourney: false }] }), {});
    const line = out.split("\n").find((l) => l.includes("evil"))!;
    // The whole path, "](" included, must sit inside ONE code span (a backtick fence on both sides of it)
    // rather than the fence breaking partway through and leaving "](https://evil.example)" as live prose.
    expect(line).toMatch(/`+ api\/evil\]\(https:\/\/evil\.example\)\|x\.ts `+/);
  });

  it("escapes an attacker-controlled chain name/stop label in the bare chains table", () => {
    const evilStop: ReviewStop = { ref: "api::evil", repo: "api", lane: "code", label: "injected | cell [link](https://evil.example)", changed: true };
    const evilName = "Evil ](x) | chain";
    const out = renderReviewMarkdown(
      baseReview({ journeys: [], chains: ["ch_evil"], chainStops: { ch_evil: [evilStop] }, chainNames: { ch_evil: evilName } }),
      {},
    );
    const tableLine = out.split("\n").find((l) => l.startsWith("|") && l.includes("injected"))!;
    expect(tableLine).toContain("Evil");
    // 2 columns (chain, stops) = 3 real (unescaped) pipes: leading + 1 separator + trailing.
    expect(realPipes(tableLine)).toBe(3);
    expect(out).not.toContain("](https://evil.example)");
    expect(out).not.toContain("](x)");
  });
});
