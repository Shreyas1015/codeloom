import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSnapshot, runSnapshotSite } from "../src/commands/snapshot.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildFailedBlock, buildSnapshotSite } from "../src/snapshot/site.js";
import { writeSnapshotData } from "../src/snapshot/write.js";
import { git } from "../src/workspace/git.js";
import { commitChange, materializeSingleRepo } from "./helpers.js";

async function setUp(): Promise<string> {
  const root = materializeSingleRepo("demo-shop");
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [] }),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "add workspace"]);
  await runIndex(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "index"]);
  git(root, ["checkout", "-q", "-b", "feature"]);
  commitChange(
    root,
    "api/app/services/customer_service.ts",
    (text) => text.replace("    const customer = await Customer.create(payload);\n", "    const customer = await Customer.create({ ...payload });\n"),
    "tweak CustomerService.create",
  );
  return root;
}

function tmpOutDir(): string {
  return join(mkdtempSync(join(tmpdir(), "codeloom-site-")), "out");
}

describe("buildSnapshotSite", () => {
  it("hosts the snapshot: copies data/, copies the dashboard assets, patches pr + repoSlug, renders review.md with the link", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const outDir = tmpOutDir();

    const result = buildSnapshotSite({
      dataDir: join(dataOut, "data"),
      outDir,
      expectedHead: manifest.head,
      pr: 42,
      repoSlug: "acme/widgets",
      link: "https://acme.github.io/widgets/pr-42/",
    });

    expect(result.hosted).toBe(true);
    expect(result.reviewMd).toContain("### 🗺 codeloom review map");
    expect(result.reviewMd).toContain("https://acme.github.io/widgets/pr-42/");

    // Dashboard assets copied next to data/ (this codeloom version's own build, never anything from the
    // artifact).
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "assets"))).toBe(true);

    // data/ copied, with pr + repoSlug patched into the manifest.
    expect(existsSync(join(outDir, "data", "review.json"))).toBe(true);
    const outManifest = JSON.parse(readFileSync(join(outDir, "data", "manifest.json"), "utf8"));
    expect(outManifest.pr).toBe(42);
    expect(outManifest.repoSlug).toBe("acme/widgets");
    expect(outManifest.head).toBe(manifest.head);
  });

  it("splices the review block into a PR body file when --body is given", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const outDir = tmpOutDir();
    const bodyFile = join(mkdtempSync(join(tmpdir(), "codeloom-body-")), "body.md");
    writeFileSync(bodyFile, "## My PR\n\nDescription here.");

    const result = buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head, bodyFile });

    expect(result.body).toBeDefined();
    expect(result.body).toContain("## My PR");
    expect(result.body).toContain("Description here.");
    expect(result.body).toContain("<!-- codeloom:review:start -->");
    expect(result.comment).toBeUndefined();
  });

  it("tooLarge manifest: no dashboard assets, hosted false, the block says too large", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut, maxBytes: 1 });
    expect(manifest.tooLarge).toBeDefined();
    const outDir = tmpOutDir();

    const result = buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head });

    expect(result.hosted).toBe(false);
    expect(result.reviewMd).toContain("too large to host");
    expect(existsSync(join(outDir, "index.html"))).toBe(false);
    expect(existsSync(join(outDir, "assets"))).toBe(false);
    expect(existsSync(join(outDir, "data", "manifest.json"))).toBe(true);
  });

  it("refuses an artifact with a top-level index.html before writing anything to outDir", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    writeFileSync(join(dataOut, "data", "index.html"), "<html>evil</html>");
    const outDir = tmpOutDir();

    expect(() => buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head })).toThrow();
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses an artifact with a nested assets/evil.js before writing anything to outDir", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    mkdirSync(join(dataOut, "data", "assets"));
    writeFileSync(join(dataOut, "data", "assets", "evil.js"), "alert(1)");
    const outDir = tmpOutDir();

    expect(() => buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head })).toThrow();
    expect(existsSync(outDir)).toBe(false);
  });

  it("C1 (security review, reproduced end to end): a listed \"..\" entry never publishes the artifact root's evil.html/assets/evil.js", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });

    // The artifact root (a sibling of data/, exactly like a real build artifact's extracted contents)
    // carries attacker HTML/JS; manifest.files lists ".." alongside the real entries so `join(dataDir,
    // "..")` would resolve to that root.
    writeFileSync(join(dataOut, "evil.html"), "<html>pwned</html>");
    mkdirSync(join(dataOut, "assets"));
    writeFileSync(join(dataOut, "assets", "evil.js"), "alert(document.cookie)");
    const manifestPath = join(dataOut, "data", "manifest.json");
    const onDiskManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    onDiskManifest.files.push("..");
    writeFileSync(manifestPath, JSON.stringify(onDiskManifest));

    const outDir = tmpOutDir();
    expect(() => buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head })).toThrow();
    // Nothing published at all — never mind evil.html/assets/evil.js specifically.
    expect(existsSync(outDir)).toBe(false);
  });

  it('I1\' (re-review): a chain id of "constructor" with no matching chainStops entry refuses cleanly (not a crash) and leaves outDir untouched — render runs before any write', async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });

    const reviewPath = join(dataOut, "data", "review.json");
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    review.chains = ["constructor"];
    review.chainStops = {};
    review.chainNames = {};
    writeFileSync(reviewPath, JSON.stringify(review));

    const outDir = tmpOutDir();
    expect(() => buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head })).toThrow();
    expect(existsSync(outDir)).toBe(false);
  });

  it('C1\' (Critical, re-review): refuses a non-empty outDir instead of wiping it, and NEVER deletes anything already there', async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const outDir = tmpOutDir();
    mkdirSync(outDir, { recursive: true });
    // Pre-existing, unrelated content (e.g. a checked-out gh-pages pr-<n>/ folder with real files) —
    // round 1's resetOutDir would have rmSync'd exactly these.
    writeFileSync(join(outDir, "README.md"), "pre-existing readme");
    mkdirSync(join(outDir, "keep"));
    writeFileSync(join(outDir, "keep", "notes.txt"), "do not delete me");

    expect(() => buildSnapshotSite({ dataDir: join(dataOut, "data"), outDir, expectedHead: manifest.head })).toThrow();

    expect(readFileSync(join(outDir, "README.md"), "utf8")).toBe("pre-existing readme");
    expect(readFileSync(join(outDir, "keep", "notes.txt"), "utf8")).toBe("do not delete me");
    // And nothing new was added either (no data/, no dashboard assets).
    expect(existsSync(join(outDir, "data"))).toBe(false);
    expect(existsSync(join(outDir, "index.html"))).toBe(false);
  });

  it("--pages-disabled: the Pages note replaces the link, even when link is also given", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const outDir = tmpOutDir();

    const result = buildSnapshotSite({
      dataDir: join(dataOut, "data"),
      outDir,
      expectedHead: manifest.head,
      link: "https://acme.github.io/widgets/pr-42/",
      pagesDisabled: true,
    });

    expect(result.reviewMd).toContain("GitHub Pages is not enabled for this repo");
    expect(result.reviewMd).not.toContain("Open the full review map");
    expect(result.reviewMd).not.toContain("https://acme.github.io/widgets/pr-42/");
  });

  it("C1': the same-dir case (codeloom snapshot: dataDir === outDir/data) is the one legitimate exception — outDir already has exactly its own data/ and that alone is not a refusal", async () => {
    const root = await setUp();
    const out = tmpOutDir();
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: out });

    const result = buildSnapshotSite({ dataDir: join(out, "data"), outDir: out, expectedHead: manifest.head });

    expect(result.hosted).toBe(true);
    expect(existsSync(join(out, "data", "review.json"))).toBe(true);
  });

  it("C1': the same-dir exception does not extend to any OTHER pre-existing entry — data/ plus something else still refuses", async () => {
    const root = await setUp();
    const out = tmpOutDir();
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: out });
    writeFileSync(join(out, "unexpected.txt"), "not ours");

    expect(() => buildSnapshotSite({ dataDir: join(out, "data"), outDir: out, expectedHead: manifest.head })).toThrow();
    expect(readFileSync(join(out, "unexpected.txt"), "utf8")).toBe("not ours");
  });
});

describe("buildFailedBlock", () => {
  it("C1' (Critical, re-review, exact reproduction): --failed with a non-empty --out refuses instead of wiping README.md/keep/notes.txt", () => {
    const outDir = tmpOutDir();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "README.md"), "pre-existing readme");
    mkdirSync(join(outDir, "keep"));
    writeFileSync(join(outDir, "keep", "notes.txt"), "do not delete me");

    expect(() => buildFailedBlock({ outDir, runUrl: "https://github.com/acme/widgets/actions/runs/123" })).toThrow();

    expect(readFileSync(join(outDir, "README.md"), "utf8")).toBe("pre-existing readme");
    expect(readFileSync(join(outDir, "keep", "notes.txt"), "utf8")).toBe("do not delete me");
    expect(existsSync(join(outDir, "review.md"))).toBe(false);
  });

  it("without a previous manifest: just the error line with the run URL", () => {
    const outDir = tmpOutDir();
    const result = buildFailedBlock({ outDir, runUrl: "https://github.com/acme/widgets/actions/runs/123" });
    expect(result.reviewMd).toContain("https://github.com/acme/widgets/actions/runs/123");
    expect(result.reviewMd).not.toContain("Last good map");
  });

  it("with a previous manifest: the error line plus the last good link", () => {
    const outDir = tmpOutDir();
    const prevDir = mkdtempSync(join(tmpdir(), "codeloom-prev-"));
    const prevManifest = join(prevDir, "manifest.json");
    writeFileSync(prevManifest, JSON.stringify({ version: 1, head: "deadbeef".padEnd(40, "0") }));

    const result = buildFailedBlock({
      outDir,
      runUrl: "https://github.com/acme/widgets/actions/runs/123",
      previousManifest: prevManifest,
      link: "https://acme.github.io/widgets/pr-42/",
    });

    expect(result.reviewMd).toContain("https://github.com/acme/widgets/actions/runs/123");
    expect(result.reviewMd).toContain("Last good map");
    expect(result.reviewMd).toContain("https://acme.github.io/widgets/pr-42/");
  });

  it("splices into a PR body file when --body is given", () => {
    const outDir = tmpOutDir();
    const bodyFile = join(mkdtempSync(join(tmpdir(), "codeloom-body-")), "body.md");
    writeFileSync(bodyFile, "## My PR");

    const result = buildFailedBlock({ outDir, runUrl: "https://github.com/acme/widgets/actions/runs/123", bodyFile });
    expect(result.body).toContain("## My PR");
    expect(result.body).toContain("<!-- codeloom:review:start -->");
  });

  it("final review m6: one trailing newline (what `gh pr view --json body -q .body` adds) is dropped, so re-running on its own output never grows the body", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-body-"));
    const bodyFile = join(dir, "body.txt");
    writeFileSync(bodyFile, "## My PR\n\nDescription.\n"); // gh's own output: the body plus "\n"
    const first = buildFailedBlock({ outDir: tmpOutDir(), runUrl: "https://github.com/acme/widgets/actions/runs/1", bodyFile });
    expect(first.body!.startsWith("## My PR\n\nDescription.\n\n<!-- codeloom:review:start -->")).toBe(true);
    writeFileSync(bodyFile, `${first.body!}\n`); // the next run reads the edited body back through gh again
    const second = buildFailedBlock({ outDir: tmpOutDir(), runUrl: "https://github.com/acme/widgets/actions/runs/1", bodyFile });
    expect(second.body).toBe(first.body);
  });

  it("--pages-disabled: valid in --failed mode too, adds the Pages note", () => {
    const outDir = tmpOutDir();
    const result = buildFailedBlock({ outDir, runUrl: "https://github.com/acme/widgets/actions/runs/123", pagesDisabled: true });
    expect(result.reviewMd).toContain("GitHub Pages is not enabled for this repo");
  });

  it("I4: a missing previous manifest file never crashes — treated as no previous", () => {
    const outDir = tmpOutDir();
    const result = buildFailedBlock({
      outDir,
      runUrl: "https://github.com/acme/widgets/actions/runs/1",
      previousManifest: join(tmpdir(), "codeloom-does-not-exist", "manifest.json"),
      link: "https://acme.github.io/widgets/pr-42/",
    });
    expect(result.reviewMd).not.toContain("Last good map");
  });

  it("I4: unparsable JSON in the previous manifest never crashes — treated as no previous", () => {
    const outDir = tmpOutDir();
    const prevManifest = join(mkdtempSync(join(tmpdir(), "codeloom-prev-")), "manifest.json");
    writeFileSync(prevManifest, "{not json");
    const result = buildFailedBlock({ outDir, runUrl: "https://github.com/acme/widgets/actions/runs/1", previousManifest: prevManifest, link: "https://x/" });
    expect(result.reviewMd).not.toContain("Last good map");
  });

  it("I4: a non-hex / wrong-length head in the previous manifest never crashes — treated as no previous", () => {
    const outDir = tmpOutDir();
    const prevManifest = join(mkdtempSync(join(tmpdir(), "codeloom-prev-")), "manifest.json");
    writeFileSync(prevManifest, JSON.stringify({ head: "not-a-sha" }));
    const result = buildFailedBlock({ outDir, runUrl: "https://github.com/acme/widgets/actions/runs/1", previousManifest: prevManifest, link: "https://x/" });
    expect(result.reviewMd).not.toContain("Last good map");
  });
});

describe("runSnapshot (the codeloom snapshot command)", () => {
  it("writes data/*.json, the dashboard assets and review.md, unless --data-only", async () => {
    const root = await setUp();
    const out = tmpOutDir();
    const result = await runSnapshot(root, { base: "main", out });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "data", "manifest.json"))).toBe(true);
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(existsSync(join(out, "review.md"))).toBe(true);
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("### 🗺 codeloom review map");
  });

  it("--data-only writes only data/*.json: no dashboard assets, no review.md", async () => {
    const root = await setUp();
    const out = tmpOutDir();
    const result = await runSnapshot(root, { base: "main", out, dataOnly: true });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "data", "manifest.json"))).toBe(true);
    expect(existsSync(join(out, "index.html"))).toBe(false);
    expect(existsSync(join(out, "review.md"))).toBe(false);
  });

  it("C1' (Critical, re-review, exact reproduction): a non-empty --out is refused (exit 2) before writeSnapshotData ever runs — nothing added, nothing deleted", async () => {
    const root = await setUp();
    // `codeloom snapshot --base main --out .` on an actual working tree: anything already there
    // (standing in for a repo root's own files, incl. .git) must survive completely untouched.
    const out = mkdtempSync(join(tmpdir(), "codeloom-site-"));
    writeFileSync(join(out, "existing-file.txt"), "pretend this is .git or similar");

    let thrown: unknown;
    try {
      await runSnapshot(root, { base: "main", out });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { exitCode?: number }).exitCode).toBe(2);

    expect(readFileSync(join(out, "existing-file.txt"), "utf8")).toBe("pretend this is .git or similar");
    expect(existsSync(join(out, "data"))).toBe(false);
  });
});

describe("runSnapshotSite (the codeloom snapshot-site command)", () => {
  it("writes the site, data/, and review.md + body.md to disk", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const out = tmpOutDir();
    const bodyFile = join(mkdtempSync(join(tmpdir(), "codeloom-body-")), "body.md");
    writeFileSync(bodyFile, "Existing description.");

    const result = runSnapshotSite({ out, data: join(dataOut, "data"), head: manifest.head, pr: 7, repoSlug: "acme/widgets", link: "https://acme.github.io/widgets/pr-7/", bodyFile });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(existsSync(join(out, "data", "manifest.json"))).toBe(true);
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("### 🗺 codeloom review map");
    const body = readFileSync(join(out, "body.md"), "utf8");
    expect(body).toContain("Existing description.");
    expect(body).toContain("<!-- codeloom:review:start -->");
    expect(existsSync(join(out, "comment.md"))).toBe(false);
  });

  it("a validation failure writes only review.md (the refusal) and exits 1 — nothing else reaches out/", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const out = tmpOutDir();

    // The wrong expectedHead: validateSnapshotData's own manifest.head check refuses it.
    const result = runSnapshotSite({ out, data: join(dataOut, "data"), head: "0".repeat(40) });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("codeloom review map refused:");
    expect(existsSync(join(out, "data"))).toBe(false);
    expect(existsSync(join(out, "index.html"))).toBe(false);
  });

  it("requires either --data/--head or --failed", () => {
    expect(() => runSnapshotSite({ out: tmpOutDir() })).toThrow();
  });

  it("C1' (Critical, re-review): a non-empty --out in data mode is refused (exit 2), contents untouched — not converted into the exit-1 review.md refusal path", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const out = mkdtempSync(join(tmpdir(), "codeloom-site-")); // non-empty: mkdtempSync's own dir has no entries, so plant one
    writeFileSync(join(out, "README.md"), "pre-existing");

    let thrown: unknown;
    try {
      runSnapshotSite({ out, data: join(dataOut, "data"), head: manifest.head });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { exitCode?: number }).exitCode).toBe(2);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("pre-existing");
    expect(existsSync(join(out, "review.md"))).toBe(false);
  });

  it("C1' (Critical, re-review): a non-empty --out in --failed mode is refused (exit 2), contents untouched", () => {
    const out = mkdtempSync(join(tmpdir(), "codeloom-site-"));
    writeFileSync(join(out, "README.md"), "pre-existing");

    let thrown: unknown;
    try {
      runSnapshotSite({ out, failed: "https://github.com/acme/widgets/actions/runs/1" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { exitCode?: number }).exitCode).toBe(2);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("pre-existing");
    expect(existsSync(join(out, "review.md"))).toBe(false);
  });

  it("I2: a validation failure with --body still writes body.md (the refusal spliced in), exit 1", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const out = tmpOutDir();
    const bodyFile = join(mkdtempSync(join(tmpdir(), "codeloom-body-")), "body.md");
    writeFileSync(bodyFile, "## Existing PR description");

    const result = runSnapshotSite({ out, data: join(dataOut, "data"), head: "0".repeat(40), bodyFile });

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(out, "review.md"))).toBe(true);
    const body = readFileSync(join(out, "body.md"), "utf8");
    expect(body).toContain("## Existing PR description");
    expect(body).toContain("codeloom review map refused:");
  });

  it("--failed writes the error block to review.md", () => {
    const out = tmpOutDir();
    const result = runSnapshotSite({ out, failed: "https://github.com/acme/widgets/actions/runs/1" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("https://github.com/acme/widgets/actions/runs/1");
  });

  it("--pages-disabled in data mode: review.md carries the Pages note, no link", async () => {
    const root = await setUp();
    const dataOut = mkdtempSync(join(tmpdir(), "codeloom-data-"));
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir: dataOut });
    const out = tmpOutDir();

    const result = runSnapshotSite({ out, data: join(dataOut, "data"), head: manifest.head, link: "https://acme.github.io/widgets/pr-7/", pagesDisabled: true });

    expect(result.exitCode).toBe(0);
    const reviewMd = readFileSync(join(out, "review.md"), "utf8");
    expect(reviewMd).toContain("GitHub Pages is not enabled for this repo");
    expect(reviewMd).not.toContain("acme.github.io");
  });

  it("--pages-disabled in --failed mode: review.md carries the Pages note", () => {
    const out = tmpOutDir();
    const result = runSnapshotSite({ out, failed: "https://github.com/acme/widgets/actions/runs/1", pagesDisabled: true });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("GitHub Pages is not enabled for this repo");
  });
});

describe("codeloom snapshot / snapshot-site (cli wiring)", () => {
  it("registers snapshot's and snapshot-site's flags", async () => {
    const { buildProgram } = await import("../src/cli.js");
    const program = buildProgram();
    const snapshot = program.commands.find((c) => c.name() === "snapshot")!;
    const snapshotSite = program.commands.find((c) => c.name() === "snapshot-site")!;
    expect(snapshot).toBeDefined();
    expect(snapshot.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--base", "--out", "--max-size", "--data-only"]));
    expect(snapshotSite).toBeDefined();
    expect(snapshotSite.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--out", "--data", "--head", "--failed", "--previous", "--pr", "--repo", "--link", "--body", "--max-size", "--pages-disabled"]),
    );
  });

  it("exits 2 when --base is missing from snapshot", async () => {
    const { buildProgram, exitCodeFor } = await import("../src/cli.js");
    const program = buildProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    let code = 0;
    try {
      await program.parseAsync(["node", "codeloom", "snapshot", "--out", "x"]);
    } catch (err) {
      code = exitCodeFor(err);
    }
    expect(code).toBe(2);
  });
});
