import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram, exitCodeFor } from "../src/cli.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { parseReviewFormat, runReview } from "../src/commands/review.js";
import { CodeloomError } from "../src/errors.js";
import type { Review } from "../src/review/types.js";
import { git } from "../src/workspace/git.js";
import { commitChange, materializeSingleRepo } from "./helpers.js";

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
  git(root, ["checkout", "-q", "-b", "feature"]);
  commitChange(
    root,
    "api/app/services/customer_service.ts",
    (text) => text.replace("    const customer = await Customer.create(payload);\n", "    const customer = await Customer.create({ ...payload });\n"),
    "tweak CustomerService.create",
  );
  return root;
}

describe("parseReviewFormat", () => {
  it("defaults to markdown and accepts json", () => {
    expect(parseReviewFormat(undefined)).toBe("markdown");
    expect(parseReviewFormat("json")).toBe("json");
  });

  it("rejects anything else as a usage error (exit 2)", () => {
    expect(() => parseReviewFormat("yaml")).toThrow(CodeloomError);
    try {
      parseReviewFormat("yaml");
    } catch (err) {
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });
});

describe("runReview", () => {
  it("renders the markdown PR block by default", async () => {
    const root = await setUp();
    const { review, output } = runReview(root, { base: "main" });
    expect(review.baseRef).toBe("main");
    expect(output).toContain("### 🗺 codeloom review map");
  });

  it("prints the Review model as JSON with --format json", async () => {
    const root = await setUp();
    const { review, output } = runReview(root, { base: "main", format: "json" });
    const parsed = JSON.parse(output) as Review;
    expect(parsed.version).toBe(1);
    expect(parsed.base).toBe(review.base);
    expect(parsed.head).toBe(review.head);
  });

  it("adds the open-the-full-map line with --link", async () => {
    const root = await setUp();
    const { output } = runReview(root, { base: "main", link: "https://x.github.io/demo/pr-1/" });
    expect(output).toContain("https://x.github.io/demo/pr-1/");
  });
});

describe("codeloom review (cli wiring)", () => {
  it("registers --base (required), --format and --link", () => {
    const review = buildProgram().commands.find((c) => c.name() === "review")!;
    expect(review).toBeDefined();
    expect(review.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--base", "--format", "--link"]));
  });

  it("exits 2 when --base is missing", async () => {
    const program = buildProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    let code = 0;
    try {
      await program.parseAsync(["node", "codeloom", "review"]);
    } catch (err) {
      code = exitCodeFor(err);
    }
    expect(code).toBe(2);
  });
});
