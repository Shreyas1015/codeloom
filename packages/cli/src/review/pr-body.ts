// The PR description splice (design spec §4): the codeloom block lives between two HTML comment markers,
// appended the first time and replaced in place after that; everything outside the markers is never
// touched. Over GitHub's body limit, the block goes in a single comment instead.

export const START = "<!-- codeloom:review:start -->";
export const END = "<!-- codeloom:review:end -->";

/** GitHub's pull request body limit, in characters. */
export const GITHUB_BODY_LIMIT = 65_536;

function wrap(block: string): string {
  return `${START}${block}${END}`;
}

/** The first valid START..END pair in `body` (the first START, and the nearest END strictly after it) —
 * or null when there isn't one. Security review I3: a lone START with no END anywhere after it, or an
 * END with no START before it, is NOT a pair — guessing that "everything after an unclosed START is
 * ours" would delete real author text that just happens to follow a stray marker. Only a matched,
 * ordered START..END span is ever treated as "our" block. */
function findBlock(body: string): { startAt: number; endAt: number } | null {
  const startAt = body.indexOf(START);
  if (startAt < 0) return null;
  const endAt = body.indexOf(END, startAt + START.length);
  if (endAt < 0) return null;
  return { startAt, endAt };
}

/** Splices `block` into `body` between the markers: appended (with a blank line before it) when there is
 * no existing valid START..END pair (including a lone/unclosed START or a stray END — I3), or replacing
 * the first such pair in place — text before and after that pair is byte-identical, and a second,
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
  const spliced = found === null ? `${body}\n\n${wrap(block)}` : `${body.slice(0, found.startAt)}${wrap(block)}${body.slice(found.endAt + END.length)}`;

  if (spliced.length <= GITHUB_BODY_LIMIT) return { body: spliced };

  const stripped = found === null ? body : `${body.slice(0, found.startAt)}${body.slice(found.endAt + END.length)}`;
  return { body: stripped, comment: wrap(block) };
}
