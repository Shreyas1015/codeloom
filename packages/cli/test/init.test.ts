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
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeloomBin, ensureMcpEntry, formatInit, HOOK_MARK, hookLine, installHook, MCP_ENTRY, runInit, shellQuote } from "../src/commands/init.js";
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

  it("writes a workspace file for a single repo too, saving its stable id (final review batch 2, item C)", () => {
    const repo = makeRepo({ "a.ts": "", "package.json": JSON.stringify({ name: "@acme/shop" }) });
    const res = runInit(repo);
    expect(res.created).toContain("codeloom.workspace.json");
    const ws = JSON.parse(readFileSync(join(repo, "codeloom.workspace.json"), "utf8"));
    expect(ws).toEqual({ version: 1, name: "acme-shop", repos: [{ id: "acme-shop", path: "." }], links: [] });
  });

  it("does not write a single-repo workspace file inside an existing workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));
    runInit(root);
    const res = runInit(join(root, "web"));
    expect(res.created).not.toContain("codeloom.workspace.json");
    expect(existsSync(join(root, "web", "codeloom.workspace.json"))).toBe(false);
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

  it("reports a broken .git file as skipped and does not throw", () => {
    const folder = mkdtempSync(join(tmpdir(), "codeloom-worktree-"));
    writeFileSync(join(folder, ".git"), "gitdir: /nonexistent\n");

    expect(() => installHook(folder, folder)).not.toThrow();
    expect(installHook(folder, folder)).toMatchObject({ status: "skipped", reason: expect.any(String) });
  });
});

describe("hook placement", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

  it("writes the hook into core.hooksPath (e.g. husky)", () => {
    const repo = makeRepo({ "a.ts": "" });
    git(repo, "config", "core.hooksPath", ".husky");
    const res = runInit(repo);
    expect(readFileSync(join(repo, ".husky/post-commit"), "utf8")).toContain(HOOK_MARK);
    expect(existsSync(join(repo, ".git/hooks/post-commit"))).toBe(false);
    expect(res.created).toContain(".husky/post-commit");
    expect(res.skipped).toEqual([]);
  });

  it("leaves a non-shell post-commit hook untouched and reports it with the line to add", () => {
    const repo = makeRepo({ "a.ts": "" });
    const hook = join(repo, ".git/hooks/post-commit");
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    const body = "#!/usr/bin/env node\nconsole.log('hi');\n";
    writeFileSync(hook, body);
    const res = runInit(repo);
    expect(readFileSync(hook, "utf8")).toBe(body);
    expect(res.skipped).toEqual([{ repo: expect.any(String), reason: expect.stringContaining("not a shell script") }]);
    const text = formatInit(res);
    expect(text).toContain("codeloom index --quiet");
    expect(text).toContain(res.skipped[0]!.reason);
  });

  it("appends to an empty post-commit hook with a shell shebang", () => {
    const repo = makeRepo({ "a.ts": "" });
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    writeFileSync(join(repo, ".git/hooks/post-commit"), "");
    runInit(repo);
    const body = readFileSync(join(repo, ".git/hooks/post-commit"), "utf8");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain(HOOK_MARK);
  });

  it("installs the hook in the shared hooks folder for a git worktree", () => {
    const main = makeRepo({ "a.ts": "" });
    const wt = join(mkdtempSync(join(tmpdir(), "codeloom-wt-")), "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    let res: ReturnType<typeof runInit> | undefined;
    expect(() => { res = runInit(wt); }).not.toThrow();
    const hooksDir = git(wt, "rev-parse", "--git-path", "hooks").trim();
    expect(readFileSync(resolve(wt, hooksDir, "post-commit"), "utf8")).toContain(HOOK_MARK);
    expect(res!.skipped).toEqual([]);
  });

  it("installs into .husky/post-commit, not the generated .husky/_ wrapper, for husky v9", () => {
    const repo = makeRepo({ "a.ts": "" });
    mkdirSync(join(repo, ".husky/_"), { recursive: true });
    const wrapper = "#!/usr/bin/env sh\n. \"$(dirname \"$0\")/h\"\n";
    writeFileSync(join(repo, ".husky/_/post-commit"), wrapper);
    writeFileSync(join(repo, ".husky/_/h"), "c=0\n");
    git(repo, "config", "core.hooksPath", ".husky/_");

    const res = runInit(repo);

    expect(readFileSync(join(repo, ".husky/post-commit"), "utf8")).toContain(HOOK_MARK);
    expect(readFileSync(join(repo, ".husky/_/post-commit"), "utf8")).toBe(wrapper);
    expect(res.created).toContain(".husky/post-commit");
    expect(res.skipped).toEqual([]);
  });

  it("appends to an existing .husky/post-commit for husky v9 without requiring a shebang", () => {
    const repo = makeRepo({ "a.ts": "" });
    mkdirSync(join(repo, ".husky/_"), { recursive: true });
    writeFileSync(join(repo, ".husky/_/post-commit"), "#!/usr/bin/env sh\n. \"$(dirname \"$0\")/h\"\n");
    writeFileSync(join(repo, ".husky/post-commit"), "echo custom\n");
    git(repo, "config", "core.hooksPath", ".husky/_");

    const res = runInit(repo);

    const body = readFileSync(join(repo, ".husky/post-commit"), "utf8");
    expect(body).toContain("echo custom");
    expect(body.split(HOOK_MARK).length - 1).toBe(1);
    expect(res.skipped).toEqual([]);
  });

  it("skips and reports a hooks folder that is shared outside this repo", () => {
    const repo = makeRepo({ "a.ts": "" });
    const outside = mkdtempSync(join(tmpdir(), "codeloom-outsidehooks-"));
    git(repo, "config", "core.hooksPath", outside);

    const res = runInit(repo);

    expect(res.skipped).toEqual([
      { repo: expect.any(String), reason: expect.stringContaining("hooks folder is shared outside this repo") },
    ]);
    expect(existsSync(join(outside, "post-commit"))).toBe(false);
    const text = formatInit(res);
    expect(text).toContain("codeloom index --quiet");
  });
});

describe("ensureMcpEntry", () => {
  it("creates .mcp.json with just the codeloom entry when none exists", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    const res = ensureMcpEntry(root);
    expect(res).toBe("added");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { codeloom: MCP_ENTRY } });
  });

  it("writes 2-space JSON with a trailing newline", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    ensureMcpEntry(root);
    const text = readFileSync(join(root, ".mcp.json"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "mcpServers"');
  });

  it("keeps another server and extra top-level keys when adding codeloom", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    const existing = { mcpServers: { other: { command: "other-server" } }, extra: "keepme" };
    writeFileSync(join(root, ".mcp.json"), JSON.stringify(existing));

    const res = ensureMcpEntry(root);

    expect(res).toBe("added");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { command: "other-server" }, codeloom: MCP_ENTRY },
      extra: "keepme",
    });
  });

  it("reports present and leaves the file byte-identical when the entry already matches", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    ensureMcpEntry(root);
    const before = readFileSync(join(root, ".mcp.json"), "utf8");

    const res = ensureMcpEntry(root);

    expect(res).toBe("present");
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe(before);
  });

  it("keeps a custom codeloom entry untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    const custom = { mcpServers: { codeloom: { command: "node", args: ["./my-server.js"], env: { FOO: "bar" } } } };
    writeFileSync(join(root, ".mcp.json"), JSON.stringify(custom, null, 2) + "\n");

    const res = ensureMcpEntry(root);

    expect(res).toBe("kept-custom");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual(custom);
  });

  it("leaves unparseable JSON untouched and reports invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    writeFileSync(join(root, ".mcp.json"), "{ not json");

    const res = ensureMcpEntry(root);

    expect(res).toBe("invalid");
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("{ not json");
  });

  it("treats a non-object top-level value as invalid and leaves it untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    writeFileSync(join(root, ".mcp.json"), "[1, 2, 3]");

    const res = ensureMcpEntry(root);

    expect(res).toBe("invalid");
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("[1, 2, 3]");
  });

  it("treats a non-object mcpServers as invalid and leaves it untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: "nope" }));

    const res = ensureMcpEntry(root);

    expect(res).toBe("invalid");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: "nope" });
  });

  it("is idempotent across repeated calls", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-mcp-"));
    expect(ensureMcpEntry(root)).toBe("added");
    expect(ensureMcpEntry(root)).toBe("present");
    expect(ensureMcpEntry(root)).toBe("present");
  });
});

describe("runInit writes .mcp.json", () => {
  it("adds the codeloom entry at the workspace root for a folder of repos", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-mcp-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));

    const res = runInit(root);

    expect(res.mcp).toBe("added");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { codeloom: MCP_ENTRY } });
  });

  it("adds the codeloom entry at the repo root for a standalone single repo", () => {
    const repo = makeRepo({ "a.ts": "" });

    const res = runInit(repo);

    expect(res.mcp).toBe("added");
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
  });

  it("writes .mcp.json at the enclosing workspace root, not the repo, for a repo inside a workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-mcp-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));
    runInit(root);

    const res = runInit(join(root, "web"));

    expect(res.mcp).toBe("present");
    expect(existsSync(join(root, "web", ".mcp.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { codeloom: MCP_ENTRY } });
  });

  it("is idempotent when init runs twice", () => {
    const repo = makeRepo({ "a.ts": "" });
    expect(runInit(repo).mcp).toBe("added");
    expect(runInit(repo).mcp).toBe("present");
  });

  it("formatInit reports each mcp outcome", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-mcp-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    const added = runInit(root);
    expect(formatInit(added)).toContain("Added codeloom to .mcp.json");

    const present = runInit(root);
    expect(formatInit(present)).toContain("codeloom already in .mcp.json");
  });

  it("formatInit reports a kept-custom codeloom entry", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-mcp-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { codeloom: { command: "custom" } } }));

    const res = runInit(root);

    expect(res.mcp).toBe("kept-custom");
    expect(formatInit(res)).toContain("kept your own codeloom entry in .mcp.json");
  });

  it("formatInit reports invalid JSON with the entry to add by hand", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init-mcp-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    writeFileSync(join(root, ".mcp.json"), "{ not json");

    const res = runInit(root);

    expect(res.mcp).toBe("invalid");
    const text = formatInit(res);
    expect(text).toContain(".mcp.json is not valid JSON");
    expect(text).toContain("add this entry by hand");
  });
});

describe("formatInit: an unusable .mcp.json", () => {
  it("names the problem: mcpServers not an object, or not a JSON object, is not 'not valid JSON'", () => {
    for (const [content, expected] of [
      [JSON.stringify({ mcpServers: "nope" }), '"mcpServers" in .mcp.json is not an object'],
      ["[1, 2, 3]", ".mcp.json is not a JSON object"],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "codeloom-init-mcp-"));
      makeRepo({ "a.ts": "" }, join(root, "web"));
      writeFileSync(join(root, ".mcp.json"), content);
      const res = runInit(root);
      expect(res.mcp).toBe("invalid");
      const text = formatInit(res);
      expect(text).toContain(expected);
      expect(text).not.toContain("not valid JSON");
      expect(text).toContain("add this entry by hand");
    }
  });
});

describe("formatInit on an already-initialized workspace", () => {
  it("mentions every repo, including ones whose hook is already installed", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-init2-"));
    makeRepo({ "a.ts": "" }, join(root, "api"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    runInit(root);

    const second = runInit(root);

    expect(second.created).toEqual([]);
    const text = formatInit(second);
    expect(text).toContain("api");
    expect(text).toContain("web");
    expect(text).toContain("hook already installed");
  });
});

describe("post-commit hook command (H7)", () => {
  /** An executable stand-in for the codeloom bin: records its working folder and arguments. */
  function fakeBin(dirName = "codeloom bin's dir"): { bin: string; out: string } {
    const dir = join(mkdtempSync(join(tmpdir(), "codeloom-h7-")), dirName);
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "ran.txt");
    const bin = join(dir, "bin.js");
    writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*" > ${shellQuote(out)}\n`);
    chmodSync(bin, 0o755);
    return { bin, out };
  }

  it("codeloomBin is the absolute path of the running bin when it exists and is executable", () => {
    const { bin } = fakeBin();
    expect(codeloomBin(bin)).toBe(bin);
    expect(codeloomBin(join(bin, "..", "bin.js"))).toBe(bin);
    expect(codeloomBin(join(tmpdir(), "no-such-codeloom-bin.js"))).toBeUndefined();
    expect(codeloomBin(undefined)).toBeUndefined();
    const plain = join(mkdtempSync(join(tmpdir(), "codeloom-h7-")), "bin.js");
    writeFileSync(plain, "console.log(1)\n");
    chmodSync(plain, 0o644);
    expect(codeloomBin(plain)).toBeUndefined();
  });

  it("the hook runs the bin that ran init, by its quoted absolute path, then codeloom on PATH; never npx", () => {
    const { bin } = fakeBin();
    const line = hookLine("/ws", bin);
    expect(line).toContain(`[ -x ${shellQuote(bin)} ]`);
    expect(line).toContain(`${shellQuote(bin)} index --quiet`);
    expect(line).toContain("command -v codeloom");
    expect(line.indexOf(shellQuote(bin))).toBeLessThan(line.indexOf("command -v codeloom"));
    expect(line).not.toContain("npx");
    expect(hookLine("/ws")).not.toContain("[ -x");
    expect(hookLine("/ws")).toContain("command -v codeloom");
    expect(hookLine("/ws")).not.toContain("npx");
  });

  it("init writes that line, and the installed hook runs the bin in the workspace root", () => {
    const { bin, out } = fakeBin();
    const repo = makeRepo({ "a.ts": "" });
    runInit(repo, { bin });
    const hookPath = join(repo, ".git/hooks/post-commit");
    expect(readFileSync(hookPath, "utf8")).toContain(`${shellQuote(bin)} index --quiet`);
    // PATH holds no codeloom: only the absolute path can have run it
    execFileSync("sh", [hookPath], { cwd: repo, env: { ...process.env, PATH: "/usr/bin:/bin" }, stdio: "pipe" });
    waitUntil(() => existsSync(out));
    expect(readFileSync(out, "utf8").trim()).toBe(`${resolve(repo)}|index --quiet`);
  });

  it("formatInit's hand-install hint uses the same line", () => {
    const { bin } = fakeBin();
    const folder = mkdtempSync(join(tmpdir(), "codeloom-h7-nohooks-"));
    const repo = makeRepo({ "a.ts": "" }, join(folder, "web"));
    // core.hooksPath outside the repo: init skips the hook and prints the line to add by hand
    execFileSync("git", ["config", "core.hooksPath", join(folder, "shared-hooks")], { cwd: repo });
    const res = runInit(folder, { bin });
    expect(res.skipped).toHaveLength(1);
    expect(formatInit(res)).toContain(hookLine(res.root, bin));
  });
});
