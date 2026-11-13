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

  it("I3' (re-review): an author-typed mention of the START marker text earlier in the body is never mistaken for the real block's start — the LAST START before the first END wins", () => {
    // The author's own prose, quoting the marker literally (e.g. explaining how the bot works), sits
    // well before the real, bot-inserted block. The old "first START, nearest END after it" logic would
    // span from the author's incidental mention all the way to the real END, deleting everything
    // between (including the real START and its own content).
    const before = `Please use \`${START}\` markers to mark the block.\n\n`;
    const after = "\n\nTrailer.";
    const body = `${before}${START}REAL OLD BLOCK${END}${after}`;
    const result = splicePrBody(body, "NEW BLOCK");
    expect(result).toEqual({ body: `${before}${START}NEW BLOCK${END}${after}` });
  });

  // --- m5 (security review): a label containing literal marker text must never corrupt a later splice -

  it("m5: a block containing the literal END marker text is neutralized, so a later splice still finds exactly the one real pair", () => {
    // A file path (attacker-controlled, from the PR branch) that happens to literally contain the END
    // marker's own text — e.g. a changed-file line the renderer wrote verbatim.
    const hostileBlock = `- \`api/${END}evil.ts\` (+1/-0)`;

    const first = splicePrBody("Intro text.", hostileBlock);
    // Only ONE real END should exist in the result: the one `wrap()` itself appends. The embedded one
    // inside the hostile block must have been neutralized (no longer an exact match for END).
    expect(first.body.split(END).length - 1).toBe(1);
    expect(first.body).toContain("evil.ts");

    const second = splicePrBody(first.body, "SECOND BLOCK");
    // A second splice must still find exactly the same real pair and replace cleanly — nothing was
    // corrupted by the embedded marker text left over from the first round.
    expect(second).toEqual({ body: `Intro text.\n\n${START}SECOND BLOCK${END}` });
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
