// The PR description splice (design spec §4): the codeloom block lives between two HTML comment markers,
// appended the first time and replaced in place after that; everything outside the markers is never
// touched. Over GitHub's body limit, the block goes in a single comment instead.

export const START = "<!-- codeloom:review:start -->";
export const END = "<!-- codeloom:review:end -->";

/** GitHub's pull request body limit, in characters. */
export const GITHUB_BODY_LIMIT = 65_536;

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

function wrap(block: string): string {
  return `${START}${neutralizeMarkers(block)}${END}`;
}

/** The real START..END pair in `body`: the first END, and the LAST START at or before it — or null when
 * there isn't one. Security review I3: a lone START with no END anywhere after it, or an END with no
 * START before it, is NOT a pair — guessing that "everything after an unclosed START is ours" would
 * delete real author text that just happens to follow a stray marker. Security review I3': the LAST
 * START before the END (not the FIRST START in the whole body) — an author's own prose that happens to
 * quote the marker text earlier in the body (e.g. explaining how the bot works) must never be mistaken
 * for the real block's start; only the START closest to (and before) the real END is the real one. */
function findBlock(body: string): { startAt: number; endAt: number } | null {
  const endAt = body.indexOf(END);
  if (endAt < 0) return null;
  const startAt = body.lastIndexOf(START, endAt);
  if (startAt < 0 || startAt + START.length > endAt) return null;
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
