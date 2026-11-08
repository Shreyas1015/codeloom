import { describe, expect, it } from "vitest";
import { fencedBlock, outermost } from "../analyzer/extract-json.js";
import { MakefileParser } from "../plugins/parsers/makefile-parser.js";
import { MarkdownParser } from "../plugins/parsers/markdown-parser.js";

// The regexes these helpers replace: same results, without their worst-case polynomial time (CodeQL js/polynomial-redos).
const OLD_FENCE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
const oldFence = (s: string) => s.match(OLD_FENCE)?.[1]?.trim();
const oldOuter = (s: string, re: RegExp) => s.match(re)?.[0]?.trim();

const SAMPLES = [
  "",
  "no json here",
  '```json\n{"a": 1}\n```',
  '```\n[1, 2]\n```',
  'Here you go:\n```json   \n  {"a": {"b": 2}}  \n```\nThanks',
  "```json```",
  "````",
  "``` only an opening fence",
  '```js\nconst x = 1;\n```',
  '```jsonx\n{"x": 1}\n```',
  'text {"a": 1} more } and {',
  "} reversed {",
  "[1, [2, 3]] trailing ]",
  "] [",
  "```a``` and ```b```",
];

describe("fencedBlock", () => {
  it.each(SAMPLES)("matches the old fence regex on %j", (s) => {
    expect(fencedBlock(s)).toBe(oldFence(s));
  });
});

describe("outermost", () => {
  it.each(SAMPLES)("matches the old {…} and […] regexes on %j", (s) => {
    expect(outermost(s, "{", "}")).toBe(oldOuter(s, /\{[\s\S]*\}/));
    expect(outermost(s, "[", "]")).toBe(oldOuter(s, /\[[\s\S]*\]/));
  });
});

describe("hostile input stays fast", () => {
  const fast = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("an LLM reply of many fences or braces with no close", () => {
    expect(fast(() => fencedBlock("```" + " \n".repeat(50_000)))).toBeLessThan(200);
    expect(fast(() => outermost("{".repeat(100_000), "{", "}"))).toBeLessThan(200);
  });

  it("a Makefile line of spaces with no colon", () => {
    const parser = new MakefileParser();
    expect(fast(() => parser.analyzeFile("Makefile", "a" + " ".repeat(50_000)))).toBeLessThan(200);
  });

  it("a Markdown file of brackets with no close", () => {
    const parser = new MarkdownParser();
    expect(fast(() => parser.extractReferences("README.md", "[".repeat(50_000)))).toBeLessThan(500);
    expect(fast(() => parser.extractReferences("README.md", "[a](" .repeat(20_000)))).toBeLessThan(500);
  });
});
