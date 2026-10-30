import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_MARK, runInit } from "../src/commands/init.js";
import { CodeloomError } from "../src/errors.js";
import { makeRepo } from "./helpers.js";

describe("codeloom init", () => {
  it("sets up a folder of repos as a workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));
    const res = runInit(root);

    expect(res.repos.map((r) => r.id)).toEqual(["api", "web"]);
    const ws = JSON.parse(readFileSync(join(root, "codeloom.workspace.json"), "utf8"));
    expect(ws).toEqual({ version: 1, name: expect.any(String), repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [] });
    for (const repo of ["api", "web"]) {
      expect(JSON.parse(readFileSync(join(root, repo, ".codeloom/config.json"), "utf8"))).toEqual({ version: 1, autoUpdate: true, ignore: [] });
      const hook = join(root, repo, ".git/hooks/post-commit");
      expect(readFileSync(hook, "utf8")).toContain(HOOK_MARK);
      expect(statSync(hook).mode & 0o111).not.toBe(0);
      expect(readFileSync(join(root, repo, ".gitignore"), "utf8")).toContain(".codeloom/fingerprints.json");
    }
  });

  it("is safe to run twice", () => {
    const repo = makeRepo({ "a.ts": "" });
    runInit(repo);
    const second = runInit(repo);
    expect(second.created).toEqual([]);
    const hook = readFileSync(join(repo, ".git/hooks/post-commit"), "utf8");
    expect(hook.split(HOOK_MARK).length - 1).toBe(1);
  });

  it("does not write a workspace file for a single repo", () => {
    const repo = makeRepo({ "a.ts": "" });
    const res = runInit(repo);
    expect(res.created).not.toContain("codeloom.workspace.json");
  });

  it("explains when there are no repos", () => {
    const empty = mkdtempSync(join(tmpdir(), "codeloom-empty-"));
    expect(() => runInit(empty)).toThrow(CodeloomError);
    expect(() => runInit(empty)).toThrow(/No git repos found/);
  });
});
