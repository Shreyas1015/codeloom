import { compare } from "../util.js";
import { HEADING } from "./heading.js";
import { renderChangedPath, renderMermaid } from "./mermaid.js";
import { FILE_KINDS, fileKind } from "./paths.js";
import { GITHUB_BODY_LIMIT } from "./pr-body.js";
import type { SavedPrReview } from "./saved.js";
import { buildPrSummary, type PrSummary, type SummaryCode, type SummaryWhere } from "./summary.js";
import type { Review, ReviewEntry, ReviewFile, ReviewRisk } from "./types.js";

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
 * a bare chains table when none are named yet), the changed files on no mapped chain, a caveat line when
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

  const notOnChain = review.files.filter((f) => !f.onChain);
  if (notOnChain.length > 0) lines.push("", "Not on any mapped chain:", ...listFiles(notOnChain));

  if (caveat) lines.push("", caveat);

  if (opts.pagesDisabled) {
    lines.push("", PAGES_DISABLED_LINE);
  } else if (opts.link) {
    lines.push("", `→ Open the full review map: ${opts.link}${opts.builtFor ? ` (built for ${opts.builtFor})` : ""}`);
  }

  return finish(lines.join("\n"), opts);
}

// ---- the 0.5 draft (spec §2) ---------------------------------------------------------------------------------

export interface ReviewDraftOptions {
  /** URL of the hosted snapshot; adds the "Open the full review map" line. */
  link?: string;
  /** Claude's saved, checked review (review/saved.ts). Used only when it is for this very review — same head,
   * base and repo; a stale one (another head) is ignored and the draft is shown. */
  checked?: SavedPrReview | null;
}

export const DRAFT_STATUS = "_Draft by codeloom — not checked._";
export const WHAT_IT_DOES_PLACEHOLDER = "_(Claude fills this in when it checks the PR.)_";

const ENTRY_WORD: Record<ReviewEntry["kind"], string> = { page: "page", route: "route", consumer: "queue consumer" };
const RISK_WORD: Record<ReviewRisk["kind"], string> = { migration: "Migration", schema: "Schema", env: "Env", docker: "Docker", ci: "CI" };

/** `lines`, then "- +N more" when `more` were left out. */
const withMore = (lines: string[], more: number): string[] => (more > 0 ? [...lines, `- +${more} more`] : lines);

function names(list: readonly string[], more: number): string {
  const shown = list.map((n) => codeSpan(String(n)));
  return more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ");
}

/** Claude's free text (save_pr_review notes, "What it does"): control characters dropped, then escaped like every
 * label (escapeMarkdownInline) plus ":" (no bare-URL autolinks), "~" (no strikethrough), "$" (no math) and a
 * "www." prefix (no www autolinks). */
export function escapeClaudeText(s: string): string {
  return escapeMarkdownInline(s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""))
    .replace(/[:~$]/g, (c) => `\\${c}`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, -1)}\\.`);
}

const claudeSays = (notes: readonly string[] | undefined): string => (notes && notes.length > 0 ? `Claude: ${notes.map(escapeClaudeText).join("; ")}` : "Claude");

const NO_ENTRY = "**Where it matters:** no entry point on the map reaches the changed code.";

function whereLine(w: SummaryWhere): string {
  if (w.kind === undefined) {
    // Claude's ranking: the name and its reason.
    const why = typeof w.why === "string" && w.why !== "" ? ` — ${escapeClaudeText(w.why)}` : "";
    return `- ${codeSpan(String(w.name))}${why}`;
  }
  const word = Object.hasOwn(ENTRY_WORD, w.kind) ? ENTRY_WORD[w.kind] : "entry";
  const journey = typeof w.journey === "string" ? `**${escapeMarkdownInline(w.journey)}** — ` : "";
  return `- ${journey}${word} ${codeSpan(String(w.name))} (${escapeMarkdownInline(String(w.repo))})`;
}

function whereItMatters(s: PrSummary): string[] {
  if (s.whereItMatters.length === 0) return [NO_ENTRY];
  return ["**Where it matters:**", ...withMore(s.whereItMatters.map(whereLine), s.more.whereItMatters)];
}

/** What it writes: codeloom's detected writes in the PR's own repo (Claude's note in brackets beside one), then any
 * write Claude added; then "Further along (other services):" for writes only other repos make further along the
 * chains; "Reads only:" after, minus anything Claude says is written. */
function whatItWrites(s: PrSummary): string[] {
  const items = s.writes.map((w) => (w.detected && w.notes.length === 0 ? codeSpan(w.name) : `${codeSpan(w.name)} (${claudeSays(w.notes)})`));
  const shown = items.join(", ") + (s.more.writes > 0 ? `, +${s.more.writes} more` : "");
  const further = s.furtherAlong ?? [];
  const none = further.length > 0 && s.repoId !== "" ? `nothing in ${s.repoId}.` : "nothing on the map.";
  const lines = [items.length > 0 ? `**What it writes:** ${shown}` : `**What it writes:** ${none}`];
  // 0.6: what the other services the changed code calls then write, on one line of its own.
  if (further.length > 0) lines.push("", `Further along (other services): ${further.map((x) => `${x.repo}: ${names(x.names, 0)}`).join("; ")}`);
  if (s.readsOnly.length > 0) lines.push("", `Reads only: ${names(s.readsOnly, s.more.readsOnly)}`);
  return lines;
}

/** ⚠ Before deploying: every detected risk (Claude's note beside the one for its file), then the risks Claude
 * added. Omitted when there are none. */
function beforeDeploying(s: PrSummary): string[] {
  const detected = s.beforeDeploying.filter((r) => r.detected);
  const added = s.beforeDeploying.filter((r) => !r.detected);
  const lines = detected.map((r) => {
    const word = r.kind !== undefined && Object.hasOwn(RISK_WORD, r.kind) ? RISK_WORD[r.kind] : "Check";
    const detail = typeof r.detail === "string" && r.detail !== "" ? ` — ${escapeMarkdownInline(r.detail)}` : "";
    return `- ${word}: ${codeSpan(String(r.file))}${detail}${r.notes.length > 0 ? ` — ${claudeSays(r.notes)}` : ""}`;
  });
  const extra = added.map((r) => `- Claude: ${r.file !== undefined ? `${codeSpan(r.file)} — ` : ""}${r.notes.map(escapeClaudeText).join("; ")}`);
  if (lines.length === 0 && extra.length === 0) return [];
  return ["**⚠ Before deploying:**", ...withMore(lines, s.more.beforeDeploying), ...withMore(extra, s.more.beforeDeployingAdded)];
}

/** Code to check: the changed functions (Claude's note beside one; the ones Claude noted first), then the
 * functions Claude added — each list capped on its own. */
function codeToCheck(s: PrSummary): string[] {
  const detected = s.codeToCheck.filter((c) => c.detected);
  const added = s.codeToCheck.filter((c) => !c.detected).map((c) => `- ${codeSpan(c.name)} — ${claudeSays(c.notes)}`);
  const addedLines = withMore(added, s.more.codeToCheckAdded);
  if (detected.length === 0) return ["**Code to check:** no changed function on the map.", ...addedLines];
  const line = (c: SummaryCode): string =>
    `- ${codeSpan(c.name)} — ${c.change}, +${safeCount(c.added)}/-${safeCount(c.removed)} (${codeSpan(String(c.file))})${c.notes.length > 0 ? ` — ${claudeSays(c.notes)}` : ""}`;
  return ["**Code to check:**", ...withMore(detected.map(line), s.more.codeToCheck), ...addedLines];
}

function alsoChanged(review: Review): string[] {
  const off = review.files.filter((f) => !f.onChain);
  if (off.length === 0) return [];
  const counts = new Map<string, number>();
  for (const f of off) {
    const k = fileKind(String(f.file));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const kinds = FILE_KINDS.filter((k) => counts.has(k)).sort((a, b) => counts.get(b)! - counts.get(a)! || FILE_KINDS.indexOf(a) - FILE_KINDS.indexOf(b));
  return [`Also changed: ${plural(off.length, "file")} — ${kinds.join(", ")}`];
}

/** "2026-11-16" from an ISO timestamp; "" when it is not one. */
export function checkedOn(savedAt: unknown): string {
  return typeof savedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(savedAt) ? savedAt.slice(0, 10) : "";
}

/** The 0.5 PR block (spec §2): the PR summary (summary.ts buildPrSummary — the status line, What it does, the entry
 * points that reach the changed code, what it writes and only reads, the risks before deploying, the changed
 * functions, and, when checked, Claude's notes), then a small changed-path diagram and one line for the files on no
 * chain. With `opts.checked` (Claude's saved review of this same head) the status is "Checked by Claude <date>";
 * otherwise What it does is a placeholder for Claude. Every label is escaped as in renderReviewMarkdown (markdown)
 * and renderMermaid (Mermaid); the same GitHub-size backstop applies. Pure and deterministic. */
export function renderReviewDraft(review: Review, opts: ReviewDraftOptions = {}): string {
  const s = buildPrSummary(review, opts.checked);
  const lines = [HEADING, ""];
  if (s.status === "checked") {
    const on = checkedOn(s.checkedAt);
    lines.push(`_Checked by Claude${on ? ` ${on}` : ""}._`, "", `**What it does:** ${escapeClaudeText(String(s.whatItDoes))}`);
  } else {
    lines.push(DRAFT_STATUS, "", `**What it does:** ${WHAT_IT_DOES_PLACEHOLDER}`);
  }
  lines.push("", ...whereItMatters(s));
  lines.push("", ...whatItWrites(s));
  const risks = beforeDeploying(s);
  if (risks.length > 0) lines.push("", ...risks);
  lines.push("", ...codeToCheck(s));
  if (s.notes && s.notes.length > 0) lines.push("", `**Notes:** ${s.notes.map((n) => escapeClaudeText(String(n))).join(" ")}`);
  const diagram = renderChangedPath(review);
  if (diagram !== "") lines.push("", diagram);
  const also = alsoChanged(review);
  if (also.length > 0) lines.push("", ...also);
  const caveat = caveatLine(review);
  if (caveat) lines.push("", caveat);
  if (opts.link) lines.push("", `→ Open the full review map: ${opts.link}`);
  return finish(lines.join("\n"), { link: opts.link });
}
