import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatIndexSummary, runIndex } from "../src/commands/index-cmd.js";
import { runDoctor } from "../src/commands/doctor.js";
import { loadMapState } from "../src/mcp/state.js";
import { progressPath } from "../src/store/progress.js";
import type { Chain } from "../src/store/schemas.js";
import { loadWorkspace } from "../src/workspace/repos.js";
import { groupRoot, readRegistry } from "../src/workspace/registry.js";
import { type ChangeKey, watchMap } from "../src/web/events.js";
import { commitAll, materializeFixture } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** One demo-shop repo as its own git repo at `<parent>/<folder>`, with `origin` set when `remote` is given. */
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
const repoPath = (c: Chain) => [...new Set(c.stops.map((s) => s.repo))];
const crossing = (chains: Chain[]) => chains.filter((c) => repoPath(c).length > 1);

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.CODELOOM_HOME;
  process.env.CODELOOM_HOME = tmp("home");
});
afterEach(() => {
  process.env.CODELOOM_HOME = savedHome;
});

describe("codeloom index inside one repo (0.6 §1)", () => {
  it("registers the repo and links separately indexed web and api repos from two parent folders", async () => {
    const web = shopRepo("web", tmp("folder-a"));
    const api = shopRepo("api", tmp("folder-b"));

    const first = await runIndex(web);
    expect(first.repos.map((r) => r.id)).toEqual(["demo-web"]);
    expect(first.group?.name).toBe("github.com/demo-shop");
    expect(first.root).toBe(groupRoot("github.com/demo-shop"));
    expect(crossing(readChains(first.root))).toEqual([]);

    const second = await runIndex(api);
    expect(second.repos.map((r) => r.id)).toEqual(["demo-api"]); // only this repo was parsed
    expect(second.group?.members).toEqual(["demo-api", "demo-web"]);
    const chains = readChains(second.root);
    const linked = crossing(chains);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((c) => repoPath(c).join(" > ") === "demo-web > demo-api")).toBe(true);
    expect(linked.some((c) => c.complete && c.stops.some((s) => s.lane === "db"))).toBe(true);
    expect(second.group?.connections).toEqual([{ from: "demo-web", to: "demo-api", chains: linked.length }]);
    expect(formatIndexSummary(second)).toMatch(/demo-web → demo-api/);

    const reg = readRegistry();
    expect(reg.repos.map((e) => [e.id, e.group, e.remote])).toEqual([
      ["demo-api", "github.com/demo-shop", "github.com/demo-shop/demo-api"],
      ["demo-web", "github.com/demo-shop", "github.com/demo-shop/demo-web"],
    ]);
  });

  it("gives the same chains in any order, and the same as a workspace folder of the two repos", async () => {
    const webA = shopRepo("web", tmp("a"));
    const apiA = shopRepo("api", tmp("a"));
    await runIndex(webA);
    const ab = readChains((await runIndex(apiA)).root);

    process.env.CODELOOM_HOME = tmp("home");
    const webB = shopRepo("web", tmp("b"));
    const apiB = shopRepo("api", tmp("b"));
    await runIndex(apiB);
    const ba = readChains((await runIndex(webB)).root);
    expect(ba).toEqual(ab);

    const root = materializeFixture("demo-shop");
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", repos: [{ id: "demo-api", path: "api" }, { id: "demo-web", path: "web" }], links: [],
    }));
    await runIndex(root);
    expect(ab).toEqual(readChains(root));
  });

  it("never re-parses or rewrites the other repos of the group", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("a"));
    await runIndex(web);
    const files = [".codeloom/fingerprints.json", ".codeloom/graph.json", ".codeloom/endpoints.json"].map((f) => join(web, f));
    const before = files.map((f) => statSync(f).mtimeMs);
    await new Promise((r) => setTimeout(r, 20));
    await runIndex(api);
    expect(files.map((f) => statSync(f).mtimeMs)).toEqual(before);
  });

  it("ignores an older duplicate checkout of the same remote for linking", async () => {
    const parent = tmp("dups");
    const web = shopRepo("web", parent);
    const api = shopRepo("api", parent);
    await runIndex(web);
    const ab = readChains((await runIndex(api)).root);
    const copy = shopRepo("web", parent, { folder: "web-old-checkout" });
    const third = await runIndex(copy);
    expect(third.repos.map((r) => r.id)).toEqual(["demo-web"]);
    expect(third.group?.members).toEqual(["demo-api", "demo-web"]);
    expect(third.group?.copies).toEqual([expect.stringMatching(/\/web$/)]);
    expect(readChains(third.root)).toEqual(ab);
    const ws = loadWorkspace(api);
    expect(ws.repos.find((r) => r.id === "demo-web")!.path).toMatch(/web-old-checkout$/);
    const old = readRegistry().repos.find((e) => e.path.endsWith("/web"))!;
    expect(old.copyOf).toMatch(/web-old-checkout$/);
    // Each copy is named once, by the run that made it one; later runs say how many are ignored.
    expect(formatIndexSummary(third)).toMatch(/Ignored .*\/web: an older checkout of a repo already in the group/);
    const later = formatIndexSummary(await runIndex(api));
    expect(later).not.toContain("Ignored ");
    expect(later).toContain("1 older checkout ignored");
  });

  it("names a group's repo by its remote repo name, else its folder — not a template package name (0.6 Task E)", async () => {
    const parent = tmp("ids");
    const ui = shopRepo("web", parent, { folder: "web-checkout", remote: "git@github.com:demo-shop/installer-ui.git" });
    const lone = shopRepo("api", parent, { folder: "orders-api", remote: null });
    const a = await runIndex(ui);
    expect(a.repos.map((r) => r.id)).toEqual(["installer-ui"]);
    const b = await runIndex(lone, { group: "github.com/demo-shop" });
    expect(b.repos.map((r) => r.id)).toEqual(["orders-api"]);
    expect(readRegistry().repos.map((e) => e.id).sort()).toEqual(["installer-ui", "orders-api"]);
  });

  it("keeps a repo of another remote owner in its own group", async () => {
    const parent = tmp("mixed");
    const web = shopRepo("web", parent);
    const api = shopRepo("api", parent, { remote: "https://github.com/someone-else/demo-api.git" });
    await runIndex(web);
    const r = await runIndex(api);
    expect(r.group?.name).toBe("github.com/someone-else");
    expect(r.group?.members).toEqual(["demo-api"]);
    expect(crossing(readChains(r.root))).toEqual([]);
    expect(loadWorkspace(web).repos.map((x) => x.id)).toEqual(["demo-web"]);
  });

  it("groups repos with no remote by parent folder, and --group overrides", async () => {
    const parent = tmp("local");
    // No remote: a repo is named by its folder.
    const web = shopRepo("web", parent, { remote: null });
    const api = shopRepo("api", parent, { remote: null });
    await runIndex(web);
    const r = await runIndex(api);
    expect(r.group?.members).toEqual(["api", "web"]);
    expect(crossing(readChains(r.root)).length).toBeGreaterThan(0);

    const other = shopRepo("billing", tmp("elsewhere"), { remote: null });
    const moved = await runIndex(other, { group: r.group!.name });
    expect(moved.group?.members).toEqual(["api", "billing", "web"]);
    // The choice sticks without --group.
    expect((await runIndex(other)).group?.name).toBe(r.group!.name);
  });

  it("serves the group from inside any member repo and from the group data folder", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(web);
    await runIndex(api);
    const fromWeb = loadMapState(web);
    expect(fromWeb.ws.root).toBe(groupRoot("github.com/demo-shop"));
    expect(fromWeb.ws.repos.map((r) => r.ref.id)).toEqual(["demo-api", "demo-web"]);
    expect(crossing(fromWeb.chains).length).toBeGreaterThan(0);
    expect(loadMapState(join(web, "app")).ws.root).toBe(fromWeb.ws.root);
    expect(loadMapState(fromWeb.ws.root).ws.repos).toHaveLength(2);
  });

  it("the dashboard's watcher sees a repo join the group and its data change", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(web);
    const calls: ChangeKey[][] = [];
    const stop = watchMap(web, (keys) => calls.push(keys), { debounceMs: 100 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      calls.length = 0;
      await runIndex(api);
      const until = Date.now() + 4000;
      const seen = () => new Set(calls.flat());
      // (The group's chains.json is watched as in a workspace folder; macOS may fold its event into the
      // first run's, so only the registry change is asserted here.)
      while (!seen().has("workspace") && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(seen().has("workspace")).toBe(true);
      // Now armed on the new member: its map changing is seen too.
      calls.length = 0;
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(join(api, ".codeloom", "endpoints.json"), readFileSync(join(api, ".codeloom", "endpoints.json"), "utf8") + " ");
      const until2 = Date.now() + 4000;
      while (!seen().has("repo:demo-api") && Date.now() < until2) await new Promise((r) => setTimeout(r, 25));
      expect(seen().has("repo:demo-api")).toBe(true);
    } finally {
      stop();
    }
  });

  it("keeps the progress file id of a group stable as repos join", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(web);
    const one = loadMapState(web).ws;
    await runIndex(api);
    const two = loadMapState(web).ws;
    expect(two.repos).toHaveLength(2);
    expect(progressPath(two)).toBe(progressPath(one));
  });

  it("doctor reports moved or deleted repos and --fix drops them", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(web);
    await runIndex(api);
    rmSync(api, { recursive: true });
    expect(loadWorkspace(web).repos.map((r) => r.id)).toEqual(["demo-web"]);
    const report = runDoctor(web, {});
    const item = report.items.find((i) => i.check === "registry" && i.repo === "demo-api");
    expect(item).toMatchObject({ status: "warn" });
    expect(item!.message).toMatch(/moved or deleted/);
    expect(readRegistry().repos).toHaveLength(2);
    const fixed = runDoctor(web, { fix: true });
    expect(fixed.items.find((i) => i.check === "registry" && i.repo === "demo-api")).toMatchObject({ status: "fixed" });
    expect(readRegistry().repos.map((e) => e.id)).toEqual(["demo-web"]);
  });

  it("drops a gone repo from the registry on the next index", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(api);
    rmSync(api, { recursive: true });
    const r = await runIndex(web);
    expect(r.group?.dropped).toEqual([expect.stringMatching(/api$/)]);
    expect(readRegistry().repos.map((e) => e.id)).toEqual(["demo-web"]);
    expect(formatIndexSummary(r)).toMatch(/no longer found/);
  });

  it("links what it can when another member's saved map is gone", async () => {
    const web = shopRepo("web", tmp("a"));
    const api = shopRepo("api", tmp("b"));
    await runIndex(api);
    rmSync(join(api, ".codeloom"), { recursive: true });
    const r = await runIndex(web);
    expect(r.group?.members).toEqual(["demo-web"]);
    expect(r.group?.notes).toEqual([expect.stringMatching(/^demo-api has no saved map/)]);
    expect(loadMapState(web).ws.repos.map((x) => x.ref.id)).toEqual(["demo-web"]);
  });

  it("leaves workspace-folder mode alone: nothing is registered", async () => {
    const root = materializeFixture("demo-shop");
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [],
    }));
    const r = await runIndex(root);
    expect(r.group).toBeUndefined();
    expect(r.root).toBe(root);
    expect(existsSync(join(process.env.CODELOOM_HOME!, "registry.json"))).toBe(false);
    await expect(runIndex(root, { group: "shop" })).rejects.toThrow(/--group/);
  });
});
