import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { chainId } from "../src/linker/chains.js";
import { saveJourneysTool } from "../src/mcp/tools/journeys.js";
import { snapshotKey } from "../src/snapshot/key.js";
import { validateSnapshotData } from "../src/snapshot/validate.js";
import { DEFAULT_MAX_BYTES, writeSnapshotData } from "../src/snapshot/write.js";
import { CODE_MAX_BYTES } from "../src/web/api.js";
import { git } from "../src/workspace/git.js";
import { commitChange, materializeSingleRepo } from "./helpers.js";

const CREATE_CUSTOMER_CHAIN = chainId("page:web:/customers/new", "api:POST /api/customers");
const CHANGED_REF = "api::function:app/services/customer_service.ts:CustomerService.create";
const AUDIT_LOG_LINE = '    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });\n';
const VALIDATE_LINES = '    if (!payload.email) {\n      throw new Error("email required");\n    }\n';
const FIXED_NOW = () => new Date("2026-11-13T12:00:00.000Z");

/** demo-shop as one git repo, indexed, with the create-customer journey named and a confirmed spec link to
 * its doc — ready for the caller to branch, edit app/services/customer_service.ts, and snapshot it. */
async function setUp(): Promise<{ root: string; journeyId: string }> {
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
  const { created } = saveJourneysTool(root, [{ op: "create", name: "Create a customer", chainIds: [CREATE_CUSTOMER_CHAIN] }]) as {
    created: string[];
  };
  const journeyId = created[0]!;
  // A confirmed spec link, so docs@... has something real to write (saveSpecLinks goes through the normal
  // path-safety check; a second, unsafe link is added by hand below to test the writer's own check).
  writeFileSync(
    join(root, ".codeloom/specs.json"),
    JSON.stringify({
      version: 1,
      journeys: {
        [journeyId]: {
          checkedAt: "2026-01-01T00:00:00.000Z",
          links: [
            { kind: "doc", ref: "api:docs/customers.md", reason: "the create-customer flow", savedAt: "2026-01-01T00:00:00.000Z" },
            { kind: "doc", ref: "api:.env", reason: "a stale/malicious link", savedAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
      },
    }),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "name the create-customer journey and link its doc"]);
  return { root, journeyId };
}

/** setUp, then one commit changing CustomerService.create on a feature branch off main. */
async function setUpWithChange(): Promise<{ root: string; journeyId: string }> {
  const { root, journeyId } = await setUp();
  git(root, ["checkout", "-q", "-b", "feature"]);
  commitChange(root, "api/app/services/customer_service.ts", (text) => text.replace(AUDIT_LOG_LINE, VALIDATE_LINES), "edit CustomerService.create");
  return { root, journeyId };
}

function readJson(dataDir: string, key: string): unknown {
  return JSON.parse(readFileSync(join(dataDir, `${key}.json`), "utf8"));
}

function tmpOutDir(): string {
  return mkdtempSync(join(tmpdir(), "codeloom-snapshot-"));
}

describe("writeSnapshotData", () => {
  it("writes the always-included set, the changed node, its journey's docs and code, and no progress/search", async () => {
    const { root, journeyId } = await setUpWithChange();
    const outDir = tmpOutDir();

    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir, now: FIXED_NOW });
    const dataDir = join(outDir, "data");
    const present = new Set(readdirSync(dataDir));
    const has = (key: string) => present.has(`${key}.json`);

    // Always-included.
    for (const key of ["overview", "journeys", "chains", "specs", "views", "review", "manifest"]) expect(has(key), key).toBe(true);
    expect(has(`journeys~${journeyId}`)).toBe(true);
    expect(has(`tours~${journeyId}`)).toBe(true);
    expect(has(`specs~${journeyId}`)).toBe(true);
    expect(has("layers@repo=api")).toBe(true);
    expect(has("layers@repo=web")).toBe(true);
    expect(has("graph@repo=api")).toBe(true);
    expect(has("graph@repo=web")).toBe(true);

    // Map: every folder on the path to the one changed file (app/services/customer_service.ts), not an
    // unrelated one.
    expect(has("graph@dir=app&repo=api")).toBe(true);
    expect(has(snapshotKey("/api/graph", { repo: "api", dir: "app/services" }))).toBe(true);
    expect(has(snapshotKey("/api/graph", { repo: "api", dir: "app/controllers" }))).toBe(false);
    // Every data file name is in the static-host-safe charset (final review C1/I1): no "%", no ":".
    for (const file of present) expect(file, file).toMatch(/^[A-Za-z0-9._~@=&-]+\.json$/);

    // The changed node, and every node-bearing stop of the journey it is on (read back from the journey's
    // own API answer, so this does not assume which stops the indexer gives it).
    expect(has(snapshotKey(`/api/node/${encodeURIComponent(CHANGED_REF)}`))).toBe(true);
    const journey = readJson(dataDir, `journeys~${journeyId}`) as { lanes: Record<string, Array<{ repo: string; file: string; ref?: string }>> };
    const stops = Object.values(journey.lanes).flat();
    const refs = stops.map((s) => s.ref).filter((r): r is string => r !== undefined);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const key = snapshotKey(`/api/node/${encodeURIComponent(ref)}`);
      expect(existsSync(join(dataDir, `${key}.json`)), ref).toBe(true);
    }

    // The whole text of every file holding one of those stops, matching the file on disk.
    for (const s of stops) {
      const key = snapshotKey(`/api/files/${s.repo}/${s.file}`);
      expect(existsSync(join(dataDir, `${key}.json`)), `${s.repo}:${s.file}`).toBe(true);
      const body = readJson(dataDir, key) as { file: string; text: string };
      expect(body.text).toBe(readFileSync(join(root, s.repo, s.file), "utf8"));
    }

    // The confirmed doc link, written whole; the stale/malicious one to .env is never written, under any key.
    const docKey = snapshotKey("/api/docs", { repo: "api", file: "docs/customers.md" });
    expect(has(docKey)).toBe(true);
    const doc = readJson(dataDir, docKey) as { text: string };
    expect(doc.text).toContain("Creating a customer");
    for (const file of present) expect(file.toLowerCase()).not.toContain(".env");

    // Never progress or search.
    for (const file of present) {
      expect(file.startsWith("progress")).toBe(false);
      expect(file.startsWith("search")).toBe(false);
    }

    // The manifest itself.
    expect(manifest.version).toBe(1);
    expect(manifest.head).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.base).toMatch(/^[0-9a-f]{40}$/);
    // Final review m1: the --base the user passed, for the banner's "vs main".
    expect(manifest.baseRef).toBe("main");
    expect(manifest.builtAt).toBe(FIXED_NOW().toISOString());
    expect(manifest.tooLarge).toBeUndefined();
    expect(manifest.omitted).toEqual({ mapFolders: [], codeFiles: [] });
    expect(manifest.files).toEqual([...manifest.files].sort());
    expect(new Set(manifest.files)).toEqual(new Set([...present]));
  });

  it("skips a code file over the dashboard's own code size cap (CODE_MAX_BYTES), but keeps the rest", async () => {
    const { root } = await setUpWithChange();
    // The UI page stop of the create-customer journey, grown past CODE_MAX_BYTES. Left uncommitted on
    // purpose: writeSnapshotData reads a stop's whole file straight off the working tree (the same path
    // /api/code and /api/docs use), not from a git blob, so this alone is enough to trigger the cap.
    const pageFile = join(root, "web/app/customers/new/page.tsx");
    writeFileSync(pageFile, `${readFileSync(pageFile, "utf8")}\n// ${"x".repeat(CODE_MAX_BYTES)}\n`);

    const outDir = tmpOutDir();
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir, now: FIXED_NOW });
    const dataDir = join(outDir, "data");

    const oversizedKey = snapshotKey("/api/files/web/app/customers/new/page.tsx");
    expect(existsSync(join(dataDir, `${oversizedKey}.json`))).toBe(false);
    // Skipped for being over the per-file cap, not "cut for the --max-size budget" (manifest.omitted is
    // for that; this file never reached the budget decision at all).
    expect(manifest.omitted.codeFiles).not.toContain(oversizedKey);
    expect(manifest.files).not.toContain(`${oversizedKey}.json`);

    // A different stop of the same journey is still written in full.
    const keptKey = snapshotKey("/api/files/api/app/services/customer_service.ts");
    expect(existsSync(join(dataDir, `${keptKey}.json`))).toBe(true);
  });

  it("final review C1: a change to a Next.js [id] page (web/app/customers/[id]/page.tsx) still produces data the publish step accepts", async () => {
    const { root } = await setUp();
    git(root, ["checkout", "-q", "-b", "feature"]);
    commitChange(root, "web/app/customers/[id]/page.tsx", (text) => text.replace("<h1>{customer.name}</h1>", "<h1>{customer.name}!</h1>"), "edit the [id] page");

    const outDir = tmpOutDir();
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir, now: FIXED_NOW });
    const dataDir = join(outDir, "data");
    expect(() => validateSnapshotData(dataDir, { maxBytes: DEFAULT_MAX_BYTES, expectedHead: manifest.head })).not.toThrow();
    for (const file of manifest.files) expect(file, file).toMatch(/^[A-Za-z0-9._~@=&-]+\.json$/);
    // The [id] folder's own Map level is there, under the same key the dashboard asks for.
    expect(manifest.files).toContain(`${snapshotKey("/api/graph", { repo: "web", dir: "app/customers/[id]" })}.json`);
  });

  it("final review I4: with no journeys named, every affected chain is treated like a journey — its journeys~<chainId>, stop nodes and stop files are written", async () => {
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
    commitChange(root, "api/app/services/customer_service.ts", (text) => text.replace(AUDIT_LOG_LINE, VALIDATE_LINES), "edit CustomerService.create");

    const outDir = tmpOutDir();
    await writeSnapshotData(root, { baseRef: "main", outDir, now: FIXED_NOW });
    const dataDir = join(outDir, "data");
    const review = readJson(dataDir, "review") as { journeys: unknown[]; chains: string[] };
    expect(review.journeys).toEqual([]);
    expect(review.chains.length).toBeGreaterThan(0);
    for (const chainId of review.chains) {
      const key = snapshotKey(`/api/journeys/${chainId}`);
      expect(existsSync(join(dataDir, `${key}.json`)), key).toBe(true);
      const body = readJson(dataDir, key) as { lanes: Record<string, Array<{ repo: string; file: string; ref?: string }>> };
      for (const s of Object.values(body.lanes).flat()) {
        expect(existsSync(join(dataDir, `${snapshotKey(`/api/files/${s.repo}/${s.file}`)}.json`)), `${s.repo}:${s.file}`).toBe(true);
        if (s.ref) expect(existsSync(join(dataDir, `${snapshotKey(`/api/node/${encodeURIComponent(s.ref)}`)}.json`)), s.ref).toBe(true);
      }
    }
    // The create-customer UI page (a stop of the chain, not a changed file) is there for the code panel.
    expect(existsSync(join(dataDir, `${snapshotKey("/api/files/web/app/customers/new/page.tsx")}.json`))).toBe(true);
  });

  it("is deterministic: two runs with the same `now` produce byte-identical data files", async () => {
    const { root } = await setUpWithChange();
    const outA = tmpOutDir();
    const outB = tmpOutDir();

    const manifestA = await writeSnapshotData(root, { baseRef: "main", outDir: outA, now: FIXED_NOW });
    const manifestB = await writeSnapshotData(root, { baseRef: "main", outDir: outB, now: FIXED_NOW });

    expect(manifestA.bytes).toBe(manifestB.bytes);
    const dataA = join(outA, "data");
    const dataB = join(outB, "data");
    const filesA = readdirSync(dataA).sort();
    expect(filesA).toEqual(readdirSync(dataB).sort());
    for (const f of filesA) expect(readFileSync(join(dataA, f))).toEqual(readFileSync(join(dataB, f)));
  });

  describe("the size cap", () => {
    it("cuts Map folders first (code files kept), then code files too once tighter, then only manifest+review below the always-included (API) size", async () => {
      const { root } = await setUpWithChange();

      // A full, uncapped run to learn the natural sizes.
      const fullOut = tmpOutDir();
      const full = await writeSnapshotData(root, { baseRef: "main", outDir: fullOut, now: FIXED_NOW });
      expect(full.omitted).toEqual({ mapFolders: [], codeFiles: [] });
      const fullDataDir = join(fullOut, "data");
      const sizeOf = (key: string) => statSync(join(fullDataDir, `${key}.json`)).size;
      const mapFolderBytes = full.files
        .filter((f) => f.startsWith("graph@dir="))
        .reduce((n, f) => n + sizeOf(f.slice(0, -".json".length)), 0);
      const codeFileBytes = full.files
        .filter((f) => f.startsWith("files~"))
        .reduce((n, f) => n + sizeOf(f.slice(0, -".json".length)), 0);
      expect(mapFolderBytes).toBeGreaterThan(0);
      expect(codeFileBytes).toBeGreaterThan(0);
      const reviewBytes = sizeOf("review");
      const alwaysAndReviewBytes = full.bytes - mapFolderBytes - codeFileBytes;
      const alwaysOnlyBytes = alwaysAndReviewBytes - reviewBytes;

      // Just under the full size: at least one Map folder is cut, every code file is still kept.
      const justUnderOut = tmpOutDir();
      const justUnder = await writeSnapshotData(root, { baseRef: "main", outDir: justUnderOut, maxBytes: full.bytes - 1, now: FIXED_NOW });
      expect(justUnder.omitted.mapFolders.length).toBeGreaterThan(0);
      expect(justUnder.omitted.codeFiles).toEqual([]);
      expect(justUnder.tooLarge).toBeUndefined();

      // Tighter: not enough room for every code file either.
      const tighterOut = tmpOutDir();
      const tighter = await writeSnapshotData(root, {
        baseRef: "main",
        outDir: tighterOut,
        maxBytes: alwaysAndReviewBytes + Math.floor(codeFileBytes / 2),
        now: FIXED_NOW,
      });
      expect(tighter.omitted.mapFolders.length).toBeGreaterThan(0);
      expect(tighter.omitted.codeFiles.length).toBeGreaterThan(0);
      expect(tighter.tooLarge).toBeUndefined();

      // Below the always-included size (the API-derived data alone, not counting review.json, which is
      // always written): only manifest.json and review.json are written, tooLarge is set, and the call
      // still resolves normally (exit 0 is the caller's job, not this function's).
      const tooLargeOut = tmpOutDir();
      const tooLarge = await writeSnapshotData(root, { baseRef: "main", outDir: tooLargeOut, maxBytes: alwaysOnlyBytes - 1, now: FIXED_NOW });
      expect(tooLarge.tooLarge).toBeDefined();
      expect(tooLarge.tooLarge!.max).toBe(alwaysOnlyBytes - 1);
      expect(tooLarge.tooLarge!.bytes).toBeGreaterThan(tooLarge.tooLarge!.max);
      const tooLargeFiles = readdirSync(join(tooLargeOut, "data")).sort();
      expect(tooLargeFiles).toEqual(["manifest.json", "review.json"]);
      expect(tooLarge.files).toEqual(["manifest.json", "review.json"]);
    });
  });

  it("defaults maxBytes to 25 MB", async () => {
    const { root } = await setUpWithChange();
    const outDir = tmpOutDir();
    const manifest = await writeSnapshotData(root, { baseRef: "main", outDir, now: FIXED_NOW });
    expect(manifest.bytes).toBeLessThan(DEFAULT_MAX_BYTES);
    expect(manifest.omitted).toEqual({ mapFolders: [], codeFiles: [] });
  });
});
