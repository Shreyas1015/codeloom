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

/** Escapes markdown control characters (spec §5: "every label escaped" — journey/chain names, symbols and
 * file paths all come from the PR branch, so an attacker can put anything in them) and flattens newlines,
 * so a label can't break a table cell, open a link/image, or otherwise inject markdown. */
export function escapeMarkdownInline(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/[|[\]()*_`<>!@#]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, " ");
}

/** Same as escapeMarkdownInline, for a table cell specifically: an empty cell (e.g. an escaped label that
 * collapsed to nothing) would misalign the row, so it becomes a literal "_" instead. */
export function escapeMarkdownCell(s: string): string {
  const esc = escapeMarkdownInline(s);
  return esc === "" ? "\\_" : esc;
}

function fileLine(f: ReviewFile): string {
  return `- \`${escapeMarkdownInline(f.repo)}/${escapeMarkdownInline(f.file)}\` (+${f.added}/-${f.removed})`;
}

function listFiles(files: ReviewFile[]): string[] {
  const shown = files.slice(0, MAX_LISTED).map(fileLine);
  const hidden = files.length - MAX_LISTED;
  return hidden > 0 ? [...shown, `- +${hidden} more`] : shown;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function summaryLine(review: Review): string {
  return `This PR touches ${plural(review.journeys.length, "journey")}, ${plural(review.chains.length, "chain")}, ${plural(review.tables.length, "table")}, ${plural(review.queues.length, "queue")}.`;
}

/** A short italic line calling out anything approximate or cut, so it's visible next to the diagram
 * rather than only in the underlying JSON. null when there is nothing to say. */
function caveatLine(review: Review): string | null {
  const parts: string[] = [];
  if (review.truncated) parts.push("Some results were truncated.");
  for (const n of review.notes) parts.push(escapeMarkdownInline(n));
  return parts.length > 0 ? `*${parts.join(" ")}*` : null;
}

/** Human symbols for a set of node refs (review.nodes), sorted; a ref with no matching node (should not
 * happen) falls back to the ref itself. Each symbol is escaped before joining, so a "," in one doesn't
 * get confused with the join separator's own escaping. */
function symbolsFor(review: Review, refs: readonly string[]): string {
  const byRef = new Map(review.nodes.map((n) => [n.ref, n.symbol]));
  return [...refs]
    .map((r) => byRef.get(r) ?? r)
    .sort(compare)
    .map(escapeMarkdownCell)
    .join(", ");
}

function journeyTable(review: Review): string[] {
  const rows = [...review.journeys].sort((a, b) => compare(a.name, b.name));
  const lines = ["| Journey | Changed stops | Spec |", "|---|---|---|"];
  for (const j of rows) lines.push(`| ${escapeMarkdownCell(j.name)} | ${symbolsFor(review, j.changedStops)} | ${j.spec} |`);
  return lines;
}

/** No journey names any of the touched chains yet: list the bare chains instead (spec §4: "with no
 * journeys named yet, chains are shown instead"). Review is self-contained (chainStops), so this needs no
 * MapState — a chain shows its id (Review carries no chain names) and its changed stops' labels. */
function chainsTable(review: Review): string[] {
  const lines = ["| Chain | Changed stops |", "|---|---|"];
  for (const id of [...review.chains].sort(compare)) {
    const labels = (review.chainStops[id] ?? [])
      .filter((s) => s.changed)
      .map((s) => s.label)
      .sort(compare)
      .map(escapeMarkdownCell)
      .join(", ");
    lines.push(`| ${escapeMarkdownCell(id)} | ${labels} |`);
  }
  return lines;
}

/** The PR description block (spec §4): heading, one-line summary, Mermaid diagram, a journey/spec table (or
 * a bare chains table when none are named yet), the changed files on no journey, a caveat line when
 * anything was approximate or cut, and a link to the hosted snapshot.
 * `review: null` is a failed build (`opts.error`, with `opts.previous` the last good link) — the only case
 * rendered without a summary or diagram, since the build's own data cannot be trusted either.
 * `opts.tooLarge` stops short of the table/link (nothing was hosted to link to).
 * Self-contained: no MapState parameter (PR review maps design §5 — the publish step renders this from
 * data/review.json alone). Pure and deterministic: the same inputs always render the same text. */
export function renderReviewMarkdown(review: Review | null, opts: ReviewMarkdownOptions = {}): string {
  if (review === null) {
    const lines = [HEADING, "", opts.error ?? "codeloom review map refused."];
    if (opts.previous) lines.push("", `Last good map (${opts.previous.builtFor}): ${opts.previous.link}`);
    return lines.join("\n");
  }

  const lines = [HEADING, "", summaryLine(review)];
  const caveat = caveatLine(review);

  if (review.chains.length === 0) {
    lines.push("", "No journeys touched.");
    const changedFiles = listFiles(review.files);
    if (changedFiles.length > 0) lines.push("", ...changedFiles);
    if (caveat) lines.push("", caveat);
    return lines.join("\n");
  }

  lines.push("", renderMermaid(review));

  if (opts.tooLarge) {
    lines.push("", `Full map too large to host (${mb(opts.tooLarge.bytes)} MB > ${mb(opts.tooLarge.max)} MB).`);
    if (caveat) lines.push("", caveat);
    return lines.join("\n");
  }

  lines.push("", ...(review.journeys.length > 0 ? journeyTable(review) : chainsTable(review)));

  const notOnJourney = review.files.filter((f) => !f.onJourney);
  if (notOnJourney.length > 0) lines.push("", "Not on any journey:", ...listFiles(notOnJourney));

  if (caveat) lines.push("", caveat);

  if (opts.link) lines.push("", `→ Open the full review map: ${opts.link}${opts.builtFor ? ` (built for ${opts.builtFor})` : ""}`);

  return lines.join("\n");
}
