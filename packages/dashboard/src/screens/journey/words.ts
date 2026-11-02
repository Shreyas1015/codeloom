import type { Confidence } from "@/api/types";

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

export const fileLine = (file: string, line: number) => `${file}:${line}`;
