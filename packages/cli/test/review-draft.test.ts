import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { parseReviewFormat, runReview } from "../src/commands/review.js";
import { CodeloomError } from "../src/errors.js";
import { chainId } from "../src/linker/chains.js";
import { saveJourneysTool } from "../src/mcp/tools/journeys.js";
import { writeSnapshotData } from "../src/snapshot/write.js";
import { buildReview } from "../src/review/build.js";
import { packetFromReview } from "../src/review/packet.js";
import { reviewSchema } from "../src/review/schema.js";
import { renderReviewDraft, renderReviewMarkdown } from "../src/review/markdown.js";
import type { Review, ReviewNodeChange, ReviewStop } from "../src/review/types.js";
import { git } from "../src/workspace/git.js";
import { commitChange, materializeFixture, materializeSingleRepo } from "./helpers.js";

const CREATE_CUSTOMER_CHAIN = chainId("page:web:/customers/new", "api:POST /api/customers");
const AUDIT_LOG_LINE = '    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });\n';
const WEBHOOK_LINES = AUDIT_LOG_LINE + '    if (process.env.CUSTOMER_WEBHOOK_URL) await fetch(process.env.CUSTOMER_WEBHOOK_URL, { method: "POST" });\n';
const FIND_OLD = "  async find(id: number) {\n    return Customer.findOrFail(id);\n  }";
const FIND_NEW = "  async find(id: number) {\n    return Customer.findOrFail(Number(id));\n  }";
const MIGRATION = "database/migrations/1730000000002_add_phone_to_customers.ts";

const commitAllIn = (dir: string, message: string): void => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
};

/** demo-shop as a FOLDER of separate repos (api, web, billing — each its own git repo; the root is not a
 * repo), indexed, with api/.env.example on main and the create-customer journey named. */
async function setUpFolder(before?: (root: string) => void): Promise<string> {
  const root = materializeFixture("demo-shop");
  before?.(root);
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  writeFileSync(join(root, "api/.env.example"), "PORT=3333\n");
  await runIndex(root);
  for (const repo of ["api", "billing", "web"]) commitAllIn(join(root, repo), "index");
  saveJourneysTool(root, [{ op: "create", name: "Create a customer", chainIds: [CREATE_CUSTOMER_CHAIN] }]);
  return root;
}

/** The api PR: CustomerService.create (writes customers + audit_logs, reads a new env var), CustomerService.find
 * (reads customers), a new migration, a new .env.example key and a docs edit. web gets its own unrelated
 * branch, which `--repo api` must never show. */
function makeApiPr(root: string, opts: { find?: boolean; create?: boolean } = { find: true, create: true }): void {
  const api = join(root, "api");
  git(api, ["checkout", "-q", "-b", "feature"]);
  if (opts.create) commitChange(api, "app/services/customer_service.ts", (t) => t.replace(AUDIT_LOG_LINE, WEBHOOK_LINES), "notify a webhook on create");
  if (opts.find) commitChange(api, "app/services/customer_service.ts", (t) => t.replace(FIND_OLD, FIND_NEW), "coerce the id in find");
  if (opts.create) {
    writeFileSync(join(api, MIGRATION), 'export default class { tableName = "customers"; }\n');
    writeFileSync(join(api, ".env.example"), "PORT=3333\nGST_RATE=0.18\n");
    writeFileSync(join(api, "docs/customers.md"), `${readFileSync(join(api, "docs/customers.md"), "utf8")}\nPhone numbers are optional.\n`);
    commitAllIn(api, "phone numbers");
  }
  const web = join(root, "web");
  git(web, ["checkout", "-q", "-b", "web-feature"]);
  commitChange(web, "lib/get-customer.ts", (t) => `${t}// web-only change\n`, "web change");
}

describe("buildReview --repo (a folder of separate repos)", () => {
  it("diffs only the chosen repo, against merge-base inside it", async () => {
    const root = await setUpFolder();
    const mainHead = git(join(root, "api"), ["rev-parse", "HEAD"]).trim();
    makeApiPr(root);

    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.repoId).toBe("api");
    expect(review.base).toBe(mainHead);
    expect(review.head).toBe(git(join(root, "api"), ["rev-parse", "HEAD"]).trim());
    expect(review.files.length).toBeGreaterThan(0);
    expect(review.files.every((f) => f.repo === "api")).toBe(true);
    expect(review.files.map((f) => f.file).sort()).toEqual([".env.example", MIGRATION, "app/services/customer_service.ts", "docs/customers.md"].sort());
    // review.json stays valid for the hosted snapshot's own schema check, with the 0.5 fields kept.
    const parsed = reviewSchema.safeParse(JSON.parse(JSON.stringify(review)));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.writes).toEqual(review.writes);
  });

  it("never diffs another checkout of the same repo, even when it has the same commits", async () => {
    const root = await setUpFolder();
    makeApiPr(root, { find: true });
    // A second checkout of api (the same remote) that also has the feature commits: the range resolves in
    // it too, so only an explicit repo filter keeps it out.
    execFileSync("git", ["clone", "-q", "--no-hardlinks", join(root, "api"), join(root, "api-copy")]);
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "api-copy", path: "api-copy" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
    );
    git(join(root, "api-copy"), ["checkout", "-q", "main"]);
    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.files.every((f) => f.repo === "api")).toBe(true);
    expect(review.nodes.every((n) => n.repo === "api")).toBe(true);
  });

  it("refuses an unknown repo id, listing the real ones (exit 2)", async () => {
    const root = await setUpFolder();
    let threw: unknown;
    try {
      buildReview(root, "main", { repoId: "nope" });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(CodeloomError);
    expect((threw as CodeloomError).exitCode).toBe(2);
    expect((threw as CodeloomError).message).toContain('No repo "nope" in this workspace');
    expect((threw as CodeloomError).message).toContain("api, billing, web");
  });

  it("asks for --repo when run at the root of a folder of repos", async () => {
    const root = await setUpFolder();
    expect(() => buildReview(root, "main")).toThrow(/pass --repo <id>.*api, billing, web/);
  });

  it("picks the repo the current directory is in when --repo is left out", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const review = buildReview(join(root, "api", "app"), "main");
    expect(review.repoId).toBe("api");
    expect(review.files.every((f) => f.repo === "api")).toBe(true);
  });
});

describe("buildReview — the 0.5 draft facts", () => {
  it("splits writes from reads by each stop's op, after the changed stop only", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.writes).toEqual(["audit_logs", "customers"]);
    // find() reads customers, but create() writes it: a written table is never also "reads only".
    expect(review.readsOnly).toEqual([]);
  });

  it("lists a table the changed code only reads under readsOnly", async () => {
    const root = await setUpFolder();
    makeApiPr(root, { find: true });
    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.writes).toEqual([]);
    expect(review.readsOnly).toEqual(["customers"]);
  });

  it("counts a queue publish as a write and stops at the consumer on the other side", async () => {
    const root = await setUpFolder();
    const billing = join(root, "billing");
    git(billing, ["checkout", "-q", "-b", "feature"]);
    commitChange(billing, "src/invoices.ts", (t) => t.replace("Number(req.params.id)", "Number.parseInt(req.params.id, 10)"), "parse the id");
    const review = buildReview(root, "main", { repoId: "billing" });
    expect(review.writes).toEqual(["billing:invoice.paid", "invoices"]);
    // email_logs is written by the emails consumer, a separate flow on the far side of the queue.
    expect(review.writes).not.toContain("email_logs");
  });

  it("names entry points by journey when one is named", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.entries).toEqual([
      { kind: "page", label: "/customers/new", journey: "Create a customer", repo: "web" },
      { kind: "page", label: "/customers/:id", repo: "web" },
    ]);
  });

  it("flags a migration, a new .env.example key and a new process.env read as risks", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.risks).toEqual([
      { kind: "migration", file: `api/${MIGRATION}`, detail: "new file" },
      { kind: "env", file: "api/.env.example", detail: "new key: GST_RATE" },
      { kind: "env", file: "api/app/services/customer_service.ts", detail: "new env read: CUSTOMER_WEBHOOK_URL" },
    ]);
  });

  it("renders the draft: status line, placeholder, sections, a capped changed-path diagram, Also changed", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const review = buildReview(root, "main", { repoId: "api" });
    const out = renderReviewDraft(review);
    expect(out).toContain("### 🗺 codeloom review map");
    expect(out).toContain("_Draft by codeloom — not checked._");
    expect(out).toContain("**What it does:** _(Claude fills this in when it checks the PR.)_");
    expect(out).toContain("**Where it matters:**\n- **Create a customer** — page ` /customers/new ` (web)\n- page ` /customers/:id ` (web)");
    expect(out).toContain("**What it writes:** ` audit_logs `, ` customers `");
    expect(out).not.toContain("Reads only:");
    expect(out).toContain("**⚠ Before deploying:**\n- Migration: ` api/database/migrations/1730000000002_add_phone_to_customers.ts ` — new file");
    expect(out).toContain("- Env: ` api/.env.example ` — new key: GST\\_RATE");
    // Biggest change first.
    expect(out).toContain(
      "**Code to check:**\n- ` CustomerService.find ` — changed, +1/-1 (` api/app/services/customer_service.ts `)\n- ` CustomerService.create ` — changed, +1/-0",
    );
    expect(out).toContain("Also changed: 3 files — ");
    const mermaid = out.slice(out.indexOf("```mermaid"), out.indexOf("```", out.indexOf("```mermaid") + 3) + 3);
    const nodes = mermaid.match(/^n\d+\[/gm) ?? [];
    expect(nodes.length).toBeLessThanOrEqual(9); // ≤ 8 stops + one "+N more"
    expect(mermaid).toContain("+2 more");
    expect(mermaid).toContain('["✏️ CustomerService.create"]:::changed');
    expect(mermaid).toContain('["✏️ CustomerService.find"]:::changed'); // [fix 3] never cut, even past 8
    expect(mermaid).toContain('["customers (insert)"]');
    // Only the changed path: no UI helper functions or call stops, no reads.
    expect(mermaid).not.toContain("useCreateCustomer");
    expect(mermaid).not.toContain("customers (read)");
  });
});

describe("buildReview — a workspace that is itself one git repo", () => {
  async function setUpSingle(): Promise<string> {
    const root = materializeSingleRepo("demo-shop");
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [] }),
    );
    await runIndex(root);
    commitAllIn(root, "index");
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "api/app/services/customer_service.ts", (t) => t.replace(FIND_OLD, FIND_NEW), "edit find");
    commitChange(root, "web/lib/get-customer.ts", (t) => `${t}// web change\n`, "web change");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/deploy.yml"), "on: push\n");
    writeFileSync(join(root, "api/Dockerfile"), "FROM node:20\n");
    commitAllIn(root, "ci + docker");
    return root;
  }

  it("diffs the whole workspace without --repo (repoId is empty), and flags root CI and repo Docker files", async () => {
    const root = await setUpSingle();
    const review = buildReview(root, "main");
    expect(review.repoId).toBe("");
    expect(new Set(review.files.map((f) => f.repo))).toEqual(new Set(["api", "web"]));
    expect(review.risks).toEqual([
      { kind: "docker", file: "api/Dockerfile", detail: "new file" },
      { kind: "ci", file: ".github/workflows/deploy.yml", detail: "new file" },
    ]);
  });

  it("[fix 1] never flags docs or test files as risks (migrations/ docs, a .sql fixture, a test's env read)", async () => {
    const root = await setUpSingle();
    const files: Record<string, string> = {
      "api/docs/migrations/upgrade-guide.md": "# Upgrading\n",
      "api/docs/drizzle/notes.md": "notes\n",
      "api/src/__tests__/migrations/run.test.ts": "export {};\n",
      "api/test/fixtures/seed.sql": "insert into customers values (1);\n",
      "api/tests/customer.test.ts": "const url = process.env.TEST_ONLY_URL;\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    commitAllIn(root, "docs and tests");
    const review = buildReview(root, "main");
    expect(review.files.map((f) => `${f.repo}/${f.file}`)).toEqual(expect.arrayContaining(Object.keys(files)));
    expect(review.risks).toEqual([
      { kind: "docker", file: "api/Dockerfile", detail: "new file" },
      { kind: "ci", file: ".github/workflows/deploy.yml", detail: "new file" },
    ]);
  });

  it("[fix 5] codeloom snapshot still refuses a folder of repos, even run from inside one repo", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const outDir = join(mkdtempSync(join(tmpdir(), "codeloom-snap-")), "out");
    await expect(writeSnapshotData(join(root, "api"), { baseRef: "main", outDir })).rejects.toThrow(/is not a git repository/);
  });

  it("diffs only one subfolder repo with --repo", async () => {
    const root = await setUpSingle();
    const review = buildReview(root, "main", { repoId: "api" });
    expect(review.repoId).toBe("api");
    expect(review.files.every((f) => f.repo === "api")).toBe(true);
    expect(review.risks.map((r) => r.file)).toEqual(["api/Dockerfile"]);
  });
});

// ---- renderReviewDraft on a hand-built Review ----------------------------------------------------------

const CHANGED_REF = "api::function:app/services/customer_service.ts:CustomerService.create";

function stops(): ReviewStop[] {
  return [
    { ref: "web::function:app/customers/new/page.tsx:NewCustomerPage", repo: "web", lane: "ui", kind: "page", label: "NewCustomerPage", file: "app/customers/new/page.tsx", changed: false },
    { ref: "web::call:lib/use-create-customer.ts:5", repo: "web", lane: "ui", kind: "call", label: "useCreateCustomer", file: "lib/use-create-customer.ts", changed: false, from: 0 },
    { ref: "api::route:POST POST /api/customers", repo: "api", lane: "api", kind: "route", label: "POST /api/customers", file: "start/routes.ts", changed: false, from: 1 },
    { ref: "api::function:app/controllers/customers_controller.ts:CustomersController.store", repo: "api", lane: "code", kind: "handler", label: "CustomersController.store", file: "app/controllers/customers_controller.ts", changed: false, from: 2 },
    { ref: CHANGED_REF, repo: "api", lane: "code", kind: "function", label: "CustomerService.create", file: "app/services/customer_service.ts", changed: true, from: 3 },
    { ref: "api::db:customers:insert", repo: "api", lane: "db", kind: "db", op: "insert", label: "customers (insert)", file: "app/services/customer_service.ts", changed: false, from: 4 },
  ];
}

function node(partial: Partial<ReviewNodeChange> = {}): ReviewNodeChange {
  return {
    ref: CHANGED_REF, repo: "api", file: "app/services/customer_service.ts", symbol: "CustomerService.create",
    before: { start: 5, end: 9, text: "x" }, after: { start: 5, end: 11, text: "y" }, hunks: [], added: 3, removed: 1, journeys: ["j_1"],
    ...partial,
  };
}

function draftReview(partial: Partial<Review> = {}): Review {
  return {
    version: 1,
    base: "a".repeat(40),
    head: "b".repeat(40),
    baseRef: "main",
    repoId: "api",
    files: [
      { repo: "api", file: "app/services/customer_service.ts", added: 3, removed: 1, onChain: true },
      { repo: "api", file: "docs/customers.md", added: 1, removed: 0, onChain: false },
      { repo: "api", file: "test/customer.test.ts", added: 9, removed: 0, onChain: false },
    ],
    nodes: [node()],
    journeys: [{ id: "j_1", name: "Create a customer", changedStops: [CHANGED_REF], spec: "unchecked", chains: ["ch_1"] }],
    chains: ["ch_1"],
    chainStops: { ch_1: stops() },
    chainNames: { ch_1: "POST /api/customers · NewCustomerPage" },
    tables: ["customers"],
    queues: [],
    truncated: false,
    notes: [],
    entries: [{ kind: "page", label: "/customers/new", journey: "Create a customer", repo: "web" }],
    writes: ["customers"],
    readsOnly: ["cities"],
    risks: [],
    ...partial,
  };
}

describe("renderReviewDraft", () => {
  it("golden: the 0.5 draft block", async () => {
    const { existsSync } = await import("node:fs");
    const path = join(import.meta.dirname, "golden", "review-draft.md");
    const out = renderReviewDraft(draftReview(), { link: "https://x.github.io/demo/pr-1/" });
    if (process.env.CODELOOM_UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, out);
    expect(out).toBe(readFileSync(path, "utf8"));
  });

  it("puts Reads only on its own line after the writes, and omits Before deploying when there are no risks", () => {
    const out = renderReviewDraft(draftReview());
    expect(out).toContain("**What it writes:** ` customers `\n\nReads only: ` cities `");
    expect(out).not.toContain("Before deploying");
  });

  it("says so when the changed code writes nothing on the map", () => {
    const out = renderReviewDraft(draftReview({ writes: [], readsOnly: [] }));
    expect(out).toContain("**What it writes:** nothing on the map.");
  });

  it("caps Where it matters at 5 and Code to check at 8, then +N more", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ kind: "route" as const, label: `GET /r${i}`, repo: "api" }));
    const nodes = Array.from({ length: 11 }, (_, i) => node({ ref: `api::function:f${i}.ts:fn${i}`, symbol: `fn${i}`, file: `f${i}.ts`, added: 20 - i, removed: 0 }));
    const out = renderReviewDraft(draftReview({ entries, nodes }));
    expect(out).toContain("- route ` GET /r4 ` (api)\n- +2 more");
    expect(out).not.toContain("GET /r5");
    expect(out).toContain("- ` fn7 ` — changed, +13/-0 (` api/f7.ts `)\n- +3 more");
    expect(out).not.toContain("fn8");
  });

  it("marks new and deleted functions", () => {
    const out = renderReviewDraft(draftReview({ nodes: [node({ before: null, added: 4, removed: 0 }), node({ ref: "api::function:x.ts:gone", symbol: "gone", file: "x.ts", after: null, added: 0, removed: 6 })] }));
    expect(out).toContain("- ` gone ` — deleted, +0/-6 (` api/x.ts `)");
    expect(out).toContain("- ` CustomerService.create ` — new, +4/-0");
  });

  it("escapes every label: journey names, entry labels, risk details and diagram labels", () => {
    const evil = "[x](https://evil.example) <b>|*";
    const out = renderReviewDraft(
      draftReview({
        entries: [{ kind: "page", label: "/a`b", journey: evil, repo: "web" }],
        risks: [{ kind: "env", file: "api/.env.example", detail: `new key: ${evil}` }],
        chainStops: { ch_1: stops().map((s) => (s.changed ? { ...s, label: '<script>"a|b[c]' } : s)) },
      }),
    );
    expect(out).not.toContain("[x](https://evil.example)");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("\\[x\\]\\(https://evil.example\\)");
  });

  it("[fix 3] a cut diagram always draws every changed stop and what it writes, before other path stops", () => {
    // Chain 2: a long route → handler → … path (all drawn kinds) ending in a changed function writing a table.
    const long: ReviewStop[] = [
      { ref: "api::route:GET /long", repo: "api", lane: "api", kind: "route", label: "GET /long", changed: false },
      ...Array.from({ length: 6 }, (_, i): ReviewStop => ({ ref: `api::h${i}`, repo: "api", lane: "code", kind: "handler", label: `h${i}`, changed: false, from: i })),
      { ref: "api::function:svc.ts:Svc.changed", repo: "api", lane: "code", kind: "function", label: "Svc.changed", changed: true, from: 6 },
      { ref: "api::db:orders:update", repo: "api", lane: "db", kind: "db", op: "update", label: "orders (update)", changed: false, from: 7 },
    ];
    const out = renderReviewDraft(draftReview({ chains: ["ch_1", "ch_2"], chainStops: { ch_1: stops(), ch_2: long }, chainNames: { ch_1: "a", ch_2: "b" } }));
    expect(out).toContain('["✏️ CustomerService.create"]:::changed');
    expect(out).toContain('["✏️ Svc.changed"]:::changed');
    expect(out).toContain('["customers (insert)"]');
    expect(out).toContain('["orders (update)"]');
    const nodes = out.match(/^n\d+\[/gm) ?? [];
    expect(nodes.length).toBe(9); // 8 stops + "+N more"
    expect(out).toMatch(/\["\+\d+ more"\]/);
  });

  it("lists changed functions on a chain first, then other changed ones, then new, then deleted", () => {
    const newOnes = Array.from({ length: 9 }, (_, i) => node({ ref: `api::function:lib/new.ts:helper${i}`, symbol: `helper${i}`, file: "lib/new.ts", before: null, added: 30, removed: 0, journeys: [] }));
    const offChain = node({ ref: "api::function:lib/util.ts:formatGst", symbol: "formatGst", file: "lib/util.ts", added: 9, removed: 2, journeys: [] });
    const gone = node({ ref: "api::function:lib/old.ts:oldOne", symbol: "oldOne", file: "lib/old.ts", after: null, added: 0, removed: 40, journeys: [] });
    const review = draftReview({ nodes: [...newOnes, gone, offChain, node()] });
    const out = renderReviewDraft(review);
    const code = out.slice(out.indexOf("**Code to check:**"), out.indexOf("```mermaid"));
    expect(code.split("\n").filter((l) => l.startsWith("- ")).map((l) => /^- ` (.+?) `/.exec(l)?.[1] ?? l)).toEqual([
      "CustomerService.create", "formatGst", "helper0", "helper1", "helper2", "helper3", "helper4", "helper5", "- +4 more",
    ]);
    expect(packetFromReview(review, []).draft.codeToCheck.map((c) => c.name).slice(0, 3)).toEqual(["CustomerService.create", "formatGst", "helper0"]);
  });

  it("lists entry kinds in words: page, route, queue consumer", () => {
    const out = renderReviewDraft(
      draftReview({
        entries: [
          { kind: "route", label: "POST /billing/invoices", repo: "billing" },
          { kind: "consumer", label: "invoice.created", repo: "billing" },
        ],
      }),
    );
    expect(out).toContain("- route ` POST /billing/invoices ` (billing)");
    expect(out).toContain("- queue consumer ` invoice.created ` (billing)");
  });

  it("with no chain touched, says so and still lists Also changed", () => {
    const out = renderReviewDraft(draftReview({ chains: [], chainStops: {}, entries: [], writes: [], readsOnly: [], nodes: [], files: [{ repo: "api", file: "README.md", added: 1, removed: 0, onChain: false }] }));
    expect(out).toContain("**Where it matters:** no entry point on the map reaches the changed code.");
    expect(out).not.toContain("```mermaid");
    expect(out).toContain("Also changed: 1 file — docs");
  });
});

describe("codeloom review --format / --repo", () => {
  it('accepts "full" as a format', () => {
    expect(parseReviewFormat("full")).toBe("full");
  });

  it("registers --repo", () => {
    const review = buildProgram().commands.find((c) => c.name() === "review")!;
    expect(review.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--base", "--format", "--link", "--repo"]));
  });

  it("renders the draft by default and the 0.4 layout under --format full", async () => {
    const root = await setUpFolder();
    makeApiPr(root);
    const draft = runReview(root, { base: "main", repo: "api" });
    expect(draft.output).toContain("_Draft by codeloom — not checked._");
    const full = runReview(root, { base: "main", repo: "api", format: "full" });
    expect(full.output).toBe(renderReviewMarkdown(full.review, { builtFor: full.review.head.slice(0, 7) }));
    expect(full.output).toContain("This PR touches");
  });
});

describe("buildReview — v0.5 acceptance: UI changes and proxied calls", () => {
  /** A shared layout (CustomersShell) between the new-customer page and the form whose hook POSTs. */
  const addShell = (root: string): void => {
    const web = join(root, "web");
    mkdirSync(join(web, "components"), { recursive: true });
    writeFileSync(join(web, "components/customers-shell.tsx"), [
      'import { NewCustomerForm } from "./new-customer-form";',
      "",
      "export function CustomersShell({ title }: { title: string }) {",
      "  return (",
      "    <section>",
      "      <h1>{title}</h1>",
      "      <NewCustomerForm />",
      "    </section>",
      "  );",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(web, "components/new-customer-form.tsx"), readFileSync(join(web, "app/customers/new/page.tsx"), "utf8")
      .replace('"../../../lib/use-create-customer"', '"../lib/use-create-customer"')
      .replace("export default function NewCustomerPage()", "export function NewCustomerForm()"));
    writeFileSync(join(web, "app/customers/new/page.tsx"), [
      'import { CustomersShell } from "../../../components/customers-shell";',
      "",
      "export default function NewCustomerPage() {",
      '  return <CustomersShell title="New customer" />;',
      "}",
      "",
    ].join("\n"));
    commitAllIn(web, "a shared customers layout");
  };

  it("does not count writes reached only through an unchanged child hook of a changed UI component", async () => {
    const root = await setUpFolder(addShell);
    const web = join(root, "web");
    git(web, ["checkout", "-q", "-b", "feature"]);
    commitChange(web, "components/customers-shell.tsx", (t) => t.replace("<h1>{title}</h1>", '<h1 className="title">{title}</h1>'), "style the title");
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.nodes.map((n) => n.symbol)).toEqual(["CustomersShell"]);
    expect(review.chains).toContain(CREATE_CUSTOMER_CHAIN);
    expect(review.writes).toEqual([]);
    expect(review.readsOnly).toEqual([]);
  });

  it("counts the writes a changed hook's own call reaches", async () => {
    const root = await setUpFolder(addShell);
    const web = join(root, "web");
    git(web, ["checkout", "-q", "-b", "feature"]);
    commitChange(web, "lib/use-create-customer.ts", (t) => t.replace('api.post("/api/customers", input)', 'api.post("/api/customers", { ...input, city: input.city.trim() })'), "trim the city");
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.nodes.map((n) => n.symbol)).toEqual(["useCreateCustomer"]);
    expect(review.writes).toEqual(["audit_logs", "customers"]);
  });

  it("names a proxied call's entry by the route it reaches: METHOD path and the repo that owns it", async () => {
    const root = materializeFixture("demo-shop");
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({
        version: 1, name: "demo-shop",
        repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web", proxies: [{ from: "/api/core", to: "billing" }] }],
        links: [],
      }),
    );
    const web = join(root, "web");
    writeFileSync(join(web, "lib/pay-invoice-via-core.ts"), [
      "export async function payInvoiceViaCore() {",
      '  const res = await fetch("/api/core/billing/invoices/42/pay", { method: "POST" });',
      "  return res.json();",
      "}",
      "",
    ].join("\n"));
    commitAllIn(web, "pay through the core proxy");
    await runIndex(root);
    for (const repo of ["api", "billing", "web"]) commitAllIn(join(root, repo), "index");

    git(web, ["checkout", "-q", "-b", "feature"]);
    commitChange(web, "lib/pay-invoice-via-core.ts", (t) => t.replace("  return res.json();", "  if (!res.ok) throw new Error(\"payment failed\");\n  return res.json();"), "fail loudly");
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.entries).toEqual([{ kind: "route", label: "POST /billing/invoices/:id/pay", repo: "billing" }]);
    expect(review.writes).toContain("invoices");
    expect(renderReviewDraft(review)).toMatch(/route ` ?POST \/billing\/invoices\/:id\/pay ?` \(billing\)/);
  }, 60_000);

  it("suppresses the UI repo's own catch-all proxy route as an entry, listing the proxied backend route instead", async () => {
    const root = materializeFixture("demo-shop");
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({
        version: 1, name: "demo-shop",
        repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web", proxies: [{ from: "/api/core", to: "billing" }] }],
        links: [],
      }),
    );
    const web = join(root, "web");
    // The UI repo's OWN catch-all proxy route (a Next.js app-router route file): matches the call's own
    // URL too, so codeloom's own-repo route resolution finds it alongside the workspace `proxies` match.
    mkdirSync(join(web, "app/api/core/[...path]"), { recursive: true });
    writeFileSync(join(web, "app/api/core/[...path]/route.ts"), [
      "export async function POST(req: Request) {",
      "  return new Response(null, { status: 502 });",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(web, "lib/pay-invoice-via-core.ts"), [
      "export async function payInvoiceViaCore() {",
      '  const res = await fetch("/api/core/billing/invoices/42/pay", { method: "POST" });',
      "  return res.json();",
      "}",
      "",
    ].join("\n"));
    commitAllIn(web, "pay through the core proxy, with the UI's own catch-all route");
    await runIndex(root);
    for (const repo of ["api", "billing", "web"]) commitAllIn(join(root, repo), "index");

    git(web, ["checkout", "-q", "-b", "feature"]);
    commitChange(web, "lib/pay-invoice-via-core.ts", (t) => t.replace("  return res.json();", "  if (!res.ok) throw new Error(\"payment failed\");\n  return res.json();"), "fail loudly");
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.entries).toEqual([{ kind: "route", label: "POST /billing/invoices/:id/pay", repo: "billing" }]);
    const draft = renderReviewDraft(review);
    expect(draft).toMatch(/route ` ?POST \/billing\/invoices\/:id\/pay ?` \(billing\)/);
    expect(draft).not.toMatch(/api\/core/);
  }, 60_000);
});

describe("buildReview — final review fixes: proxies and changed UI calls", () => {
  /** demo-shop as a folder of repos with `web`'s proxies set, `addFiles` written into web and committed, then
   * indexed on main; returns the root and web's path, ready for a feature branch in web. */
  async function setUpProxied(proxies: Array<{ from: string; to: string }>, addFiles: Record<string, string>): Promise<{ root: string; web: string }> {
    const root = materializeFixture("demo-shop");
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web", proxies }], links: [] }),
    );
    const web = join(root, "web");
    for (const [file, text] of Object.entries(addFiles)) {
      mkdirSync(join(web, file, ".."), { recursive: true });
      writeFileSync(join(web, file), text);
    }
    commitAllIn(web, "web files");
    await runIndex(root);
    for (const repo of ["api", "billing", "web"]) commitAllIn(join(root, repo), "index");
    git(web, ["checkout", "-q", "-b", "feature"]);
    return { root, web };
  }

  const PAY_VIA_CORE = [
    "export async function payInvoiceViaCore() {",
    '  const res = await fetch("/api/core/billing/invoices/42/pay", { method: "POST" });',
    "  return res.json();",
    "}",
    "",
  ].join("\n");

  it("keeps a real route of the UI repo's own under a proxies prefix as an entry", async () => {
    const { root, web } = await setUpProxied([{ from: "/api", to: "billing" }], {
      "app/api/session/route.ts": 'export async function GET(req: Request) {\n  return new Response("ok");\n}\n',
      "lib/session.ts": 'export async function loadSession() {\n  const res = await fetch("/api/session");\n  return res.json();\n}\n',
    });
    commitChange(web, "app/api/session/route.ts", (t) => t.replace('new Response("ok")', 'new Response("ok", { status: 200 })'), "status");
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.entries).toContainEqual({ kind: "route", label: "GET /api/session", repo: "web" });
    expect(renderReviewDraft(review)).not.toContain("no entry point on the map reaches the changed code");
  }, 120_000);

  it("falls back to the catch-all proxy route itself when no proxied backend route is reached", async () => {
    const { root, web } = await setUpProxied([{ from: "/api/core", to: "billing" }], {
      "app/api/core/[...path]/route.ts": "export async function POST(req: Request) {\n  return new Response(null, { status: 502 });\n}\n",
      "lib/ping-core.ts": 'export async function pingCore() {\n  const res = await fetch("/api/core/nowhere", { method: "POST" });\n  return res.ok;\n}\n',
    });
    commitChange(web, "app/api/core/[...path]/route.ts", (t) => t.replace("status: 502", "status: 504"), "gateway timeout");
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.entries).toContainEqual({ kind: "route", label: "POST /api/core/:path*", repo: "web" });
  }, 120_000);

  it("lists a deleted file's functions even when the map was indexed at the PR's head", async () => {
    const { root, web } = await setUpProxied([], { "lib/old-totals.ts": "export function oldTotal() {\n  return 1;\n}\nexport function oldTax() {\n  return 2;\n}\n" });
    rmSync(join(web, "lib/old-totals.ts"));
    commitAllIn(web, "drop the old totals");
    await runIndex(root); // indexed at head: the deleted file's functions are no longer on the map
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.nodes.map((n) => `${n.symbol}:${n.after === null ? "deleted" : "kept"}:-${n.removed}`)).toEqual(["oldTax:deleted:-3", "oldTotal:deleted:-3"]);
    expect(renderReviewDraft(review)).toContain("- ` oldTax ` — deleted, +0/-3 (` web/lib/old-totals.ts `)");
  }, 120_000);

  it("builds at most 8 functions of new or deleted files that are on no chain, and says how many more", async () => {
    const { root, web } = await setUpProxied([], {});
    writeFileSync(join(web, "lib/format.ts"), Array.from({ length: 11 }, (_, i) => `export function fmt${i}(x: number) {\n  return x + ${i};\n}\n`).join(""));
    commitAllIn(web, "formatters");
    await runIndex(root);
    const review = buildReview(root, "main", { repoId: "web" });
    expect(review.nodes.filter((n) => n.file === "lib/format.ts")).toHaveLength(8);
    expect(review.notes).toContain("3 more functions in new or deleted files are not listed.");
  }, 120_000);

  it("draws a changed hook whose only stop is its own call, and names its journeys", async () => {
    const { root, web } = await setUpProxied([{ from: "/api/core", to: "billing" }], { "lib/pay-invoice-via-core.ts": PAY_VIA_CORE });
    commitChange(web, "lib/pay-invoice-via-core.ts", (t) => t.replace("  return res.json();", '  if (!res.ok) throw new Error("payment failed");\n  return res.json();'), "fail loudly");
    let review = buildReview(root, "main", { repoId: "web" });
    expect(review.nodes.map((n) => n.symbol)).toEqual(["payInvoiceViaCore"]);
    expect(review.writes).toContain("invoices");
    const draft = renderReviewDraft(review);
    expect(draft).toContain("```mermaid");
    expect(draft).toContain('["✏️ payInvoiceViaCore"]:::changed'); // the hook's own call, named by the hook
    expect(draft).toContain('["invoices (update)"]');
    // A journey naming the call's chain is named beside the changed function.
    saveJourneysTool(root, [{ op: "create", name: "Pay an invoice", chainIds: review.chains }]);
    review = buildReview(root, "main", { repoId: "web" });
    expect(review.journeys.map((j) => j.name)).toEqual(["Pay an invoice"]);
    expect(review.journeys[0]!.changedStops).toEqual([review.nodes[0]!.ref]);
    expect(review.nodes[0]!.journeys).toEqual([review.journeys[0]!.id]);
  }, 120_000);
});
