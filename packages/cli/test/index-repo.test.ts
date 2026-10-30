import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer/index-repo.js";
import { readJson } from "../src/store/json.js";
import { EndpointsFileSchema } from "../src/store/schemas.js";
import { makeRepo } from "./helpers.js";

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
});
