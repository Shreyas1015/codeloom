// 0.6 Task A, review fix round 1: a clean git status, doctor's exclude check, parallel indexes, a corrupt
// registry, 0.5 lone-repo data carried into the group, review from a non-real path.
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildReport } from "../src/commands/check.js";
import { runDoctor } from "../src/commands/doctor.js";
import { formatIndexSummary, runIndex } from "../src/commands/index-cmd.js";
import { buildReview } from "../src/review/build.js";
import { progressPath } from "../src/store/progress.js";
import type { Chain } from "../src/store/schemas.js";
import { overview } from "../src/web/api.js";
import { groupRoot, readRegistry, registryPath } from "../src/workspace/registry.js";
import { commitAll, materializeFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(CLI_DIR, "dist", "bin.js");

function shopRepo(name: "web" | "api" | "billing", parent: string, opts: { folder?: string; remote?: string | null } = {}): string {
  const dest = join(parent, opts.folder ?? name);
  mkdirSync(parent, { recursive: true });
  cpSync(fileURLToPath(new URL(`../../../fixtures/demo-shop/${name}`, import.meta.url)), dest, { recursive: true });
  git(dest, "init", "-q", "-b", "main");
  commitAll(dest);
  const remote = opts.remote === undefined ? `git@github.com:demo-shop/demo-${name}.git` : opts.remote;
  if (remote !== null) git(dest, "remote", "add", "origin", remote);
  return dest;
}
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `codeloom-${prefix}-`));
const readChains = (root: string): Chain[] => JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains;

describe("git status stays clean (fix 1) and doctor checks the exclude line in a group (fix 2)", () => {
  it("indexing a clean repo leaves git status empty, through .git/info/exclude only", async () => {
    const web = shopRepo("web", tmp("a"));
    await runIndex(web);
    expect(git(web, "status", "--porcelain")).toBe("");
    expect(existsSync(join(web, ".gitignore"))).toBe(false);
    expect(readFileSync(join(web, ".git", "info", "exclude"), "utf8").split("\n")).toContain(".codeloom/");
    expect(existsSync(join(web, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("works in a linked worktree too (the exclude file is the main checkout's)", async () => {
    const web = shopRepo("web", tmp("a"));
    const wt = join(tmp("wt"), "web-wt");
    git(web, "worktree", "add", "-q", "-b", "side", wt);
    await runIndex(wt);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("doctor --fix never writes .gitignore in a group; it checks and restores the exclude line", async () => {
    const web = shopRepo("web", tmp("a"));
    await runIndex(web);
    const ok = runDoctor(web, {});
    expect(ok.items.filter((i) => i.check === "gitignore")).toEqual([]);
    expect(ok.items.find((i) => i.check === "exclude")).toMatchObject({ status: "ok" });
    writeFileSync(join(web, ".git", "info", "exclude"), "# nothing\n");
    expect(runDoctor(web, {}).items.find((i) => i.check === "exclude")).toMatchObject({ status: "warn" });
    const fixed = runDoctor(web, { fix: true });
    expect(fixed.items.find((i) => i.check === "exclude")).toMatchObject({ status: "fixed" });
    expect(existsSync(join(web, ".gitignore"))).toBe(false);
    expect(git(web, "status", "--porcelain")).toBe("");
  });
});

describe("parallel indexes (fix 3)", () => {
  beforeAll(() => {
    if (!(process.env.CI && existsSync(BIN))) execFileSync("pnpm", ["--filter", "codeloom...", "build"], { cwd: CLI_DIR, stdio: "pipe" });
  }, 180_000);

  it("three repos indexed at once lose no registry entry, and end with the chains of a sequential run", async () => {
    const seqHome = process.env.CODELOOM_HOME!;
    const seqParent = tmp("seq");
    for (const r of ["web", "api", "billing"] as const) await runIndex(shopRepo(r, seqParent));
    const sequential = readChains(groupRoot("github.com/demo-shop"));
    for (let round = 0; round < 4; round++) {
      const home = tmp("par-home");
      const parent = tmp("par");
      const repos = (["web", "api", "billing"] as const).map((r) => shopRepo(r, parent));
      await Promise.all(repos.map((cwd) => execFileAsync(process.execPath, [BIN, "index", "--quiet"], { cwd, env: { ...process.env, CODELOOM_HOME: home } })));
      process.env.CODELOOM_HOME = home;
      expect(readRegistry().repos.map((e) => e.id)).toEqual(["demo-api", "demo-billing", "demo-web"]);
      expect(readChains(groupRoot("github.com/demo-shop"))).toEqual(sequential);
      process.env.CODELOOM_HOME = seqHome;
    }
  }, 180_000);
});

describe("a corrupt registry (fix 4)", () => {
  it("names the file and the backup, never advising to delete it", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(web);
    const first = readFileSync(registryPath(), "utf8");
    await runIndex(api);
    expect(readFileSync(`${registryPath()}.bak`, "utf8")).toBe(first);
    writeFileSync(registryPath(), "{ not json");
    let message = "";
    try {
      await runIndex(web);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(registryPath());
    expect(message).toContain("registry.json.bak");
    expect(message).not.toMatch(/delete/i);
  });

  it("does not break check or the dashboard of a workspace folder", async () => {
    writeFileSync(registryPath(), "{ not json");
    const root = materializeFixture("demo-shop");
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [],
    }));
    await runIndex(root);
    expect((await buildReport(root)).summary).toBeDefined();
    expect((await overview(root)).repos.map((r) => r.id)).toEqual(["api", "web"]);
  });
});

describe("0.5 lone-repo data carried into the group (fix 7)", () => {
  const J1 = "j_000000000001";
  const J2 = "j_000000000002";
  const journey = (id: string, name: string) => ({ id, name, area: "shop", note: "", chainIds: [], status: "ok" });

  it("copies journeys, tours, views and specs once, never overwriting the group's own", async () => {
    const parent = tmp("old");
    const web = shopRepo("web", parent);
    const api = shopRepo("api", parent);
    // api joins first, and the group already has its own J1.
    await runIndex(api);
    const groupDir = join(groupRoot("github.com/demo-shop"), ".codeloom");
    const journeysPath = join(groupDir, "journeys.json");
    const groupJourneys = JSON.parse(readFileSync(journeysPath, "utf8"));
    groupJourneys.journeys.push(journey(J1, "group's own"));
    writeFileSync(journeysPath, JSON.stringify(groupJourneys));
    // web was indexed alone by 0.5: its .codeloom holds journeys, a tour, a view and specs.
    const old = join(web, ".codeloom");
    mkdirSync(join(old, "tours"), { recursive: true });
    mkdirSync(join(old, "views"), { recursive: true });
    writeFileSync(join(old, "journeys.json"), JSON.stringify({ version: 1, journeys: [journey(J1, "old copy"), journey(J2, "carried")] }));
    writeFileSync(join(old, "tours", `${J2}.json`), '{"tour":"x"}');
    writeFileSync(join(old, "views", "no-spec.json"), '{"view":"x"}');
    writeFileSync(join(old, "specs.json"), JSON.stringify({ version: 1, journeys: { [J2]: { links: [], checkedAt: "2026-11-01T00:00:00.000Z" } } }));

    const r = await runIndex(web);
    const merged = JSON.parse(readFileSync(journeysPath, "utf8")).journeys as Array<{ id: string; name: string }>;
    expect(merged.find((j) => j.id === J1)!.name).toBe("group's own");
    expect(merged.find((j) => j.id === J2)!.name).toBe("carried");
    expect(readFileSync(join(groupDir, "tours", `${J2}.json`), "utf8")).toBe('{"tour":"x"}');
    expect(readFileSync(join(groupDir, "views", "no-spec.json"), "utf8")).toBe('{"view":"x"}');
    expect(JSON.parse(readFileSync(join(groupDir, "specs.json"), "utf8")).journeys[J2]).toBeDefined();
    expect(r.group?.carried).toEqual(expect.arrayContaining(["1 journey", "tours/" + `${J2}.json`, "views/no-spec.json", "specs for 1 journey"]));
    expect(formatIndexSummary(r)).toMatch(/Carried over from .*web.*\.codeloom/);

    // Once: a later index carries nothing again, even if the old files change.
    writeFileSync(join(old, "views", "no-spec.json"), '{"view":"changed"}');
    const again = await runIndex(web);
    expect(again.group?.carried ?? []).toEqual([]);
    expect(readFileSync(join(groupDir, "views", "no-spec.json"), "utf8")).toBe('{"view":"x"}');
  });
});

describe("fix round 2", () => {
  it("carries a 0.5 lone repo's personal progress into the group's, once, never over the group's own", async () => {
    const J1 = "j_000000000001";
    const J2 = "j_000000000002";
    const parent = tmp("old");
    const web = shopRepo("web", parent);
    // 0.5: web was its own workspace, named and keyed by its id.
    const oldWs = { root: web, name: "demo-web", repos: [{ ref: { id: "demo-web" }, abs: web }] };
    const progress = (journeys: Record<string, unknown>) => ({ version: 1, journeys });
    const seen = (at: string) => ({ seenAt: at, checks: [] });
    mkdirSync(join(process.env.CODELOOM_HOME!, "progress"), { recursive: true });
    writeFileSync(progressPath(oldWs), JSON.stringify(progress({ [J1]: seen("2026-11-01T00:00:00.000Z"), [J2]: seen("2026-11-02T00:00:00.000Z") })));
    const group = { root: groupRoot("github.com/demo-shop"), name: "github.com/demo-shop", repos: [] };
    writeFileSync(progressPath(group), JSON.stringify(progress({ [J1]: seen("2026-11-10T00:00:00.000Z") })));

    const r = await runIndex(web);
    const merged = JSON.parse(readFileSync(progressPath(group), "utf8")).journeys;
    expect(merged[J1].seenAt).toBe("2026-11-10T00:00:00.000Z");
    expect(merged[J2].seenAt).toBe("2026-11-02T00:00:00.000Z");
    expect(r.group?.carried).toContain("your progress on 1 journey");
    expect((await runIndex(web)).group?.carried ?? []).toEqual([]);
  });

  it("a corrupt registry does not break check or the dashboard in a lone, unregistered repo", async () => {
    const web = shopRepo("web", tmp("lone"));
    writeFileSync(join(web, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "demo-web", repos: [{ id: "demo-web", path: "." }], links: [] }));
    await runIndex(web);
    rmSync(join(web, "codeloom.workspace.json"));
    writeFileSync(registryPath(), "{ not json");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect((await buildReport(web)).summary).toBeDefined();
      expect((await overview(web)).repos.map((x) => x.id)).toEqual(["demo-web"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("review from inside a group member (fix 8)", () => {
  it("picks the repo holding the folder even when the path is not the real one", async () => {
    const parent = tmp("rev"); // under /var on macOS, while git reports /private/var
    const web = shopRepo("web", parent);
    const api = shopRepo("api", parent);
    await runIndex(web);
    await runIndex(api);
    const review = buildReview(api, "HEAD");
    expect(review).toBeDefined();
  });
});
