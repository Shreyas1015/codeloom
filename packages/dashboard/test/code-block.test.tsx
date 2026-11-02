import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeBlock, langForFile } from "@/components/code/CodeBlock";
import { CODE_LANGS, getHighlighter, getHighlighterFor } from "@/components/code/highlighter";

const src = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/components/code", rel), "utf8");

const code = ["async store({ request, response }) {", "  const data = await request.validateUsing(", "    createCustomerValidator)", "  return response.created(data)", "}"].join("\n");

describe("CodeBlock", () => {
  it("renders one row per line, numbered from startLine, with the range highlighted", () => {
    render(<CodeBlock code={code} startLine={41} highlight={{ from: 42, to: 43 }} file="app/controllers/customers.ts" />);
    const pre = screen.getByRole("region", { name: "app/controllers/customers.ts, lines 41–45" });
    const rows = pre.querySelectorAll("[data-line]");
    expect([...rows].map((r) => r.getAttribute("data-line"))).toEqual(["41", "42", "43", "44", "45"]);
    expect([...rows].filter((r) => r.hasAttribute("data-highlighted")).map((r) => r.getAttribute("data-line"))).toEqual(["42", "43"]);
    const nums = pre.querySelectorAll("[data-slot=line-number]");
    expect(nums[0]).toHaveTextContent("41");
    expect(nums[0]).toHaveAttribute("aria-hidden", "true");
    expect(pre.querySelector("pre")?.className).toMatch(/font-mono/);
  });

  it("shows plain text first, then Shiki tokens once the highlighter loads", async () => {
    render(<CodeBlock code={code} lang="typescript" />);
    const block = screen.getByRole("region");
    expect(block.textContent).toContain("createCustomerValidator");
    await screen.findByText("async", { selector: "[data-token]" }, { timeout: 5000 });
    expect(block).toHaveAttribute("data-highlighted", "true");
    // text survives highlighting unchanged
    expect([...block.querySelectorAll("[data-slot=line-code]")].map((n) => n.textContent).join("\n")).toBe(code);
  });

  it("leaves unknown languages as plain text", () => {
    render(<CodeBlock code="hello" file="README.md" />);
    expect(screen.getByRole("region")).toHaveAttribute("data-lang", "text");
  });

  it("maps file extensions to the listed languages", () => {
    expect(langForFile("a.ts")).toBe("typescript");
    expect(langForFile("a.mts")).toBe("typescript");
    expect(langForFile("a.tsx")).toBe("tsx");
    expect(langForFile("a.js")).toBe("javascript");
    expect(langForFile("a.cjs")).toBe("javascript");
    expect(langForFile("a.jsx")).toBe("jsx");
    expect(langForFile("db/q.SQL")).toBe("sql");
    expect(langForFile("package.json")).toBe("json");
    expect(langForFile("a.py")).toBe("text");
  });
});

describe("highlighter (fine-grained Shiki)", () => {
  it("has one theme and loads only the listed languages, each on demand", async () => {
    expect([...CODE_LANGS].sort()).toEqual(["javascript", "json", "jsx", "sql", "tsx", "typescript"]);
    const hl = await getHighlighter();
    expect(hl.getLoadedThemes()).toEqual(["codeloom-gallery"]);
    await getHighlighterFor("sql");
    expect(hl.getLoadedLanguages()).toContain("sql");
    for (const l of CODE_LANGS) await getHighlighterFor(l);
    const loaded = hl.getLoadedLanguages();
    for (const l of CODE_LANGS) expect(loaded).toContain(l);
    // nothing beyond our six grammars and their aliases
    const aliases = ["ts", "js", "cjs", "mjs", "cts", "mts", "jsonc", "text", "plaintext", "txt", "plain"];
    expect(loaded.filter((l) => !(CODE_LANGS as readonly string[]).includes(l) && !aliases.includes(l))).toEqual([]);
  });

  it("imports only shiki/core, the JS engine and the listed grammars (no bundles)", () => {
    const text = src("highlighter.ts");
    const specifiers = [...new Set([...text.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]))].sort();
    expect(specifiers).toEqual([
      "shiki/core",
      "shiki/engine/javascript",
      "shiki/langs/javascript.mjs",
      "shiki/langs/json.mjs",
      "shiki/langs/jsx.mjs",
      "shiki/langs/sql.mjs",
      "shiki/langs/tsx.mjs",
      "shiki/langs/typescript.mjs",
    ]);
  });

  it("CodeBlock loads the highlighter lazily (dynamic import only)", () => {
    const text = src("CodeBlock.tsx");
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']shiki/m);
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']\.\/highlighter["']/m);
    expect(text).toMatch(/import\(\s*["']\.\/highlighter["']\s*\)/);
  });
});
