// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles/tokens.css"), "utf8");

/** The value a custom property gets in the :root block. */
function rootValue(name: string): string | undefined {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  return root.match(new RegExp(`(?:^|\\s)${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
}

describe("Gallery Guide tokens", () => {
  it.each([
    ["--background", "#F3F4F1"],
    ["--foreground", "#1A1D1C"],
    ["--primary", "#1F4D45"],
    ["--accent", "#E3A72F"],
    ["--destructive", "#B5483D"],
    ["--rail", "#1F4D45"],
    ["--lane-ui", "#2F5E9E"],
    ["--lane-api", "#1F4D45"],
    ["--lane-db", "#8A5A2B"],
  ])("%s is %s", (name, hex) => {
    expect(rootValue(name)?.toUpperCase()).toBe(hex);
  });

  it("defines a queue lane in the DB umber family, lighter than the DB lane", () => {
    const q = rootValue("--lane-queue");
    expect(q).toMatch(/^#[0-9A-Fa-f]{6}$/);
    const lum = (hex: string) => [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
    expect(lum(q!)).toBeGreaterThan(lum("#8A5A2B"));
    // umber family: red > green > blue
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(q!.slice(i, i + 2), 16));
    expect(r! > g! && g! > b!).toBe(true);
  });

  it("maps every token into Tailwind colors", () => {
    for (const t of ["background", "foreground", "primary", "accent", "destructive", "rail", "lane-ui", "lane-api", "lane-db", "lane-queue"]) {
      expect(css).toContain(`--color-${t}: var(--${t});`);
    }
  });

  it("self-hosts the fonts through @fontsource with the required weights", () => {
    for (const w of ["400", "600", "700"]) expect(css).toContain(`@fontsource/schibsted-grotesk/${w}.css`);
    for (const w of ["400", "600"]) expect(css).toContain(`@fontsource/jetbrains-mono/${w}.css`);
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("is light theme only", () => {
    expect(css).not.toMatch(/\.dark\b|prefers-color-scheme/);
  });
});
