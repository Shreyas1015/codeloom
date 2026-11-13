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

/** Splices `block` into `body` between the markers: appended (with a blank line before it) the first
 * time, or replacing the first START..END pair in place when one already exists — text before and after
 * that pair is byte-identical, and a second, unrelated START later in the body (e.g. left over from a
 * manual edit) is never touched, since only the first START and the nearest END after it are matched.
 * When the result would pass GITHUB_BODY_LIMIT, nothing is spliced into `body`: the block is returned as
 * a standalone comment instead (still wrapped in the same markers, so a future run can find and update
 * that same comment the same way it would find an inline block). */
export function splicePrBody(body: string, block: string): { body: string } | { comment: string } {
  const startAt = body.indexOf(START);
  let spliced: string;
  if (startAt < 0) {
    spliced = `${body}\n\n${wrap(block)}`;
  } else {
    const endAt = body.indexOf(END, startAt);
    const before = body.slice(0, startAt);
    const after = endAt < 0 ? "" : body.slice(endAt + END.length);
    spliced = `${before}${wrap(block)}${after}`;
  }
  if (spliced.length > GITHUB_BODY_LIMIT) return { comment: wrap(block) };
  return { body: spliced };
}
