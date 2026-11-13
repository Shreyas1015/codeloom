import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { validateSnapshotData } from "../src/snapshot/validate.js";

const HEAD = "a".repeat(40);
const MAX = 25 * 1024 * 1024;

function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-validate-"));
  return dir;
}

/** A minimal valid data/ folder: manifest.json + review.json, both listed in manifest.files. */
function validDataDir(opts: { head?: string; extraFiles?: Record<string, string> } = {}): string {
  const dir = tmpDataDir();
  const files = ["manifest.json", "review.json", ...Object.keys(opts.extraFiles ?? {})];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 1, codeloom: "0.0.0", head: opts.head ?? HEAD, base: "b".repeat(40), builtAt: "2026-11-13T00:00:00.000Z", files, omitted: { mapFolders: [], codeFiles: [] }, bytes: 0 }),
  );
  writeFileSync(join(dir, "review.json"), JSON.stringify({ version: 1 }));
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
});
