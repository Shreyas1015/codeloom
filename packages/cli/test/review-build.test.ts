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
    expect(node.before!.text).not.toBe(node.after!.text);
    expect(node.before!.text).toContain('await db.table("audit_logs")');
    expect(node.after!.text).toContain("email required");
    expect(node.hunks).toHaveLength(1);
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

  it("throws a CodeloomError (exit 2) outside a git repository", () => {
    const root = materializeSingleRepo("demo-shop");
    rmSync(join(root, ".git"), { recursive: true, force: true });
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [] }),
    );
    let threw: unknown;
    try {
      buildReview(root, "main");
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(CodeloomError);
    expect((threw as CodeloomError).exitCode).toBe(2);
  });
});
