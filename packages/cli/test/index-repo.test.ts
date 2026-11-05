import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { indexRepo } from "../src/indexer/index-repo.js";
import { effectiveRoutes } from "../src/linker/mounts.js";
import { readJson } from "../src/store/json.js";
import { EndpointsFileSchema } from "../src/store/schemas.js";
import { commitAll, makeRepo } from "./helpers.js";

const files = {
  "package.json": JSON.stringify({ dependencies: { express: "^4" } }),
  "src/server.ts": `import express from "express";\nconst app = express();\napp.get("/health", (_q, r) => r.json({}));`,
  "src/util.ts": `export function add(a: number, b: number) { return a + b; }`,
  "big.ts": `export const x = "${"a".repeat(1_100_000)}";`,
};

describe("indexRepo", () => {
  it("writes graph, endpoints and cache, and skips huge files", async () => {
    const repo = makeRepo(files);
    const res = await indexRepo(repo, "svc");
    expect(res.stats.files).toBe(4);
    expect(res.stats.parsed).toBe(3);
    expect(res.stats.reused).toBe(0);
    expect(res.stats.skipped).toEqual([{ file: "big.ts", reason: expect.stringContaining("larger than 1 MB") }]);
    for (const f of ["graph.json", "endpoints.json", "fingerprints.json"]) expect(existsSync(join(repo, ".codeloom", f))).toBe(true);
    const ep = readJson(join(repo, ".codeloom", "endpoints.json"), EndpointsFileSchema)!;
    expect(ep.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /health"]);
  });

  it("re-parses only changed files", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    const again = await indexRepo(repo, "svc");
    expect(again.stats.parsed).toBe(0);
    expect(again.stats.reused).toBe(3);
    writeFileSync(join(repo, "src/util.ts"), `export function add(a: number, b: number) { return b + a; }`);
    const third = await indexRepo(repo, "svc");
    expect(third.stats.parsed).toBe(1);
    expect(third.stats.reused).toBe(2);
  });

  it("re-parses everything when dependencies change", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { express: "^4", pg: "^8" } }));
    const res = await indexRepo(repo, "svc");
    expect(res.stats.reused).toBe(0);
  });

  it("re-parses everything when the codeloom version changes", async () => {
    const repo = makeRepo(files);
    const first = await indexRepo(repo, "svc", { codeloomVersion: "1.0.0" });
    const second = await indexRepo(repo, "svc", { codeloomVersion: "1.0.1" });
    expect(second.stats.reused).toBe(0);
    expect(second.stats.parsed).toBe(first.stats.parsed);
  });

  it("gives a clear error naming the repo for a broken .git file, instead of a stack trace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "codeloom-brokengit-"));
    writeFileSync(join(repo, ".git"), "gitdir: /nonexistent\n");
    await expect(indexRepo(repo, "svc")).rejects.toThrow(CodeloomError);
    await expect(indexRepo(repo, "svc")).rejects.toThrow(/svc/);
  });

  it("builds a per-repo code index for JS/TS files only", async () => {
    const repo = makeRepo(files);
    const res = await indexRepo(repo, "svc");
    expect([...res.codeIndex.keys()].sort()).toEqual(["src/server.ts", "src/util.ts"]);
    expect(res.codeIndex.get("src/util.ts")?.symbols.map((s) => s.name)).toEqual(["add"]);
    expect(res.files.has("package.json")).toBe(true);
    expect(res.aliases).toEqual([]);
  });

  it("keeps the code index after a cache hit and after a cold cache rebuild", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    const reused = await indexRepo(repo, "svc");
    expect(reused.stats.reused).toBe(3);
    expect(reused.codeIndex.get("src/util.ts")?.symbols.map((s) => s.name)).toEqual(["add"]);
    rmSync(join(repo, ".codeloom/fingerprints.json"));
    const cold = await indexRepo(repo, "svc");
    expect(cold.codeIndex.get("src/util.ts")?.symbols.map((s) => s.name)).toEqual(["add"]);
  });
});

describe("indexRepo cache guard", () => {
  // A record missing the key entirely fails the schema (whole cache discarded); `null` passes
  // `z.any()`, so the per-file guard is what keeps it from reaching the linker.
  it("rebuilds a file's code index when a cache hit has no codeIndex", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    const cache = join(repo, ".codeloom/fingerprints.json");
    const fp = JSON.parse(readFileSync(cache, "utf8"));
    fp.files["src/util.ts"].codeIndex = null;
    writeFileSync(cache, JSON.stringify(fp));
    const res = await indexRepo(repo, "svc");
    expect(res.codeIndex.get("src/util.ts")?.symbols.map((s) => s.name)).toEqual(["add"]);
    expect(res.stats.parsed).toBe(1);
    expect(res.stats.reused).toBe(2);
  });
});

describe("indexRepo determinism (committed files depend only on code)", () => {
  it("writes byte-identical graph.json and endpoints.json on a second run, leaving git clean", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    writeFileSync(join(repo, ".gitignore"), ".codeloom/fingerprints.json\n");
    commitAll(repo);
    const graph1 = readFileSync(join(repo, ".codeloom/graph.json"), "utf8");
    const ep1 = readFileSync(join(repo, ".codeloom/endpoints.json"), "utf8");
    await new Promise((r) => setTimeout(r, 20));
    await indexRepo(repo, "svc");
    expect(readFileSync(join(repo, ".codeloom/graph.json"), "utf8")).toBe(graph1);
    expect(readFileSync(join(repo, ".codeloom/endpoints.json"), "utf8")).toBe(ep1);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toBe("");
  });

  it("keeps time and commit out of committed files and stores them in the cache", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    const ep = JSON.parse(readFileSync(join(repo, ".codeloom/endpoints.json"), "utf8"));
    expect(ep).not.toHaveProperty("generatedAt");
    const graph = JSON.parse(readFileSync(join(repo, ".codeloom/graph.json"), "utf8"));
    expect(graph.project.analyzedAt).toBe("");
    expect(graph.project.gitCommitHash).toBe("");
    const fp = JSON.parse(readFileSync(join(repo, ".codeloom/fingerprints.json"), "utf8"));
    expect(fp.version).toBe(2);
    expect(Number.isNaN(Date.parse(fp.indexedAt))).toBe(false);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(fp.gitCommitHash).toBe(head);
  });

  it("is deterministic across a cold cache (fingerprints.json deleted between runs)", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    const graph1 = readFileSync(join(repo, ".codeloom/graph.json"), "utf8");
    const ep1 = readFileSync(join(repo, ".codeloom/endpoints.json"), "utf8");
    rmSync(join(repo, ".codeloom/fingerprints.json"));
    await indexRepo(repo, "svc");
    expect(readFileSync(join(repo, ".codeloom/graph.json"), "utf8")).toBe(graph1);
    expect(readFileSync(join(repo, ".codeloom/endpoints.json"), "utf8")).toBe(ep1);
  });

  it("prunes a deleted file from the cache", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    rmSync(join(repo, "src/util.ts"));
    await indexRepo(repo, "svc");
    const fp = JSON.parse(readFileSync(join(repo, ".codeloom/fingerprints.json"), "utf8"));
    expect(Object.keys(fp.files)).not.toContain("src/util.ts");
    expect(Object.keys(fp.files)).toContain("src/server.ts");
  });

  it("silently rebuilds a cache that is corrupt, wrong-shape or from an older format", async () => {
    const repo = makeRepo(files);
    await indexRepo(repo, "svc");
    const cache = join(repo, ".codeloom/fingerprints.json");
    for (const bad of ["{ nope", JSON.stringify({ version: 1, contextKey: "x", files: {} }), JSON.stringify({ version: 2 })]) {
      writeFileSync(cache, bad);
      const res = await indexRepo(repo, "svc");
      expect(res.stats.reused).toBe(0);
      expect(res.stats.parsed).toBe(3);
      expect(JSON.parse(readFileSync(cache, "utf8")).version).toBe(2);
    }
  });
});

describe("indexRepo in a monorepo", () => {
  const mono = {
    "package.json": JSON.stringify({ private: true, devDependencies: { typescript: "^5" } }),
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15", react: "^19" } }),
    "apps/web/app/orders/page.tsx": "export default function Page() { return null; }",
    "apps/api/package.json": JSON.stringify({ dependencies: { express: "^4" } }),
    "apps/api/src/server.ts": `import express from "express";\nconst app = express();\napp.get("/orders", (_q, r) => r.json([]));`,
    "apps/spa/package.json": JSON.stringify({ dependencies: { react: "^19", vite: "^5" } }),
    "apps/spa/src/pages/Dashboard.tsx": "export default function Dashboard() { return null; }",
    "packages/app/package.json": JSON.stringify({ dependencies: { next: "^15" } }),
    "packages/app/src/app/dashboard/page.tsx": "export default function Page() { return null; }",
  };

  it("applies each package's own frameworks and package-relative paths", async () => {
    const res = await indexRepo(makeRepo(mono), "mono");
    expect(res.endpoints.routes.map((r) => `${r.method} ${r.path} [${r.framework}]`)).toEqual(["GET /orders [express]"]);
    expect(res.endpoints.pages.map((p) => `${p.route} ${p.file}`)).toEqual([
      "/dashboard packages/app/src/app/dashboard/page.tsx",
      "/orders apps/web/app/orders/page.tsx",
    ]);
  });

  it("re-parses when a nested package's deps change", async () => {
    const repo = makeRepo(mono);
    await indexRepo(repo, "mono");
    writeFileSync(join(repo, "apps/spa/package.json"), JSON.stringify({ dependencies: { react: "^19", next: "^15" } }));
    const res = await indexRepo(repo, "mono");
    expect(res.stats.reused).toBe(0);
    expect(res.endpoints.pages.map((p) => p.route)).toContain("/Dashboard");
  });

  it("keeps each package's own main app known, even when two packages share a top-level directory (review finding: packageOf used the top-level dir, not the real package root)", async () => {
    // packages/a/src/index.ts and packages/b/src/index.ts both sit directly under "packages/", which is
    // exactly what the old directory-based grouping conflated into one "package" — counting two apps there
    // and marking both unknown. Each has its own package.json, so detectRouters now stamps the real
    // package root (AdapterContext.packageRoot) onto its RouterDef and isMainApp groups by that instead.
    // Both apps are exported (e.g. for supertest, same as other "exported only for tests" cases in
    // router-mounts.test.ts) so this exercises isMainApp's per-package counting rather than the separate
    // "unexported, so trivially known" shortcut.
    const repo = makeRepo({
      "package.json": JSON.stringify({ private: true }),
      "packages/a/package.json": JSON.stringify({ dependencies: { express: "^4" } }),
      "packages/a/src/index.ts": `import express from "express";\nconst api = express();\napi.get("/health", (_q, r) => r.json({}));\nexport default api;`,
      "packages/b/package.json": JSON.stringify({ dependencies: { express: "^4" } }),
      "packages/b/src/index.ts": `import express from "express";\nconst worker = express();\nworker.get("/health", (_q, r) => r.json({}));\nexport default worker;`,
    });
    const res = await indexRepo(repo, "mono");
    const effs = effectiveRoutes(res.endpoints);
    expect(effs).toHaveLength(2);
    expect(effs.every((e) => e.mountsKnown)).toBe(true);
  });

  it("keeps a bundled file as a file node but gives it no code index, call edges or endpoints", async () => {
    const bundle = [
      `var __commonJS = (cb, mod) => function () { return mod; };`,
      `var require_app = __commonJS({ "app.js"(exports, module) {`,
      `  const express = require("express"); const app = express();`,
      `  app.get("/bundled", (_q, r) => r.json({}));`,
      `  module.exports = class { save() { return this.check(); } check() { return 1; } };`,
      `} });`,
      `function boot() { return start(); }`,
      `function start() { return 1; }`,
    ].join("\n");
    const repo = makeRepo({ ...files, "tools/run-bundle.cjs": bundle, "src/hooks.js": bundle.replaceAll("__commonJS", "commonJs") });
    const res = await indexRepo(repo, "svc");
    const B = "tools/run-bundle.cjs";
    expect(res.graph.nodes.some((n) => n.id === `file:${B}`)).toBe(true);
    expect(res.codeIndex.get(B)).toEqual({ symbols: [], imports: [], reExports: [], classFields: [], localNews: [], calls: [] });
    expect(res.graph.edges.some((e) => e.type === "calls" && e.source.includes(B))).toBe(false);
    expect(res.endpoints.routes.filter((r) => r.path === "/bundled").map((r) => r.at.file)).toEqual(["src/hooks.js"]);
    expect(res.stats.skipped.some((s) => s.file === B)).toBe(false);
    // a near-identical file without the bundler marker is analysed as normal
    expect(res.codeIndex.get("src/hooks.js")!.symbols.length).toBeGreaterThan(0);
  });
});
