/**
 * Pulling JSON out of an LLM reply with string search instead of regexes: the regexes this replaces
 * (/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/, /\{[\s\S]*\}/) take polynomial time on hostile input.
 * The results are the same.
 */

/** The trimmed body of the first ``` fence (an optional `json` tag after it is skipped), if it is closed. */
export function fencedBlock(text: string): string | undefined {
  const open = text.indexOf("```");
  if (open < 0) return undefined;
  let start = open + 3;
  if (text.startsWith("json", start)) start += 4;
  const close = text.indexOf("```", start);
  return close < 0 ? undefined : text.slice(start, close).trim();
}

/** From the first `open` to the last `close` character, trimmed, if the close comes after the open. */
export function outermost(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start < 0 || end < start ? undefined : text.slice(start, end + 1).trim();
}
