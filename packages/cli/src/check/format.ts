import type { CheckItem, CheckReport } from "../store/schemas.js";
import { completePercent } from "./report.js";

interface Group {
  label: string;
  match: (i: CheckItem) => boolean;
}

// Text groups read UI → API → DB top to bottom, with the informational unresolved calls last. Groups
// match on item kind only, never on detail text. The raw `items` array (JSON) stays sorted by kind in
// plain code-point order.
const GROUPS: Group[] = [
  { label: "UI calls that match no route", match: (i) => i.kind === "ui-no-route" },
  { label: "Routes whose handler could not be found", match: (i) => i.kind === "handler-not-found" },
  { label: "Routes or consumers that reach no database table or queue", match: (i) => i.kind === "no-store" },
  { label: "Calls not reached from any page", match: (i) => i.kind === "ui-unreached" },
  { label: "URLs that could not be read", match: (i) => i.kind === "unresolved-url" },
  { label: "Routes with no UI caller", match: (i) => i.kind === "route-no-caller" },
  { label: "Hops matched only by a guess", match: (i) => i.kind === "guess-link" },
  {
    label: "Calls that could not be resolved, info only — they do not affect completeness",
    match: (i) => i.kind === "unmatched-call",
  },
];

function summaryLine(r: CheckReport): string {
  const { chains, complete, missingDb, brokenUiApi } = r.summary;
  if (chains === 0) return "0 journeys: nothing indexed yet.";
  const parts = [`${complete} complete UI → API → DB`];
  if (missingDb > 0) parts.push(`${missingDb} missing the DB step`);
  if (brokenUiApi > 0) parts.push(`${brokenUiApi} broken at UI → API`);
  // The buckets add up to `chains` by construction (report.ts bucketOf), so there is no "other".
  return `${chains} journey${chains === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** Unreadable URLs are per call, not per journey: a separate line, never added into the summary. */
function unreadableUrlLine(r: CheckReport): string | undefined {
  const n = r.summary.unresolvedCalls;
  if (n === 0) return undefined;
  return n === 1 ? "1 call with a URL codeloom could not read" : `${n} calls with URLs codeloom could not read`;
}

export function formatCheckText(r: CheckReport): string {
  const trailer = unreadableUrlLine(r);
  const lines = [summaryLine(r), ...(trailer ? [trailer] : []), `complete: ${completePercent(r)}%`, ""];
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
