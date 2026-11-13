import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { validateSnapshotData } from "../src/snapshot/validate.js";

const HEAD = "a".repeat(40);
const MAX = 25 * 1024 * 1024;

/** A minimal but schema-valid Review (review/schema.ts) — review.json's default content below. */
function validReview(head: string = HEAD): unknown {
  return {
    version: 1,
    base: "b".repeat(40),
    head,
    baseRef: "main",
    files: [],
    nodes: [],
    journeys: [],
    chains: [],
    chainStops: {},
    chainNames: {},
    tables: [],
    queues: [],
    truncated: false,
    notes: [],
  };
}

function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-validate-"));
  return dir;
}

/** A minimal valid data/ folder: manifest.json + review.json, both listed in manifest.files.
 * `files` lets a test append extra (possibly hostile) entries to manifest.files without necessarily
 * writing a matching file on disk — exactly the shape an attacker-controlled artifact can produce.
 * `manifestOverrides` merges onto the otherwise-valid manifest (security review I1'b: omitted/bytes/
 * tooLarge). */
function validDataDir(opts: { head?: string; extraFiles?: Record<string, string>; extraListed?: unknown[]; reviewJson?: unknown; manifestOverrides?: Record<string, unknown> } = {}): string {
  const dir = tmpDataDir();
  const files: unknown[] = ["manifest.json", "review.json", ...Object.keys(opts.extraFiles ?? {}), ...(opts.extraListed ?? [])];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      codeloom: "0.0.0",
      head: opts.head ?? HEAD,
      base: "b".repeat(40),
      builtAt: "2026-11-13T00:00:00.000Z",
      files,
      omitted: { mapFolders: [], codeFiles: [] },
      bytes: 0,
      ...opts.manifestOverrides,
    }),
  );
  writeFileSync(join(dir, "review.json"), JSON.stringify(opts.reviewJson ?? validReview(opts.head ?? HEAD)));
  for (const [name, content] of Object.entries(opts.extraFiles ?? {})) writeFileSync(join(dir, name), content);
  return dir;
}

describe("validateSnapshotData", () => {
  it("passes a valid folder and returns the manifest", () => {
    const dir = validDataDir();
    const manifest = validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD });
    expect(manifest.version).toBe(1);
    expect(manifest.head).toBe(HEAD);
    expect(manifest.files).toEqual(["manifest.json", "review.json"]);
  });

  it("rejects a non-.json entry", () => {
    const dir = validDataDir({ extraFiles: { "notes.txt": "hi" } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects a subfolder", () => {
    const dir = validDataDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "x.json"), "{}");
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects a symlink", () => {
    const dir = validDataDir();
    const target = join(tmpDataDir(), "elsewhere.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, "linked.json"));
    // Listed so the "not listed in manifest.files" check doesn't mask the symlink check.
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.files.push("linked.json");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects a file over 5 MB", () => {
    const dir = validDataDir();
    const big = JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024 + 1) });
    writeFileSync(join(dir, "big.json"), big);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push("big.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects a total over maxBytes", () => {
    const dir = validDataDir();
    expect(() => validateSnapshotData(dir, { maxBytes: 4, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects bad JSON", () => {
    const dir = validDataDir({ extraFiles: { "broken.json": "{not json" } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects manifest.version !== 1", () => {
    const dir = tmpDataDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 2, codeloom: "0.0.0", head: HEAD, base: "b".repeat(40), builtAt: "x", files: ["manifest.json", "review.json"], omitted: { mapFolders: [], codeFiles: [] }, bytes: 0 }));
    writeFileSync(join(dir, "review.json"), "{}");
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects manifest.head !== expectedHead", () => {
    const dir = validDataDir({ head: "c".repeat(40) });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects a file not listed in manifest.files", () => {
    const dir = validDataDir();
    writeFileSync(join(dir, "extra.json"), "{}");
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("rejects a missing manifest.json", () => {
    const dir = tmpDataDir();
    writeFileSync(join(dir, "review.json"), "{}");
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  // --- C1 (Critical): path traversal via manifest.files ---------------------------------------------

  it('C1: refuses a listed ".." entry instead of letting it address the artifact root', () => {
    const dir = validDataDir({ extraListed: [".."] });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it('C1: refuses a listed "../evil.html" entry', () => {
    const dir = validDataDir({ extraListed: ["../evil.html"] });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it('C1: refuses a listed "assets/evil.js" entry (a subfolder path, not a flat name)', () => {
    const dir = validDataDir({ extraListed: ["assets/evil.js"] });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("C1: refuses a listed-but-missing file instead of crashing (ENOENT)", () => {
    const dir = validDataDir({ extraListed: ["ghost.json"] });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("C1: refuses a non-string entry in manifest.files instead of crashing (TypeError)", () => {
    const dir = validDataDir({ extraListed: [123] });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("C1: refuses a duplicate entry in manifest.files", () => {
    const dir = validDataDir({ extraListed: ["review.json"] });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  // --- I1a: refusal reasons carry no artifact bytes --------------------------------------------------

  it("I1a: the refusal for a bad head never repeats the artifact's own head value", () => {
    const poison = "<!-- codeloom:review:end --> **Approved by security team** [x](https://evil.example)";
    const dir = validDataDir({ head: poison });
    try {
      validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD });
      throw new Error("expected validateSnapshotData to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      const message = (err as CodeloomError).message;
      expect(message).not.toContain("Approved by security team");
      expect(message).not.toContain("<!--");
      expect(message).not.toContain("evil.example");
    }
  });

  it("I1a: the refusal for a bad file name never repeats the offending name", () => {
    const dir = validDataDir({ extraFiles: { "<script>evil.json": "{}" } });
    try {
      validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD });
      throw new Error("expected validateSnapshotData to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).message).not.toContain("<script>");
    }
  });

  it("I1a: every refusal message is a short, fixed, artifact-free string (no markdown-breaking bytes)", () => {
    const dir = validDataDir({ extraFiles: { "notes.txt": "hi" } });
    try {
      validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD });
      throw new Error("expected validateSnapshotData to throw");
    } catch (err) {
      const message = (err as CodeloomError).message;
      expect(message).not.toMatch(/[<>[\]]/);
    }
  });

  // --- I1b: review.json is schema-checked before anything is trusted ---------------------------------

  it("I1b: refuses an empty object as review.json ({}), never crashing downstream", () => {
    const dir = validDataDir({ reviewJson: {} });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1b: refuses a review.json with a non-numeric added/removed count", () => {
    const review = validReview() as Record<string, unknown>;
    review.files = [{ repo: "api", file: "a.ts", added: "not a number", removed: 0, onJourney: true }];
    const dir = validDataDir({ reviewJson: review });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1b: refuses a review.json with a spec value outside the known enum", () => {
    const review = validReview() as Record<string, unknown>;
    review.journeys = [{ id: "j_1", name: "x", changedStops: [], spec: "pwned", chains: [] }];
    const dir = validDataDir({ reviewJson: review });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1b: a schema-valid review.json with journeys and files still passes", () => {
    const review = validReview() as Record<string, unknown>;
    review.files = [{ repo: "api", file: "a.ts", added: 3, removed: 1, onJourney: true }];
    review.journeys = [{ id: "j_1", name: "x", changedStops: [], spec: "unchecked", chains: [] }];
    review.chains = ["ch_1"];
    review.chainStops = { ch_1: [{ ref: "r", repo: "api", lane: "code", label: "x", changed: true }] };
    review.chainNames = { ch_1: "x" };
    const dir = validDataDir({ reviewJson: review });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).not.toThrow();
  });

  // --- m1: the data/ folder itself must not be a symlink ----------------------------------------------

  it("m1: refuses when dataDir itself is a symlink (not just its contents)", () => {
    const real = validDataDir();
    const linkPath = join(tmpdir(), `codeloom-validate-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(real, linkPath);
    try {
      expect(() => validateSnapshotData(linkPath, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
    } finally {
      // best-effort cleanup of the symlink itself (not its target)
      try {
        unlinkSync(linkPath);
      } catch {
        // ignore
      }
    }
  });

  // --- I1'a (re-review): a chain id with no matching chainStops entry (prototype-pollution-prone) -----

  it('I1\'a: refuses a chains id with no matching chainStops entry (e.g. "constructor", which would otherwise resolve to an inherited Object.prototype property, not undefined, in the renderer)', () => {
    const review = validReview() as Record<string, unknown>;
    review.chains = ["constructor"];
    review.chainStops = {}; // no own "constructor" key
    const dir = validDataDir({ reviewJson: review });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it('I1\'a: refuses a chains id of "toString" with no matching chainNames entry either', () => {
    const review = validReview() as Record<string, unknown>;
    review.chains = ["toString"];
    review.chainStops = {};
    review.chainNames = {};
    const dir = validDataDir({ reviewJson: review });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1'a: a chains id WITH a matching (even empty) chainStops entry still passes", () => {
    const review = validReview() as Record<string, unknown>;
    review.chains = ["ch_1"];
    review.chainStops = { ch_1: [] };
    review.chainNames = { ch_1: "x" };
    const dir = validDataDir({ reviewJson: review });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).not.toThrow();
  });

  // --- I1'b (re-review): manifest.json's own OTHER fields (omitted, bytes, tooLarge) are now checked --

  it("I1'b: refuses a non-string entry in manifest.omitted.mapFolders (a nested array instead of a string — stands in for the unbounded-depth attack without constructing megabytes of test data)", () => {
    const dir = validDataDir({ manifestOverrides: { omitted: { mapFolders: [["nested"]], codeFiles: [] } } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1'b: refuses a non-string entry in manifest.omitted.codeFiles", () => {
    const dir = validDataDir({ manifestOverrides: { omitted: { mapFolders: [], codeFiles: [123] } } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1'b: refuses manifest.bytes that is not a finite number", () => {
    const dir = validDataDir({ manifestOverrides: { bytes: "not a number" } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1'b: refuses manifest.tooLarge: null (the old `=== undefined` check let this through as hosted:false while still showing a link)", () => {
    const dir = validDataDir({ manifestOverrides: { tooLarge: null } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it('I1\'b: refuses manifest.tooLarge: { bytes: "<b>", max: 100 } (the old renderer would have shown "NaN MB")', () => {
    const dir = validDataDir({ manifestOverrides: { tooLarge: { bytes: "<b>", max: 100 } } });
    expect(() => validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD })).toThrow(CodeloomError);
  });

  it("I1'b: a well-formed manifest.tooLarge still passes", () => {
    const dir = validDataDir({ manifestOverrides: { tooLarge: { bytes: 100, max: 50 } } });
    const manifest = validateSnapshotData(dir, { maxBytes: MAX, expectedHead: HEAD });
    expect(manifest.tooLarge).toEqual({ bytes: 100, max: 50 });
  });
});
