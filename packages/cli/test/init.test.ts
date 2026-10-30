import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_MARK, installHook, runInit, shellQuote } from "../src/commands/init.js";
import { CodeloomError } from "../src/errors.js";
import { makeRepo } from "./helpers.js";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Poll until `predicate()` is true or the timeout elapses. */
function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 50): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    sleepSync(intervalMs);
  }
}

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

describe("shellQuote", () => {
  it("quotes a path with a space", () => {
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
  });

  it("escapes an embedded single quote", () => {
    expect(shellQuote("/x/it's")).toBe("'/x/it'\\''s'");
  });

  it("keeps a command substitution literal inside single quotes", () => {
    expect(shellQuote("/x/$(touch pwned)")).toBe("'/x/$(touch pwned)'");
  });
});

/** Recursively find any file named `name` under `dir`. */
function findFileNamed(dir: string, name: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) found.push(full);
    }
  };
  walk(dir);
  return found;
}

describe("post-commit hook safety", () => {
  it("does not let a workspace path with shell metacharacters execute commands", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "codeloom-hooksafety-"));
    const parent = join(tmpRoot, "ws $(touch PWNED)");
    mkdirSync(parent, { recursive: true });
    const repo = makeRepo({ "a.ts": "" }, join(parent, "repo"));

    const res = runInit(parent);
    expect(res.repos.length).toBeGreaterThan(0);

    const hookPath = join(repo, ".git/hooks/post-commit");
    const hookBody = readFileSync(hookPath, "utf8");
    expect(hookBody).toContain(shellQuote(parent));

    const binDir = mkdtempSync(join(tmpdir(), "codeloom-fakebin-"));
    const fakeCodeloom = join(binDir, "codeloom");
    writeFileSync(fakeCodeloom, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodeloom, 0o755);

    execFileSync("sh", [hookPath], {
      cwd: repo,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      stdio: "pipe",
    });

    // The hook backgrounds a subshell; give it a moment to (not) do damage.
    waitUntil(() => false, 300);

    expect(findFileNamed(tmpRoot, "PWNED")).toEqual([]);
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  it("preserves an existing post-commit hook's shebang and content", () => {
    const repo = makeRepo({ "a.ts": "" });
    const hooksDir = join(repo, ".git/hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "post-commit");
    writeFileSync(hookPath, "#!/bin/bash\necho custom\n");

    runInit(repo);

    const hookBody = readFileSync(hookPath, "utf8");
    expect(hookBody.startsWith("#!/bin/bash")).toBe(true);
    expect(hookBody).toContain("echo custom");
    expect(hookBody.split(HOOK_MARK).length - 1).toBe(1);
  });

  it("returns false and does not throw for a worktree-style .git file", () => {
    const folder = mkdtempSync(join(tmpdir(), "codeloom-worktree-"));
    writeFileSync(join(folder, ".git"), "gitdir: /nonexistent\n");

    expect(() => installHook(folder, folder)).not.toThrow();
    expect(installHook(folder, folder)).toBe(false);
  });
});
