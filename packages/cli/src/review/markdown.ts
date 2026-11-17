import { compare } from "../util.js";
import { HEADING } from "./heading.js";
import { renderChangedPath, renderMermaid } from "./mermaid.js";
import { codeToCheckOrder, FILE_KINDS, fileKind } from "./paths.js";
import { GITHUB_BODY_LIMIT } from "./pr-body.js";
import type { SavedPrReview } from "./saved.js";
import type { Review, ReviewEntry, ReviewFile, ReviewNodeChange, ReviewRisk } from "./types.js";

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

/** Where it matters ≤ 5, Code to check ≤ 8 (spec §2), then "+N more". */
const MAX_ENTRIES = 5;
const MAX_CODE = 8;

export const DRAFT_STATUS = "_Draft by codeloom — not checked._";
export const WHAT_IT_DOES_PLACEHOLDER = "_(Claude fills this in when it checks the PR.)_";

const ENTRY_WORD: Record<ReviewEntry["kind"], string> = { page: "page", route: "route", consumer: "queue consumer" };
const RISK_WORD: Record<ReviewRisk["kind"], string> = { migration: "Migration", schema: "Schema", env: "Env", docker: "Docker", ci: "CI" };

function capped(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `- +${lines.length - max} more`] : lines;
}

function entryLine(e: ReviewEntry): string {
  const word = Object.hasOwn(ENTRY_WORD, e.kind) ? ENTRY_WORD[e.kind] : "entry";
  const journey = typeof e.journey === "string" ? `**${escapeMarkdownInline(e.journey)}** — ` : "";
  return `- ${journey}${word} ${codeSpan(String(e.label))} (${escapeMarkdownInline(String(e.repo))})`;
}

function whereItMatters(review: Review): string[] {
  if (review.entries.length === 0) return ["**Where it matters:** no entry point on the map reaches the changed code."];
  return ["**Where it matters:**", ...capped(review.entries.map(entryLine), MAX_ENTRIES)];
}

function names(list: readonly string[]): string {
  const shown = list.slice(0, MAX_LISTED).map((n) => codeSpan(String(n)));
  const hidden = list.length - MAX_LISTED;
  return hidden > 0 ? `${shown.join(", ")}, +${hidden} more` : shown.join(", ");
}

/** Claude's free text (save_pr_review notes, "What it does"): control characters dropped, then escaped like every
 * label (escapeMarkdownInline) plus ":" (no bare-URL autolinks), "~" (no strikethrough), "$" (no math) and a
 * "www." prefix (no www autolinks). */
export function escapeClaudeText(s: string): string {
  return escapeMarkdownInline(s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""))
    .replace(/[:~$]/g, (c) => `\\${c}`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, -1)}\\.`);
}

type Claude = SavedPrReview | undefined;

/** name → Claude's notes on it (joined), for the entries that name it. */
function notesBy<T>(items: readonly T[] | undefined, key: (t: T) => string | undefined, note: (t: T) => string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const it of items ?? []) {
    const k = key(it);
    if (k === undefined) continue;
    const list = out.get(k) ?? [];
    const n = note(it);
    if (typeof n === "string" && n !== "") list.push(n);
    out.set(k, list);
  }
  return out;
}

const claudeSays = (notes: readonly string[] | undefined): string => (notes && notes.length > 0 ? `Claude: ${notes.map(escapeClaudeText).join("; ")}` : "Claude");

/** What it writes: always codeloom's detected writes (Claude's note in brackets beside one), then any write Claude
 * added; "Reads only:" after, minus anything Claude says is written. */
function whatItWrites(review: Review, c?: Claude): string[] {
  const notes = notesBy(c?.writes, (w) => String(w.name), (w) => w.note);
  const detected = new Set(review.writes);
  const items = review.writes.map((n) => (notes.get(n)?.length ? `${codeSpan(String(n))} (${claudeSays(notes.get(n))})` : codeSpan(String(n))));
  const added = [...notes.keys()].filter((n) => !detected.has(n));
  items.push(...added.map((n) => `${codeSpan(n)} (${claudeSays(notes.get(n))})`));
  const shown = items.slice(0, MAX_LISTED).join(", ") + (items.length > MAX_LISTED ? `, +${items.length - MAX_LISTED} more` : "");
  const lines = [items.length > 0 ? `**What it writes:** ${shown}` : "**What it writes:** nothing on the map."];
  const addedSet = new Set(added);
  const reads = review.readsOnly.filter((r) => !addedSet.has(r));
  if (reads.length > 0) lines.push("", `Reads only: ${names(reads)}`);
  return lines;
}

/** ⚠ Before deploying: always every detected risk (Claude's note beside the one for its file), then the risks
 * Claude added. Omitted when there are none. */
function beforeDeploying(review: Review, c?: Claude): string[] {
  const notes = notesBy(c?.beforeDeploying, (r) => r.file, (r) => r.note);
  const riskFiles = new Set(review.risks.map((r) => String(r.file)));
  const lines = review.risks.map((r) => {
    const word = Object.hasOwn(RISK_WORD, r.kind) ? RISK_WORD[r.kind] : "Check";
    const detail = typeof r.detail === "string" && r.detail !== "" ? ` — ${escapeMarkdownInline(r.detail)}` : "";
    const note = notes.get(String(r.file));
    return `- ${word}: ${codeSpan(String(r.file))}${detail}${note?.length ? ` — ${claudeSays(note)}` : ""}`;
  });
  const added = (c?.beforeDeploying ?? [])
    .filter((r) => r.file === undefined || !riskFiles.has(r.file))
    .map((r) => `- Claude: ${r.file !== undefined ? `${codeSpan(r.file)} — ` : ""}${escapeClaudeText(r.note)}`);
  if (lines.length === 0 && added.length === 0) return [];
  return ["**⚠ Before deploying:**", ...capped(lines, MAX_LISTED), ...capped(added, MAX_LISTED)];
}

const changeWord = (n: ReviewNodeChange): string => (n.before === null ? "new" : n.after === null ? "deleted" : "changed");

/** Code to check: always the changed functions (Claude's note beside one) — the ones Claude noted first, in its
 * order, then the rest as in the draft (codeToCheckOrder: changed on a chain, other changed, new, deleted; biggest
 * first) — then the functions Claude added. */
function codeToCheck(review: Review, c?: Claude): string[] {
  const notes = notesBy(c?.codeToCheck, (x) => String(x.name), (x) => x.note);
  if (review.nodes.length === 0 && notes.size === 0) return ["**Code to check:** no changed function on the map."];
  if (review.nodes.length === 0) {
    const only = [...notes.keys()].map((n) => `- ${codeSpan(n)} — ${claudeSays(notes.get(n))}`);
    return ["**Code to check:** no changed function on the map.", ...capped(only, MAX_CODE)];
  }
  const sorted = codeToCheckOrder(review);
  const order = [...notes.keys()];
  const rank = (n: ReviewNodeChange): number => {
    const i = order.indexOf(String(n.symbol));
    return i === -1 ? order.length : i;
  };
  const noted = sorted.filter((n) => rank(n) < order.length).sort((a, b) => rank(a) - rank(b));
  const rest = sorted.filter((n) => rank(n) === order.length);
  const line = (n: ReviewNodeChange): string => {
    const note = notes.get(String(n.symbol));
    return `- ${codeSpan(String(n.symbol))} — ${changeWord(n)}, +${safeCount(n.added)}/-${safeCount(n.removed)} (${codeSpan(`${n.repo}/${n.file}`)})${note?.length ? ` — ${claudeSays(note)}` : ""}`;
  };
  const symbols = new Set(review.nodes.map((n) => String(n.symbol)));
  const added = order.filter((n) => !symbols.has(n)).map((n) => `- ${codeSpan(n)} — ${claudeSays(notes.get(n))}`);
  // The detected changed functions come first and get the whole MAX_CODE; Claude's additions are capped on their
  // own after them, so no number of additions can push a changed function out of sight.
  return ["**Code to check:**", ...capped([...noted.map(line), ...rest.map(line)], MAX_CODE), ...capped(added, MAX_CODE)];
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
function checkedOn(savedAt: unknown): string {
  return typeof savedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(savedAt) ? savedAt.slice(0, 10) : "";
}

/** Whether `checked` is Claude's review of exactly this review's diff. */
function checksThis(review: Review, checked: SavedPrReview | null | undefined): checked is SavedPrReview {
  return !!checked && checked.head === review.head && checked.base === review.base && checked.repoId === review.repoId;
}

/** Where it matters is a judgement ranking: Claude's list replaces the draft's when given. */
function checkedWhere(review: Review, c: SavedPrReview): string[] {
  if (c.whereItMatters === undefined) return whereItMatters(review);
  if (c.whereItMatters.length === 0) return ["**Where it matters:** no entry point on the map reaches the changed code."];
  const why = (t: string | undefined): string => (typeof t === "string" && t !== "" ? ` — ${escapeClaudeText(t)}` : "");
  return ["**Where it matters:**", ...capped(c.whereItMatters.map((w) => `- ${codeSpan(String(w.name))}${why(w.why)}`), MAX_ENTRIES)];
}

/** The 0.5 PR block (spec §2), built from facts only (no AI): the status line, a "What it does" placeholder
 * for Claude to fill in when it checks the PR (spec §3), the entry points that reach the changed code (named
 * by journey), what the changed code writes (and, apart, only reads), the risks before deploying, the
 * changed functions, a small changed-path diagram, and one line for the files on no chain. With `opts.checked`
 * (Claude's saved review of this same head), the status is "Checked by Claude <date>", Claude's "What it does"
 * and "Where it matters" replace the draft's, and its notes sit beside the detected writes, risks and changed
 * functions — which always stay (Claude can add to them, never remove one). Every label is escaped as in renderReviewMarkdown
 * (markdown) and renderMermaid (Mermaid); the same GitHub-size backstop applies. Pure and deterministic. */
export function renderReviewDraft(review: Review, opts: ReviewDraftOptions = {}): string {
  const checked = checksThis(review, opts.checked) ? opts.checked : undefined;
  const lines = [HEADING, ""];
  if (checked) {
    const on = checkedOn(checked.savedAt);
    lines.push(`_Checked by Claude${on ? ` ${on}` : ""}._`, "", `**What it does:** ${escapeClaudeText(String(checked.whatItDoes))}`);
  } else {
    lines.push(DRAFT_STATUS, "", `**What it does:** ${WHAT_IT_DOES_PLACEHOLDER}`);
  }
  // Detected writes, risks and changed functions always come from the Review; Claude only annotates or adds.
  const s = {
    where: checked ? checkedWhere(review, checked) : whereItMatters(review),
    writes: whatItWrites(review, checked),
    risks: beforeDeploying(review, checked),
    code: codeToCheck(review, checked),
  };
  lines.push("", ...s.where);
  lines.push("", ...s.writes);
  if (s.risks.length > 0) lines.push("", ...s.risks);
  lines.push("", ...s.code);
  if (checked?.notes && checked.notes.length > 0) lines.push("", `**Notes:** ${checked.notes.map((n) => escapeClaudeText(String(n))).join(" ")}`);
  const diagram = renderChangedPath(review);
  if (diagram !== "") lines.push("", diagram);
  const also = alsoChanged(review);
  if (also.length > 0) lines.push("", ...also);
  const caveat = caveatLine(review);
  if (caveat) lines.push("", caveat);
  if (opts.link) lines.push("", `→ Open the full review map: ${opts.link}`);
  return finish(lines.join("\n"), { link: opts.link });
}
