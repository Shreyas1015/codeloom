import { describe, expect, it } from "vitest";
import { END, GITHUB_BODY_LIMIT, splicePrBody, START } from "../src/review/pr-body.js";

describe("splicePrBody", () => {
  it("appends the block to an empty body as \\n\\n + START + block + END", () => {
    const result = splicePrBody("", "BLOCK");
    expect(result).toEqual({ body: `\n\n${START}BLOCK${END}` });
  });

  it("appends the block to a non-empty body, leaving the existing text untouched", () => {
    const result = splicePrBody("Fixes a bug.", "BLOCK");
    expect(result).toEqual({ body: `Fixes a bug.\n\n${START}BLOCK${END}` });
  });

  it("replaces an existing block in place, byte-identical text before and after", () => {
    const before = "# Title\n\nSome description.\n\n";
    const after = "\n\nMore notes.";
    const body = `${before}${START}OLD BLOCK${END}${after}`;
    const result = splicePrBody(body, "NEW BLOCK");
    expect(result).toEqual({ body: `${before}${START}NEW BLOCK${END}${after}` });
  });

  it("with two START markers, replaces only the first block (the first START..END pair)", () => {
    // A malformed/manually-edited body: a second START later on (no matching marker pair logic should
    // touch it) must survive untouched.
    const body = `intro\n${START}OLD${END}\nmiddle\n${START}second one, never closed`;
    const result = splicePrBody(body, "NEW");
    expect(result).toEqual({ body: `intro\n${START}NEW${END}\nmiddle\n${START}second one, never closed` });
  });

  it("returns a comment instead when the spliced body would exceed GitHub's body limit", () => {
    const block = "x".repeat(GITHUB_BODY_LIMIT);
    const result = splicePrBody("", block);
    expect(result).toEqual({ comment: `${START}${block}${END}` });
    expect("body" in result).toBe(false);
  });

  it("a short body + short block stays under the limit and is spliced normally", () => {
    const result = splicePrBody("hello", "world");
    expect(result).toEqual({ body: `hello\n\n${START}world${END}` });
  });
});
