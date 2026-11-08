import type { SpecCoverage, SpecState } from "@/api/types";

/** The four things a journey's spec badge can say. The API's `none` splits in two by `checked`: Claude
 * checked and found no spec (`none`), or nobody checked and codeloom found no candidates (`unchecked`). */
export type SpecMark = "linked" | "candidates" | "none" | "unchecked";

export const SPEC_MARKS: SpecMark[] = ["linked", "candidates", "none", "unchecked"];

/** The badge's words. Each names "spec", so a badge reads on its own. */
export const SPEC_WORD: Record<SpecMark, string> = {
  linked: "Spec linked",
  candidates: "Spec candidates",
  none: "No spec",
  unchecked: "Spec not checked",
};

/** Short words for filter menus and table headers. */
export const SPEC_SHORT: Record<SpecMark, string> = {
  linked: "Linked",
  candidates: "Candidates waiting",
  none: "No spec",
  unchecked: "Not checked",
};

/** The prompt that checks candidates and saves links (add a journey id for one journey). */
export const MATCH_SPECS = "/mcp__codeloom__match-specs";

export function specMark(s: { state: SpecState; checked: boolean }): SpecMark {
  if (s.state === "none") return s.checked ? "none" : "unchecked";
  return s.state;
}

/** A coverage total split into the four marks (they add up to `total`). A linked journey is always checked. */
export function coverageParts(c: SpecCoverage): Record<SpecMark, number> {
  const none = Math.max(0, c.checked - c.linked);
  return { linked: c.linked, candidates: c.candidates, none, unchecked: Math.max(0, c.total - c.linked - c.candidates - none) };
}

/** A doc link's ref is `repo:path`. */
export function parseDocRef(ref: string): { repo: string; file: string } | null {
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) return null;
  return { repo: ref.slice(0, at), file: ref.slice(at + 1) };
}
