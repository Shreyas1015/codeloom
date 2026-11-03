import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs against core's built dist (the script imports packages/core/dist/languages).
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts/release/collect-grammars.mjs");

const EXPECTED_WASM = [
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-cpp.wasm",
  "tree-sitter-dart.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-kotlin.wasm",
  "tree-sitter-php.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-ruby.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-swift.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-typescript.wasm",
];

// One licence per grammar package; scoped names flatten "@scope/name" to "scope__name".
const EXPECTED_LICENSES = [
  "codeloom__tree-sitter-dart-wasm.txt",
  "codeloom__tree-sitter-swift-wasm.txt",
  "tree-sitter-c-sharp.txt",
  "tree-sitter-cpp.txt",
  "tree-sitter-go.txt",
  "tree-sitter-grammars__tree-sitter-kotlin.txt",
  "tree-sitter-java.txt",
  "tree-sitter-javascript.txt",
  "tree-sitter-php.txt",
  "tree-sitter-python.txt",
  "tree-sitter-ruby.txt",
  "tree-sitter-rust.txt",
  "tree-sitter-typescript.txt",
];

describe("scripts/release/collect-grammars.mjs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("copies every configured grammar .wasm and its package licence", () => {
    const out = mkdtempSync(join(tmpdir(), "codeloom-collect-"));
    dirs.push(out);
    const run = spawnSync(process.execPath, [script, out], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const wasm = readdirSync(out).filter((f) => f.endsWith(".wasm")).sort();
    expect(wasm).toEqual(EXPECTED_WASM);
    for (const f of wasm) {
      // A real wasm module starts with "\0asm".
      expect(readFileSync(join(out, f)).subarray(0, 4).toString("latin1")).toBe("\0asm");
    }

    const licenses = readdirSync(join(out, "LICENSES")).sort();
    expect(licenses).toEqual(EXPECTED_LICENSES);
    for (const f of licenses) {
      expect(readFileSync(join(out, "LICENSES", f), "utf8")).toMatch(/permission is hereby granted/i);
    }
  });

  it("exits 1 and names the missing file when a grammar cannot be found", () => {
    const out = mkdtempSync(join(tmpdir(), "codeloom-collect-"));
    dirs.push(out);
    // Extra "<package>/<file>" arguments are collected too; this one does not exist.
    const run = spawnSync(process.execPath, [script, out, "tree-sitter-nope/tree-sitter-nope.wasm"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("tree-sitter-nope/tree-sitter-nope.wasm");
  });

  it("exits 1 with usage when no output dir is given", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/usage/i);
  });
});
