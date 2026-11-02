// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { findExternalUrls, scanDir } from "../scripts/check-dist.js";

describe("findExternalUrls (live load targets only)", () => {
  it.each([
    [`fetch("https://x.com")`, "https://x.com"],
    [`fetch( 'https://cdn.example.com/x.js' )`, "https://cdn.example.com/x.js"],
    [`@import url(http://fonts.example.com/a.css);`, "http://fonts.example.com/a.css"],
    [`src:url("https://fonts.example.com/a.woff2")`, "https://fonts.example.com/a.woff2"],
    [`@import "https://fonts.example.com/b.css";`, "https://fonts.example.com/b.css"],
    [`<script type="module" src="https://cdn.example.com/a.js"></script>`, "https://cdn.example.com/a.js"],
    [`<link rel="stylesheet" href="https://fonts.example.com/c.css">`, "https://fonts.example.com/c.css"],
    [`el.src="https://img.example.com/p.png"`, "https://img.example.com/p.png"],
    [`import("https://esm.example.com/m.js")`, "https://esm.example.com/m.js"],
    [`new URL("https://api.example.com/v1")`, "https://api.example.com/v1"],
    [`new EventSource("https://events.example.com/s")`, "https://events.example.com/s"],
    [`new WebSocket("wss://ws.example.com/s")`, "wss://ws.example.com/s"],
  ])("flags %s", (text, url) => {
    expect(findExternalUrls(text)).toEqual([url]);
  });

  it("allows plain-text doc links inside strings (React's error decoder)", () => {
    expect(findExternalUrls(`"https://react.dev/errors/"+e`)).toEqual([]);
    expect(findExternalUrls(`console.warn("see https://tanstack.com/router/v1/docs")`)).toEqual([]);
  });

  it("ignores license comments", () => {
    expect(findExternalUrls(`/*! lib v1 | MIT */ fetch("/api/x")`)).toEqual([]);
    expect(findExternalUrls(`/** @license React\n * src="https://react.dev" */ a=1`)).toEqual([]);
  });

  it("allows loopback targets and same-origin paths", () => {
    expect(findExternalUrls(`fetch("http://127.0.0.1:4747/api") new EventSource("/api/events") src="/assets/a.js" url(/assets/f.woff2)`)).toEqual([]);
  });
});

describe("scanDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-fake-dist-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("flags a fake dist file that fetches an external host, not one with the error-decoder string", () => {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "bad.js"), `async function f(){return fetch("https://x.com")}`);
    writeFileSync(join(dir, "assets", "ok.js"), `function d(e){return "Minified React error #"+e+"; visit "+"https://react.dev/errors/"+e}`);
    expect(scanDir(dir)).toEqual([{ file: join("assets", "bad.js"), url: "https://x.com" }]);
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

  it("splits vendors and lazy screens, keeping every chunk under Vite's 500 kB warning", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const entry = /src="\/assets\/(index-[^"]+\.js)"/.exec(html)![1]!;
    const assets = readdirSync(join(out, "assets"));
    expect(assets.some((f) => f.startsWith("vendor-react-"))).toBe(true);
    expect(assets.some((f) => f.startsWith("vendor-tanstack-"))).toBe(true);
    expect(assets.some((f) => f.startsWith("JourneyScreen-"))).toBe(true);
    expect(statSync(join(out, "assets", entry)).size).toBeLessThan(500 * 1000);
    for (const f of assets.filter((a) => a.endsWith(".js"))) expect(statSync(join(out, "assets", f)).size, f).toBeLessThan(500 * 1024);
  });
});
