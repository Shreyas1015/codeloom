import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { grammarPath } from "./grammar-path.js";

const require = createRequire(import.meta.url);

describe("grammarPath", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("prefers a bundled grammars/<file> next to the entry when present", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-grammars-"));
    dirs.push(root);
    mkdirSync(join(root, "grammars"));
    const bundled = join(root, "grammars", "tree-sitter-typescript.wasm");
    writeFileSync(bundled, "wasm");

    expect(
      grammarPath("tree-sitter-typescript", "tree-sitter-typescript.wasm", { baseDir: root }),
    ).toBe(bundled);
  });

  it("falls back to resolving the npm package when no bundled file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-grammars-"));
    dirs.push(root);

    expect(
      grammarPath("tree-sitter-typescript", "tree-sitter-tsx.wasm", { baseDir: root }),
    ).toBe(require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"));
  });

  it("defaults to the directory of the defining module (unbundled: falls back to the package)", () => {
    expect(grammarPath("tree-sitter-javascript", "tree-sitter-javascript.wasm")).toBe(
      require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm"),
    );
  });

  it("throws when the grammar is neither bundled nor installed", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-grammars-"));
    dirs.push(root);
    expect(() =>
      grammarPath("tree-sitter-nope", "tree-sitter-nope.wasm", { baseDir: root }),
    ).toThrow();
  });
});
