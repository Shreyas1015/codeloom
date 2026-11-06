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

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
/** WCAG relative-luminance contrast ratio. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
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

  it("defines a connector wire: tan, ≥ 3:1 on the ground and on every lane tint", () => {
    const c = rootValue("--connector")!;
    expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    const [r, g, b] = rgb(c);
    expect(r > g && g > b).toBe(true); // tan: warm, like the mock's #B9A06A
    for (const bg of ["--background", "--lane-ui-soft", "--lane-api-soft", "--lane-db-soft", "--lane-queue-soft", "--lane-code-soft"]) {
      expect(contrast(c, rootValue(bg)!)).toBeGreaterThanOrEqual(3);
    }
  });

  it("defines a warm-grey code lane whose header text is ≥ 4.5:1 on its tint, and a tint distinct from the ground", () => {
    const ink = rootValue("--lane-code")!;
    const soft = rootValue("--lane-code-soft")!;
    expect(contrast(ink, soft)).toBeGreaterThanOrEqual(4.5);
    expect(soft.toUpperCase()).not.toBe(rootValue("--background")!.toUpperCase());
    expect(contrast(soft, rootValue("--background")!)).toBeGreaterThan(1.05);
    const [r, , b] = rgb(soft);
    expect(r).toBeGreaterThan(b); // warm grey
  });

  it("maps every token into Tailwind colors", () => {
    for (const t of ["background", "foreground", "primary", "accent", "destructive", "rail", "lane-ui", "lane-api", "lane-db", "lane-queue", "lane-code", "lane-code-soft", "connector"]) {
      expect(css).toContain(`--color-${t}: var(--${t});`);
    }
  });

  it("defines the progress strip's three greens, darkest for understood, each step lighter", () => {
    const steps = ["--progress-understood", "--progress-toured", "--progress-seen"].map((n) => rootValue(n)!);
    for (const v of steps) expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(steps[0]!.toUpperCase()).toBe(rootValue("--success")!.toUpperCase());
    const card = rootValue("--card")!;
    expect(contrast(steps[0]!, card)).toBeGreaterThan(contrast(steps[1]!, card));
    expect(contrast(steps[1]!, card)).toBeGreaterThan(contrast(steps[2]!, card));
    for (const t of ["progress-understood", "progress-toured", "progress-seen"]) expect(css).toContain(`--color-${t}: var(--${t});`);
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
