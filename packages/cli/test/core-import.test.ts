import { describe, expect, it } from "vitest";
import { builtinLanguageConfigs, TreeSitterPlugin } from "@codeloom/core";

describe("@codeloom/core", () => {
  it("parses a TypeScript function with tree-sitter", async () => {
    const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter((c) => c.treeSitter));
    await plugin.init();
    const result = plugin.analyzeFile("a.ts", "export function hello(name: string) { return name; }");
    expect(result.functions.map((f) => f.name)).toContain("hello");
  });
});
