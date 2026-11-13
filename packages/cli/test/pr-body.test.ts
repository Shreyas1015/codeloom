import { describe, expect, it } from "vitest";
import { HEADING } from "../src/review/heading.js";
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

  // --- round 3 item 1: every valid pair is considered, picking the one whose content is OUR block -----

  it("round 3 item 1: an author quoting only END above the real block no longer blocks the real block from being found (stale blocks were piling up)", () => {
    const before = `Note: \`${END}\` ends it.\n\n`;
    const after = "\n\nTrailer.";
    const realBlockContent = `${HEADING}\n\nReal block content.`;
    const body = `${before}${START}${realBlockContent}${END}${after}`;

    const first = splicePrBody(body, `${HEADING}\n\nUpdated block content.`);
    expect(first).toEqual({ body: `${before}${START}${HEADING}\n\nUpdated block content.${END}${after}` });

    // Two splices: a second run must still find exactly the same real pair, not append a second one.
    const second = splicePrBody(first.body, `${HEADING}\n\nSecond update.`);
    expect(second).toEqual({ body: `${before}${START}${HEADING}\n\nSecond update.${END}${after}` });
    // Exactly one block: only one START and one END anywhere (besides the author's own quoted END text,
    // which is defused/neutralized text, not a literal match).
    expect(second.body.split(START).length - 1).toBe(1);
  });

  it("round 3 item 1: an author quoting both START and END inline above the real block gets neither marker touched — the splice finds the real (heading-prefixed) block by content, not position", () => {
    const before = `Use \`${START}...stuff...${END}\` to mark it.\n\n`;
    const after = "\n\nTrailer.";
    const realBlockContent = `${HEADING}\n\nReal block content.`;
    const body = `${before}${START}${realBlockContent}${END}${after}`;

    const result = splicePrBody(body, `${HEADING}\n\nUpdated block content.`);

    expect(result).toEqual({ body: `${before}${START}${HEADING}\n\nUpdated block content.${END}${after}` });
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
  //
  // `"x".repeat(GITHUB_BODY_LIMIT)` is AT the limit on its own; wrap() adds START/END on top of it, so
  // the wrapped comment itself is already over GITHUB_BODY_LIMIT — round 3 item 2's exact scenario, so
  // these two now expect the fixed too-large comment rather than `wrap(hugeBlock)` (which would itself
  // be too long to post as a comment).

  it("m2: over the limit, the old inline block is removed from body (not left stale) alongside the comment", () => {
    const before = "# Title\n\n";
    const after = "\n\nTrailer.";
    const body = `${before}${START}old small block${END}${after}`;
    const hugeBlock = "x".repeat(GITHUB_BODY_LIMIT);

    const result = splicePrBody(body, hugeBlock);

    expect(result.body).toBe(`${before}${after}`);
    expect(result.comment).toBeDefined();
    expect(result.comment!.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(result.comment).toContain(START);
    expect(result.comment).toContain(END);
    expect(result.comment).not.toContain("x".repeat(100));
  });

  it("m2: over the limit with no prior block, body is unchanged (nothing to strip) and the comment carries a (possibly fixed) block", () => {
    const block = "x".repeat(GITHUB_BODY_LIMIT);
    const result = splicePrBody("", block);
    expect(result.body).toBe("");
    expect(result.comment).toBeDefined();
    expect(result.comment!.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
  });

  // --- round 3 item 2: the wrapped comment itself must never pass GitHub's limit --------------------

  it("round 3 item 2: wrap(block) alone over the limit (markers pushed it over finish()'s own cap) falls back to a fixed too-large comment", () => {
    // Exactly at the limit on its own: adding START/END (and any m5 neutralisation) pushes the WRAPPED
    // form over, even though `block.length` itself is not over the limit.
    const block = "x".repeat(GITHUB_BODY_LIMIT);
    const result = splicePrBody("Some existing body.", block);

    expect(result.comment).toBeDefined();
    expect(result.comment!.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(result.comment).toContain("too large");
    expect(result.comment).not.toContain("x".repeat(100));
    // Body is the ORIGINAL text, untouched (nothing to strip — there was no existing inline block).
    expect(result.body).toBe("Some existing body.");
  });
});
