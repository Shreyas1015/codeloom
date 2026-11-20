import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatIndexSummary, runIndex } from "../src/commands/index-cmd.js";
import { mapGaps } from "../src/map/gaps.js";
import { saveMapAnswers } from "../src/map/save.js";
import { ChainsFileSchema } from "../src/store/schemas.js";
import { groupRoot, readRegistry } from "../src/workspace/registry.js";
import { commitAll, freshHome, makeRepo } from "./helpers.js";

// 0.6 Task E: a repo whose remote owner differs from the rest (`bitbucket.org:other-team/sales-tools`, a frontend
// calling main-team's backends) lands alone in its own group. codeloom says so, proposes the one group whose routes
// its calls match (only when one clearly does), and a `join-group` answer moves it there.

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

function shop(name: "web" | "api" | "billing", parent: string, remote: string): string {
  const dest = join(parent, name);
  mkdirSync(parent, { recursive: true });
  cpSync(fileURLToPath(new URL(`../../../fixtures/demo-shop/${name}`, import.meta.url)), dest, { recursive: true });
  git(dest, "init", "-q", "-b", "main");
  commitAll(dest);
  git(dest, "remote", "add", "origin", remote);
  return dest;
}

const MAIN = "bitbucket.org/main-team";
const OTHER = "bitbucket.org/other-team";

describe("a repo alone in its group (0.6 Task E)", () => {
  let home = "";
  let web = "";
  let api = "";
  let summary = "";
  beforeAll(async () => {
    home = freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-alone-"));
    api = shop("api", parent, "git@bitbucket.org:main-team/api.git");
    shop("billing", parent, "git@ssh.bitbucket.org:main-team/billing.git");
    web = shop("web", parent, "git@bitbucket.org:other-team/sales-tools.git");
    await runIndex(api);
    await runIndex(join(parent, "billing"));
    summary = formatIndexSummary(await runIndex(web));
  }, 300_000);
  beforeEach(() => {
    process.env.CODELOOM_HOME = home;
  });

  it("index prints a one-line hint naming the group its calls match", () => {
    expect(summary).toContain(`sales-tools is alone in group ${OTHER}; to join ${MAIN}: npx codeloom index --group ${MAIN}`);
  });

  it("gaps hold a repo-alone question proposing a join-group answer", () => {
    const gap = mapGaps(web).gaps.find((g) => g.kind === "repo-alone");
    expect(gap).toBeDefined();
    expect(gap!.question).toContain("sales-tools");
    expect(gap!.evidence.join("\n")).toMatch(new RegExp(`${MAIN}: \\d+ of \\d+ calls match`));
    expect((gap!.suggest ?? []).map((s) => JSON.parse(s))).toEqual([{ kind: "join-group", repo: "sales-tools", group: MAIN }]);
  });

  it("join-group is validated, then moves the repo and links it with the group", () => {
    expect(() => saveMapAnswers(web, { answers: [{ kind: "join-group", repo: "sales-tools", group: "bitbucket.org/nobody" }] }))
      .toThrow(/no group "bitbucket.org\/nobody"/);
    expect(() => saveMapAnswers(web, { answers: [{ kind: "join-group", repo: "demo-ghost", group: MAIN }] })).toThrow(/demo-ghost/);
    const gap = mapGaps(web).gaps.find((g) => g.kind === "repo-alone")!;
    const r = saveMapAnswers(web, { answers: [JSON.parse(gap.suggest![0]!)] });
    expect(r.closed.map((x) => x.id)).toContain(gap.id);
    const entry = readRegistry().repos.find((e) => e.id === "sales-tools")!;
    expect(entry).toMatchObject({ group: MAIN, groupFrom: "flag" });
    const chains = ChainsFileSchema.parse(JSON.parse(readFileSync(join(groupRoot(MAIN), ".codeloom", "chains.json"), "utf8"))).chains;
    const page = chains.find((c) => c.entry === "page:sales-tools:/customers/:id")!;
    expect(page.stops.map((s) => s.repo)).toEqual(expect.arrayContaining(["sales-tools", "api"]));
    expect(mapGaps(api).gaps.some((g) => g.kind === "repo-alone")).toBe(false);
  });

  it("a later index keeps it in the group it joined", async () => {
    const r = await runIndex(web);
    expect(r.group?.name).toBe(MAIN);
    expect(formatIndexSummary(r)).not.toContain("is alone in group");
  });
});

describe("no group stands out (0.6 Task E)", () => {
  it("says the repo is alone, proposes nothing", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-alone2-"));
    // Another group exists, but none of its routes match the kiosk's calls.
    const other = shop("billing", join(parent, "elsewhere"), "git@github.com:demo-shop/demo-billing.git");
    await runIndex(other);
    const web = makeRepo({
      "package.json": JSON.stringify({ name: "demo-kiosk", dependencies: { next: "^15", react: "^19" } }),
      "app/page.tsx": 'export default async function Home() {\n  const r = await fetch(`${process.env.NEXT_PUBLIC_KIOSK_URL}/kiosk/items`);\n  return <p>{String(r.ok)}</p>;\n}\n',
    }, join(parent, "kiosk"));
    git(web, "remote", "add", "origin", "git@github.com:kiosk-team/kiosk.git");
    const summary = formatIndexSummary(await runIndex(web));
    expect(summary).toContain(`kiosk is alone in group github.com/kiosk-team`);
    expect(summary).not.toContain("to join");
    const gap = mapGaps(web).gaps.find((g) => g.kind === "repo-alone");
    expect(gap).toBeDefined();
    expect(gap!.suggest).toBeUndefined();
  }, 120_000);
});

describe("only says what helps (0.6 Task E)", () => {
  it("no alone hint or gap when the repo's group is the only one; names unindexed sibling repos", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-only-"));
    const web = shop("web", parent, "git@github.com:demo-shop/demo-web.git");
    shop("api", parent, "git@github.com:demo-shop/demo-api.git");
    const first = formatIndexSummary(await runIndex(web));
    expect(first).not.toContain("is alone in group");
    expect(mapGaps(web).gaps.some((g) => g.kind === "repo-alone")).toBe(false);
    // The api checkout next to it is not indexed yet: named, with what to run.
    expect(first).toContain(`Not indexed yet, next to the group's repos: api — run "npx codeloom index" in each`);
    const second = formatIndexSummary(await runIndex(join(parent, "api")));
    expect(second).not.toContain("Not indexed yet");
    expect(second).not.toContain("in each of your repos");
  }, 300_000);
});

describe("a lone repo whose call bases name another group's repo (0.6 Task E)", () => {
  it("proposes that group by the base name even when no path matches, and asks to join it", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-alone-base-"));
    const core = makeRepo({
      "package.json": JSON.stringify({ name: "service-template", dependencies: { express: "^4" } }),
      "src/server.ts": 'import express from "express";\nconst app = express();\napp.get("/orders/:id", (req, res) => { res.json({}); });\napp.listen(1);\n',
    }, join(parent, "core"));
    git(core, "remote", "add", "origin", "git@bitbucket.org:main-team/core.git");
    const tools = makeRepo({
      "package.json": JSON.stringify({ name: "web-template", dependencies: { next: "^15", react: "^19" } }),
      "app/page.tsx": 'export default async function Home() {\n  const r = await fetch(`${process.env.CORE_SERVICE_URL}/v2/legacy/orders`);\n  return <p>{String(r.ok)}</p>;\n}\n',
    }, join(parent, "sales-tools"));
    git(tools, "remote", "add", "origin", "git@bitbucket.org:other-team/sales-tools.git");
    await runIndex(core);
    const summary = formatIndexSummary(await runIndex(tools));
    expect(summary).toContain(`sales-tools is alone in group ${OTHER}; to join ${MAIN}: npx codeloom index --group ${MAIN}`);
    const gap = mapGaps(tools).gaps.find((g) => g.kind === "repo-alone")!;
    expect(gap.question).toContain(`Join ${MAIN}?`);
    expect(gap.evidence.join("\n")).toMatch(/CORE_SERVICE_URL names core/);
    expect((gap.suggest ?? []).map((x) => JSON.parse(x))).toEqual([{ kind: "join-group", repo: "sales-tools", group: MAIN }]);
  }, 120_000);
});
