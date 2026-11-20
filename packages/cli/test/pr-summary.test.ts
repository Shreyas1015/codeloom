import { describe, expect, it } from "vitest";
import { buildReview } from "../src/review/build.js";
import { renderReviewDraft } from "../src/review/markdown.js";
import { buildCheckPacket } from "../src/review/packet.js";
import { rememberPacket, savePrReview, type SavedPrReview } from "../src/review/saved.js";
import { buildPrSummary, checkPrSummary, type PrSummary } from "../src/review/summary.js";
import type { Review } from "../src/review/types.js";
import { MIGRATION, makeApiPr, setUpFolder } from "./review-pr-fixture.js";

// The PR summary (codeloom pr, the snapshot's data/pr-summary.json): the same merge of codeloom's detected facts
// and Claude's saved review that renderReviewDraft prints, as data the dashboard can show.

const NOW = () => new Date("2026-11-16T10:00:00Z");

async function apiPr(): Promise<{ root: string; review: Review }> {
  const root = await setUpFolder();
  makeApiPr(root);
  return { root, review: buildReview(root, "main", { repoId: "api" }) };
}

function saveChecked(root: string, review: Review): SavedPrReview {
  rememberPacket(root, buildCheckPacket(root, "main", { repoId: "api" }));
  return savePrReview(
    root,
    {
      head: review.head,
      whatItDoes: "Creating a customer now also pings an optional webhook.",
      whereItMatters: [{ name: "/customers/new", why: "the new-customer form" }],
      writes: [{ name: "customers", note: "one new row" }],
      beforeDeploying: [{ file: `api/${MIGRATION}`, note: "run the phone-number migration" }, { note: "set the webhook URL" }],
      codeToCheck: [{ name: "CustomerService.find", note: "now coerces the id" }],
      notes: ["The docs change is only wording."],
    },
    { now: NOW },
  ).review;
}

describe("buildPrSummary", () => {
  it("draft: the detected facts only, status draft, no What it does", async () => {
    const { review } = await apiPr();
    const s = buildPrSummary(review);
    expect(s.version).toBe(1);
    expect(s.status).toBe("draft");
    expect(s.head).toBe(review.head);
    expect(s.base).toBe(review.base);
    expect(s.repoId).toBe("api");
    expect(s.whatItDoes).toBeUndefined();
    expect(s.checkedAt).toBeUndefined();
    expect(s.notes).toBeUndefined();
    expect(s.whereItMatters.length).toBeGreaterThan(0);
    expect(s.whereItMatters.every((w) => w.kind !== undefined)).toBe(true);
    // the migration and the new .env.example key are detected risks
    expect(s.beforeDeploying.map((r) => r.file)).toContain(`api/${MIGRATION}`);
    expect(s.beforeDeploying.every((r) => r.detected && r.notes.length === 0)).toBe(true);
    // every changed function, with its node ref (so the dashboard can open its diff), +/- counts and file
    const names = s.codeToCheck.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["CustomerService.create", "CustomerService.find"]));
    const create = s.codeToCheck.find((c) => c.name === "CustomerService.create")!;
    expect(create).toMatchObject({ detected: true, change: "changed", file: "api/app/services/customer_service.ts", notes: [] });
    expect(create.ref).toBe(review.nodes.find((n) => n.symbol === "CustomerService.create")!.ref);
    expect(create.added).toBeGreaterThan(0);
  });

  it("checked: Claude's What it does and Where it matters, its notes beside the detected facts, which all stay", async () => {
    const { root, review } = await apiPr();
    const saved = saveChecked(root, review);
    const s = buildPrSummary(review, saved);
    expect(s.status).toBe("checked");
    expect(s.checkedAt).toBe("2026-11-16T10:00:00.000Z");
    expect(s.whatItDoes).toBe("Creating a customer now also pings an optional webhook.");
    expect(s.whereItMatters).toEqual([{ name: "/customers/new", why: "the new-customer form" }]);
    expect(s.notes).toEqual(["The docs change is only wording."]);
    // the migration risk carries Claude's note; Claude's file-less risk is added after the detected ones
    const migration = s.beforeDeploying.find((r) => r.file === `api/${MIGRATION}`)!;
    expect(migration).toMatchObject({ detected: true, kind: "migration", notes: ["run the phone-number migration"] });
    expect(s.beforeDeploying.at(-1)).toEqual({ detected: false, notes: ["set the webhook URL"] });
    // the function Claude noted comes first; every detected one stays
    expect(s.codeToCheck[0]).toMatchObject({ name: "CustomerService.find", detected: true, notes: ["now coerces the id"] });
    expect(s.codeToCheck.map((c) => c.name)).toContain("CustomerService.create");
    expect(s.codeToCheck.filter((c) => !c.detected)).toEqual([]);
  });

  it("a saved review for another head is ignored: the draft", async () => {
    const { root, review } = await apiPr();
    const saved = saveChecked(root, review);
    expect(buildPrSummary(review, { ...saved, head: "f".repeat(40) }).status).toBe("draft");
  });

  it("is what renderReviewDraft prints (one merge, two renderings)", async () => {
    const { root, review } = await apiPr();
    const saved = saveChecked(root, review);
    const md = renderReviewDraft(review, { checked: saved });
    const s = buildPrSummary(review, saved);
    for (const c of s.codeToCheck) expect(md).toContain(c.name);
    expect(md).toContain("Claude: now coerces the id");
    expect(md).toContain("Claude: run the phone-number migration");
    expect(md).toContain("_Checked by Claude 2026-11-16._");
  });
});

describe("checkPrSummary (the hosted snapshot's trust check)", () => {
  async function both(): Promise<{ review: Review; draft: PrSummary; checked: PrSummary }> {
    const { root, review } = await apiPr();
    const saved = saveChecked(root, review);
    // JSON round trip: what the publish step reads back from data/pr-summary.json
    const rt = (s: PrSummary): PrSummary => JSON.parse(JSON.stringify(s)) as PrSummary;
    return { review, draft: rt(buildPrSummary(review)), checked: rt(buildPrSummary(review, saved)) };
  }

  it("accepts what codeloom wrote, draft and checked", async () => {
    const { review, draft, checked } = await both();
    expect(checkPrSummary(draft, review)).toEqual({ ok: true, summary: draft });
    expect(checkPrSummary(checked, review)).toEqual({ ok: true, summary: checked });
  });

  it("refuses a bad shape: a control character, an over-long line, an unknown key, a wrong status", async () => {
    const { review, checked } = await both();
    expect(checkPrSummary({ ...checked, whatItDoes: "line one\nline two" }, review)).toEqual({ ok: false, why: "shape" });
    expect(checkPrSummary({ ...checked, whatItDoes: "x".repeat(401) }, review)).toEqual({ ok: false, why: "shape" });
    expect(checkPrSummary({ ...checked, html: "<script>" }, review)).toEqual({ ok: false, why: "shape" });
    expect(checkPrSummary({ ...checked, status: "approved" }, review)).toEqual({ ok: false, why: "shape" });
    expect(checkPrSummary({ ...checked, notes: ["\u001b[31mred"] }, review)).toEqual({ ok: false, why: "shape" });
    expect(checkPrSummary({ ...checked, checkedAt: undefined }, review)).toEqual({ ok: false, why: "shape" });
    expect(checkPrSummary(null, review)).toEqual({ ok: false, why: "shape" });
  });

  it("I1: a detected name with a control character (a changed file named with a newline) is fine — names are only matched to the facts", async () => {
    const { review } = await both();
    const odd: Review = {
      ...review,
      files: [...review.files, { repo: "api", file: "database/migrations/a\nb.sql", added: 1, removed: 0, onChain: false }],
      risks: [...review.risks, { kind: "migration", file: "api/database/migrations/a\nb.sql" }],
    };
    const s = buildPrSummary(odd);
    expect(s.beforeDeploying.map((r) => r.file)).toContain("api/database/migrations/a\nb.sql");
    expect(checkPrSummary(JSON.parse(JSON.stringify(s)), odd).ok).toBe(true);
  });

  it("refuses names that are not in review.json's facts, and a summary of another head", async () => {
    const { review, checked } = await both();
    const badCode = { ...checked, codeToCheck: [...checked.codeToCheck, { name: "Evil.run", detected: false, notes: [] }] };
    expect(checkPrSummary(badCode, review)).toEqual({ ok: false, why: "names" });
    const badWrite = { ...checked, writes: [{ name: "secrets", detected: true, notes: [] }] };
    expect(checkPrSummary(badWrite, review)).toEqual({ ok: false, why: "names" });
    const badRef = { ...checked, codeToCheck: [{ ...checked.codeToCheck[0]!, ref: "api::function:x.ts:Nope" }] };
    expect(checkPrSummary(badRef, review)).toEqual({ ok: false, why: "names" });
    expect(checkPrSummary({ ...checked, head: "e".repeat(40) }, review)).toEqual({ ok: false, why: "names" });
  });
});
