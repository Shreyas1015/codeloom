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

  it("a short body + short block stays under the limit and is spliced normally", () => {
    const result = splicePrBody("hello", "world");
    expect(result).toEqual({ body: `hello\n\n${START}world${END}` });
  });

  // --- I3 (security review): an unclosed/mismatched marker must never delete the author's text --------

  it('I3: a START with no END anywhere after it leaves the body untouched and appends a fresh block (never guesses where "its" text ends)', () => {
    const body = "Please review.\n\n" + START + "some text the author wrote after an accidentally-left marker, never closed";
    const result = splicePrBody(body, "NEW");
    expect(result).toEqual({ body: `${body}\n\n${START}NEW${END}` });
  });

  it("I3: an END with no START before it (anywhere in the body) is the same — untouched, appended", () => {
    const body = `Some notes.\n${END}\nMore author text after a stray END with no matching START.`;
    const result = splicePrBody(body, "NEW");
    expect(result).toEqual({ body: `${body}\n\n${START}NEW${END}` });
  });

  it("I3: an END that appears before a later START (so the pair is in the wrong order) is treated as no valid pair", () => {
    const body = `${END}\nAuthor text in between.\n${START}unclosed from here on`;
    const result = splicePrBody(body, "NEW");
    expect(result).toEqual({ body: `${body}\n\n${START}NEW${END}` });
  });

  // --- m2 (security review): moving to a comment must strip the stale inline block, not leave it -----

  it("m2: over the limit, the old inline block is removed from body (not left stale) alongside comment", () => {
    const before = "# Title\n\n";
    const after = "\n\nTrailer.";
    const body = `${before}${START}old small block${END}${after}`;
    const hugeBlock = "x".repeat(GITHUB_BODY_LIMIT);

    const result = splicePrBody(body, hugeBlock);

    expect(result).toEqual({ body: `${before}${after}`, comment: `${START}${hugeBlock}${END}` });
  });

  it("m2: over the limit with no prior block, body is unchanged (nothing to strip) and comment carries the block", () => {
    const block = "x".repeat(GITHUB_BODY_LIMIT);
    const result = splicePrBody("", block);
    expect(result).toEqual({ body: "", comment: `${START}${block}${END}` });
  });
});
