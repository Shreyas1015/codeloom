import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runReview } from "../src/commands/review.js";
import { CodeloomError } from "../src/errors.js";
import { buildReview } from "../src/review/build.js";
import { renderReviewDraft } from "../src/review/markdown.js";
import { buildCheckPacket } from "../src/review/packet.js";
import { loadPrReview, rememberPacket, savePrReview, type SavedPrReview } from "../src/review/saved.js";
import { git } from "../src/workspace/git.js";
import { commitChange } from "./helpers.js";
import type { Review } from "../src/review/types.js";
import { MIGRATION, makeApiPr, setUpFolder } from "./review-pr-fixture.js";

const NOW = () => new Date("2026-11-16T10:00:00Z");

async function prWithPacket(): Promise<{ root: string; head: string }> {
  const root = await setUpFolder();
  makeApiPr(root);
  const packet = buildCheckPacket(root, "main", { repoId: "api" });
  rememberPacket(root, packet);
  return { root, head: packet.head };
}

function good(head: string): Record<string, unknown> {
  return {
    head,
    whatItDoes: "Creating a customer now also pings an optional webhook, and looking one up accepts a string id.",
    whereItMatters: [{ name: "/customers/new", why: "the new-customer form" }],
    writes: [{ name: "customers", note: "one new row" }],
    beforeDeploying: [{ file: `api/${MIGRATION}`, note: "run the phone-number migration" }, { note: "set CUSTOMER_WEBHOOK_URL where the webhook is wanted" }],
    codeToCheck: [{ name: "CustomerService.create", note: "the webhook call is not awaited in a try" }],
    notes: ["The docs change is only wording."],
  };
}

function refusal(fn: () => unknown): CodeloomError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CodeloomError);
    return err as CodeloomError;
  }
  throw new Error("expected a refusal");
}

describe("savePrReview", () => {
  it("saves to .codeloom/reviews/<head>.json, kept out of git, and loads back", async () => {
    const { root, head } = await prWithPacket();
    const { path, review } = savePrReview(root, good(head), { now: NOW });
    expect(path).toBe(join(root, ".codeloom", "reviews", `${head}.json`));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(root, ".codeloom", "reviews", ".gitignore"), "utf8")).toBe("*\n");
    expect(review.savedAt).toBe("2026-11-16T10:00:00.000Z");
    expect(review.repoId).toBe("api");
    expect(loadPrReview(root, head)).toEqual(review);
    expect(loadPrReview(root, "c".repeat(40))).toBeNull();
  });

  it("refuses a head that is not HEAD of the reviewed repo", async () => {
    const { root, head } = await prWithPacket();
    commitChange(join(root, "api"), "docs/customers.md", (t) => `${t}\nMore.\n`, "more docs");
    const err = refusal(() => savePrReview(root, good(head), { now: NOW }));
    expect(err.message).toContain("HEAD");
    expect(err.message).toContain(head);
    expect(existsSync(join(root, ".codeloom", "reviews", `${head}.json`))).toBe(false);
  });

  it("refuses a head it built no check packet for", async () => {
    const { root } = await prWithPacket();
    const other = git(join(root, "api"), ["rev-parse", "main"]).trim();
    const err = refusal(() => savePrReview(root, good(other), { now: NOW }));
    expect(err.message).toMatch(/pr_check_packet|--packet/);
  });

  it("refuses names that are not in the packet's facts, listing every one", async () => {
    const { root, head } = await prWithPacket();
    const input = {
      ...good(head),
      whereItMatters: [{ name: "POST /api/ghosts" }],
      writes: [{ name: "customers" }, { name: "ghost_table" }],
      codeToCheck: [{ name: "GhostService.haunt" }],
      beforeDeploying: [{ file: "api/ghost.sql", note: "x" }],
    };
    const err = refusal(() => savePrReview(root, input, { now: NOW }));
    for (const bad of ["POST /api/ghosts", "ghost_table", "GhostService.haunt", "api/ghost.sql"]) expect(err.message).toContain(bad);
    expect(err.message).not.toMatch(/writes: not a table or queue in the packet: [^\n]*"customers"[^\n]*Allowed/);
    expect(existsSync(join(root, ".codeloom", "reviews", `${head}.json`))).toBe(false);
  });

  it("refuses an over-long or malformed review", async () => {
    const { root, head } = await prWithPacket();
    refusal(() => savePrReview(root, { ...good(head), whatItDoes: "x".repeat(2000) }, { now: NOW }));
    expect(refusal(() => savePrReview(root, { ...good(head), head: "../../etc/passwd" }, { now: NOW })).message).toContain("not a full commit id");
    refusal(() => savePrReview(root, { ...good(head), whatItDoes: "" }, { now: NOW }));
    // C0/C1 control characters (terminal escapes, newlines) are refused in every free-text field.
    for (const bad of ["clear \u001b[2J screen", "two\nlines", "c1 \u0085 char"]) {
      expect(refusal(() => savePrReview(root, { ...good(head), whatItDoes: bad }, { now: NOW })).message).toMatch(/control character/);
      refusal(() => savePrReview(root, { ...good(head), notes: [bad] }, { now: NOW }));
      refusal(() => savePrReview(root, { ...good(head), codeToCheck: [{ name: "CustomerService.create", note: bad }] }, { now: NOW }));
    }
  });

  it("refuses free text naming a Name.member or snake_case identifier that is not in the packet, listing them", async () => {
    const { root, head } = await prWithPacket();
    const err = refusal(() =>
      savePrReview(root, { ...good(head), whatItDoes: "Calls GhostService.haunt and reads secret_api_key.", notes: ["Also touches Billing.charge."] }, { now: NOW }),
    );
    for (const bad of ["GhostService.haunt", "secret_api_key", "Billing.charge"]) expect(err.message).toContain(bad);
    // Whole names only: a piece of a real name is not that name.
    for (const piece of ["Service.create", "api_key", "webhook_url"]) {
      expect(refusal(() => savePrReview(root, { ...good(head), whatItDoes: `Uses ${piece}.` }, { now: NOW })).message).toContain(piece);
    }
    // Names from the packet (its facts or the code it shows) and plain prose are fine.
    savePrReview(root, { ...good(head), whatItDoes: "CustomerService.create now reads CUSTOMER_WEBHOOK_URL; it writes audit_logs. E.g. a plain sentence." }, { now: NOW });
  });
});

describe("renderReviewDraft with a checked review", () => {
  it('shows "Checked by Claude <date>" and Claude\'s lines instead of the draft\'s', async () => {
    const { root, head } = await prWithPacket();
    const { review: checked } = savePrReview(root, good(head), { now: NOW });
    const review = buildReview(root, "main", { repoId: "api" });
    const out = renderReviewDraft(review, { checked });
    expect(out).toContain("_Checked by Claude 2026-11-16._");
    expect(out).not.toContain("Draft by codeloom");
    expect(out).toContain("**What it does:** Creating a customer now also pings an optional webhook, and looking one up accepts a string id.");
    expect(out).toContain("**Where it matters:**\n- ` /customers/new ` — the new-customer form");
    // Claude's notes sit beside the detected facts; nothing detected is replaced.
    expect(out).toContain("**What it writes:** ` audit_logs `, ` customers ` (Claude: one new row)");
    expect(out).toContain(
      "**⚠ Before deploying:**\n- Migration: ` api/database/migrations/1730000000002_add_phone_to_customers.ts ` — new file — Claude: run the phone-number migration",
    );
    expect(out).toContain("- Env: ` api/.env.example ` — new key: GST\\_RATE");
    expect(out).toContain("- Claude: set CUSTOMER\\_WEBHOOK\\_URL where the webhook is wanted");
    expect(out).toContain(
      "**Code to check:**\n- ` CustomerService.create ` — changed, +1/-0 (` api/app/services/customer_service.ts `) — Claude: the webhook call is not awaited in a try\n- ` CustomerService.find ` — changed, +1/-1",
    );
    expect(out).toContain("**Notes:** The docs change is only wording.");
    expect(out).toContain("```mermaid");
  });

  it("never drops what codeloom detected: empty lists keep the migration, the changed functions and the writes", async () => {
    const { root, head } = await prWithPacket();
    const { review: checked } = savePrReview(root, { head, whatItDoes: "Nothing to see here.", beforeDeploying: [], codeToCheck: [], writes: [] }, { now: NOW });
    const out = renderReviewDraft(buildReview(root, "main", { repoId: "api" }), { checked });
    expect(out).toContain("_Checked by Claude 2026-11-16._");
    expect(out).toContain("- Migration: ` api/database/migrations/1730000000002_add_phone_to_customers.ts ` — new file");
    expect(out).toContain("**Code to check:**\n- ` CustomerService.find ` — changed, +1/-1");
    expect(out).toContain("- ` CustomerService.create ` — changed, +1/-0");
    expect(out).toContain("**What it writes:** ` audit_logs `, ` customers `");
  });

  it("a note on a detected risk renders beside it, and Claude may add one", async () => {
    const { root, head } = await prWithPacket();
    const { review: checked } = savePrReview(
      root,
      { head, whatItDoes: "x.", beforeDeploying: [{ file: "api/.env.example", note: "not a deploy concern: nothing reads it" }, { file: "api/docs/customers.md", note: "docs only" }] },
      { now: NOW },
    );
    const out = renderReviewDraft(buildReview(root, "main", { repoId: "api" }), { checked });
    expect(out).toContain("- Env: ` api/.env.example ` — new key: GST\\_RATE — Claude: not a deploy concern\\: nothing reads it");
    expect(out).toContain("- Migration: ` api/database/migrations/1730000000002_add_phone_to_customers.ts ` — new file\n");
    expect(out).toContain("- Claude: ` api/docs/customers.md ` — docs only");
  });

  it("Claude's added functions never push the changed functions out of Code to check", () => {
    const head = "e".repeat(40);
    const base = "f".repeat(40);
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      ref: `api::function:src/f${i}.ts:Changed${i}.run`,
      repo: "api",
      file: `src/f${i}.ts`,
      symbol: `Changed${i}.run`,
      before: { start: 1, end: 5, text: "" },
      after: { start: 1, end: 5, text: "" },
      hunks: [],
      added: 1,
      removed: 1,
      journeys: [],
    }));
    const review: Review = {
      version: 1, base, head, baseRef: "main", files: [], nodes, journeys: [], chains: [], chainStops: {}, chainNames: {},
      tables: [], queues: [], truncated: false, notes: [], repoId: "api", entries: [], writes: [], readsOnly: [], risks: [],
    };
    const checked: SavedPrReview = {
      version: 1, repoId: "api", base, head, savedAt: "2026-11-17T10:00:00.000Z", whatItDoes: "x.",
      codeToCheck: Array.from({ length: 8 }, (_, i) => ({ name: `Caller${i}.call`, note: "calls it" })),
    };
    const out = renderReviewDraft(review, { checked });
    for (const n of nodes) expect(out).toContain(`- \` ${n.symbol} \` — changed`);
    for (let i = 0; i < 8; i++) expect(out).toContain(`- \` Caller${i}.call \` — Claude: calls it`);
    const code = out.slice(out.indexOf("**Code to check:**"));
    expect(code.indexOf("Changed7.run")).toBeLessThan(code.indexOf("Caller0.call"));
  });

  it("escapes Claude's free text", async () => {
    const { root, head } = await prWithPacket();
    const { review: checked } = savePrReview(
      root,
      { ...good(head), whatItDoes: "Adds <img src=x onerror=alert(1)> and [a link](https://evil.example) @team <!-- codeloom-review-map -->" },
      { now: NOW },
    );
    const out = renderReviewDraft(buildReview(root, "main", { repoId: "api" }), { checked });
    // Every markdown/HTML control character is backslash-escaped, so none of it is live.
    expect(out).not.toMatch(/(?<!\\)<img/);
    expect(out).toContain("\\<img src=x onerror=alert\\(1\\)\\>");
    expect(out).not.toContain("](https://evil.example)");
    expect(out).not.toMatch(/(?<!\\)<!--/);
    expect(out).toContain("\\@team");
    // No bare-URL autolinks, strikethrough or math either.
    const { review: again } = savePrReview(root, { ...good(head), whatItDoes: "See https://evil.example and www.evil.example, ~~gone~~ $x^2$" }, { now: NOW });
    const out2 = renderReviewDraft(buildReview(root, "main", { repoId: "api" }), { checked: again });
    expect(out2).toContain("https\\://evil.example");
    expect(out2).toContain("www\\.evil.example");
    expect(out2).toContain("\\~\\~gone\\~\\~ \\$x^2\\$");
  });

  it("a corrupt or future-version saved review falls back to the draft with a one-line warning", async () => {
    const { root, head } = await prWithPacket();
    const path = join(root, ".codeloom", "reviews", `${head}.json`);
    for (const text of ["{ not json", JSON.stringify({ version: 2, head })]) {
      writeFileSync(path, text);
      const warnings: string[] = [];
      expect(loadPrReview(root, head, (w) => warnings.push(w))).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain("\n");
      expect(warnings[0]).toContain(`${head}.json`);
      expect(runReview(root, { base: "main", repo: "api" }).output).toContain("_Draft by codeloom — not checked._");
    }
  });

  it("ignores a saved review for another head (stale)", async () => {
    const { root, head } = await prWithPacket();
    const { review: checked } = savePrReview(root, good(head), { now: NOW });
    const review = buildReview(root, "main", { repoId: "api" });
    const stale: SavedPrReview = { ...checked, head: "d".repeat(40) };
    const out = renderReviewDraft(review, { checked: stale });
    expect(out).toContain("_Draft by codeloom — not checked._");
    expect(out).not.toContain("Checked by Claude");
  });

  it("codeloom review renders the saved review for HEAD by itself, and the draft again once HEAD moves", async () => {
    const { root, head } = await prWithPacket();
    savePrReview(root, good(head), { now: NOW });
    expect(runReview(root, { base: "main", repo: "api" }).output).toContain("_Checked by Claude 2026-11-16._");
    commitChange(join(root, "api"), "docs/customers.md", (t) => `${t}\nMore.\n`, "more docs");
    expect(runReview(root, { base: "main", repo: "api" }).output).toContain("_Draft by codeloom — not checked._");
  });
});
