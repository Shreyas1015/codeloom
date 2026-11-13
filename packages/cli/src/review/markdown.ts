import { formatNodeRef, type MapState } from "../mcp/state.js";
import { compare } from "../util.js";
import { renderMermaid } from "./mermaid.js";
import type { Review, ReviewFile } from "./types.js";

const HEADING = "### 🗺 codeloom review map";
/** PR description bodies and files this block is embedded in (spec §4) may show at most this many
 * entries before collapsing the rest into "+N more". */
const MAX_LISTED = 10;

export interface ReviewMarkdownOptions {
  /** URL of the hosted snapshot; adds the "Open the full review map" line. Ignored when `tooLarge` is set
   * (there is nothing to link to) or when `review` is null (use `previous` instead). */
  link?: string;
  /** Short SHA the linked snapshot (or `previous`) was built for. */
  builtFor?: string;
  /** The build or publish step failed before producing a `Review` at all: `review` is null, and this is
   * the ONLY thing shown besides the heading (the build's own error text is not trusted, spec §5/§6). */
  error?: string;
  /** The snapshot was over the size cap: shown after the summary and diagram, in place of the table/link. */
  tooLarge?: { bytes: number; max: number };
  /** The last snapshot that did build, shown next to `error` so reviewers still have a working link. */
  previous?: { link: string; builtFor: string };
}

const mb = (bytes: number): number => Math.round(bytes / 1_000_000);

function fileLine(f: ReviewFile): string {
  return `- \`${f.repo}/${f.file}\` (+${f.added}/-${f.removed})`;
}

function listFiles(files: ReviewFile[]): string[] {
  const shown = files.slice(0, MAX_LISTED).map(fileLine);
  const hidden = files.length - MAX_LISTED;
  return hidden > 0 ? [...shown, `- +${hidden} more`] : shown;
}

function summaryLine(review: Review): string {
  return `This PR touches ${review.journeys.length} journeys, ${review.chains.length} chains, ${review.tables.length} tables, ${review.queues.length} queues.`;
}

/** Human symbols for a set of node refs (review.nodes), sorted by symbol; a ref with no matching node
 * (should not happen) falls back to the ref itself. */
function symbolsFor(review: Review, refs: readonly string[]): string {
  const byRef = new Map(review.nodes.map((n) => [n.ref, n.symbol]));
  return [...refs].map((r) => byRef.get(r) ?? r).sort(compare).join(", ");
}

function journeyTable(review: Review): string[] {
  const rows = [...review.journeys].sort((a, b) => compare(a.name, b.name));
  const lines = ["| Journey | Changed stops | Spec |", "|---|---|---|"];
  for (const j of rows) lines.push(`| ${j.name} | ${symbolsFor(review, j.changedStops)} | ${j.spec} |`);
  return lines;
}

/** No journey names any of the touched chains yet: list the bare chains instead (spec §4: "with no
 * journeys named yet, chains are shown instead"). */
function chainsTable(review: Review, state: MapState): string[] {
  const byId = new Map(state.chains.map((c) => [c.id, c]));
  const changedRefs = new Set(review.nodes.map((n) => n.ref));
  const lines = ["| Chain | Changed stops |", "|---|---|"];
  for (const id of [...review.chains].sort(compare)) {
    const chain = byId.get(id);
    if (!chain) continue;
    const refs = chain.stops
      .filter((s): s is typeof s & { nodeId: string } => s.nodeId !== undefined)
      .map((s) => formatNodeRef({ repo: s.repo, nodeId: s.nodeId }))
      .filter((ref) => changedRefs.has(ref));
    lines.push(`| ${chain.name} | ${symbolsFor(review, refs)} |`);
  }
  return lines;
}

/** The PR description block (spec §4): heading, one-line summary, Mermaid diagram, a journey/spec table (or
 * a bare chains table when none are named yet), the changed files on no journey, and a link to the hosted
 * snapshot. `review: null` is a failed build (`opts.error`, with `opts.previous` the last good link) — the
 * only case rendered without a summary or diagram, since the build's own data cannot be trusted either.
 * `opts.tooLarge` stops short of the table/link (nothing was hosted to link to).
 * Pure and deterministic: the same inputs always render the same text. */
export function renderReviewMarkdown(review: Review | null, state: MapState | null, opts: ReviewMarkdownOptions = {}): string {
  if (review === null) {
    const lines = [HEADING, "", opts.error ?? "codeloom review map refused."];
    if (opts.previous) lines.push("", `Last good map (${opts.previous.builtFor}): ${opts.previous.link}`);
    return lines.join("\n");
  }

  const lines = [HEADING, "", summaryLine(review)];

  if (review.chains.length === 0) {
    lines.push("", "No journeys touched.");
    const changed = listFiles(review.files);
    if (changed.length > 0) lines.push("", ...changed);
    return lines.join("\n");
  }

  lines.push("", renderMermaid(review, state!));

  if (opts.tooLarge) {
    lines.push("", `Full map too large to host (${mb(opts.tooLarge.bytes)} MB > ${mb(opts.tooLarge.max)} MB).`);
    return lines.join("\n");
  }

  lines.push("", ...(review.journeys.length > 0 ? journeyTable(review) : chainsTable(review, state!)));

  const notOnJourney = review.files.filter((f) => !f.onJourney);
  if (notOnJourney.length > 0) lines.push("", "Not on any journey:", ...listFiles(notOnJourney));

  if (opts.link) lines.push("", `→ Open the full review map: ${opts.link}${opts.builtFor ? ` (built for ${opts.builtFor})` : ""}`);

  return lines.join("\n");
}
