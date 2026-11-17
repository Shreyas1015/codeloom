import { describe, expect, it } from "vitest";
import { buildReview } from "../src/review/build.js";
import { buildCheckPacket, packetFromReview, packetText, PACKET_LIMITS } from "../src/review/packet.js";
import type { Review, ReviewNodeChange } from "../src/review/types.js";
import { MIGRATION, makeApiPr, setUpFolder } from "./review-pr-fixture.js";

describe("buildCheckPacket on demo-shop", () => {
  it("carries the draft, the changed hunks, the commits and the facts it cites, under the cap", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const review = buildReview(root, "main", { repoId: "api" });
    const packet = buildCheckPacket(root, "main", { repoId: "api" });

    expect(packet.head).toBe(review.head);
    expect(packet.base).toBe(review.base);
    expect(packet.repoId).toBe("api");
    expect(packet.draft.writes).toEqual(["audit_logs", "customers"]);
    expect(packet.draft.codeToCheck.map((c) => c.name)).toEqual(["CustomerService.find", "CustomerService.create"]);
    expect(packet.draft.whereItMatters[0]).toEqual({ kind: "page", name: "/customers/new", journey: "Create a customer", repo: "web" });
    expect(packet.draft.beforeDeploying.map((r) => r.file)).toContain(`api/${MIGRATION}`);

    // Only the changed hunks of each changed function, with their +/- lines.
    const create = packet.hunks.find((h) => h.name === "CustomerService.create")!;
    expect(create.lines.some((l) => l.startsWith("+") && l.includes("CUSTOMER_WEBHOOK_URL"))).toBe(true);
    expect(create.file).toBe("api/app/services/customer_service.ts");

    // Commit subjects and bodies, oldest first.
    expect(packet.commits).toEqual(["notify a webhook on create", "coerce the id in find", "phone numbers", "  Customers can now have a phone number."]);

    // The facts: every name the draft cites, and the names on the touched chains.
    expect(packet.facts.functions).toEqual(expect.arrayContaining(["CustomerService.create", "CustomerService.find"]));
    expect(packet.facts.tables).toEqual(expect.arrayContaining(["audit_logs", "customers"]));
    expect(packet.facts.pages).toEqual(expect.arrayContaining(["/customers/new", "/customers/:id"]));
    expect(packet.facts.routes).toEqual(expect.arrayContaining(["POST /api/customers"]));
    expect(packet.facts.files).toEqual(expect.arrayContaining([`api/${MIGRATION}`, "api/app/services/customer_service.ts"]));
    expect(packet.facts.journeys).toEqual(["Create a customer"]);

    expect(packet.cut).toEqual([]);
    expect(packetText(packet).length).toBeLessThanOrEqual(PACKET_LIMITS.chars);
  });
});

// ---- caps, on a synthetic Review (no git needed) ------------------------------------------------------------

function bigReview(): Review {
  const nodes: ReviewNodeChange[] = Array.from({ length: 40 }, (_, i) => ({
    ref: `api::function:src/f${i}.ts:Service${i}.run`,
    repo: "api",
    file: `src/f${i}.ts`,
    symbol: `Service${i}.run`,
    before: { start: 1, end: 200, text: "" },
    after: { start: 1, end: 200, text: "" },
    hunks: [
      { oldStart: 1, oldLines: 100, newStart: 1, newLines: 100, lines: Array.from({ length: 100 }, (_, j) => `+  const value${j} = compute(${j}); // ${"x".repeat(60)}`) },
    ],
    added: 100,
    removed: 0,
    journeys: [],
  }));
  return {
    version: 1,
    base: "a".repeat(40),
    head: "b".repeat(40),
    baseRef: "main",
    files: nodes.map((n) => ({ repo: "api", file: n.file, added: 100, removed: 0, onChain: true })),
    nodes,
    journeys: [],
    chains: [],
    chainStops: {},
    chainNames: {},
    tables: Array.from({ length: 300 }, (_, i) => `table_${i}_${"t".repeat(40)}`),
    queues: [],
    truncated: false,
    notes: [],
    repoId: "api",
    entries: [],
    writes: [],
    readsOnly: [],
    risks: [],
  };
}

describe("packetFromReview caps", () => {
  it("keeps each hunk to 60 lines and all hunks to 400, commits to 40 lines, and lists what it cut", () => {
    const commits = Array.from({ length: 90 }, (_, i) => `commit ${i}`);
    const packet = packetFromReview(bigReview(), commits);
    expect(packet.hunks.every((h) => h.lines.length <= PACKET_LIMITS.hunkLines)).toBe(true);
    expect(packet.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(PACKET_LIMITS.totalHunkLines);
    expect(packet.commits.length).toBeLessThanOrEqual(PACKET_LIMITS.commitLines);
    expect(packetText(packet).length).toBeLessThanOrEqual(PACKET_LIMITS.chars);
    expect(packet.cut.some((c) => /hunk/.test(c) && /60/.test(c))).toBe(true);
    expect(packet.cut.some((c) => /^commits: kept \d+ of 90 lines/.test(c))).toBe(true);
    expect(packet.cut.some((c) => /^facts\.tables: kept \d+ of 300/.test(c))).toBe(true);
  });

  it("stays under 24,000 characters however long the names are", () => {
    const review = bigReview();
    review.tables = Array.from({ length: 300 }, (_, i) => `${i}${"t".repeat(2000)}`);
    review.writes = review.tables.slice(0, 200);
    for (const n of review.nodes) n.symbol = `${n.symbol}${"s".repeat(3000)}`;
    const packet = packetFromReview(review, Array.from({ length: 40 }, () => "c".repeat(5000)));
    expect(packetText(packet).length).toBeLessThanOrEqual(PACKET_LIMITS.chars);
    expect(packet.cut.length).toBeGreaterThan(0);
  });
});

// ---- the cut order (fix round 1) ---------------------------------------------------------------------------

function node(i: number, name: string, hunks: number[]): ReviewNodeChange {
  return {
    ref: `api::function:src/f${i}.ts:${name}`,
    repo: "api",
    file: `src/f${i}.ts`,
    symbol: name,
    before: { start: 1, end: 500, text: "" },
    after: { start: 1, end: 500, text: "" },
    hunks: hunks.map((n, h) => ({
      oldStart: 1 + h * 100,
      oldLines: n,
      newStart: 1 + h * 100,
      newLines: n,
      lines: Array.from({ length: n }, (_, j) => `+    const total${j} = await this.repository.computeSomething(${j}, options); // ${"y".repeat(40)}`),
    })),
    added: hunks.reduce((a, b) => a + b, 0),
    removed: 0,
    journeys: [],
  };
}

/** 10 changed functions with real-sized hunks, on chains with 600 other (uncited) function names, 40 commit lines. */
function realisticReview(): Review {
  const review = bigReview();
  review.nodes = Array.from({ length: 10 }, (_, i) => node(i, `InvoiceService${i}.upsert`, [45, 30]));
  review.files = review.nodes.map((n) => ({ repo: "api", file: n.file, added: n.added, removed: 0, onChain: true }));
  review.tables = ["invoice"];
  review.writes = ["invoice"];
  review.chains = ["ch_1"];
  review.chainStops = {
    ch_1: Array.from({ length: 600 }, (_, i) => ({
      ref: `api::function:src/other${i}.ts:OtherService${i}.method${i}WithAQuiteLongName`,
      repo: "api",
      lane: "code",
      kind: "function",
      label: `OtherService${i}.method${i}WithAQuiteLongName`,
      file: `src/other${i}.ts`,
      changed: false,
    })),
  };
  return review;
}

describe("packetFromReview cut order", () => {
  it("cuts uncited facts before code: every changed function keeps some of its code, every cited name stays", () => {
    const review = realisticReview();
    const packet = packetFromReview(review, Array.from({ length: 40 }, (_, i) => `commit line ${i} ${"z".repeat(60)}`));
    expect(packetText(packet).length).toBeLessThanOrEqual(PACKET_LIMITS.chars);
    const withCode = new Set(packet.hunks.filter((h) => h.lines.length > 0).map((h) => h.name));
    expect([...withCode].sort()).toEqual(review.nodes.map((n) => n.symbol).sort());
    for (const name of review.nodes.map((n) => n.symbol)) {
      const lines = packet.hunks.filter((h) => h.name === name).reduce((n, h) => n + h.lines.length, 0);
      expect(lines, name).toBeGreaterThanOrEqual(10);
    }
    for (const c of packet.draft.codeToCheck) expect(packet.facts.functions).toContain(c.name);
    expect(packet.facts.tables).toContain("invoice");
    expect(packet.commits.length).toBeGreaterThanOrEqual(10);
    expect(packet.cut.some((c) => c.startsWith("facts.functions: kept"))).toBe(true);
  });

  it("never cuts a fact the draft cites: a draft item and its fact go together", () => {
    const review = bigReview();
    review.nodes = Array.from({ length: 150 }, (_, i) => node(i, `S${i}.${"m".repeat(150)}`, [5]));
    review.tables = [];
    const packet = packetFromReview(review, []);
    expect(packetText(packet).length).toBeLessThanOrEqual(PACKET_LIMITS.chars);
    expect(packet.draft.codeToCheck.length).toBeGreaterThan(0);
    for (const c of packet.draft.codeToCheck) expect(packet.facts.functions).toContain(c.name);
    expect(packet.cut.some((c) => c.startsWith("draft.codeToCheck: kept"))).toBe(true);
  });

  it("notes long hunks only when they are in the packet", () => {
    const review = bigReview();
    review.tables = [];
    review.nodes = [node(0, "A.run", [50, 50, 50, 50, 50, 50, 50, 50, 100])];
    const packet = packetFromReview(review, []);
    expect(packet.hunks.every((h) => h.lines.length <= 50)).toBe(true);
    expect(packet.cut.some((c) => /longer than 60 lines/.test(c))).toBe(false);
    // …and does note one that is in it.
    review.nodes = [node(0, "A.run", [100])];
    expect(packetFromReview(review, []).cut).toContain("hunks: 1 hunk longer than 60 lines, each cut to at most 60");
  });

  it("gives budget the even cut leaves unused to the changed functions in draft order", () => {
    const review = bigReview();
    review.tables = [];
    review.nodes = Array.from({ length: 100 }, (_, i) => node(i, `Svc${String(i).padStart(3, "0")}.run`, [30]));
    const packet = packetFromReview(review, []);
    expect(packetText(packet).length).toBeLessThanOrEqual(PACKET_LIMITS.chars);
    const order = packet.draft.codeToCheck.map((c) => c.name);
    const linesOf = (name: string) => packet.hunks.filter((h) => h.name === name).reduce((n, h) => n + h.lines.length, 0);
    for (const name of order.slice(0, 3)) expect(linesOf(name), name).toBeGreaterThan(0);
    // The budget is used: within a few lines' worth of the cap.
    expect(packetText(packet).length).toBeGreaterThan(PACKET_LIMITS.chars - 400);
  });
});
