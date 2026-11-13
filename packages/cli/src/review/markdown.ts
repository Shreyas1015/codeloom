import { compare } from "../util.js";
import { renderMermaid } from "./mermaid.js";
import { GITHUB_BODY_LIMIT } from "./pr-body.js";
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
  /** GitHub Pages isn't enabled for this repo (design spec §6): nothing is hosted, so a one-line note on
   * enabling it replaces the "Open the full review map" line / the last-good-map link, wherever either
   * would otherwise appear — even when `link` or `previous` is also given, since there is nothing to
   * open either way. */
  pagesDisabled?: boolean;
}

const PAGES_DISABLED_LINE = "GitHub Pages is not enabled for this repo: Settings → Pages → Deploy from a branch → `gh-pages`.";

// m3 (security review): binary MB (1024*1024), matching commands/snapshot.ts's own --max-size parser
// ("25MB" = 25 * 1024 * 1024 bytes) — a decimal 1_000_000 divisor would show that same value back as a
// different, confusing number ("26 MB" for a 25 MB cap).
const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** A finite, non-negative whole number for display — never a raw field straight off a parsed JSON value
 * (security review I1b, defense in depth: review.json is schema-checked upstream, in snapshot/validate.ts,
 * but the renderer itself never assumes that already happened, e.g. the local `codeloom review` command
 * renders a freshly-built Review with no validation step at all). Anything else (not a number, NaN,
 * Infinity, negative) renders as 0 rather than being interpolated as-is. */
function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

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

/** Wraps `text` in a CommonMark inline code span that no content of `text` can break: the fence is one
 * backtick longer than the longest run of backticks already in `text`, with one padding space on each
 * side (so content starting/ending with a backtick, or that is itself all backticks, still round-trips —
 * CommonMark strips at most one such padding space per side) and newlines flattened to spaces (a code span
 * is one line). No backslash-escaping: CommonMark does not process backslash escapes inside a code span,
 * so escaping here would show literal backslashes instead of hiding anything (I2 — a file path belongs in
 * a code span, not escaped prose). */
export function codeSpan(text: string): string {
  const flat = text.replace(/\r?\n/g, " ");
  const longestRun = (flat.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${flat} ${fence}`;
}

function fileLine(f: ReviewFile): string {
  return `- ${codeSpan(`${f.repo}/${f.file}`)} (+${safeCount(f.added)}/-${safeCount(f.removed)})`;
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
 * rather than only in the underlying JSON. null when there is nothing to say.
 * Security review m7: `review.notes` is attacker-controlled data (from the PR's own index/diff run) with
 * no cap of its own — unbounded like `review.files`, capped the same way (MAX_LISTED) so a huge notes
 * array can't by itself blow up the rendered block (the `finish()` wrapper below is still the backstop
 * for a single oversized note, which capping the COUNT alone can't catch). */
function caveatLine(review: Review): string | null {
  const parts: string[] = [];
  if (review.truncated) parts.push("Some results were truncated.");
  const shown = review.notes.slice(0, MAX_LISTED).map(escapeMarkdownInline);
  parts.push(...shown);
  const hiddenNotes = review.notes.length - MAX_LISTED;
  if (hiddenNotes > 0) parts.push(`+${hiddenNotes} more notes.`);
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

/** review/types.ts's ReviewJourney.spec union, as a runtime set. Security review I1b (defense in
 * depth): `j.spec` is checked against this before it's shown, rather than interpolated as-is — again,
 * belt and suspenders on top of snapshot/validate.ts's upstream schema check, since this same renderer
 * also runs on a freshly-built, never-validated Review for the local `codeloom review` command. */
const SPEC_STATES = new Set<Review["journeys"][number]["spec"]>(["linked", "candidates", "none", "unchecked"]);

function specCell(spec: unknown): string {
  return escapeMarkdownCell(typeof spec === "string" && SPEC_STATES.has(spec as never) ? spec : "unknown");
}

function journeyTable(review: Review): string[] {
  const rows = [...review.journeys].sort((a, b) => compare(a.name, b.name));
  const lines = ["| Journey | Changed stops | Spec |", "|---|---|---|"];
  for (const j of rows) lines.push(`| ${escapeMarkdownCell(j.name)} | ${symbolsFor(review, j.changedStops)} | ${specCell(j.spec)} |`);
  return lines;
}

/** No journey names any of the touched chains yet: list the bare chains instead (spec §4: "with no
 * journeys named yet, chains are shown instead"). Review is self-contained (chainStops/chainNames), so
 * this needs no MapState — M2: shows the chain's own NAME (not its opaque id) and its changed stops'
 * labels. */
function chainsTable(review: Review): string[] {
  const lines = ["| Chain | Changed stops |", "|---|---|"];
  for (const id of [...review.chains].sort(compare)) {
    // Own-key lookups only (security review I1'a): chainStops/chainNames are plain objects, and a
    // chain id that collides with an inherited Object.prototype property name (e.g. "toString") would
    // otherwise resolve to that inherited FUNCTION — `?? []`/`?? id` never catch that (a function is
    // never nullish), and escapeMarkdownCell would then crash calling .replace on a function.
    const stops = Object.hasOwn(review.chainStops, id) ? review.chainStops[id]! : [];
    const labels = stops
      .filter((s) => s.changed)
      .map((s) => s.label)
      .sort(compare)
      .map(escapeMarkdownCell)
      .join(", ");
    const name = Object.hasOwn(review.chainNames, id) ? review.chainNames[id] : undefined;
    lines.push(`| ${escapeMarkdownCell(typeof name === "string" ? name : id)} | ${labels} |`);
  }
  return lines;
}

/** Security review m7: a backstop below GITHUB_BODY_LIMIT, independent of (and in addition to) any cap
 * on an individual piece (files, notes, mermaid nodes — the count-based caps above are the normal-case
 * mitigation; this is the hard floor for whatever still gets through, e.g. a single oversized note).
 * `out` over the limit is replaced wholesale by a fixed, tiny message — never truncated text, which could
 * cut a markdown construct (a table row, a fence) in half and corrupt the rest of the PR body/comment. */
function finish(out: string, opts: ReviewMarkdownOptions): string {
  if (out.length <= GITHUB_BODY_LIMIT) return out;
  const lines = [HEADING, "", "codeloom review map too large to show here."];
  if (opts.pagesDisabled) lines.push("", PAGES_DISABLED_LINE);
  else if (opts.link) lines.push("", `→ Open the full review map: ${opts.link}${opts.builtFor ? ` (built for ${opts.builtFor})` : ""}`);
  return lines.join("\n");
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
    if (opts.pagesDisabled) lines.push("", PAGES_DISABLED_LINE);
    else if (opts.previous) lines.push("", `Last good map (${opts.previous.builtFor}): ${opts.previous.link}`);
    return finish(lines.join("\n"), opts);
  }

  const lines = [HEADING, "", summaryLine(review)];
  const caveat = caveatLine(review);

  if (review.chains.length === 0) {
    lines.push("", "No journeys touched.");
    const changedFiles = listFiles(review.files);
    if (changedFiles.length > 0) lines.push("", ...changedFiles);
    // m6: the Pages note belongs in every branch that would otherwise end without it, not just the
    // "normal"/tooLarge ones — "nothing is hosted" is true here too.
    if (opts.pagesDisabled) lines.push("", PAGES_DISABLED_LINE);
    if (caveat) lines.push("", caveat);
    return finish(lines.join("\n"), opts);
  }

  lines.push("", renderMermaid(review));

  if (opts.tooLarge) {
    lines.push("", `Full map too large to host (${mb(opts.tooLarge.bytes)} MB > ${mb(opts.tooLarge.max)} MB).`);
    if (opts.pagesDisabled) lines.push("", PAGES_DISABLED_LINE);
    if (caveat) lines.push("", caveat);
    return finish(lines.join("\n"), opts);
  }

  lines.push("", ...(review.journeys.length > 0 ? journeyTable(review) : chainsTable(review)));

  const notOnJourney = review.files.filter((f) => !f.onJourney);
  if (notOnJourney.length > 0) lines.push("", "Not on any journey:", ...listFiles(notOnJourney));

  if (caveat) lines.push("", caveat);

  if (opts.pagesDisabled) {
    lines.push("", PAGES_DISABLED_LINE);
  } else if (opts.link) {
    lines.push("", `→ Open the full review map: ${opts.link}${opts.builtFor ? ` (built for ${opts.builtFor})` : ""}`);
  }

  return finish(lines.join("\n"), opts);
}
