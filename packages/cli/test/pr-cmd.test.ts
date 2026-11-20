import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, exitCodeFor } from "../src/cli.js";
import { type HeadlessRun, runClaudeHeadless, type SpawnLike } from "../src/claude/headless.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { defaultBaseRef, PR_KEEP, PR_OWNED_MARKER, PR_OWNED_TEXT, type PrDeps, type PrResult, runPrCommand } from "../src/commands/pr.js";
import { CHECK_PR_QUESTION } from "../src/commands/review.js";
import { buildCheckPacket } from "../src/review/packet.js";
import { rememberPacket, savePrReview } from "../src/review/saved.js";
import type { PrSummary } from "../src/review/summary.js";
import { serveStaticSite } from "../src/web/static-site.js";
import { git } from "../src/workspace/git.js";
import { makeApiPr, setUpFolder } from "./review-pr-fixture.js";

// `codeloom pr`: index, build the review, maybe let Claude check it (same consent rules as `codeloom review`),
// write a local snapshot of the PR, serve it on 127.0.0.1 and open the This PR page. No real browser, no real
// claude: `open` and the headless run are injected.

function fakeSpawn(during: () => void = () => {}): SpawnLike {
  return ((_command: string, _args: readonly string[], _options: Record<string, unknown>) => {
    const child = new EventEmitter() as unknown as ReturnType<SpawnLike>;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    queueMicrotask(() => {
      try {
        during();
      } finally {
        child.emit("close", 0);
      }
    });
    return child;
  }) as SpawnLike;
}

interface Harness {
  deps: PrDeps;
  printed: string[];
  asked: string[];
  runs: HeadlessRun[];
  opened: string[];
  indexed: string[];
}

function harness(opts: { claude?: string | null; interactive?: boolean; answer?: boolean; during?: () => void } = {}): Harness {
  const h: Harness = { printed: [], asked: [], runs: [], opened: [], indexed: [], deps: undefined as unknown as PrDeps };
  h.deps = {
    claude: opts.claude ?? null,
    interactive: opts.interactive ?? false,
    confirm: async (q, def) => {
      h.asked.push(q);
      return opts.answer ?? def;
    },
    run: (r) => {
      h.runs.push(r);
      return runClaudeHeadless(r, fakeSpawn(opts.during));
    },
    print: (t) => h.printed.push(t),
    warn: (t) => h.printed.push(t),
    index: async (start) => {
      h.indexed.push(start);
      await runIndex(start);
    },
    open: (url) => h.opened.push(url),
    serve: (dir, port) => serveStaticSite(dir, { port }),
  };
  return h;
}

const running: PrResult[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

async function prRun(start: string, opts: Parameters<typeof runPrCommand>[1], h: Harness): Promise<PrResult> {
  const result = await runPrCommand(start, opts, h.deps);
  running.push(result);
  return result;
}

const summaryAt = (outDir: string): PrSummary => JSON.parse(readFileSync(join(outDir, "data", "pr-summary.json"), "utf8")) as PrSummary;

/** GET `url`; `rawPath` is sent as is (a URL string would have its "%2e%2e" normalised away before sending). */
function get(url: string, host?: string, rawPath?: string): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: rawPath ?? `${u.pathname}${u.search}`, headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function apiPr(): Promise<string> {
  const root = await setUpFolder();
  makeApiPr(root);
  return root;
}

describe("codeloom pr", () => {
  it("indexes, writes the PR's snapshot under .codeloom/pr/<short head>/, serves it and opens This PR", async () => {
    const root = await apiPr();
    const h = harness();
    const result = await prRun(root, { repo: "api" }, h);

    expect(h.indexed).toEqual([root]);
    const head = git(join(root, "api"), ["rev-parse", "HEAD"]).trim();
    expect(result.outDir).toBe(join(root, ".codeloom", "pr", head.slice(0, 7)));
    expect(existsSync(join(result.outDir, "index.html"))).toBe(true);
    expect(readFileSync(join(root, ".codeloom", "pr", ".gitignore"), "utf8")).toBe("*\n");
    const s = summaryAt(result.outDir);
    expect(s.status).toBe("draft");
    expect(s.repoId).toBe("api");

    // served on 127.0.0.1, the browser opened on the This PR page
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/review$/);
    expect(h.opened).toEqual([result.url]);
    const page = await get(result.url!.replace("#/review", ""));
    expect(page.status).toBe(200);
    expect(page.body).toContain("<div id=\"root\">");
    const data = await get(result.url!.replace("#/review", "data/pr-summary.json"));
    expect(JSON.parse(data.body)).toEqual(s);

    const out = h.printed.join("\n");
    // the default base: origin/main is not there, so main
    expect(out).toContain("Comparing with main");
    // the block to paste into the PR description, and the URL last
    expect(out).toContain("### 🗺 codeloom review map");
    expect(out).toContain("_Draft by codeloom — not checked._");
    expect(h.printed.at(-1)).toContain(result.url);
    // non-interactive, no --check: Claude is never asked or run
    expect(h.asked).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("--no-open serves and prints the URL but opens nothing", async () => {
    const root = await apiPr();
    const h = harness();
    const result = await prRun(root, { repo: "api", open: false }, h);
    expect(h.opened).toEqual([]);
    expect(h.printed.join("\n")).toContain(result.url);
  });

  it("on a terminal with claude on PATH, asks first (default no) and never runs claude on a no", async () => {
    const root = await apiPr();
    const h = harness({ claude: "/opt/bin/claude", interactive: true, answer: false });
    const result = await prRun(root, { repo: "api" }, h);
    expect(h.asked).toEqual([CHECK_PR_QUESTION]);
    expect(h.runs).toEqual([]);
    expect(summaryAt(result.outDir).status).toBe("draft");
  });

  it("a yes runs the isolated check, and the page and block carry Claude's checked summary", async () => {
    const root = await apiPr();
    const head = git(join(root, "api"), ["rev-parse", "HEAD"]).trim();
    const h = harness({
      claude: "/opt/bin/claude",
      interactive: true,
      answer: true,
      during: () => savePrReview(root, { head, whatItDoes: "Creating a customer now pings a webhook." }),
    });
    const result = await prRun(root, { repo: "api" }, h);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.allowedTools).toEqual(["mcp__codeloom__save_pr_review"]);
    expect(h.runs[0]!.cwd).toBe(root);
    const s = summaryAt(result.outDir);
    expect(s.status).toBe("checked");
    expect(s.whatItDoes).toBe("Creating a customer now pings a webhook.");
    expect(h.printed.join("\n")).toContain("**What it does:** Creating a customer now pings a webhook.");
  });

  it("--check is the consent: no question, the check runs", async () => {
    const root = await apiPr();
    const head = git(join(root, "api"), ["rev-parse", "HEAD"]).trim();
    const h = harness({ claude: "/opt/bin/claude", during: () => savePrReview(root, { head, whatItDoes: "Pings a webhook." }) });
    const result = await prRun(root, { repo: "api", check: true }, h);
    expect(h.asked).toEqual([]);
    expect(h.runs).toHaveLength(1);
    expect(summaryAt(result.outDir).status).toBe("checked");
  });

  it("a saved review for this head is reused without asking again", async () => {
    const root = await apiPr();
    const packet = buildCheckPacket(root, "main", { repoId: "api" });
    rememberPacket(root, packet);
    savePrReview(root, { head: packet.head, whatItDoes: "Already checked." });
    const h = harness({ claude: "/opt/bin/claude", interactive: true, answer: true });
    const result = await prRun(root, { repo: "api" }, h);
    expect(h.asked).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(summaryAt(result.outDir).whatItDoes).toBe("Already checked.");
  });

  it("without claude on PATH: never asks or runs, prints a hint, shows the draft", async () => {
    const root = await apiPr();
    const h = harness({ claude: null, interactive: true, answer: true });
    const result = await prRun(root, { repo: "api" }, h);
    expect(h.asked).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.printed.join("\n")).toContain("Claude Code is not on PATH");
    expect(summaryAt(result.outDir).status).toBe("draft");
  });

  it("re-running replaces its own folder; a non-empty --out codeloom does not own is refused, untouched", async () => {
    const root = await apiPr();
    const first = await prRun(root, { repo: "api", open: false }, harness());
    writeFileSync(join(first.outDir, "stale.txt"), "old");
    await first.close();
    running.splice(running.indexOf(first), 1);
    const second = await prRun(root, { repo: "api", open: false }, harness());
    expect(second.outDir).toBe(first.outDir);
    expect(existsSync(join(second.outDir, "stale.txt"))).toBe(false);
    expect(existsSync(join(second.outDir, "index.html"))).toBe(true);

    const foreign = mkdtempSync(join(tmpdir(), "codeloom-pr-foreign-"));
    writeFileSync(join(foreign, "notes.txt"), "mine");
    await expect(runPrCommand(root, { repo: "api", out: foreign, open: false }, harness().deps)).rejects.toMatchObject({ exitCode: 2 });
    expect(readFileSync(join(foreign, "notes.txt"), "utf8")).toBe("mine");
  });

  it("--out to an empty folder works, and re-running into it again is allowed (it is codeloom's now)", async () => {
    const root = await apiPr();
    const out = join(mkdtempSync(join(tmpdir(), "codeloom-pr-out-")), "site");
    const a = await prRun(root, { repo: "api", out, open: false }, harness());
    expect(a.outDir).toBe(out);
    await a.close();
    running.splice(running.indexOf(a), 1);
    const b = await prRun(root, { repo: "api", out, open: false }, harness());
    expect(existsSync(join(b.outDir, "data", "pr-summary.json"))).toBe(true);
  });
});

describe("codeloom pr — review round 1", () => {
  it("I1: a changed file whose name holds a newline does not break it", async () => {
    const root = await apiPr();
    const api = join(root, "api");
    writeFileSync(join(api, "database", "migrations", "a\nb.sql"), "select 1;\n");
    git(api, ["add", "-A"]);
    git(api, ["commit", "-q", "-m", "an odd migration name"]);
    const h = harness();
    const result = await prRun(root, { repo: "api", open: false }, h);
    const s = summaryAt(result.outDir);
    expect(s.beforeDeploying.some((r) => r.file?.includes("a\nb.sql"))).toBe(true);
    expect(result.url).toBeDefined();
  });

  it("M1: the ownership marker is written first, so a run that fails mid-write leaves a folder the next run may replace", async () => {
    const root = await apiPr();
    // An unreadable saved review makes loadPrReview warn twice (the check step, then the snapshot writer); the
    // second warning throws, failing the run after the folder was started.
    const head = git(join(root, "api"), ["rev-parse", "HEAD"]).trim();
    mkdirSync(join(root, ".codeloom", "reviews"), { recursive: true });
    writeFileSync(join(root, ".codeloom", "reviews", `${head}.json`), "not json");
    const out = join(mkdtempSync(join(tmpdir(), "codeloom-pr-m1-")), "site");
    const failing = harness();
    let warned = 0;
    failing.deps.warn = () => {
      if (++warned === 2) throw new Error("boom");
    };
    await expect(runPrCommand(root, { repo: "api", out, open: false }, failing.deps)).rejects.toThrow("boom");
    expect(readFileSync(join(out, PR_OWNED_MARKER), "utf8")).toBe(PR_OWNED_TEXT);
    const again = await prRun(root, { repo: "api", out, open: false }, harness());
    expect(existsSync(join(again.outDir, "index.html"))).toBe(true);
  });

  it("M2: an --out folder is replaced only when its marker is codeloom's and it holds only what a snapshot writes", async () => {
    const root = await apiPr();
    const out = join(mkdtempSync(join(tmpdir(), "codeloom-pr-m2-")), "site");
    const first = await prRun(root, { repo: "api", out, open: false }, harness());
    await first.close();
    running.splice(running.indexOf(first), 1);
    // something of the user's added next to the snapshot: refused, untouched
    writeFileSync(join(out, "notes.txt"), "mine");
    await expect(runPrCommand(root, { repo: "api", out, open: false }, harness().deps)).rejects.toMatchObject({ exitCode: 2 });
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("mine");

    // a marker file with other text is not codeloom's marker
    const other = mkdtempSync(join(tmpdir(), "codeloom-pr-m2b-"));
    mkdirSync(join(other, "data"));
    writeFileSync(join(other, PR_OWNED_MARKER), "someone else's file\n");
    await expect(runPrCommand(root, { repo: "api", out: other, open: false }, harness().deps)).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync(join(other, "data"))).toBe(true);
  });

  it(`M3: keeps only the last ${5} marker-owned folders in .codeloom/pr/, never anything else`, async () => {
    const root = await apiPr();
    const prDir = join(root, ".codeloom", "pr");
    mkdirSync(prDir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const d = join(prDir, `old${i}`);
      mkdirSync(join(d, "data"), { recursive: true });
      writeFileSync(join(d, PR_OWNED_MARKER), PR_OWNED_TEXT);
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(join(d, PR_OWNED_MARKER), t, t);
    }
    mkdirSync(join(prDir, "keepme"));
    writeFileSync(join(prDir, "keepme", "x.txt"), "mine");
    const result = await prRun(root, { repo: "api", open: false }, harness());
    const left = readdirSync(prDir).filter((n) => n !== ".gitignore").sort();
    expect(PR_KEEP).toBe(5);
    // the new one plus the 4 newest old ones; the user's folder is never touched
    expect(left).toEqual(["keepme", "old2", "old3", "old4", "old5", result.outDir.slice(prDir.length + 1)].sort());
  });

  it("M4: a reused review says so; --recheck runs the check again and replaces it", async () => {
    const root = await apiPr();
    const packet = buildCheckPacket(root, "main", { repoId: "api" });
    rememberPacket(root, packet);
    savePrReview(root, { head: packet.head, whatItDoes: "First check." }, { now: () => new Date("2026-11-16T10:00:00Z") });

    const reuse = harness({ claude: "/opt/bin/claude" });
    const a = await prRun(root, { repo: "api", open: false }, reuse);
    expect(reuse.printed.join("\n")).toContain("Reusing Claude's review from 2026-11-16 (run with --recheck to check again)");
    expect(reuse.runs).toEqual([]);
    await a.close();
    running.splice(running.indexOf(a), 1);

    const recheck = harness({ claude: "/opt/bin/claude", during: () => savePrReview(root, { head: packet.head, whatItDoes: "Second check." }) });
    const b = await prRun(root, { repo: "api", recheck: true, open: false }, recheck);
    expect(recheck.asked).toEqual([]);
    expect(recheck.runs).toHaveLength(1);
    expect(summaryAt(b.outDir).whatItDoes).toBe("Second check.");
    expect(recheck.printed.join("\n")).not.toContain("Reusing Claude's review");
  });

  it("M4: --recheck without claude on PATH runs nothing, says so, and keeps the saved review", async () => {
    const root = await apiPr();
    const packet = buildCheckPacket(root, "main", { repoId: "api" });
    rememberPacket(root, packet);
    savePrReview(root, { head: packet.head, whatItDoes: "First check." });
    const h = harness({ claude: null });
    const result = await prRun(root, { repo: "api", recheck: true, open: false }, h);
    expect(h.runs).toEqual([]);
    expect(h.printed.join("\n")).toContain("Claude Code is not on PATH");
    expect(summaryAt(result.outDir).whatItDoes).toBe("First check.");
  });

  it("M6: an --out inside a workspace repo is refused; inside .codeloom it is fine", async () => {
    const root = await apiPr();
    await expect(runPrCommand(root, { repo: "api", out: join(root, "api", "pr-site"), open: false }, harness().deps)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('inside repo "api"'),
    });
    expect(existsSync(join(root, "api", "pr-site"))).toBe(false);
    const ok = await prRun(root, { repo: "api", out: join(root, ".codeloom", "my-pr"), open: false }, harness());
    expect(existsSync(join(ok.outDir, "index.html"))).toBe(true);
  });
});

describe("defaultBaseRef", () => {
  it("origin/main, else main, else master; none → a usage error naming --base", () => {
    const repo = mkdtempSync(join(tmpdir(), "codeloom-base-"));
    git(repo, ["init", "-q", "-b", "trunk"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "a"]);
    expect(() => defaultBaseRef(repo)).toThrow(/--base/);
    git(repo, ["branch", "master"]);
    expect(defaultBaseRef(repo)).toBe("master");
    git(repo, ["branch", "main"]);
    expect(defaultBaseRef(repo)).toBe("main");
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(defaultBaseRef(repo)).toBe("origin/main");
  });
});

describe("serveStaticSite", () => {
  it("serves the folder on 127.0.0.1: index.html at /, files by path; refuses other hosts, escapes and writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-static-"));
    writeFileSync(join(dir, "index.html"), "<html>hi</html>");
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "x.json"), '{"a":1}');
    const site = await serveStaticSite(dir, {});
    try {
      expect(site.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await get(site.url)).toEqual({ status: 200, body: "<html>hi</html>" });
      expect(await get(`${site.url}data/x.json`)).toEqual({ status: 200, body: '{"a":1}' });
      expect((await get(`${site.url}data/missing.json`)).status).toBe(404);
      expect((await get(site.url, undefined, "/%2e%2e/%2e%2e/etc/passwd")).status).toBe(400);
      expect((await get(site.url, undefined, "/data%2fx.json")).status).toBe(400);
      expect((await get(site.url, "evil.example:80")).status).toBe(403);
    } finally {
      await site.close();
    }
  });
});

describe("codeloom pr (cli wiring)", () => {
  it("registers --base, --repo, --check, --recheck, --no-open, --port and --out", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "pr")!;
    expect(cmd).toBeDefined();
    expect(cmd.options.map((o) => o.long).sort()).toEqual(["--base", "--check", "--no-open", "--out", "--port", "--recheck", "--repo"]);
  });

  it("a bad --port is a usage error (exit 2)", async () => {
    const program = buildProgram();
    let thrown: unknown;
    try {
      await program.parseAsync(["node", "codeloom", "pr", "--port", "nope"]);
    } catch (err) {
      thrown = err;
    }
    expect(exitCodeFor(thrown)).toBe(2);
  });
});
