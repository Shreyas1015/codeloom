import type { CallConfidence, Confidence } from "@/api/types";

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How sure the whole journey is, in words: the worst hop decides. */
export const CONFIDENCE_WORD: Record<Confidence, string> = {
  exact: "Exact links",
  param: "Path-param matches",
  guess: "Has guesses",
};

export const KIND_WORD: Record<string, string> = {
  page: "Page",
  call: "API call",
  route: "Route",
  handler: "Handler",
  function: "Function",
  db: "Database query",
  publish: "Queue publish",
  consume: "Queue consumer",
};

/** One hop's confidence, mid-sentence. */
export const HOP_WORD: Record<Confidence, string> = {
  exact: "exact link",
  param: "matched with a path parameter",
  guess: "guessed link",
};

export const fileLine =(file: string, line: number) => `${file}:${line}`;

/** A call edge's confidence, in brackets (Journey inspector) or after a dot (Map inspector). `param` is a function
 * handed over or wired up — "path param" is only for route matches. */
export const CALL_TAG: Record<CallConfidence, string> = {
  exact: "exact",
  param: "likely (passed or wired, not a direct call)",
  unverified: "unverified",
};
