import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { type PrDeps, type PrResult, runPrCommand } from "../src/commands/pr.js";
import { buildCheckPacket, packetText } from "../src/review/packet.js";
import { buildReview } from "../src/review/build.js";
import { serveStaticSite } from "../src/web/static-site.js";
import { shopGroup } from "./shop-group-fixture.js";

// 0.6 Task E (spec §4): `codeloom pr` in a repo of a group. web + api + billing indexed one by one; a PR branch in
// the api changes CustomerService.create, which web's new-customer page reaches (POST /api/customers) and which
// calls billing (POST /billing/invoices). The PR page and the block name the web page journey and billing's route.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" }).toString();

function deps(printed: string[]): PrDeps {
  return {
    claude: null, interactive: false,
    confirm: async (_q, def) => def,
    run: () => {
      throw new Error("Claude must not start without consent");
    },
    print: (t) => printed.push(t), warn: (t) => printed.push(t),
    index: async (start) => {
      await runIndex(start);
    },
    open: () => {
      throw new Error("--no-open");
    },
    serve: (dir, port) => serveStaticSite(dir, { port }),
  };
}

describe("codeloom pr in a group (0.6 Task E)", () => {
  let g: Awaited<ReturnType<typeof shopGroup>>;
  const running: PrResult[] = [];
  beforeAll(async () => {
    g = await shopGroup();
    git(g.api, "checkout", "-q", "-b", "feat/invoice-note");
    const file = join(g.api, "app/services/customer_service.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(
      "    return customer;\n  }\n\n  async find",
      "    await db.table(\"audit_logs\").insert({ action: \"invoice.requested\", customer_id: customer.id });\n    return customer;\n  }\n\n  async find",
    ));
    git(g.api, "commit", "-qam", "Note each invoice request in the audit log");
  }, 300_000);
  beforeEach(() => {
    process.env.CODELOOM_HOME = g.home;
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.close();
  });

  it("names the web page journey and the billing route, and the page shows the journey across repos", async () => {
    const printed: string[] = [];
    const r = await runPrCommand(g.api, { base: "main", open: false }, deps(printed));
    running.push(r);
    const where = r.summary.whereItMatters.map((w) => `${w.repo ?? ""} ${w.name}`);
    expect(where).toEqual(expect.arrayContaining(["demo-web /customers/new"]));
    const block = printed.join("\n");
    expect(block).toContain("/customers/new");
    expect(block).toContain("POST /billing/invoices");
    // What it writes: the PR's own repo; what the other services then write on one line of its own.
    expect(block).toContain("**What it writes:** ` audit_logs `, ` customers `");
    expect(block).toContain("Further along (other services): demo-billing: ` invoice.created `, ` invoices `");
    expect(r.summary.writes.map((w) => w.name)).toEqual(["audit_logs", "customers"]);
    expect(r.summary.furtherAlong).toEqual([{ repo: "demo-billing", names: ["invoice.created", "invoices"] }]);
    // The diagram draws the changed function once (its outgoing call is an edge to billing's route, not a 2nd box).
    expect(block.match(/✏️ CustomerService\.create/g) ?? []).toHaveLength(1);
    expect(block).toMatch(/n\d+\["POST \/billing\/invoices"\]/);
    // The page's data: the chains the PR touches run web → api → billing.
    const review = JSON.parse(readFileSync(join(r.outDir, "data", "review.json"), "utf8")) as { rows?: Array<{ stops: Array<{ repo: string }> }> };
    const repos = new Set(JSON.stringify(review).match(/"repo":"demo-[a-z]+"/g));
    expect(repos).toEqual(new Set(['"repo":"demo-web"', '"repo":"demo-api"', '"repo":"demo-billing"']));
    // No absolute local path in any snapshot data file (group repos are registered by absolute path).
    const { homedir } = await import("node:os");
    const { readdirSync, realpathSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const local = [homedir(), dirname(g.api), realpathSync(dirname(g.api)), g.home, realpathSync(g.home), "/Users/", "/private/"];
    for (const f of readdirSync(join(r.outDir, "data"))) {
      const text = readFileSync(join(r.outDir, "data", f), "utf8");
      for (const p of local) expect(text.includes(p), `${f} holds ${p}`).toBe(false);
    }
    // The PR folder lives with the group's data, never in the repo.
    expect(r.outDir.startsWith(g.root)).toBe(true);
    expect(git(g.api, "status", "--porcelain")).toBe("");
  }, 300_000);

  it("snapshot --data-only in a group asks for --repo", () => {
    expect(() => buildReview(g.api, "main", { wholeWorkspaceOnly: true }))
      .toThrow(/In a group, pass --repo <id> \(demo-api, demo-billing, demo-web\)/);
    expect(buildReview(g.api, "main", { repoId: "demo-api" }).repoId).toBe("demo-api");
  });

  it("the check packet spans the repos and stays within 24,000 characters", () => {
    const packet = buildCheckPacket(g.api, "main");
    const text = packetText(packet);
    expect(text.length).toBeLessThanOrEqual(24_000);
    expect(text).toContain("demo-web");
    expect(text).toContain("POST /billing/invoices");
  });
});
