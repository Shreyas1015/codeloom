import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeEval } from "./helpers.js";

describe("materializeEval", () => {
  it("copies fixtures/evals/<app> to a temp dir and git-inits every repo in its workspace file", () => {
    const root = materializeEval("realworld");
    const ws = JSON.parse(readFileSync(join(root, "codeloom.workspace.json"), "utf8")) as { repos: Array<{ path: string }> };
    expect(ws.repos.length).toBeGreaterThan(0);
    for (const repo of ws.repos) {
      const repoAbs = join(root, repo.path);
      expect(existsSync(join(repoAbs, ".git"))).toBe(true);
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoAbs, encoding: "utf8" });
      expect(status.trim()).toBe("");
    }
    expect(existsSync(join(root, "expected-journeys.json"))).toBe(true);
  });
});
