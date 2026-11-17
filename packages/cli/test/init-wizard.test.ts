import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HeadlessRun, runClaudeHeadless } from "../src/claude/headless.js";
import { HOOK_MARK } from "../src/commands/init.js";
import {
  type Ask,
  defaultSelection,
  displayRemote,
  effectiveYes,
  formatInitWizard,
  readlineAsk,
  runInitWizard,
} from "../src/commands/init-wizard.js";
import { nameJourneysPromptText } from "../src/mcp/prompts.js";
import { VERSION } from "../src/version.js";
import { makeRepo } from "./helpers.js";

/** A fake Ask: resolves confirm() with the answer keyed by the exact question text (falling back to the
 * given default), and pickMany() with the given answer (falling back to the defaults it was offered).
 * Records every call so tests can assert what was (or was not) asked. */
function fakeAsk(
  confirmAnswers: Record<string, boolean>,
  pickManyAnswer?: boolean[],
): Ask & {
  confirmCalls: Array<{ q: string; def: boolean }>;
  pickManyCalls: Array<{ q: string; items: Array<{ label: string; checked: boolean }> }>;
  closed: boolean;
} {
  const confirmCalls: Array<{ q: string; def: boolean }> = [];
  const pickManyCalls: Array<{ q: string; items: Array<{ label: string; checked: boolean }> }> = [];
  const state = { closed: false };
  return {
    confirmCalls,
    pickManyCalls,
    get closed() {
      return state.closed;
    },
    async confirm(q, def) {
      confirmCalls.push({ q, def });
      return q in confirmAnswers ? confirmAnswers[q]! : def;
    },
    async pickMany(q, items) {
      pickManyCalls.push({ q, items });
      return pickManyAnswer ?? items.map((i) => i.checked);
    },
    close() {
      state.closed = true;
    },
  };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

describe("defaultSelection", () => {
  it("pre-selects every repo when none share a remote", () => {
    expect(defaultSelection([{ path: "web" }, { path: "api" }])).toEqual([true, true]);
  });

  it("pre-selects only the repo on the default branch among duplicates of the same remote", () => {
    const repos = [
      { path: "core-1", remote: "git@x:core.git", branch: "feature/foo", defaultBranch: "main" },
      { path: "core-2", remote: "git@x:core.git", branch: "main", defaultBranch: "main" },
      { path: "core-3", remote: "git@x:core.git", branch: "feature/bar", defaultBranch: "main" },
    ];
    expect(defaultSelection(repos)).toEqual([false, true, false]);
  });

  it("pre-selects the first duplicate when none of them is on the default branch", () => {
    const repos = [
      { path: "core-1", remote: "git@x:core.git", branch: "feature/foo" },
      { path: "core-2", remote: "git@x:core.git", branch: "feature/bar" },
    ];
    expect(defaultSelection(repos)).toEqual([true, false]);
  });

  it("treats repos with no remote as never duplicating each other", () => {
    const repos = [{ path: "a" }, { path: "b" }];
    expect(defaultSelection(repos)).toEqual([true, true]);
  });
});

describe("runInitWizard: repos step", () => {
  it("duplicate remotes: pre-selects the copy on the default branch; the other is offered unchecked and excluded", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-wizard-"));
    const copy1 = makeRepo({ "a.ts": "" }, join(root, "core-copy-1"));
    git(copy1, "remote", "add", "origin", "git@example.com:org/core.git");
    git(copy1, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(copy1, "checkout", "-q", "-b", "feature/x");

    const copy2 = makeRepo({ "a.ts": "" }, join(root, "core-copy-2"));
    git(copy2, "remote", "add", "origin", "git@example.com:org/core.git");
    git(copy2, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    // copy2 stays on "main", its default branch

    const ask = fakeAsk({});
    const result = await runInitWizard(root, { ask });

    expect(ask.pickManyCalls).toHaveLength(1);
    expect(ask.pickManyCalls[0]!.items.map((i) => i.checked)).toEqual([false, true]);
    expect(result.repos.map((r) => r.path)).toEqual(["core-copy-2"]);
    expect(result.skipped.map((r) => r.path)).toEqual(["core-copy-1"]);

    const ws = JSON.parse(readFileSync(join(root, "codeloom.workspace.json"), "utf8"));
    expect(ws.repos).toEqual([{ id: "core-copy-2", path: "core-copy-2" }]);
    expect(ws.links).toEqual([]);
  });
});

describe("displayRemote: never shows credentials", () => {
  it("drops user and token from an http(s) remote", () => {
    expect(displayRemote("https://shop-bot:s3cret-token@git.example.com/demo/shop.git")).toBe("https://git.example.com/demo/shop.git");
    expect(displayRemote("http://only-a-token@git.example.com/demo/shop.git")).toBe("http://git.example.com/demo/shop.git");
  });

  it("keeps an ssh user but drops a password, and leaves scp-style remotes alone", () => {
    expect(displayRemote("ssh://git:pw@git.example.com/demo/shop.git")).toBe("ssh://git@git.example.com/demo/shop.git");
    expect(displayRemote("git@git.example.com:demo/shop.git")).toBe("git@git.example.com:demo/shop.git");
    expect(displayRemote("https://git.example.com/demo/shop.git")).toBe("https://git.example.com/demo/shop.git");
  });

  it("the repo picker shows the remote without its token", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-wizard-"));
    const repo = makeRepo({ "a.ts": "" }, join(root, "shop"));
    git(repo, "remote", "add", "origin", "https://shop-bot:s3cret-token@git.example.com/demo/shop.git");
    makeRepo({ "b.ts": "" }, join(root, "billing"));
    const ask = fakeAsk({});
    const result = await runInitWizard(root, { ask });
    const labels = ask.pickManyCalls[0]!.items.map((i) => i.label).join("\n");
    expect(labels).toContain("https://git.example.com/demo/shop.git");
    expect(labels).not.toContain("s3cret");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});

describe("runInitWizard: commit or keep local", () => {
  it('keep local ("Commit..." answered no): adds .codeloom/ to .git/info/exclude; no .gitignore edit, no hook', async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-wizard-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));
    const ask = fakeAsk({ "Commit codeloom's files with your code?": false });

    const result = await runInitWizard(root, { ask });

    expect(result.mode).toBe("local");
    for (const repo of ["web", "api"]) {
      const repoAbs = join(root, repo);
      const exclude = git(repoAbs, "rev-parse", "--git-path", "info/exclude").toString().trim();
      expect(readFileSync(join(repoAbs, exclude), "utf8")).toContain(".codeloom/");
      expect(existsSync(join(repoAbs, ".gitignore"))).toBe(false);
      expect(existsSync(join(repoAbs, ".git/hooks/post-commit"))).toBe(false);
    }
    const ws = JSON.parse(readFileSync(join(root, "codeloom.workspace.json"), "utf8"));
    expect(ws.links).toEqual([]);
  });

  it('keep local for a single repo also excludes codeloom.workspace.json (it sits inside the same repo)', async () => {
    const repo = makeRepo({ "a.ts": "" });
    const ask = fakeAsk({ "Commit codeloom's files with your code?": false });

    await runInitWizard(repo, { ask });

    const exclude = git(repo, "rev-parse", "--git-path", "info/exclude").toString().trim();
    const body = readFileSync(join(repo, exclude), "utf8");
    expect(body).toContain(".codeloom/");
    expect(body).toContain("codeloom.workspace.json");
  });

  it('commit mode matches today\'s "codeloom init": hook installed, .gitignore line added, workspace file with links: []', async () => {
    const repo = makeRepo({ "a.ts": "", "package.json": JSON.stringify({ name: "@acme/shop" }) });
    const ask = fakeAsk({ "Commit codeloom's files with your code?": true });

    const result = await runInitWizard(repo, { ask });

    expect(result.mode).toBe("commit");
    expect(readFileSync(join(repo, ".git/hooks/post-commit"), "utf8")).toContain(HOOK_MARK);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".codeloom/fingerprints.json");
    const ws = JSON.parse(readFileSync(join(repo, "codeloom.workspace.json"), "utf8"));
    expect(ws).toEqual({ version: 1, name: "acme-shop", repos: [{ id: "acme-shop", path: "." }], links: [] });
  });
});

describe("runInitWizard: --yes takes every default", () => {
  it("a single repo defaults to commit", async () => {
    const repo = makeRepo({ "a.ts": "" });
    const result = await runInitWizard(repo, { ask: fakeAsk({}), yes: true });
    expect(result.mode).toBe("commit");
  });

  it("a folder of repos defaults to keep local", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-wizard-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    makeRepo({ "b.ts": "" }, join(root, "api"));
    const result = await runInitWizard(root, { ask: fakeAsk({}), yes: true });
    expect(result.mode).toBe("local");
  });

  it("never asks when --yes is set", async () => {
    const repo = makeRepo({ "a.ts": "" });
    const ask = fakeAsk({});
    await runInitWizard(repo, { ask, yes: true, claude: "/bin/claude" });
    expect(ask.confirmCalls).toEqual([]);
    expect(ask.pickManyCalls).toEqual([]);
  });

  // Regression: codeloom init --yes used to default "Open the dashboard?" to yes, and opening the
  // dashboard starts a server that keeps the process alive — so `codeloom init --yes < /dev/null` never
  // exited. The default must be no under --yes, exactly like "name journeys now".
  it("never opens the dashboard (it would keep the process alive forever, hanging --yes)", async () => {
    const repo = makeRepo({ "a.ts": "" });
    let opened = false;
    const result = await runInitWizard(repo, {
      ask: fakeAsk({}),
      yes: true,
      openDashboard: async () => {
        opened = true;
      },
    });
    expect(opened).toBe(false);
    expect(result.dashboardOpened).toBe(false);
    expect(formatInitWizard(result)).toContain('codeloom dashboard');
  });
});

describe("runInitWizard: Claude Code", () => {
  it("found: connecting writes a .mcp.json entry pinned to this codeloom version", async () => {
    const repo = makeRepo({ "a.ts": "" });
    const ask = fakeAsk({ "Connect Claude Code?": true });

    const result = await runInitWizard(repo, { ask, claude: "/usr/local/bin/claude" });

    expect(result.claude.found).toBe(true);
    expect(result.claude.connected).toBe(true);
    const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.codeloom).toEqual({ command: "npx", args: ["-y", `codeloom@${VERSION}`, "serve"] });
  });

  it('"name your journeys now" defaults to no and never runs claude without being asked', async () => {
    const repo = makeRepo({ "a.ts": "" });
    const ask = fakeAsk({ "Connect Claude Code?": true });
    let ran = false;
    const fakeRun = (async () => {
      ran = true;
      return { exitCode: 0, output: "" };
    }) as typeof runClaudeHeadless;

    await runInitWizard(repo, { ask, claude: "/bin/claude", run: fakeRun });

    expect(ran).toBe(false);
    const nameQ = ask.confirmCalls.find((c) => c.q === "Let Claude name your journeys now? (uses your Claude Code)");
    expect(nameQ).toBeDefined();
    expect(nameQ!.def).toBe(false);
  });

  it('"name your journeys now": yes runs the headless prompt, limited to codeloom\'s own MCP tools', async () => {
    const repo = makeRepo({ "a.ts": "" });
    const ask = fakeAsk({
      "Connect Claude Code?": true,
      "Let Claude name your journeys now? (uses your Claude Code)": true,
    });
    const calls: HeadlessRun[] = [];
    const fakeRun = (async (run: HeadlessRun) => {
      calls.push(run);
      return { exitCode: 0, output: "named 3 journeys" };
    }) as typeof runClaudeHeadless;

    const result = await runInitWizard(repo, { ask, claude: "/bin/claude", run: fakeRun });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe(nameJourneysPromptText());
    expect(calls[0]!.claudeBin).toBe("/bin/claude");
    expect(calls[0]!.cwd).toBe(repo);
    expect(calls[0]!.allowedTools.length).toBeGreaterThan(0);
    for (const tool of calls[0]!.allowedTools) expect(tool.startsWith("mcp__codeloom__")).toBe(true);
    expect(result.claude.namedJourneys).toEqual({ ran: true, exitCode: 0 });
  });

  it("no claude on PATH: never touches .mcp.json and surfaces the name-journeys prompt text instead", async () => {
    const repo = makeRepo({ "a.ts": "" });

    const result = await runInitWizard(repo, { ask: fakeAsk({}), claude: null });

    expect(result.claude.found).toBe(false);
    expect(result.claude.connected).toBe(false);
    expect(result.claude.prompt).toBe(nameJourneysPromptText());
    expect(existsSync(join(repo, ".mcp.json"))).toBe(false);
  });
});

describe("runInitWizard: re-run offers only what is missing", () => {
  it("does not re-ask about repos or re-offer connecting an already-connected Claude Code", async () => {
    const repo = makeRepo({ "a.ts": "" });
    await runInitWizard(repo, { ask: fakeAsk({ "Connect Claude Code?": true }), claude: "/bin/claude" });

    const ask2 = fakeAsk({});
    const result2 = await runInitWizard(repo, { ask: ask2, claude: "/bin/claude" });

    expect(ask2.pickManyCalls).toHaveLength(0);
    expect(ask2.confirmCalls.some((c) => c.q === "Connect Claude Code?")).toBe(false);
    expect(result2.claude.connected).toBe(true);
    expect(result2.created).toEqual([]);
  });
});

describe("runInitWizard: an older pinned Claude Code entry", () => {
  const OLD = { command: "npx", args: ["-y", "codeloom@0.3.0", "serve"] };

  it("offers to update it to this version, and updates it on yes (keeping other servers)", async () => {
    const repo = makeRepo({ "a.ts": "" });
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { codeloom: OLD, other: { command: "x" } } }));
    const q = `Update Claude Code's codeloom from codeloom@0.3.0 to codeloom@${VERSION}?`;
    const ask = fakeAsk({ [q]: true });
    const result = await runInitWizard(repo, { ask, claude: "/bin/claude" });
    expect(ask.confirmCalls.find((c) => c.q === q)?.def).toBe(true);
    const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.codeloom).toEqual({ command: "npx", args: ["-y", `codeloom@${VERSION}`, "serve"] });
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(result.claude.connected).toBe(true);
    expect(result.mcp).toBe("updated");
  });

  it("leaves it as it is on no, still connected", async () => {
    const repo = makeRepo({ "a.ts": "" });
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { codeloom: OLD } }));
    const ask = fakeAsk({ [`Update Claude Code's codeloom from codeloom@0.3.0 to codeloom@${VERSION}?`]: false });
    const result = await runInitWizard(repo, { ask, claude: "/bin/claude" });
    expect(JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.codeloom).toEqual(OLD);
    expect(result.claude.connected).toBe(true);
  });
});

describe("effectiveYes: non-interactive runs behave like --yes", () => {
  it("true when --yes was passed", () => {
    expect(effectiveYes(true, { isTTY: true } as NodeJS.ReadableStream, { isTTY: true } as NodeJS.WritableStream)).toBe(true);
  });

  it("true when stdin is not a TTY, even without --yes", () => {
    expect(effectiveYes(undefined, { isTTY: false } as NodeJS.ReadableStream, { isTTY: true } as NodeJS.WritableStream)).toBe(true);
  });

  it("true when stdout is not a TTY, even without --yes", () => {
    expect(effectiveYes(undefined, { isTTY: true } as NodeJS.ReadableStream, { isTTY: false } as NodeJS.WritableStream)).toBe(true);
  });

  it("false when both are TTYs and --yes was not passed", () => {
    expect(effectiveYes(undefined, { isTTY: true } as NodeJS.ReadableStream, { isTTY: true } as NodeJS.WritableStream)).toBe(false);
  });
});

describe("readlineAsk", () => {
  it("confirm: an empty answer takes the default", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = readlineAsk(input, output);
    const p = ask.confirm("Do the thing?", true);
    input.write("\n");
    expect(await p).toBe(true);
    input.end();
  });

  it("confirm: 'n' overrides a true default", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = readlineAsk(input, output);
    const p = ask.confirm("Q?", true);
    input.write("n\n");
    expect(await p).toBe(false);
    input.end();
  });

  it("pickMany: toggling a number by position flips that item's default", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = readlineAsk(input, output);
    const p = ask.pickMany("Pick:", [
      { label: "a", checked: true },
      { label: "b", checked: false },
    ]);
    input.write("2\n");
    expect(await p).toEqual([true, true]);
    input.end();
  });

  // Regression: readline/promises' own question() can be left unsettled forever when the input ends
  // (EOF / Ctrl+D) before a line is read, which would otherwise make the wizard hang silently instead
  // of moving on. confirm/pickMany must settle with a default the moment the interface closes.
  it("confirm: EOF while a question is pending resolves with the default instead of hanging", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = readlineAsk(input, output);
    const p = ask.confirm("Q?", true);
    input.end(); // no answer line at all — just end the stream
    expect(await p).toBe(true);
  });

  it("pickMany: EOF while pending resolves with the defaults it offered, not an empty/invalid answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = readlineAsk(input, output);
    const p = ask.pickMany("Pick:", [
      { label: "a", checked: true },
      { label: "b", checked: false },
    ]);
    input.end();
    expect(await p).toEqual([true, false]);
  });

  it("close() lets a later question resolve immediately with its default instead of blocking", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = readlineAsk(input, output);
    ask.close();
    expect(await ask.confirm("Q?", false)).toBe(false);
  });

  it("writes question prompts to stderr by default, never stdout (so piping init's stdout never captures them)", async () => {
    const input = new PassThrough();
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderrChunks.push(String(chunk));
      return (origStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      stdoutChunks.push(String(chunk));
      return (origStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      const ask = readlineAsk(input);
      const p = ask.confirm("Secret question text?", true);
      input.write("\n");
      await p;
      ask.close();
    } finally {
      process.stderr.write = origStderrWrite;
      process.stdout.write = origStdoutWrite;
    }
    expect(stderrChunks.join("")).toContain("Secret question text?");
    expect(stdoutChunks.join("")).not.toContain("Secret question text?");
  });
});

describe("formatInitWizard", () => {
  it("names the selected repos and the setup mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-wizard-"));
    makeRepo({ "a.ts": "" }, join(root, "web"));
    const result = await runInitWizard(root, { ask: fakeAsk({ "Commit codeloom's files with your code?": false }) });
    const text = formatInitWizard(result);
    expect(text).toContain("web");
    expect(text).toContain("local");
  });

  it('says "Journeys named" only when Claude exited 0; otherwise how to name them by hand', async () => {
    const repo = makeRepo({ "a.ts": "" });
    const result = await runInitWizard(repo, { ask: fakeAsk({ "Connect Claude Code?": true }), claude: "/bin/claude" });
    const ok = formatInitWizard({ ...result, claude: { ...result.claude, namedJourneys: { ran: true, exitCode: 0 } } });
    expect(ok).toContain("Journeys named.");
    const failed = formatInitWizard({ ...result, claude: { ...result.claude, namedJourneys: { ran: true, exitCode: 3 } } });
    expect(failed).not.toContain("Journeys named");
    expect(failed).toContain("Claude could not name journeys (exit 3); run /mcp__codeloom__name-journeys in Claude Code");
  });

  it("without claude on PATH, prints the name-journeys prompt text for the user to run themselves", async () => {
    const repo = makeRepo({ "a.ts": "" });
    const result = await runInitWizard(repo, { ask: fakeAsk({}), claude: null });
    expect(formatInitWizard(result)).toContain(nameJourneysPromptText());
  });
});
