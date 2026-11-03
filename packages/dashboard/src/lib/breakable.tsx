import { Fragment, type ReactNode } from "react";

/** Where a path or code name may wrap: after "/" (paths) and "." "_" "-" (names; a file extension and its ":line" stay with the name), and at a
 * lowercase→Uppercase hump ("Customers|Controller"). Never inside a word otherwise. */
const BREAK = /(?<=[/_\-])(?=.)|(?<=\.)(?![a-z0-9]{1,5}(?::\d+)?$)(?=.)|(?<=[a-z0-9])(?=[A-Z])/;

/** The pieces `text` splits into at its break points ("app/", "controllers/", "x.ts:9"). */
export function breakPieces(text: string): string[] {
  return text.split(BREAK).filter((p) => p !== "");
}

/** `text` with a <wbr> at every break point, so a long path or identifier wraps at "/" or "." instead of
 * mid-segment. The text content stays exactly `text`. */
export function Breakable({ text }: { text: string }): ReactNode {
  const pieces = breakPieces(text);
  return pieces.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {p}
    </Fragment>
  ));
}
