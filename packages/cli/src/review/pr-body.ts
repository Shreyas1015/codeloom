// The PR description splice (design spec §4): the codeloom block lives between two HTML comment markers,
// appended the first time and replaced in place after that; everything outside the markers is never
// touched. Over GitHub's body limit, the block goes in a single comment instead.

import { HEADING } from "./heading.js";

export const START = "<!-- codeloom:review:start -->";
export const END = "<!-- codeloom:review:end -->";

/** GitHub's pull request body limit, in characters. */
export const GITHUB_BODY_LIMIT = 65_536;

/** Round 3 item 2: a fixed, tiny message for when even a single wrapped block (markers plus any m5
 * neutralisation) is on its own already over GITHUB_BODY_LIMIT — too big to ever post as a comment,
 * regardless of what the rest of the body does. Starts with HEADING like every block codeloom writes, so
 * a later splice recognises it as codeloom's own (final review I6). */
const TOO_LARGE_COMMENT = `${HEADING}\n\nReview map too large to show here.`;

/** The text START and END share (security review m5): any rendered label (a file path, journey name,
 * chain name, ... — all attacker-controlled, from the PR branch) that happens to literally contain this
 * exact text would otherwise look like a real marker to a LATER splice. */
const MARKER_PREFIX = "<!-- codeloom:review:";
const ZWSP = "​";

/** Defuses every occurrence of MARKER_PREFIX inside `block` by inserting a zero-width space right after
 * "<!--" (invisible once rendered as markdown, but no longer an exact substring match for START or
 * END). Applied once, here, to the whole block before it is ever wrapped — the single choke point every
 * splice goes through, regardless of which renderer produced the text (security review m5). */
function neutralizeMarkers(block: string): string {
  return block.split(MARKER_PREFIX).join(`<!--${ZWSP} codeloom:review:`);
}

/** Each marker on a line of its own (final review I3): with START and the block's "### …" heading on one
 * line, CommonMark reads the whole line as one HTML block and the heading renders as literal text. */
function wrap(block: string): string {
  return `${START}\n${neutralizeMarkers(block)}\n${END}`;
}

interface Pair {
  startAt: number;
  endAt: number;
}

/** Every valid START..END pair in `body`, in the order their ENDs appear. For each END (left to right),
 * the pairing START is the LAST one at or before it that is NOT already inside an earlier END's own
 * span — i.e. each END's own search window starts right after the END before it (or the start of the
 * body, for the first one). Security review round 3 item 1 (regression from I3'): an END-only mention
 * above the real block (no START anywhere before it) simply contributes no pair for THAT end — it no
 * longer prevents a LATER end from finding its own, real, START. An author quoting both markers inline
 * (their own short END right after their own short START) is itself a structurally "valid" pair too;
 * `pickPair` below is what tells it apart from the real one. */
function findAllPairs(body: string): Pair[] {
  const pairs: Pair[] = [];
  let searchFrom = 0;
  let endAt = body.indexOf(END);
  while (endAt >= 0) {
    const startAt = body.lastIndexOf(START, endAt);
    if (startAt >= searchFrom && startAt + START.length <= endAt) pairs.push({ startAt, endAt });
    searchFrom = endAt + END.length;
    endAt = body.indexOf(END, searchFrom);
  }
  return pairs;
}

/** Among every valid pair, the real one is whichever's own inner text (leading whitespace aside — wrap()
 * puts a newline after START, older blocks had none) starts with HEADING: every block codeloom writes
 * starts with it (normal, refused, failed, markdown.ts's finish() fallback, TOO_LARGE_COMMENT), and an
 * author's quotation of the markers (their own prose, or an inline code span mentioning both) does not.
 * No pair matches → null, and a fresh block is appended (final review I6): an author's own START…END pair
 * is never overwritten, and neither is a lone/unclosed marker (I3). */
function pickPair(body: string, pairs: Pair[]): Pair | null {
  return pairs.find((p) => body.slice(p.startAt + START.length, p.endAt).trimStart().startsWith(HEADING)) ?? null;
}

function findBlock(body: string): Pair | null {
  return pickPair(body, findAllPairs(body));
}

/** Splices `block` into `body` between the markers: appended (with a blank line before it) when there is
 * no existing START..END pair holding a codeloom block (including a lone/unclosed START, a stray END — I3 —
 * or an author's own quoted pair — final review I6), or replacing that pair in place — text before and after that pair is byte-identical, and a second,
 * unrelated START later in the body (e.g. left over from a manual edit) is never touched, since only the
 * first matched pair is ever replaced.
 *
 * When the spliced result would pass GITHUB_BODY_LIMIT, nothing that large is put in the body: `comment`
 * carries the block instead (still wrapped in the same markers, so a future run can find and update that
 * same comment the way it would find an inline block), and `body` is the ORIGINAL body with any existing
 * inline block removed (security review m2) — never left stale next to the new standalone comment. With
 * no existing block to remove, `body` is just the original body, unchanged. `body` is always present;
 * `comment` only when the block had to move out of it. */
export function splicePrBody(body: string, block: string): { body: string; comment?: string } {
  const found = findBlock(body);
  const wrapped = wrap(block);
  const spliced = found === null ? `${body}\n\n${wrapped}` : `${body.slice(0, found.startAt)}${wrapped}${body.slice(found.endAt + END.length)}`;

  if (spliced.length <= GITHUB_BODY_LIMIT) return { body: spliced };

  const stripped = found === null ? body : `${body.slice(0, found.startAt)}${body.slice(found.endAt + END.length)}`;
  // Round 3 item 2: `wrapped` itself (markers plus any m5 neutralisation) can be over the limit even
  // though `spliced` being over the limit is what got us here — a comment that large could never be
  // posted anyway, so fall back to a fixed, tiny message instead of the real (oversized) block.
  const comment = wrapped.length <= GITHUB_BODY_LIMIT ? wrapped : wrap(TOO_LARGE_COMMENT);
  return { body: stripped, comment };
}
