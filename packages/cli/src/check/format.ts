import type { CheckItem, CheckReport } from "../store/schemas.js";
import { completePercent } from "./report.js";

interface Group {
  label: string;
  match: (i: CheckItem) => boolean;
}

/** The linker's reason for a UI call that matched no route ("no matching route for POST /api/x"). Such
 * an `unmatched-call` is a real UI → API break, so the text output shows it apart from the other
 * unresolved calls, which are mostly framework/library noise. */
function isUnmatchedUiCall(i: CheckItem): boolean {
  return i.kind === "unmatched-call" && i.detail.startsWith("no matching route for ");
}

// Text groups read UI → API → DB top to bottom, with the informational unresolved calls last. The raw
// `items` array (JSON) stays sorted by kind in plain code-point order.
const GROUPS: Group[] = [
  { label: "UI calls that match no route", match: isUnmatchedUiCall },
  { label: "Routes whose handler could not be found", match: (i) => i.kind === "handler-not-found" },
  { label: "Routes or consumers that reach no database table or queue", match: (i) => i.kind === "no-store" },
  { label: "URLs that could not be read", match: (i) => i.kind === "unresolved-url" },
  { label: "Routes with no UI caller", match: (i) => i.kind === "route-no-caller" },
  { label: "Hops matched only by a guess", match: (i) => i.kind === "guess-link" },
  {
    label: "Calls that could not be resolved, info only — they do not affect completeness",
    match: (i) => i.kind === "unmatched-call" && !isUnmatchedUiCall(i),
  },
];

function summaryLine(r: CheckReport): string {
  const { chains, complete, missingDb, brokenUiApi } = r.summary;
  if (chains === 0) return "0 journeys: nothing indexed yet.";
  const parts = [`${complete} complete UI → API → DB`];
  if (missingDb > 0) parts.push(`${missingDb} missing the DB step`);
  if (brokenUiApi > 0) parts.push(`${brokenUiApi} broken at UI → API`);
  const other = chains - complete - missingDb - brokenUiApi;
  if (other > 0) parts.push(`${other} other`);
  return `${chains} journey${chains === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

export function formatCheckText(r: CheckReport): string {
  const lines = [summaryLine(r), `complete: ${completePercent(r)}%`, ""];
  for (const { label, match } of GROUPS) {
    const group = r.items.filter(match);
    if (group.length === 0) continue;
    lines.push(`${label} (${group.length}):`);
    for (const item of group) lines.push(`  ${item.repo}/${item.file}:${item.line} ${item.symbol} — ${item.detail}`);
    lines.push("");
  }
  if (r.items.length === 0) lines.push("No issues found.");
  return lines.join("\n").trimEnd();
}

export function formatCheckJson(r: CheckReport): string {
  return JSON.stringify(r, null, 2);
}
