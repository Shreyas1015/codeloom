import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverRepos, gitHead, loadWorkspace } from "../src/workspace/repos.js";
import { listFiles } from "../src/workspace/files.js";
import { commitAll, makeRepo } from "./helpers.js";

describe("discoverRepos", () => {
  it("treats a repo as a single-repo workspace", () => {
    const repo = makeRepo({ "a.ts": "export const a = 1;" });
    expect(discoverRepos(repo)).toEqual([{ id: basename(repo), path: "." }]);
  });

  it("finds child repos in a parent folder, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));
    mkdirSync(join(root, "notes"));
    expect(discoverRepos(root)).toEqual([
      { id: "api", path: "api" },
      { id: "web", path: "web" },
    ]);
  });
});

describe("discoverRepos ordering (final review item 5)", () => {
  it("sorts repo ids by code point (util.compare), never by locale", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
    makeRepo({ "a.ts": "" }, join(root, "alpha"));
    makeRepo({ "b.ts": "" }, join(root, "Zeta"));
    expect(discoverRepos(root).map((r) => r.id)).toEqual(["Zeta", "alpha"]);
  });
});

describe("loadWorkspace", () => {
  it("uses the workspace file when present", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "shop", repos: [{ id: "web", path: "web" }], links: [] }),
    );
    const ws = loadWorkspace(join(root, "web"));
    expect(ws).toEqual({ root, name: "shop", repos: [{ id: "web", path: "web" }], links: [], traces: undefined });
  });

  it("falls back to the git repo around the start folder", () => {
    const repo = makeRepo({ "src/a.ts": "" });
    const ws = loadWorkspace(join(repo, "src"));
    expect(ws.repos).toEqual([{ id: basename(repo), path: "." }]);
  });
});

describe("listFiles", () => {
  it("skips symlinks, keeping only regular files", () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;" });
    symlinkSync("a.ts", join(repo, "src/link.ts"));
    symlinkSync("src", join(repo, "srclink"));
    commitAll(repo);
    expect(listFiles(repo)).toEqual(["src/a.ts"]);
  });

  it("respects .gitignore, default ignores and .codeloom", () => {
    const repo = makeRepo({
      ".gitignore": "secret.txt\n",
      "src/a.ts": "export const a = 1;",
      "secret.txt": "x",
      "dist/out.js": "x",
      "logo.png": "x",
      ".codeloom/graph.json": "{}",
    });
    writeFileSync(join(repo, "src/new.ts"), "export const n = 1;"); // untracked, still listed
    expect(listFiles(repo)).toEqual(["src/a.ts", "src/new.ts"]);
  });

  it("applies extra ignore patterns", () => {
    const repo = makeRepo({ "src/a.ts": "", "scripts/b.ts": "" });
    expect(listFiles(repo, ["scripts/"])).toEqual(["src/a.ts"]);
  });
});

describe("gitHead", () => {
  it("returns the commit hash", () => {
    expect(gitHead(makeRepo({ "a.ts": "" }))).toMatch(/^[0-9a-f]{40}$/);
  });
});
