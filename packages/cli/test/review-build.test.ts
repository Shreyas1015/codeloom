import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { chainId } from "../src/linker/chains.js";
import { saveJourneysTool } from "../src/mcp/tools/journeys.js";
import { buildReview } from "../src/review/build.js";
import type { Review } from "../src/review/types.js";
import { git } from "../src/workspace/git.js";
import { commitChange, materializeSingleRepo } from "./helpers.js";

const CREATE_CUSTOMER_CHAIN = chainId("page:web:/customers/new", "api:POST /api/customers");
const AUDIT_LOG_LINE = '    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });\n';
const VALIDATE_LINES = '    if (!payload.email) {\n      throw new Error("email required");\n    }\n';

/** demo-shop as one git repo (web/ and api/ as subfolders), indexed, with the create-customer journey
 * named. Returns the repo root, ready for the caller to branch and edit. */
async function setUp(): Promise<string> {
  const root = materializeSingleRepo("demo-shop");
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [] }),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "add workspace"]);
  await runIndex(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "index"]);
  saveJourneysTool(root, [{ op: "create", name: "Create a customer", chainIds: [CREATE_CUSTOMER_CHAIN] }]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "name the create-customer journey"]);
  return root;
}

describe("buildReview", () => {
  it("reports the edited function, the journey it is on, and the new unrelated file", async () => {
    const root = await setUp();

    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (text) => text.replace(AUDIT_LOG_LINE, VALIDATE_LINES),
      "edit CustomerService.create",
    );
    mkdirSync(join(root, "api/lib"), { recursive: true });
    writeFileSync(join(root, "api/lib/gst.ts"), "export const GST_RATE = 0.18;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "add gst helper"]);

    const review: Review = buildReview(root, "main");

    expect(review.version).toBe(1);
    expect(review.baseRef).toBe("main");
    expect(review.base).toMatch(/^[0-9a-f]{40}$/);
    expect(review.head).toMatch(/^[0-9a-f]{40}$/);
    expect(review.base).not.toBe(review.head);

    const svc = review.files.find((f) => f.file === "app/services/customer_service.ts" && f.repo === "api");
    expect(svc).toMatchObject({ added: 3, removed: 1, onJourney: true });
    const gst = review.files.find((f) => f.file === "lib/gst.ts" && f.repo === "api");
    expect(gst).toMatchObject({ onJourney: false });

    expect(review.nodes).toHaveLength(1);
    const node = review.nodes[0]!;
    expect(node.ref).toBe("api::function:app/services/customer_service.ts:CustomerService.create");
    expect(node.repo).toBe("api");
    expect(node.file).toBe("app/services/customer_service.ts");
    expect(node.symbol).toBe("CustomerService.create");
    expect(node.before).not.toBeNull();
    expect(node.after).not.toBeNull();
    // before/after differ EXACTLY by the edit: the full original and edited method bodies, verbatim.
    expect(node.before).toEqual({
      start: 5,
      end: 9,
      text:
        '  async create(payload: { name: string; email: string; city: string }) {\n' +
        '    const customer = await Customer.create(payload);\n' +
        AUDIT_LOG_LINE.trimEnd() +
        '\n    return customer;\n  }',
    });
    expect(node.after).toEqual({
      start: 5,
      end: 11,
      text:
        '  async create(payload: { name: string; email: string; city: string }) {\n' +
        '    const customer = await Customer.create(payload);\n' +
        VALIDATE_LINES.trimEnd() +
        '\n    return customer;\n  }',
    });
    // One hunk: the audit-log line (-1) replaced by the three validation lines (+3), with its surrounding
    // context (±3 lines, clamped to the function's own extent — 2 lines are available on each side here).
    expect(node.hunks).toEqual([
      {
        oldStart: 5,
        oldLines: 5,
        newStart: 5,
        newLines: 7,
        lines: [
          '  async create(payload: { name: string; email: string; city: string }) {',
          '    const customer = await Customer.create(payload);',
          `-${AUDIT_LOG_LINE.trimEnd()}`,
          '+    if (!payload.email) {',
          '+      throw new Error("email required");',
          '+    }',
          '    return customer;',
          '  }',
        ].map((l) => (l.startsWith("-") || l.startsWith("+") ? l : ` ${l}`)),
      },
    ]);
    expect(node.added).toBe(3);
    expect(node.removed).toBe(1);

    expect(review.journeys).toHaveLength(1);
    const journey = review.journeys[0]!;
    expect(journey.name).toBe("Create a customer");
    expect(journey.changedStops).toEqual([node.ref]);
    expect(journey.spec).toBe("unchecked");
    expect(node.journeys).toEqual([journey.id]);

    expect(review.tables).toContain("customers");
  });

  it("resolves base through merge-base when HEAD is two commits ahead of it", async () => {
    const root = await setUp();
    const mainHead = git(root, ["rev-parse", "HEAD"]).trim();

    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "api/app/services/customer_service.ts", (t) => `${t}// one\n`, "first");
    commitChange(root, "api/app/services/customer_service.ts", (t) => `${t}// two\n`, "second");

    const review = buildReview(root, "main");
    expect(review.base).toBe(mainHead);
    expect(review.head).toBe(git(root, ["rev-parse", "HEAD"]).trim());
  });

  it("throws a CodeloomError (exit 2) outside a git repository", async () => {
    // Indexed first, so this genuinely reaches the "not a git repository" check (loadMapState itself
    // needs the repo indexed) rather than failing earlier for an unrelated reason.
    const root = await setUp();
    rmSync(join(root, ".git"), { recursive: true, force: true });
    let threw: unknown;
    try {
      buildReview(root, "main");
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(CodeloomError);
    expect((threw as CodeloomError).exitCode).toBe(2);
    expect((threw as CodeloomError).message).toBe(`${root} is not a git repository. "codeloom review" needs the workspace's own git history.`);
  });
});

// ---- Fix round 1 (reviewer findings) ------------------------------------------------------------------

describe("buildReview — indexed at HEAD (the real CI flow: checkout PR head, index, then review)", () => {
  it("attributes the edit to create(), not to the new sibling method inserted above it", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (text) =>
        text
          .replace(
            "export default class CustomerService {\n",
            'export default class CustomerService {\n  async validate(payload: { email: string }) {\n    if (!payload.email) {\n      throw new Error("email required");\n    }\n  }\n\n',
          )
          .replace(AUDIT_LOG_LINE, VALIDATE_LINES),
      "add validate() above create(), edit create()",
    );
    // The real flow: checkout the PR head, then `codeloom index` runs there — not at the merge-base.
    // index writes only git-ignored/local files, so HEAD stays this same commit (no extra commit here).
    await runIndex(root);

    const review = buildReview(root, "main");

    const create = review.nodes.find((n) => n.symbol === "CustomerService.create");
    expect(create).toBeDefined();
    expect(create!.before).not.toBeNull();
    expect(create!.before!.text).toContain('await db.table("audit_logs")');
    expect(create!.before!.text).not.toContain("email required");
    expect(create!.after).not.toBeNull();
    expect(create!.after!.text).toContain("email required");
    expect(create!.after!.text).not.toContain('await db.table("audit_logs")');

    const validate = review.nodes.find((n) => n.symbol === "CustomerService.validate");
    expect(validate).toBeDefined();
    expect(validate!.before).toBeNull(); // brand new: did not exist at base

    expect(review.chains.length).toBeGreaterThan(0);
    expect(review.journeys).toHaveLength(1);
    const svc = review.files.find((f) => f.file === "app/services/customer_service.ts");
    expect(svc?.onJourney).toBe(true);
  });

  it("does not mark a function touched just because a new sibling was inserted right after its closing brace", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (text) =>
        text.replace(
          "\n  async find(id: number) {",
          '\n  async validate(payload: { email: string }) {\n    if (!payload.email) throw new Error("email required");\n  }\n\n  async find(id: number) {',
        ),
      "add validate() right after create()'s closing brace",
    );
    await runIndex(root);

    const review = buildReview(root, "main");
    expect(review.nodes.find((n) => n.symbol === "CustomerService.create")).toBeUndefined();
    const validate = review.nodes.find((n) => n.symbol === "CustomerService.validate");
    expect(validate).toBeDefined();
    expect(validate!.before).toBeNull();
  });
});

describe("buildReview — hunk content (-U0 parsing must not mistake content for a file header)", () => {
  it("keeps a removed line starting with -- and an added line starting with ++ (no leading indent, so it really does read as ---/+++ in the raw diff)", async () => {
    const root = await setUp();
    // A top-level (column 0, no indentation) line: "-count;"/"+i;" prefixed by the diff's own "-"/"+"
    // produces the literal raw lines "---count;" and "+++i;" — exactly what the file-header guard must
    // not swallow. Establish it as part of base, reindexed so base stays accurate (isolated from the
    // indexed-at-head scenario above).
    commitChange(root, "api/app/services/customer_service.ts", (t) => t.replace("export default class", "--count;\n\nexport default class"), "add --count;");
    await runIndex(root);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "reindex"]);

    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "api/app/services/customer_service.ts", (t) => t.replace("--count;\n", "++i;\n"), "decrement -> increment");

    const review = buildReview(root, "main");
    const svc = review.files.find((f) => f.file === "app/services/customer_service.ts")!;
    expect(svc).toBeDefined();
    expect(svc.removed).toBe(1);
    expect(svc.added).toBe(1);
  });
});
