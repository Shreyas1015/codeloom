import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverRepos, gitHead, loadWorkspace, repoIdFor } from "../src/workspace/repos.js";
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

describe("stable repo ids (final review batch 2, item C)", () => {
  it("uses the package.json name, sanitized: @acme/web -> acme-web, ':' and '#' -> '-'", () => {
    expect(repoIdFor("@acme/web", "folder")).toBe("acme-web");
    expect(repoIdFor("a:b#c", "folder")).toBe("a-b-c");
    expect(repoIdFor(undefined, "folder")).toBe("folder");
    expect(repoIdFor("  ", "fo:ld#er")).toBe("fo-ld-er");
  });

  it("single repo: id = package.json name, not the folder name", () => {
    const repo = makeRepo({ "package.json": JSON.stringify({ name: "shop" }) });
    expect(discoverRepos(repo)).toEqual([{ id: "shop", path: "." }]);
  });

  it("no package.json (or no name) -> folder name", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "package.json": "{}" }, join(root, "api"));
    makeRepo({ "package.json": "not json" }, join(root, "bad"));
    expect(discoverRepos(root).map((r) => r.id)).toEqual(["api", "bad", "web"]);
  });

  it("scoped names in a workspace; collisions get -2, -3 by path order", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
    makeRepo({ "package.json": JSON.stringify({ name: "@acme/web" }) }, join(root, "frontend"));
    makeRepo({ "package.json": JSON.stringify({ name: "shop" }) }, join(root, "b-shop"));
    makeRepo({ "package.json": JSON.stringify({ name: "shop" }) }, join(root, "a-shop"));
    makeRepo({ "package.json": JSON.stringify({ name: "shop" }) }, join(root, "c-shop"));
    expect(discoverRepos(root)).toEqual([
      { id: "acme-web", path: "frontend" },
      { id: "shop", path: "a-shop" },
      { id: "shop-2", path: "b-shop" },
      { id: "shop-3", path: "c-shop" },
    ]);
  });

  it("a suffixed id never collides with a real name", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
    makeRepo({ "package.json": JSON.stringify({ name: "shop" }) }, join(root, "a"));
    makeRepo({ "package.json": JSON.stringify({ name: "shop" }) }, join(root, "b"));
    makeRepo({ "package.json": JSON.stringify({ name: "shop-2" }) }, join(root, "c"));
    const ids = discoverRepos(root).map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("shop");
    expect(ids).toContain("shop-2");
  });

  it("loadWorkspace with no workspace file uses the package.json name too", () => {
    const repo = makeRepo({ "package.json": JSON.stringify({ name: "@acme/web" }), "src/a.ts": "" });
    const ws = loadWorkspace(join(repo, "src"));
    expect(ws.repos).toEqual([{ id: "acme-web", path: "." }]);
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
