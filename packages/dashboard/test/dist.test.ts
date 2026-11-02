// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { findExternalUrls, scanDir } from "../scripts/check-dist.js";

describe("findExternalUrls", () => {
  it("finds http(s) URLs outside comments", () => {
    expect(findExternalUrls(`fetch("https://cdn.example.com/x.js")`)).toEqual(["https://cdn.example.com/x.js"]);
    expect(findExternalUrls(`@import url(http://fonts.example.com/a.css);`)).toEqual(["http://fonts.example.com/a.css"]);
  });

  it("ignores license comments", () => {
    expect(findExternalUrls(`/*! lib v1 | MIT https://example.com/license */ a=1`)).toEqual([]);
    expect(findExternalUrls(`/** @license React\n * https://react.dev */ a=1`)).toEqual([]);
  });

  it("allows loopback and XML namespace identifiers (never fetched)", () => {
    expect(findExternalUrls(`"http://127.0.0.1:4747" "http://localhost:4747" "http://www.w3.org/2000/svg"`)).toEqual([]);
  });
});

describe("built dist", () => {
  const out = mkdtempSync(join(tmpdir(), "codeloom-dash-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("contains no external URL", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    // vitest sets NODE_ENV=test, which would pull React's dev build; build what ships.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await build({ root, mode: "production", configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = prev;
    }
    const hits = scanDir(out);
    expect(hits).toEqual([]);
  }, 120_000);
});
