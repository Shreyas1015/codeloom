import { z } from "zod";
import { compare } from "../util.js";
import { codeToCheckOrder, isWrite } from "./paths.js";
import { reviewFacts } from "./packet.js";
import { CONTROL, PR_REVIEW_LIMITS, type SavedPrReview, text } from "./saved.js";
import type { Review, ReviewEntry, ReviewNodeChange, ReviewRisk } from "./types.js";

// The PR summary (0.5 `codeloom pr`): codeloom's detected facts merged with Claude's saved review, as data. This is
// the one place that merge happens — renderReviewDraft (markdown.ts) prints it as the PR block, and a snapshot
// writes it to data/pr-summary.json for the dashboard's This PR page. Detected writes, risks and changed functions
// always stay; Claude's notes sit beside them and its additions come after them. Strings are kept raw here: each
// renderer escapes them its own way (markdown escapes; the dashboard renders text).

/** Where it matters ≤ 5, Code to check ≤ 8 (+ ≤ 8 Claude added), What it writes / Reads only / Before deploying
 * ≤ 10 each (spec §2) — the rest are counted in `more`, shown as "+N more". */
export const SUMMARY_LIMITS = { whereItMatters: 5, writes: 10, readsOnly: 10, beforeDeploying: 10, codeToCheck: 8, notes: PR_REVIEW_LIMITS.notes } as const;

export interface SummaryWhere {
  /** The page's URL path, the route's "METHOD /path" or the consumed queue's name. */
  name: string;
  /** Detected entry points only (Claude's list has no kind). */
  kind?: ReviewEntry["kind"];
  journey?: string;
  repo?: string;
  /** Claude's reason (checked only). */
  why?: string;
}

export interface SummaryWrite {
  name: string;
  /** codeloom found it; false when Claude added it. */
  detected: boolean;
  /** Claude's notes on it. */
  notes: string[];
}

export interface SummaryRisk {
  /** The file ("<repo>/<path>"); a risk Claude added may name none. */
  file?: string;
  kind?: ReviewRisk["kind"];
  detail?: string;
  detected: boolean;
  notes: string[];
}

export interface SummaryCode {
  /** The function's symbol, e.g. "CustomerService.create". */
  name: string;
  detected: boolean;
  /** Detected (changed) functions only. */
  change?: "new" | "changed" | "deleted";
  added?: number;
  removed?: number;
  /** "<repo>/<file>". */
  file?: string;
  /** The ReviewNodeChange.ref, so the dashboard can open this function's diff. */
  ref?: string;
  notes: string[];
}

export interface PrSummary {
  version: 1;
  status: "checked" | "draft";
  head: string;
  base: string;
  repoId: string;
  /** Checked only: when Claude saved its review (ISO). */
  checkedAt?: string;
  /** Checked only: Claude's 1–2 sentences. */
  whatItDoes?: string;
  whereItMatters: SummaryWhere[];
  writes: SummaryWrite[];
  /** 0.6: detected writes that happen only in other repos further along the chains (another service the changed
   * code calls), by repo — left out of `writes`, which keeps the PR's own repo. Absent when there are none. */
  furtherAlong?: Array<{ repo: string; names: string[] }>;
  readsOnly: string[];
  /** Detected risks first, then the ones Claude added. */
  beforeDeploying: SummaryRisk[];
  /** Detected (changed) functions first — the ones Claude noted first, in its order — then the ones Claude added. */
  codeToCheck: SummaryCode[];
  notes?: string[];
  /** How many were left out of each list by SUMMARY_LIMITS ("+N more"); the `added` ones count Claude's additions,
   * capped on their own so no number of them can push a detected item out of sight. */
  more: { whereItMatters: number; writes: number; readsOnly: number; beforeDeploying: number; beforeDeployingAdded: number; codeToCheck: number; codeToCheckAdded: number };
}

/** A finite, non-negative whole number (never a raw field of an unvalidated Review). */
function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/** Whether `checked` is Claude's review of exactly this review's diff (same head, base and repo). */
export function checksThis(review: Review, checked: SavedPrReview | null | undefined): checked is SavedPrReview {
  return !!checked && checked.head === review.head && checked.base === review.base && checked.repoId === review.repoId;
}

/** name → Claude's notes on it, for the entries that name it (a name with no note still gets an empty list). */
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

const cap = <T>(items: T[], max: number): { shown: T[]; more: number } => ({ shown: items.slice(0, max), more: Math.max(0, items.length - max) });

const changeOf = (n: ReviewNodeChange): SummaryCode["change"] => (n.before === null ? "new" : n.after === null ? "deleted" : "changed");

function whereItMatters(review: Review, c: SavedPrReview | undefined): SummaryWhere[] {
  // Where it matters is a judgement ranking: Claude's list replaces the draft's when given.
  if (c?.whereItMatters !== undefined) return c.whereItMatters.map((w) => ({ name: String(w.name), ...(typeof w.why === "string" && w.why !== "" ? { why: w.why } : {}) }));
  return review.entries.map((e) => ({
    name: String(e.label),
    kind: e.kind,
    ...(typeof e.journey === "string" ? { journey: e.journey } : {}),
    repo: String(e.repo),
  }));
}

/** The detected writes made only in repos other than the PR's own (`review.repoId`; never in whole-workspace
 * mode), by repo: read from the touched chains' write stops. */
function writesElsewhere(review: Review): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const own = review.repoId ?? "";
  if (own === "") return out;
  const stops = Object.values(review.chainStops ?? {}).flatMap((list) => (Array.isArray(list) ? list : []));
  for (const name of review.writes.map(String)) {
    // A write stop's label is "<name> (<op>)" (review/build.ts stopLabel).
    const repos = new Set(stops.filter((s) => isWrite(s) && String(s.label) === `${name} (${String(s.op)})`).map((s) => String(s.repo)));
    if (repos.size === 0 || repos.has(own)) continue;
    for (const r of repos) out.set(r, [...(out.get(r) ?? []), name]);
  }
  return out;
}

function writes(review: Review, c: SavedPrReview | undefined): { writes: SummaryWrite[]; added: Set<string>; further: Array<{ repo: string; names: string[] }> } {
  const notes = notesBy(c?.writes, (w) => String(w.name), (w) => w.note);
  const detected = new Set(review.writes);
  // Further along: only another service writes it (and Claude said nothing about it here).
  const elsewhere = writesElsewhere(review);
  const away = new Set([...elsewhere.values()].flat().filter((n) => (notes.get(n) ?? []).length === 0));
  const further = [...elsewhere.entries()].sort(([a], [b]) => compare(a, b))
    .map(([repo, names]) => ({ repo, names: names.filter((n) => away.has(n)).sort(compare) })).filter((x) => x.names.length > 0);
  const items: SummaryWrite[] = review.writes.filter((n) => !away.has(String(n)))
    .map((n) => ({ name: String(n), detected: true, notes: notes.get(n) ?? [] }));
  const added = [...notes.keys()].filter((n) => !detected.has(n));
  items.push(...added.map((n) => ({ name: n, detected: false, notes: notes.get(n) ?? [] })));
  return { writes: items, added: new Set(added), further };
}

function risks(review: Review, c: SavedPrReview | undefined): { detected: SummaryRisk[]; added: SummaryRisk[] } {
  const notes = notesBy(c?.beforeDeploying, (r) => r.file, (r) => r.note);
  const riskFiles = new Set(review.risks.map((r) => String(r.file)));
  const detected = review.risks.map((r) => ({
    file: String(r.file),
    kind: r.kind,
    ...(typeof r.detail === "string" && r.detail !== "" ? { detail: r.detail } : {}),
    detected: true,
    notes: notes.get(String(r.file)) ?? [],
  }));
  const added = (c?.beforeDeploying ?? [])
    .filter((r) => r.file === undefined || !riskFiles.has(r.file))
    .map((r) => ({ ...(r.file !== undefined ? { file: r.file } : {}), detected: false, notes: [r.note] }));
  return { detected, added };
}

function code(review: Review, c: SavedPrReview | undefined): { detected: SummaryCode[]; added: SummaryCode[] } {
  const notes = notesBy(c?.codeToCheck, (x) => String(x.name), (x) => x.note);
  const order = [...notes.keys()];
  const rank = (n: ReviewNodeChange): number => {
    const i = order.indexOf(String(n.symbol));
    return i === -1 ? order.length : i;
  };
  // The changed functions as the draft orders them (codeToCheckOrder: changed on a chain, other changed, new,
  // deleted; biggest first), the ones Claude noted moved to the front in its order.
  const sorted = codeToCheckOrder(review);
  const noted = sorted.filter((n) => rank(n) < order.length).sort((a, b) => rank(a) - rank(b));
  const rest = sorted.filter((n) => rank(n) === order.length);
  const detected = [...noted, ...rest].map((n) => ({
    name: String(n.symbol),
    detected: true,
    change: changeOf(n),
    added: safeCount(n.added),
    removed: safeCount(n.removed),
    file: `${n.repo}/${n.file}`,
    ref: String(n.ref),
    notes: notes.get(String(n.symbol)) ?? [],
  }));
  const symbols = new Set(review.nodes.map((n) => String(n.symbol)));
  const added = order.filter((n) => !symbols.has(n)).map((n) => ({ name: n, detected: false, notes: notes.get(n) ?? [] }));
  return { detected, added };
}

/** The PR summary for `review`: the draft (detected facts only), or — when `checked` is Claude's saved review of
 * this very diff (same head, base and repo; anything else is ignored) — the checked summary: Claude's What it does
 * and Where it matters, its notes beside the detected writes, risks and changed functions, its additions after
 * them, and its notes. Lists are capped (SUMMARY_LIMITS), the rest counted in `more`. Pure and deterministic. */
export function buildPrSummary(review: Review, checked?: SavedPrReview | null): PrSummary {
  const c = checksThis(review, checked) ? checked : undefined;
  const where = cap(whereItMatters(review, c), SUMMARY_LIMITS.whereItMatters);
  const w = writes(review, c);
  const wr = cap(w.writes, SUMMARY_LIMITS.writes);
  const reads = cap(
    review.readsOnly.map(String).filter((r) => !w.added.has(r)),
    SUMMARY_LIMITS.readsOnly,
  );
  const r = risks(review, c);
  const rd = cap(r.detected, SUMMARY_LIMITS.beforeDeploying);
  const ra = cap(r.added, SUMMARY_LIMITS.beforeDeploying);
  const k = code(review, c);
  const kd = cap(k.detected, SUMMARY_LIMITS.codeToCheck);
  const ka = cap(k.added, SUMMARY_LIMITS.codeToCheck);
  return {
    version: 1,
    status: c ? "checked" : "draft",
    head: review.head,
    base: review.base,
    repoId: review.repoId ?? "",
    ...(c ? { checkedAt: c.savedAt, whatItDoes: String(c.whatItDoes) } : {}),
    whereItMatters: where.shown,
    writes: wr.shown,
    ...(w.further.length > 0 ? { furtherAlong: w.further } : {}),
    readsOnly: reads.shown,
    beforeDeploying: [...rd.shown, ...ra.shown],
    codeToCheck: [...kd.shown, ...ka.shown],
    ...(c?.notes && c.notes.length > 0 ? { notes: c.notes.slice(0, SUMMARY_LIMITS.notes).map(String) } : {}),
    more: {
      whereItMatters: where.more,
      writes: wr.more,
      readsOnly: reads.more,
      beforeDeploying: rd.more,
      beforeDeployingAdded: ra.more,
      codeToCheck: kd.more,
      codeToCheckAdded: ka.more,
    },
  };
}

// ---- the hosted snapshot's trust check ------------------------------------------------------------------------

const L = PR_REVIEW_LIMITS;
/** A name or file codeloom detected or Claude used. No control-character rule here: a real changed file may be named
 * with a newline, and these are only ever matched against review.json's facts below and rendered as text — the
 * control-character rule is for Claude's own text (`text()`). */
const name = z.string().min(1).max(2000);
const count = z.number().int().nonnegative();
/** Claude's notes beside one item: at most one per save_pr_review entry naming it. */
const itemNotes = z.array(text(L.line)).max(L.writes);
const HEAD = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** data/pr-summary.json's shape, held to save_pr_review's rules (lengths, no control characters) for everything
 * Claude wrote. Strict: an unknown key anywhere is refused. */
export const prSummarySchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["checked", "draft"]),
    head: HEAD,
    base: HEAD,
    repoId: z.string().max(200).refine((v) => !CONTROL.test(v)),
    checkedAt: z.iso.datetime().optional(),
    whatItDoes: text(L.whatItDoes).optional(),
    whereItMatters: z
      .array(
        z
          .object({
            name,
            kind: z.enum(["route", "page", "consumer"]).optional(),
            journey: name.optional(),
            repo: name.optional(),
            why: text(L.line).optional(),
          })
          .strict(),
      )
      .max(SUMMARY_LIMITS.whereItMatters),
    writes: z.array(z.object({ name, detected: z.boolean(), notes: itemNotes }).strict()).max(SUMMARY_LIMITS.writes),
    furtherAlong: z.array(z.object({ repo: name, names: z.array(name).max(200) }).strict()).max(50).optional(),
    readsOnly: z.array(name).max(SUMMARY_LIMITS.readsOnly),
    beforeDeploying: z
      .array(
        z
          .object({
            file: name.optional(),
            kind: z.enum(["migration", "schema", "env", "docker", "ci"]).optional(),
            detail: name.optional(),
            detected: z.boolean(),
            notes: itemNotes,
          })
          .strict(),
      )
      .max(SUMMARY_LIMITS.beforeDeploying * 2),
    codeToCheck: z
      .array(
        z
          .object({
            name,
            detected: z.boolean(),
            change: z.enum(["new", "changed", "deleted"]).optional(),
            added: count.optional(),
            removed: count.optional(),
            file: name.optional(),
            ref: name.optional(),
            notes: itemNotes,
          })
          .strict(),
      )
      .max(SUMMARY_LIMITS.codeToCheck * 2),
    notes: z.array(text(L.line)).max(SUMMARY_LIMITS.notes).optional(),
    more: z
      .object({
        whereItMatters: count,
        writes: count,
        readsOnly: count,
        beforeDeploying: count,
        beforeDeployingAdded: count,
        codeToCheck: count,
        codeToCheckAdded: count,
      })
      .strict(),
  })
  .strict()
  // Checked: Claude's date and What it does are there. Draft: nothing of Claude's is.
  .refine((s) => (s.status === "checked" ? s.checkedAt !== undefined && s.whatItDoes !== undefined : s.checkedAt === undefined && s.whatItDoes === undefined && s.notes === undefined));

export type CheckedSummary = { ok: true; summary: PrSummary } | { ok: false; why: "shape" | "names" };

/** Whether `raw` (an untrusted data/pr-summary.json) is a PR summary of `review` (the artifact's already-validated
 * review.json): the right shape (prSummarySchema), the same head/base/repo, and every name one of the review's
 * facts — functions, routes/pages/queues, tables/queues, changed files and changed-function refs. Never throws;
 * the caller refuses with a fixed message (no artifact bytes). */
export function checkPrSummary(raw: unknown, review: Review): CheckedSummary {
  const parsed = prSummarySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, why: "shape" };
  const s = parsed.data as PrSummary;
  const f = reviewFacts(review);
  const among = (n: string | undefined, ...sets: Array<Set<string>>): boolean => n === undefined || sets.some((set) => set.has(n));
  const refs = new Set(review.nodes.map((n) => String(n.ref)));
  const ok =
    s.head === review.head &&
    s.base === review.base &&
    s.repoId === (review.repoId ?? "") &&
    s.whereItMatters.every((w) => among(w.name, f.routes, f.pages, f.queues) && among(w.journey, f.journeys)) &&
    s.writes.every((w) => among(w.name, f.tables, f.queues)) &&
    (s.furtherAlong ?? []).every((x) => x.names.every((n) => among(n, f.tables, f.queues))) &&
    s.readsOnly.every((n) => among(n, f.tables, f.queues)) &&
    s.beforeDeploying.every((r) => among(r.file, f.files)) &&
    s.codeToCheck.every((x) => among(x.name, f.functions) && among(x.file, f.files) && (x.ref === undefined || refs.has(x.ref)));
  return ok ? { ok: true, summary: s } : { ok: false, why: "names" };
}
