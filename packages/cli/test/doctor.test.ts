import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildProgram, exitCodeFor } from "../src/cli.js";
import { formatDoctor, runDoctor, type DoctorReport } from "../src/commands/doctor.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { HOOK_MARK, runInit, shellQuote } from "../src/commands/init.js";
import { readJson, writeJsonAtomic } from "../src/store/json.js";
import { loadWorkspace } from "../src/workspace/repos.js";
import { RepoConfigSchema } from "../src/store/schemas.js";
import { progressPath } from "../src/store/progress.js";
import { stopKey } from "../src/store/stop-key.js";
import { writeTour } from "../src/store/tours.js";
import { commitAll, makeRepo, materializeFixture } from "./helpers.js";

const REPOS = ["api", "billing", "web"];
const IDS = ["demo-api", "demo-billing", "demo-web"];

/** An executable stand-in for the codeloom bin, in a folder of its own. */
function fakeBin(name = "bin.js"): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-doctor-bin-"));
  const bin = join(dir, name);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}

/** The hooks run this bin, so the hook check passes whatever is on the machine's PATH (H7). */
const SHOP_BIN = fakeBin();

/** demo-shop, set up and indexed with every repo committed, so nothing is stale. */
async function healthyShop(): Promise<string> {
  const root = materializeFixture("demo-shop");
  runInit(root, { bin: SHOP_BIN });
  for (const r of REPOS) commitAll(join(root, r));
  await runIndex(root);
  return root;
}

/** A fresh copy of the healthy shop. cpSync does not keep timestamps, so every git index in the copy
 * has stale stat info (a plain `git status` would rewrite .git/index). The hooks are pointed at the copy. */
function copyShop(src: string): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-doctor-"));
  cpSync(src, root, { recursive: true });
  for (const r of REPOS) {
    const hook = join(root, r, ".git", "hooks", "post-commit");
    if (existsSync(hook)) writeFileSync(hook, readFileSync(hook, "utf8").split(src).join(root));
  }
  return root;
}

/** sha1 of every file under root (including .git), keyed by relative path. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[p.slice(root.length)] = createHash("sha1").update(readFileSync(p)).digest("hex") + statSync(p).mode;
    }
  };
  walk(root);
  return out;
}

const nonOk = (r: DoctorReport) => r.items.filter((i) => i.status !== "ok");
/** The first `tours` item of a doctor run. */
const r0 = (root: string) => runDoctor(root, {}).items.find((i) => i.check === "tours")!;
const statusOf = (r: DoctorReport, check: string, repo?: string) =>
  r.items.find((i) => i.check === check && i.repo === repo)?.status;

const ReportShape = z.object({
  version: z.literal(1),
  items: z.array(
    z.object({
      check: z.string(),
      repo: z.string().optional(),
      status: z.enum(["ok", "warn", "error", "fixed"]),
      message: z.string(),
      fix: z.string().optional(),
    }).strict(),
  ),
  summary: z.object({ ok: z.number().int(), warn: z.number().int(), error: z.number().int(), fixed: z.number().int() }).strict(),
}).strict();

async function cli(root: string, args: string[]): Promise<{ out: string; code: number }> {
  let out = "";
  const origLog = console.log;
  const origCwd = process.cwd();
  const prevExit = process.exitCode;
  console.log = (s: unknown) => { out += `${String(s)}\n`; };
  process.chdir(root);
  process.exitCode = undefined;
  let code = 0;
  try {
    await buildProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} }).parseAsync(["node", "codeloom", "doctor", ...args]);
    code = Number(process.exitCode ?? 0);
  } catch (err) {
    code = exitCodeFor(err);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    process.exitCode = prevExit;
  }
  return { out, code };
}

describe("codeloom doctor", { timeout: 90_000 }, () => {
  let healthy: string;
  let shop: () => string;
  beforeAll(async () => {
    healthy = await healthyShop();
    shop = () => copyShop(healthy);
  }, 90_000);

  it("reports a healthy indexed demo-shop as all ok, exit 0", async () => {
    const r = runDoctor(healthy, {});
    expect(nonOk(r)).toEqual([]);
    expect(r.summary.warn + r.summary.error + r.summary.fixed).toBe(0);
    // every documented check ran
    const checks = new Set(r.items.map((i) => i.check));
    for (const c of ["git", "workspace", "config", "graph", "endpoints", "cache", "summaries", "chains", "journeys", "progress", "tours", "hook", "gitignore", "mcp", "index"]) {
      expect(checks).toContain(c);
    }
    expect(r.items.filter((i) => i.check === "hook").map((i) => i.repo)).toEqual(IDS);
    const { out, code } = await cli(healthy, []);
    expect(code).toBe(0);
    expect(out).toMatch(/\d+ ok, 0 warnings, 0 errors, 0 fixed/);
    expect(out).not.toMatch(/--fix/);
  });

  it("orders items by check order, then repo id", () => {
    const r = runDoctor(healthy, {});
    const order = ["git", "workspace", "config", "graph", "endpoints", "cache", "summaries", "chains", "journeys", "progress", "tours", "hook", "gitignore", "mcp", "index"];
    const keys = r.items.map((i) => [order.indexOf(i.check), i.repo ?? ""] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
  });

  it("finds a missing hook, gitignore line, .mcp.json entry and config; --fix repairs all four", async () => {
    const root = shop();
    rmSync(join(root, "api", ".git", "hooks", "post-commit"));
    const gi = join(root, "web", ".gitignore");
    writeFileSync(gi, readFileSync(gi, "utf8").replace(".codeloom/fingerprints.json\n", ""));
    // keep the working tree clean so only the four planted problems show up
    commitAll(join(root, "web"));
    await runIndex(root);
    writeJsonAtomic(join(root, ".mcp.json"), { mcpServers: { other: { command: "x" } } });
    rmSync(join(root, "billing", ".codeloom", "config.json"));
    commitAll(join(root, "billing"));
    await runIndex(root);

    const before = runDoctor(root, {});
    const bad = nonOk(before);
    expect(bad.map((i) => [i.check, i.repo, i.status])).toEqual([
      ["config", "demo-billing", "warn"],
      ["hook", "demo-api", "warn"],
      ["gitignore", "demo-web", "warn"],
      ["mcp", undefined, "warn"],
    ]);
    expect(bad.every((i) => i.fix)).toBe(true);
    expect(formatDoctor(before)).toContain('Run "codeloom doctor --fix" to repair 4 items.');

    const fixed = runDoctor(root, { fix: true, bin: SHOP_BIN }); // as the CLI does (H7): the repaired hook runs this bin
    expect(nonOk(fixed).map((i) => i.status)).toEqual(["fixed", "fixed", "fixed", "fixed"]);
    expect(fixed.summary.fixed).toBe(4);
    expect(readFileSync(join(root, "api", ".git", "hooks", "post-commit"), "utf8")).toContain(HOOK_MARK);
    expect(readFileSync(gi, "utf8")).toContain(".codeloom/fingerprints.json");
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.mcpServers.codeloom).toBeDefined();
    expect(readJson(join(root, "billing", ".codeloom", "config.json"), RepoConfigSchema)).toEqual({ version: 1, autoUpdate: true, ignore: [] });

    commitAll(join(root, "web")); // the restored gitignore line is a working-tree change
    commitAll(join(root, "billing"));
    await runIndex(root);
    const after = runDoctor(root, {});
    expect(nonOk(after)).toEqual([]);
  });

  it("deletes a corrupt fingerprints cache with --fix", async () => {
    const root = shop();
    const fp = join(root, "api", ".codeloom", "fingerprints.json");
    writeFileSync(fp, "{ not json");
    const r = runDoctor(root, {});
    expect(statusOf(r, "cache", "demo-api")).toBe("warn");
    expect(r.items.find((i) => i.check === "cache" && i.repo === "demo-api")!.fix).toMatch(/delete/i);
    const f = runDoctor(root, { fix: true });
    expect(statusOf(f, "cache", "demo-api")).toBe("fixed");
    expect(existsSync(fp)).toBe(false);
    // graph.json is still there, so the repo is indexed: only the local record is gone
    const index = f.items.find((i) => i.check === "index" && i.repo === "demo-api")!;
    expect(index.status).toBe("warn");
    expect(index.message).toContain("no local index record — run codeloom index");
    expect(f.items.map((i) => i.message).join("\n")).not.toMatch(/not indexed on this machine/);
  });

  it("an outdated cache context is one non-fixable index warn; --fix keeps the cache", async () => {
    const root = shop();
    const fp = join(root, "web", ".codeloom", "fingerprints.json");
    const data = JSON.parse(readFileSync(fp, "utf8"));
    writeJsonAtomic(fp, { ...data, contextKey: "stale-format-key" });
    const r = runDoctor(root, {});
    expect(nonOk(r).map((i) => [i.check, i.repo, i.status, i.fix])).toEqual([["index", "demo-web", "warn", undefined]]);
    expect(nonOk(r)[0]!.message).toContain('cache will be rebuilt on the next "codeloom index"');
    const f = runDoctor(root, { fix: true });
    expect(f.summary.fixed).toBe(0);
    expect(existsSync(fp)).toBe(true);
  });

  it("a new dependency (committed) gives one warn, and --fix does not delete the cache", async () => {
    const root = shop();
    const pkgPath = join(root, "api", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies["left-pad"] = "^1.3.0";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    commitAll(join(root, "api"));
    const fp = join(root, "api", ".codeloom", "fingerprints.json");
    const r = runDoctor(root, {});
    const bad = nonOk(r);
    expect(bad.map((i) => [i.check, i.repo, i.status])).toEqual([["index", "demo-api", "warn"]]);
    expect(bad[0]!.fix).toBeUndefined();
    expect(bad[0]!.message).toContain('cache will be rebuilt on the next "codeloom index"');
    const f = runDoctor(root, { fix: true });
    expect(f.summary.fixed).toBe(0);
    expect(existsSync(fp)).toBe(true);
  });

  it("reports an invalid journeys.json as an error, leaves it untouched with --fix, exit 1", async () => {
    const root = shop();
    const path = join(root, ".codeloom", "journeys.json");
    writeFileSync(path, '{ "version": 1, "journeys": [{ "id": "bad" }] }');
    const text = readFileSync(path, "utf8");
    const r = runDoctor(root, { fix: true });
    expect(statusOf(r, "journeys")).toBe("error");
    expect(r.items.find((i) => i.check === "journeys")!.fix).toBeUndefined();
    expect(r.items.find((i) => i.check === "journeys")!.message).toMatch(/by hand/);
    expect(readFileSync(path, "utf8")).toBe(text);
    const { code, out } = await cli(root, ["--fix"]);
    expect(code).toBe(1);
    expect(out).toMatch(/1 error\b/);
  });

  it("reports duplicate journey ids as an error", async () => {
    const root = shop();
    const path = join(root, ".codeloom", "journeys.json");
    const j = { id: "j_0123456789ab", name: "Sign up", area: "", note: "", chainIds: [], status: "ok" };
    writeJsonAtomic(path, { version: 1, journeys: [j, { ...j, name: "Sign up again" }] });
    const text = readFileSync(path, "utf8");
    const r = runDoctor(root, { fix: true });
    expect(statusOf(r, "journeys")).toBe("error");
    expect(r.items.find((i) => i.check === "journeys")!.message).toMatch(/duplicate journey id j_0123456789ab/);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect((await cli(root, [])).code).toBe(1);
  });

  it("reports a corrupt progress file as an error and never touches it, even with --fix", () => {
    const root = shop();
    const ws = loadWorkspace(root);
    const path = progressPath({ root, name: ws.name, repos: ws.repos.map((ref) => ({ ref, abs: join(root, ref.path) })) });
    expect(statusOf(runDoctor(root, {}), "progress")).toBe("ok");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ nope");
    const r = runDoctor(root, { fix: true });
    const item = r.items.find((i) => i.check === "progress")!;
    expect(item.status).toBe("error");
    expect(item.message).toContain(path);
    expect(item.fix).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("{ nope");
    rmSync(path);
  });

  it("checks tours: valid, stale stops counted, invalid files reported", () => {
    const root = shop();
    expect(r0(root)).toMatchObject({ status: "ok", message: "no tours yet" });
    const ws = loadWorkspace(root);
    const repos = ws.repos.map((ref) => ({ ref, abs: join(root, ref.path) }));
    const key = stopKey({ lane: "code", repo: "demo-api", file: "package.json", line: 1, symbol: "x" });
    const check = [1, 2, 3].map((n) => ({ question: `q${n}`, expected: ["p"] }));
    writeTour(root, "j_0123456789ab", {
      stops: [{ chainId: "ch_x", stopIndex: 0, key, explanation: "" }],
      dataJourney: { input: "", steps: [], output: "" },
      fileNotes: [],
      check,
    }, { ws: { repos } });
    expect(r0(root)).toMatchObject({ status: "ok", message: "1 tour" });
    writeFileSync(join(root, "api", "package.json"), readFileSync(join(root, "api", "package.json"), "utf8") + "\n");
    const stale = r0(root);
    expect(stale.status).toBe("warn");
    expect(stale.message).toMatch(/j_0123456789ab: 1 stop may be out of date/);
    writeFileSync(join(root, ".codeloom", "tours", "j_00000000beef.json"), "{}");
    const r = runDoctor(root, { fix: true });
    const bad = r.items.filter((i) => i.check === "tours" && i.status === "error");
    expect(bad).toHaveLength(1);
    expect(bad[0]!.message).toContain("j_00000000beef.json");
    expect(readFileSync(join(root, ".codeloom", "tours", "j_00000000beef.json"), "utf8")).toBe("{}");
  });

  it("warns about orphaned journeys, naming them", async () => {
    const root = shop();
    const path = join(root, ".codeloom", "journeys.json");
    writeJsonAtomic(path, {
      version: 1,
      journeys: [{ id: "j_0123456789ab", name: "Old checkout", area: "", note: "", chainIds: ["ch_gone"], status: "orphaned" }],
    });
    const r = runDoctor(root, {});
    const item = r.items.find((i) => i.check === "journeys" && i.status === "warn")!;
    expect(item.message).toContain("Old checkout");
    expect(item.fix).toBeUndefined();
  });

  it("reports an endpoints v1 file as an error", async () => {
    const root = shop();
    writeJsonAtomic(join(root, "api", ".codeloom", "endpoints.json"), { version: 1, routes: [] });
    const r = runDoctor(root, { fix: true });
    expect(statusOf(r, "endpoints", "demo-api")).toBe("error");
    expect(r.items.find((i) => i.check === "endpoints" && i.repo === "demo-api")!.message).toMatch(/codeloom index/);
    expect(JSON.parse(readFileSync(join(root, "api", ".codeloom", "endpoints.json"), "utf8")).version).toBe(1);
  });

  it("reports an invalid config, summaries and workspace file as errors, never fixed", async () => {
    const root = shop();
    writeJsonAtomic(join(root, "web", ".codeloom", "config.json"), { version: 1 });
    writeJsonAtomic(join(root, "web", ".codeloom", "summaries.json"), { version: 9 });
    const before = hashTree(root);
    const r = runDoctor(root, { fix: true });
    expect(statusOf(r, "config", "demo-web")).toBe("error");
    expect(statusOf(r, "summaries", "demo-web")).toBe("error");
    expect(hashTree(root)).toEqual(before);

    writeFileSync(join(root, "codeloom.workspace.json"), "{ nope");
    const w = runDoctor(root, { fix: true });
    expect(statusOf(w, "workspace")).toBe("error");
    expect(readFileSync(join(root, "codeloom.workspace.json"), "utf8")).toBe("{ nope");
  });

  it("an unusable .mcp.json says which problem it has: not valid JSON vs mcpServers not an object", () => {
    const root = shop();
    const mcpItem = () => runDoctor(root, {}).items.find((i) => i.check === "mcp")!;
    writeFileSync(join(root, ".mcp.json"), "{ nope");
    expect(mcpItem().status).toBe("error");
    expect(mcpItem().message).toContain(".mcp.json is not valid JSON");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: "nope" }));
    expect(mcpItem().status).toBe("error");
    expect(mcpItem().message).toContain('"mcpServers" in .mcp.json is not an object');
    expect(mcpItem().message).not.toContain("not valid JSON");
    writeFileSync(join(root, ".mcp.json"), "[1, 2]");
    expect(mcpItem().message).toContain(".mcp.json is not a JSON object");
  });

  it("an invalid workspace file is hand-written: fix by hand, never delete; per-repo checks are skipped", () => {
    const root = shop();
    writeJsonAtomic(join(root, "codeloom.workspace.json"), { version: 1, name: "x", repos: "nope" });
    const r = runDoctor(root, {});
    const ws = r.items.filter((i) => i.check === "workspace");
    expect(ws[0]!.status).toBe("error");
    expect(ws[0]!.message).toMatch(/by hand/);
    expect(ws[0]!.message).not.toMatch(/[Dd]elete it|run "codeloom index"/);
    expect(ws.some((i) => /per-repo checks .*skipped until .*codeloom\.workspace\.json.* fixed/.test(i.message))).toBe(true);
    expect(r.items.some((i) => i.repo !== undefined)).toBe(false);
    // loadWorkspace (index, serve, check, ...) says the same
    let message = "";
    try {
      loadWorkspace(root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/by hand/);
    expect(message).not.toMatch(/[Dd]elete it|run "codeloom index"/);
  });

  it("a folder with no workspace and no git repo: a clear error, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-nothing-"));
    const r = runDoctor(dir, {});
    expect(r.items.map((i) => [i.check, i.status])).toEqual([["git", "ok"], ["workspace", "error"]]);
    expect(r.items[1]!.message).toMatch(/No codeloom workspace or git repo found/);
    const { code, out } = await cli(dir, []);
    expect(code).toBe(1);
    expect(out).toMatch(/No codeloom workspace or git repo found/);
  });

  it("warns about an un-indexed repo", () => {
    const repo = makeRepo({ "package.json": '{ "name": "solo" }', "src/a.ts": "export const a = 1;\n" });
    const r = runDoctor(repo, {});
    expect(statusOf(r, "workspace")).toBe("warn");
    expect(r.items.find((i) => i.check === "workspace")!.message).toMatch(/codeloom init/);
    expect(statusOf(r, "graph", "solo")).toBe("warn");
    expect(statusOf(r, "endpoints", "solo")).toBe("warn");
    expect(statusOf(r, "index", "solo")).toBe("warn");
    expect(statusOf(r, "chains")).toBe("warn");
    expect(r.summary.error).toBe(0);
  });

  it("changes no file without --fix", async () => {
    const root = shop();
    rmSync(join(root, "api", ".git", "hooks", "post-commit"));
    rmSync(join(root, ".mcp.json"));
    rmSync(join(root, "web", ".codeloom", "config.json"));
    writeFileSync(join(root, "billing", ".codeloom", "fingerprints.json"), "garbage");
    const before = hashTree(root);
    expect(Object.keys(before)).toContain("/api/.git/index");
    const r = runDoctor(root, {});
    expect(r.summary.warn).toBeGreaterThanOrEqual(4);
    expect(hashTree(root)).toEqual(before);
  });

  it("leaves .git/index alone when the copied repos have stale stat info (no --fix)", () => {
    const root = shop();
    const before = hashTree(root);
    for (const r of REPOS) expect(Object.keys(before)).toContain(`/${r}/.git/index`);
    runDoctor(root, {});
    expect(hashTree(root)).toEqual(before);
  });

  it("prints a JSON report with --json that matches the report shape", async () => {
    const { out, code } = await cli(healthy, ["--json"]);
    expect(code).toBe(0);
    const parsed = ReportShape.parse(JSON.parse(out));
    expect(parsed.summary.ok).toBe(parsed.items.length);
  });

  it("text output groups non-ok items by check and prints the summary line", async () => {
    const root = shop();
    rmSync(join(root, "api", ".git", "hooks", "post-commit"));
    rmSync(join(root, "web", ".git", "hooks", "post-commit"));
    const text = formatDoctor(runDoctor(root, {}));
    expect(text).toMatch(/hook/);
    expect(text).toMatch(/demo-api: post-commit hook not installed/);
    expect(text).toMatch(/demo-web: post-commit hook not installed/);
    expect(text).toMatch(/\d+ ok, 2 warnings, 0 errors, 0 fixed/);
    expect(text).toContain('Run "codeloom doctor --fix" to repair 2 items.');
  });
});

describe("codeloom doctor: can the hook run codeloom? (H7)", () => {
  const EMPTY_PATH = mkdtempSync(join(tmpdir(), "codeloom-doctor-emptypath-"));
  const hookItem = (repo: string, opts: Parameters<typeof runDoctor>[1]) =>
    runDoctor(repo, opts).items.find((i) => i.check === "hook")!;

  it("ok while the bin the hook names exists", () => {
    const repo = makeRepo({ "a.ts": "" });
    runInit(repo, { bin: fakeBin() });
    expect(hookItem(repo, { pathEnv: EMPTY_PATH })).toMatchObject({ status: "ok" });
  });

  it("warns when the hook's bin is gone and codeloom is not on PATH; --fix points the hook at the current bin", () => {
    const repo = makeRepo({ "a.ts": "" });
    const gone = fakeBin();
    runInit(repo, { bin: gone });
    rmSync(gone);
    const item = hookItem(repo, { pathEnv: EMPTY_PATH });
    expect(item.status).toBe("warn");
    expect(item.message).toContain(`post-commit hook cannot run codeloom: ${gone} is missing and codeloom is not on PATH`);
    expect(item.fix).toBeUndefined(); // without a current bin there is nothing to point it at

    const now = fakeBin();
    expect(hookItem(repo, { pathEnv: EMPTY_PATH, bin: now }).fix).toBe("point the hook at " + now);
    expect(hookItem(repo, { pathEnv: EMPTY_PATH, bin: now, fix: true })).toMatchObject({ status: "fixed" });
    const body = readFileSync(join(repo, ".git/hooks/post-commit"), "utf8");
    expect(body).toContain(`${shellQuote(now)} index --quiet`);
    expect(body).not.toContain(gone);
    expect(body.split(HOOK_MARK).length - 1).toBe(1);
    expect(hookItem(repo, { pathEnv: EMPTY_PATH })).toMatchObject({ status: "ok" });
  });

  it("ok when the bin is gone but codeloom is on PATH", () => {
    const repo = makeRepo({ "a.ts": "" });
    const gone = fakeBin();
    runInit(repo, { bin: gone });
    rmSync(gone);
    const onPath = fakeBin("codeloom");
    expect(hookItem(repo, { pathEnv: `${EMPTY_PATH}:${join(onPath, "..")}` })).toMatchObject({ status: "ok" });
  });

  it("warns when a PATH-only hook finds no codeloom on PATH", () => {
    const repo = makeRepo({ "a.ts": "" });
    runInit(repo);
    const item = hookItem(repo, { pathEnv: EMPTY_PATH });
    expect(item.status).toBe("warn");
    expect(item.message).toContain("post-commit hook cannot run codeloom: codeloom is not on PATH");
  });
});
