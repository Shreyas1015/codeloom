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
    expect(svc).toMatchObject({ added: 3, removed: 1, onChain: true });
    const gst = review.files.find((f) => f.file === "lib/gst.ts" && f.repo === "api");
    expect(gst).toMatchObject({ onChain: false });

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
    expect(svc?.onChain).toBe(true);
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

// ---- Fix round 2 (re-review findings) -----------------------------------------------------------------

const SIGNATURE_LINE = "  async create(payload: { name: string; email: string; city: string }) {\n";
const SIGNATURE_LINE_EDITED = "  async create(payload: { name: string; email: string; city: string }, strict = false) {\n";

describe("buildReview — a signature edit (the function's own first line changes)", () => {
  it("is not mistaken for brand-new/deleted when indexed at base (the default)", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "api/app/services/customer_service.ts", (t) => t.replace(SIGNATURE_LINE, SIGNATURE_LINE_EDITED), "add a strict param");

    const review = buildReview(root, "main");
    const create = review.nodes.find((n) => n.symbol === "CustomerService.create");
    expect(create).toBeDefined();
    expect(create!.before).not.toBeNull();
    expect(create!.after).not.toBeNull();
    expect(create!.before!.text).not.toContain("strict = false");
    expect(create!.after!.text).toContain("strict = false");
  });

  it("is not mistaken for brand-new/deleted when indexed at head", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "api/app/services/customer_service.ts", (t) => t.replace(SIGNATURE_LINE, SIGNATURE_LINE_EDITED), "add a strict param");
    await runIndex(root); // reindex at head: the real CI flow

    const review = buildReview(root, "main");
    const create = review.nodes.find((n) => n.symbol === "CustomerService.create");
    expect(create).toBeDefined();
    expect(create!.before).not.toBeNull();
    expect(create!.after).not.toBeNull();
    expect(create!.before!.text).not.toContain("strict = false");
    expect(create!.after!.text).toContain("strict = false");
  });

  it("falls back to finding the same symbol by name when the signature's own hunk is merged with an unrelated shift", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    // One hunk replaces old line 5 (just the signature) with two new lines (a comment, then the edited
    // signature) — a comment inserted right above create(), merged into the SAME hunk as the signature
    // edit, so simple same-offset mapping lands on the comment line, not on any function's start.
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (t) => t.replace(SIGNATURE_LINE, `  // validates and creates a customer\n${SIGNATURE_LINE_EDITED}`),
      "comment + strict param, merged into one hunk",
    );

    const review = buildReview(root, "main");
    const create = review.nodes.find((n) => n.symbol === "CustomerService.create");
    expect(create).toBeDefined();
    expect(create!.before).not.toBeNull();
    expect(create!.after).not.toBeNull();
    expect(create!.before!.text).not.toContain("strict = false");
    expect(create!.after!.text).toContain("strict = false");
    // The comment pushed create() down by one line (to 6, not 5 — a same-offset guess would have landed
    // on the comment itself, which is not a function and so would have failed the "starts there" check,
    // forcing the by-name fallback to the real new location).
    expect(create!.after!.start).toBe(6);
  });
});

describe("buildReview — hunk header counts (must equal the emitted lines)", () => {
  it("counts the new side correctly when a trailing line (the function's own closing brace) is replaced by more lines than it had", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    // create()'s own closing "  }" (its last line, base[1] — no trailing context available beyond it)
    // replaced by two lines: this is exactly the boundary case where naively mapping the window's end
    // through the diff (rather than counting what was actually emitted) undercounts newLines.
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (t) => t.replace("    return customer;\n  }\n", "    return customer;\n  } // x\n  // y\n"),
      "replace the closing brace with two lines",
    );

    const review = buildReview(root, "main");
    const create = review.nodes.find((n) => n.symbol === "CustomerService.create")!;
    expect(create).toBeDefined();
    expect(create.hunks).toHaveLength(1);
    const h = create.hunks[0]!;
    const oldCount = h.lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
    const newCount = h.lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
    expect(h.oldLines).toBe(oldCount);
    expect(h.newLines).toBe(newCount);
  });
});

describe("buildReview — a brand-new function (M1: added > 0 but hunks was empty)", () => {
  it("emits one all-+ hunk for a brand-new function", async () => {
    const root = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (t) =>
        t.replace(
          "export default class CustomerService {\n",
          'export default class CustomerService {\n  async validate(payload: { email: string }) {\n    if (!payload.email) {\n      throw new Error("email required");\n    }\n  }\n\n',
        ),
      "add validate() above create()",
    );
    await runIndex(root); // indexed at head, so validate() has a real lineRange

    const review = buildReview(root, "main");
    const validate = review.nodes.find((n) => n.symbol === "CustomerService.validate");
    expect(validate).toBeDefined();
    expect(validate!.before).toBeNull();
    expect(validate!.added).toBeGreaterThan(0);
    expect(validate!.hunks.length).toBeGreaterThan(0);
    expect(validate!.hunks.every((h) => h.lines.every((l) => l.startsWith("+")))).toBe(true);
    const totalAdded = validate!.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("+")).length, 0);
    expect(totalAdded).toBe(validate!.added);
  });
});

describe("buildReview — real two-chain review (I1: distinct stop refs, real branch edges)", () => {
  it("gives a route its own ref, a call stop its own ref (not its enclosing function's), and branches from the real predecessor", async () => {
    const GET_CUSTOMER_CHAIN = chainId("page:web:/customers/:id", "api:GET /api/customers/:id");
    const root = await setUp();
    saveJourneysTool(root, [{ op: "create", name: "Show a customer", chainIds: [GET_CUSTOMER_CHAIN] }]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "name the show-customer journey"]);

    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "api/app/services/customer_service.ts", (t) => t.replace(AUDIT_LOG_LINE, VALIDATE_LINES), "edit create()");
    commitChange(
      root,
      "api/app/services/customer_service.ts",
      (t) => t.replace("  async find(id: number) {\n    return Customer.findOrFail(id);\n  }", "  async find(id: number) {\n    return Customer.findOrFail(Number(id));\n  }"),
      "edit find()",
    );

    const review = buildReview(root, "main");
    expect(review.chains.length).toBe(2);

    const allStops = review.chains.flatMap((id) => review.chainStops[id] ?? []);
    // No self-loop: no stop is its own predecessor's same ref (a "call" stop must not collapse onto its
    // enclosing function's node ref).
    for (const stops of review.chains.map((id) => review.chainStops[id]!)) {
      stops.forEach((s, i) => {
        if (s.from !== undefined) expect(stops[s.from]!.ref).not.toBe(s.ref);
      });
    }

    // The two routes are distinct nodes, not both collapsed to the routes file's own node.
    const routeRefs = new Set(allStops.filter((s) => s.lane === "api").map((s) => s.ref));
    expect(routeRefs.size).toBe(2);
    for (const ref of routeRefs) expect(ref).not.toBe("api::file:start/routes.ts");

    // The create-customer chain's two db stops (customers insert, audit_logs insert) both branch from the
    // SAME function stop (the real predecessor), not from each other.
    const createChainStops = review.chainStops[CREATE_CUSTOMER_CHAIN]!;
    const dbStops = createChainStops.filter((s) => s.lane === "db");
    expect(dbStops.length).toBeGreaterThanOrEqual(2);
    const fromRefs = new Set(dbStops.map((s) => createChainStops[s.from!]!.ref));
    expect(fromRefs.size).toBe(1);
    expect([...fromRefs][0]).toContain("CustomerService.create");
  });
});
