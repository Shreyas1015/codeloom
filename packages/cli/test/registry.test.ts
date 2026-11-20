import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoGroup, clearSshHostCache, groupAtDataRoot, groupRoot, groupSlug, groupWorkspace, normalizeRegistry, parseRemote, planRegistration,
  readRemote, type RegistryFile, repoAbsPath,
} from "../src/workspace/registry.js";
import { makeRepo } from "./helpers.js";

const empty = (): RegistryFile => ({ version: 1, repos: [] });
const remote = (name: string, owner = "demo-shop") => ({ host: "github.com", owner, name });

describe("parseRemote", () => {
  it("reads host, owner and name from every common URL shape, without credentials", () => {
    expect(parseRemote("git@github.com:Demo-Shop/web.git")).toEqual({ host: "github.com", owner: "demo-shop", name: "web" });
    expect(parseRemote("https://github.com/demo-shop/api")).toEqual({ host: "github.com", owner: "demo-shop", name: "api" });
    expect(parseRemote("https://user:secret@bitbucket.org/demo-shop/billing.git")).toEqual({ host: "bitbucket.org", owner: "demo-shop", name: "billing" });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/demo-shop/tools/web.git")).toEqual({ host: "gitlab.example.com", owner: "demo-shop", name: "tools/web" });
    expect(parseRemote("git://github.com/demo-shop/web.git/")).toEqual({ host: "github.com", owner: "demo-shop", name: "web" });
  });

  it("gives no remote for local paths and file URLs", () => {
    expect(parseRemote("/srv/git/web.git")).toBeNull();
    expect(parseRemote("../web")).toBeNull();
    expect(parseRemote("file:///srv/git/web.git")).toBeNull();
    expect(parseRemote("C:/repos/web")).toBeNull();
    expect(parseRemote("")).toBeNull();
  });
});

describe("groups and registration", () => {
  it("groups by remote host + owner, else by parent folder name", () => {
    expect(autoGroup("/x/y/web", remote("web"))).toEqual({ group: "github.com/demo-shop", from: "remote" });
    expect(autoGroup("/x/shop-repos/web", null)).toEqual({ group: "shop-repos", from: "folder" });
    expect(groupSlug("github.com/demo-shop")).toBe("github.com-demo-shop");
  });

  it("makes ids unique inside a group and keeps an id once given", () => {
    const a = planRegistration(empty(), "/r/one/api", { baseId: "api", remote: remote("api") });
    const b = planRegistration(a.registry, "/r/two/api", { baseId: "api", remote: remote("api-v2") });
    expect(b.entry.id).toBe("api-2");
    const again = planRegistration(b.registry, "/r/two/api", { baseId: "api", remote: remote("api-v2") });
    expect(again.entry.id).toBe("api-2");
    // Another owner is another group: no clash there.
    const other = planRegistration(b.registry, "/r/three/api", { baseId: "api", remote: remote("api", "someone-else") });
    expect(other.entry).toMatchObject({ id: "api", group: "github.com/someone-else" });
  });

  it("treats checkouts of one remote as copies: the newest indexed is the group's copy", () => {
    const t0 = new Date("2026-11-01T00:00:00Z");
    const t1 = new Date("2026-11-02T00:00:00Z");
    const a = planRegistration(empty(), "/r/a/web", { baseId: "demo-web", remote: remote("web"), now: t0 });
    const b = planRegistration(a.registry, "/r/b/web-copy", { baseId: "web-copy", remote: remote("web"), now: t1 });
    expect(b.entry.id).toBe("demo-web");
    expect(b.copies).toEqual(["/r/a/web"]);
    const old = b.registry.repos.find((e) => e.path === "/r/a/web")!;
    expect(old.copyOf).toBe("/r/b/web-copy");
    expect(b.registry.repos.find((e) => e.path === "/r/b/web-copy")!.copyOf).toBeUndefined();
  });

  it("keeps a --group choice on later runs without --group", () => {
    const a = planRegistration(empty(), "/r/a/web", { baseId: "web", remote: remote("web"), group: "shop" });
    const b = planRegistration(a.registry, "/r/a/web", { baseId: "web", remote: remote("web") });
    expect(b.entry).toMatchObject({ group: "shop", groupFrom: "flag" });
  });

  it("normalises a registry deterministically", () => {
    const reg = planRegistration(empty(), "/r/a/web", { baseId: "web", remote: remote("web"), now: new Date(0) }).registry;
    expect(normalizeRegistry(normalizeRegistry(reg))).toEqual(normalizeRegistry(reg));
  });
});

describe("groupWorkspace", () => {
  it("lists one checkout per remote with absolute paths, and reports gone folders", () => {
    const parent = mkdtempSync(join(tmpdir(), "codeloom-reg-"));
    const web = makeRepo({ "a.ts": "" }, join(parent, "web"));
    const copy = makeRepo({ "a.ts": "" }, join(parent, "web-copy"));
    const gone = join(parent, "gone");
    mkdirSync(gone);
    let reg = planRegistration(empty(), web, { baseId: "web", remote: remote("web"), now: new Date(1000) }).registry;
    reg = planRegistration(reg, copy, { baseId: "web", remote: remote("web"), now: new Date(2000) }).registry;
    reg = planRegistration(reg, gone, { baseId: "gone", remote: remote("gone"), now: new Date(3000) }).registry;
    rmSync(gone, { recursive: true });
    const ws = groupWorkspace(reg, "github.com/demo-shop");
    expect(ws.repos.map((r) => r.id)).toEqual(["web"]);
    expect(ws.repos[0]!.path).toMatch(/web-copy$/);
    expect(ws.copies.map((c) => c.path)).toEqual([expect.stringMatching(/\/web$/)]);
    expect(ws.missing.map((m) => m.id)).toEqual(["gone"]);
    // The newest checkout gone: the older one stands in.
    rmSync(copy, { recursive: true });
    expect(groupWorkspace(reg, "github.com/demo-shop").repos[0]!.path).toMatch(/\/web$/);
  });

  it("resolves relative and absolute repo paths", () => {
    expect(repoAbsPath("/ws", { path: "api" })).toBe(join("/ws", "api"));
    expect(repoAbsPath("/ws", { path: "." })).toBe("/ws");
    expect(repoAbsPath("/ws", { path: "/elsewhere/api" })).toBe("/elsewhere/api");
  });
});

describe("review fix round 1", () => {
  it("never folds two groups into one data folder (fix 6)", () => {
    expect(groupRoot("a/b")).not.toBe(groupRoot("a-b"));
    expect(groupRoot("github.com/demo-shop")).not.toBe(groupRoot("github.com-demo-shop"));
    expect(groupRoot("a/b")).toBe(groupRoot("a/b"));
    expect(basename(groupRoot("github.com/demo-shop"))).toMatch(/^github\.com-demo-shop-[0-9a-f]{8}$/);
  });

  it("finds the group of a data folder by its exact name (fix 6)", () => {
    let reg = planRegistration(empty(), "/r/x/web", { baseId: "web", remote: null, group: "a/b" }).registry;
    reg = planRegistration(reg, "/r/y/api", { baseId: "api", remote: null, group: "a-b" }).registry;
    expect(groupAtDataRoot(reg, join(groupRoot("a/b"), ".codeloom"))).toBe("a/b");
    expect(groupAtDataRoot(reg, groupRoot("a-b"))).toBe("a-b");
  });

  it("reads Azure DevOps remotes with the organisation as the owner (fix 5)", () => {
    const ssh = parseRemote("git@ssh.dev.azure.com:v3/demo-shop/storefront/web");
    const https = parseRemote("https://demo-shop@dev.azure.com/demo-shop/storefront/_git/web");
    expect(ssh).toEqual({ host: "dev.azure.com", owner: "demo-shop", name: "storefront/web" });
    expect(https).toEqual(ssh);
  });

  it("maps the ssh-over-443 hosts to their sites (fix round 2)", () => {
    expect(parseRemote("ssh://git@ssh.github.com:443/demo-shop/web.git")).toEqual({ host: "github.com", owner: "demo-shop", name: "web" });
    expect(parseRemote("ssh://git@altssh.bitbucket.org:443/demo-shop/api.git")?.host).toBe("bitbucket.org");
    expect(parseRemote("ssh://git@altssh.gitlab.com:443/demo-shop/api.git")?.host).toBe("gitlab.com");
  });

  it("maps ssh.bitbucket.org and ssh.gitlab.com to their sites, so one owner stays one group (0.6 Task E)", () => {
    expect(parseRemote("git@ssh.bitbucket.org:demo-shop/api.git")).toEqual({ host: "bitbucket.org", owner: "demo-shop", name: "api" });
    expect(parseRemote("git@ssh.bitbucket.org:demo-shop/api.git")).toEqual(parseRemote("git@bitbucket.org:demo-shop/api.git"));
    expect(parseRemote("ssh://git@ssh.bitbucket.org:443/demo-shop/api.git")?.host).toBe("bitbucket.org");
    expect(parseRemote("git@ssh.gitlab.com:demo-shop/api.git")?.host).toBe("gitlab.com");
    expect(parseRemote("git@altssh.gitlab.com:demo-shop/api.git")?.host).toBe("gitlab.com");
    expect(parseRemote("git@altssh.github.com:demo-shop/web.git")?.host).toBe("github.com");
    expect(autoGroup("/x/api", parseRemote("git@ssh.bitbucket.org:demo-shop/api.git")).group).toBe(autoGroup("/x/web", parseRemote("git@bitbucket.org:demo-shop/web.git")).group);
  });

  describe("SSH host aliases (fix 5)", () => {
    const fakeSsh = (script: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "codeloom-fake-ssh-"));
      writeFileSync(join(dir, "ssh"), `#!/bin/sh\n${script}\n`);
      chmodSync(join(dir, "ssh"), 0o755);
      return dir;
    };
    let savedPath: string | undefined;
    beforeEach(() => {
      savedPath = process.env.PATH;
      clearSshHostCache();
    });
    afterEach(() => {
      process.env.PATH = savedPath;
      clearSshHostCache();
    });

    it("resolves git@<alias>:owner/repo to the real host with ssh -G, once per alias", () => {
      const log = join(mkdtempSync(join(tmpdir(), "codeloom-ssh-log-")), "calls");
      const dir = fakeSsh(`for a in "$@"; do last="$a"; done\necho "$last" >> "${log}"\nif [ "$last" = "github-work" ]; then echo "hostname github.com"; else echo "hostname $last"; fi\necho "port 22"`);
      process.env.PATH = `${dir}:${savedPath}`;
      const repo = makeRepo({ "a.ts": "" });
      execFileSync("git", ["remote", "add", "origin", "git@github-work:Demo-Shop/web.git"], { cwd: repo });
      expect(readRemote(repo)).toEqual({ host: "github.com", owner: "demo-shop", name: "web" });
      expect(readRemote(repo)).toEqual({ host: "github.com", owner: "demo-shop", name: "web" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["github-work"]);
    });

    it("maps an alias whose HostName is ssh.github.com to github.com (fix round 2)", () => {
      process.env.PATH = `${fakeSsh('echo "hostname ssh.github.com"')}:${savedPath}`;
      const repo = makeRepo({ "a.ts": "" });
      execFileSync("git", ["remote", "add", "origin", "git@github-443:demo-shop/web.git"], { cwd: repo });
      expect(readRemote(repo)).toEqual({ host: "github.com", owner: "demo-shop", name: "web" });
    });

    it("keeps the alias when ssh fails or is missing, and never asks ssh about https remotes", () => {
      const log = join(mkdtempSync(join(tmpdir(), "codeloom-ssh-log-")), "calls");
      process.env.PATH = `${fakeSsh(`echo called >> "${log}"\nexit 255`)}:${savedPath}`;
      const repo = makeRepo({ "a.ts": "" });
      execFileSync("git", ["remote", "add", "origin", "git@github-work:demo-shop/web.git"], { cwd: repo });
      expect(readRemote(repo)).toEqual({ host: "github-work", owner: "demo-shop", name: "web" });
      const https = makeRepo({ "a.ts": "" });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/demo-shop/api.git"], { cwd: https });
      clearSshHostCache();
      const before = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(readRemote(https)).toEqual({ host: "github.com", owner: "demo-shop", name: "api" });
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
    });
  });
});
