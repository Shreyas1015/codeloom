import type { CheckItem, CheckReport, TracesReport } from "../store/schemas.js";
import { compare } from "../util.js";
import { completePercent } from "./report.js";

interface Group {
  label: string;
  match: (i: CheckItem) => boolean;
  /** Info only (never broken): summarised in plain text unless --verbose. */
  info?: true;
  /** Order within the group (default: the items' own order). */
  order?: (a: CheckItem, b: CheckItem) => number;
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
  { label: "Routes with no caller", match: (i) => i.kind === "route-no-caller" },
  { label: "Hops matched only by a guess", match: (i) => i.kind === "guess-link" },
  {
    label: "Calls that could not be resolved, info only — they do not affect completeness",
    match: (i) => i.kind === "unmatched-call",
    info: true,
  },
  { label: "Manual links that could not be resolved", match: (i) => i.kind === "manual-link-broken" },
  { label: "Manual links that match no chain, info only", match: (i) => i.kind === "manual-link-unused", info: true },
  {
    // Grouped by service: every detail starts "calls <name>:", so ordering by detail keeps a service's calls together.
    label: "Calls to other services, info only — not broken",
    match: (i) => i.kind === "external-call",
    info: true,
    order: (a, b) => compare(a.detail, b.detail) || compare(a.repo, b.repo) || compare(a.file, b.file) || a.line - b.line,
  },
];

/** Manual-link items point at the workspace file itself, not at a file inside a repo. */
function itemLine(item: CheckItem): string {
  if (item.kind === "manual-link-broken" || item.kind === "manual-link-unused") return `  ${item.file} ${item.symbol} — ${item.detail}`;
  return `  ${item.repo}/${item.file}:${item.line} ${item.symbol} — ${item.detail}`;
}

function summaryLine(r: CheckReport): string {
  const { chains, complete, apiOnly, missingDb, brokenUiApi } = r.summary;
  if (chains === 0) return "0 journeys: nothing indexed yet.";
  const parts = [`${complete} complete UI → API → DB`];
  if (apiOnly > 0) parts.push(`${apiOnly} API → DB only (no UI caller)`);
  if (missingDb > 0) parts.push(`${missingDb} missing the DB step`);
  if (brokenUiApi > 0) parts.push(`${brokenUiApi} broken at UI → API`);
  // The buckets add up to `chains` by construction (report.ts bucketOf), so there is no "other".
  return `${chains} journey${chains === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** "3/5 routes have a caller (2 from UI, 1 from services)" — only when the workspace has routes. */
function routesLine(r: CheckReport): string | undefined {
  const { routes, routesWithUiCaller } = r.summary;
  const fromServices = r.summary.routesWithServiceCaller ?? 0;
  if (routes === 0) return undefined;
  return `${routesWithUiCaller + fromServices}/${routes} routes have a caller (${routesWithUiCaller} from UI, ${fromServices} from services)`;
}

/** The ratio `--fail-under` uses: complete over the journeys that start in the UI. */
function completeLine(r: CheckReport): string {
  const { chains, uiChains, complete } = r.summary;
  if (chains === 0) return `complete: ${completePercent(r)}%`;
  if (uiChains === 0) return "complete: n/a — no journey starts in the UI";
  return `complete: ${completePercent(r)}% of journeys that start in the UI (${complete}/${uiChains})`;
}

/** Unreadable URLs are per call, not per journey: a separate line, never added into the summary. */
function unreadableUrlLine(r: CheckReport): string | undefined {
  const n = r.summary.unresolvedCalls;
  if (n === 0) return undefined;
  return n === 1 ? "1 call with a URL codeloom could not read" : `${n} calls with URLs codeloom could not read`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Calls to other services are info only: a separate line, never added into the summary. */
function externalLine(r: CheckReport): string | undefined {
  const n = r.summary.externalCalls;
  return n === 0 ? undefined : plural(n, "call to another service", "calls to other services");
}

/** "queues: demo-api 2 published; demo-billing 2 published, 5 consumed" — only when some repo uses a queue. */
function queuesLine(r: CheckReport): string | undefined {
  if (!r.queues || r.queues.length === 0) return undefined;
  const parts = r.queues.map((q) => {
    const ops = [q.publish > 0 ? `${q.publish} published` : "", q.consume > 0 ? `${q.consume} consumed` : ""].filter(Boolean);
    return `${q.repo} ${ops.join(", ")}`;
  });
  return `queues: ${parts.join("; ")}`;
}

/** The `--traces` section: one summary line, then each non-empty group. */
function tracesLines(t: NonNullable<CheckReport["traces"]>): string[] {
  if ("skipped" in t) return [`Traces: skipped — ${t.skipped}`];
  const r = t as TracesReport;
  const lines = [
    `Traces (${r.source}, ${plural(r.spans, "span", "spans")}): ${plural(r.confirmed.length, "route", "routes")} confirmed, ` +
      `${plural(r.missingInMap.length, "link", "links")} seen in traffic but missing from the map, ` +
      `${plural(r.neverHit.length, "route", "routes")} never hit`,
    "",
  ];
  const group = (label: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`${label} (${items.length}):`, ...items.map((i) => `  ${i}`), "");
  };
  group("Seen in traffic but missing from the map", r.missingInMap.map((m) =>
    `${m.repo} ${m.method ?? ""} ${m.route ?? ""}${m.store ? ` → ${m.store}` : ""} — ${m.detail} (${plural(m.hits, "hit", "hits")})`));
  group("Routes confirmed by traffic", r.confirmed.map((c) =>
    `${c.routeKey} — ${plural(c.hits, "hit", "hits")}${c.stores.length > 0 ? `; ${c.stores.join(", ")}` : ""}`));
  group("Routes never hit", r.neverHit);
  group("Services that match no repo", r.unmatchedServices);
  return lines;
}

/** Examples an info-only group shows in plain text (without --verbose). */
const INFO_EXAMPLES = 5;
/** Items of one kind `--json` keeps (without --all). */
export const JSON_ITEMS_PER_KIND = 200;

export function formatCheckText(r: CheckReport, opts: { verbose?: boolean } = {}): string {
  const extra = [routesLine(r), unreadableUrlLine(r), externalLine(r), queuesLine(r)].filter((l): l is string => l !== undefined);
  const lines = [summaryLine(r), ...extra, completeLine(r), ""];
  for (const { label, match, order, info } of GROUPS) {
    const group = order ? r.items.filter(match).sort(order) : r.items.filter(match);
    if (group.length === 0) continue;
    lines.push(`${label} (${group.length}):`);
    if (info && !opts.verbose && group.length > INFO_EXAMPLES) {
      // Info only, never broken: how many per repo, and a few examples.
      const byRepo = new Map<string, number>();
      for (const item of group) byRepo.set(item.repo, (byRepo.get(item.repo) ?? 0) + 1);
      lines.push(`  ${[...byRepo.entries()].sort(([a, x], [b, y]) => y - x || compare(a, b)).map(([repo, n]) => `${repo}: ${n}`).join(", ")}`);
      for (const item of group.slice(0, INFO_EXAMPLES)) lines.push(itemLine(item));
      lines.push(`  … ${group.length - INFO_EXAMPLES} more: "codeloom check --verbose" lists them all`);
    } else {
      for (const item of group) lines.push(itemLine(item));
    }
    lines.push("");
  }
  if (r.items.length === 0) lines.push("No issues found.", "");
  if (r.traces) lines.push(...tracesLines(r.traces));
  return lines.join("\n").trimEnd();
}

/** The report as JSON. Without `all`, each kind keeps its first JSON_ITEMS_PER_KIND items and `truncated` counts,
 * per kind, the ones left out (the summary's counts are always the full ones). */
export function formatCheckJson(r: CheckReport, opts: { all?: boolean } = {}): string {
  if (opts.all) return JSON.stringify(r, null, 2);
  const seen = new Map<string, number>();
  const truncated: Record<string, number> = {};
  const items = r.items.filter((i) => {
    const n = (seen.get(i.kind) ?? 0) + 1;
    seen.set(i.kind, n);
    if (n <= JSON_ITEMS_PER_KIND) return true;
    truncated[i.kind] = (truncated[i.kind] ?? 0) + 1;
    return false;
  });
  return JSON.stringify(Object.keys(truncated).length > 0 ? { ...r, items, truncated } : r, null, 2);
}
