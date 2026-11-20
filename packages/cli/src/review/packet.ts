import { compare } from "../util.js";
import { git } from "../workspace/git.js";
import { loadWorkspace } from "../workspace/repos.js";
import { buildReview } from "./build.js";
import { codeToCheckOrder, fileKind } from "./paths.js";
import type { Review, ReviewEntry, ReviewNodeChange, ReviewRisk } from "./types.js";
import { repoAbsPath } from "../workspace/registry.js";

// The check packet (0.5 spec §3): everything Claude needs to check codeloom's draft of a PR, and nothing more,
// so a check costs few tokens and needs no other tool call. Built from the Review alone (no AI) plus the
// commit messages; capped at PACKET_LIMITS.chars characters of JSON, with every cut listed in `cut`.

export const PACKET_LIMITS = {
  /** The whole packet, as packetText() — the exact text inlined in the check-pr prompt (~6k tokens). */
  chars: 24_000,
  /** Lines of one diff hunk. */
  hunkLines: 60,
  /** Lines of every hunk together. */
  totalHunkLines: 400,
  /** Commit subjects and bodies together. */
  commitLines: 40,
  /** Any one string (a name, a code line, a commit line): longer ones end in "…". */
  stringChars: 300,
  /** Items in any one list of the draft or the facts, before the size cap is even looked at. */
  listItems: 100,
} as const;

export interface PacketEntry {
  kind: ReviewEntry["kind"];
  /** A page's URL path, a route's "METHOD /path" or a consumed queue's name. */
  name: string;
  journey?: string;
  repo: string;
}

export interface PacketCode {
  /** The changed function's symbol, e.g. "CustomerService.create". */
  name: string;
  change: "new" | "changed" | "deleted";
  /** "<repo>/<file>". */
  file: string;
  added: number;
  removed: number;
  /** Names of the journeys it is a stop of. */
  journeys: string[];
}

export interface PacketHunk {
  /** The changed function the hunk belongs to. */
  name: string;
  file: string;
  /** "@@ -old,n +new,m @@". */
  at: string;
  /** Lines with their leading " ", "+" or "-". */
  lines: string[];
}

export interface CheckPacket {
  version: 1;
  repoId: string;
  base: string;
  head: string;
  baseRef: string;
  /** The draft, as data: what codeloom's `review` prints, section by section. */
  draft: {
    whereItMatters: PacketEntry[];
    writes: string[];
    readsOnly: string[];
    beforeDeploying: Array<Pick<ReviewRisk, "kind" | "file" | "detail">>;
    codeToCheck: PacketCode[];
    alsoChanged: Array<{ file: string; kind: string; added: number; removed: number }>;
  };
  /** Only the changed hunks of each changed function, most important function first. */
  hunks: PacketHunk[];
  /** Commit subjects (and, indented by two spaces, their body lines), oldest first. */
  commits: string[];
  /** Every name Claude may use: save_pr_review refuses any other. */
  facts: {
    functions: string[];
    routes: string[];
    pages: string[];
    queues: string[];
    tables: string[];
    files: string[];
    journeys: string[];
  };
  /** What was left out to fit the caps, one line per list, e.g. "hunks: kept 400 of 912 lines". */
  cut: string[];
}

/** The packet exactly as it is inlined in the check-pr prompt and printed by `codeloom review --packet`. */
export function packetText(packet: CheckPacket): string {
  return JSON.stringify(packet);
}

const clip = (s: string): string => (s.length > PACKET_LIMITS.stringChars ? `${s.slice(0, PACKET_LIMITS.stringChars - 1)}…` : s);
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0);
const changeOf = (n: ReviewNodeChange): PacketCode["change"] => (n.before === null ? "new" : n.after === null ? "deleted" : "changed");
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(compare);

type FactKey = keyof CheckPacket["facts"];
type DraftKey = keyof CheckPacket["draft"];
const FACT_KEYS: FactKey[] = ["functions", "routes", "pages", "queues", "tables", "files", "journeys"];
/** The order draft lists are cut in, last resort: what codeloom detected (risks, changed functions) goes last. */
const DRAFT_CUT_ORDER: DraftKey[] = ["alsoChanged", "readsOnly", "whereItMatters", "writes", "beforeDeploying", "codeToCheck"];
/** Commit lines kept until every hunk is cut (the subjects say what the PR is for). */
const KEEP_COMMIT_LINES = 10;

/** One changed function's hunks, each already clipped to PACKET_LIMITS.hunkLines (`long`: it was longer). */
interface SourceHunks {
  name: string;
  file: string;
  hunks: Array<{ at: string; lines: string[]; long: boolean }>;
}

/** The names each fact list must keep for the draft as it stands (a draft item cut takes its names with it). */
function citedBy(draft: CheckPacket["draft"], queueNames: ReadonlySet<string>): Record<FactKey, string[]> {
  const w = draft.whereItMatters;
  return {
    functions: sortedUnique(draft.codeToCheck.map((c) => c.name)),
    routes: sortedUnique(w.filter((e) => e.kind === "route").map((e) => e.name)),
    pages: sortedUnique(w.filter((e) => e.kind === "page").map((e) => e.name)),
    queues: sortedUnique([...w.filter((e) => e.kind === "consumer").map((e) => e.name), ...draft.writes.filter((n) => queueNames.has(n))]),
    tables: sortedUnique([...draft.writes.filter((n) => !queueNames.has(n)), ...draft.readsOnly]),
    files: sortedUnique([...draft.beforeDeploying.map((r) => r.file), ...draft.codeToCheck.map((c) => c.file), ...draft.alsoChanged.map((f) => f.file)]),
    journeys: sortedUnique([...w.flatMap((e) => (e.journey !== undefined ? [e.journey] : [])), ...draft.codeToCheck.flatMap((c) => c.journeys)]),
  };
}

/** Lines per function when every function may keep at most `cap` lines (in hunk order), plus `extra.get(name)`
 * more for the functions given leftover budget. */
function hunksAt(source: SourceHunks[], cap: number, extra: ReadonlyMap<string, number> = new Map()): { hunks: PacketHunk[]; longIncluded: number } {
  const hunks: PacketHunk[] = [];
  let longIncluded = 0;
  for (const f of source) {
    let room = cap + (extra.get(f.name) ?? 0);
    for (const h of f.hunks) {
      if (room <= 0) break;
      const lines = h.lines.slice(0, room);
      room -= lines.length;
      if (h.long) longIncluded++;
      hunks.push({ name: f.name, file: f.file, at: h.at, lines });
    }
  }
  return { hunks, longIncluded };
}

const totalLines = (source: SourceHunks[], cap: number): number =>
  source.reduce((n, f) => n + Math.min(cap, f.hunks.reduce((m, h) => m + h.lines.length, 0)), 0);

/** The largest n in [0, max] with fits(n), given fits(0) is the fallback (binary search). */
function largest(max: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Every name the Review offers, by kind (before any cap): the changed functions and the function/handler stops of
 * the touched chains (never one in a test or docs file), entry routes/pages/queues, tables and queues, changed files
 * and journey names — plus the (clipped) queue names, which never count as tables. */
function factPool(review: Review): { everything: Record<FactKey, string[]>; queueNames: Set<string> } {
  const nodes = codeToCheckOrder(review);
  const stops = Object.keys(review.chainStops)
    .filter((id) => Object.hasOwn(review.chainStops, id))
    .flatMap((id) => review.chainStops[id]!);
  const stopNames = (pred: (kind: string | undefined, lane: string) => boolean): string[] =>
    stops.filter((s) => pred(s.kind, s.lane)).map((s) => String(s.label).replace(/ \((?:read|insert|update|delete|upsert|publish|consume)\)$/, ""));
  const queueNames = new Set([...review.queues, ...stopNames((_k, lane) => lane === "queue")].map(clip));
  // A function/handler stop in a test or docs file (paths.ts fileKind) is never an uncited fact either
  // (0.5 acceptance fix): review.nodes already excludes it, so only a chain stop could still sneak it in.
  const nonTestDocsFunctionStops = stops
    .filter((s) => (s.kind === "function" || s.kind === "handler") && !(s.file !== undefined && (fileKind(s.file) === "tests" || fileKind(s.file) === "docs")))
    .map((s) => String(s.label).replace(/ \((?:read|insert|update|delete|upsert|publish|consume)\)$/, ""));
  const everything: Record<FactKey, string[]> = {
    functions: [...nodes.map((n) => n.symbol), ...nonTestDocsFunctionStops],
    routes: [...review.entries.filter((e) => e.kind === "route").map((e) => e.label), ...stopNames((k) => k === "route")],
    pages: [...review.entries.filter((e) => e.kind === "page").map((e) => e.label), ...stopNames((k) => k === "page")],
    queues: [...review.queues, ...review.entries.filter((e) => e.kind === "consumer").map((e) => e.label), ...stopNames((_k, lane) => lane === "queue")],
    tables: [...review.writes, ...review.readsOnly, ...review.tables, ...stopNames((_k, lane) => lane === "db")].filter((n) => !queueNames.has(clip(n))),
    files: [...review.risks.map((r) => r.file), ...review.files.map((f) => `${f.repo}/${f.file}`)],
    journeys: review.journeys.map((j) => j.name),
  };
  return { everything, queueNames };
}

/** Every name a Review offers, by kind — what a check packet's facts are drawn from (before the packet's caps). Each
 * name as the Review has it and, when longer than PACKET_LIMITS.stringChars, also as the packet clips it (the form
 * Claude saw). The hosted snapshot checks data/pr-summary.json's names against these. */
export function reviewFacts(review: Review): Record<FactKey, Set<string>> {
  const { everything } = factPool(review);
  return Object.fromEntries(FACT_KEYS.map((k) => [k, new Set(everything[k].flatMap((n) => [String(n), clip(String(n))]))])) as Record<FactKey, Set<string>>;
}

/** The packet for an already-built Review and its commit lines (oldest first). Pure: no git, no files.
 * Caps first (each hunk ≤ 60 lines, ≤ 400 hunk lines shared evenly between the changed functions, ≤ 40 commit
 * lines, ≤ 300 characters a string, ≤ 100 items a list — never below what the draft cites); then, while the JSON
 * is over 24,000 characters, cuts in this order: fact names the draft does not cite; commit lines beyond the
 * first 10; every function's code evenly (no function loses all of its code before the others are cut down);
 * the remaining commit lines; then draft items — each with its facts — risks and changed functions last.
 * A fact the draft cites is never cut while the draft still cites it. Every cut is listed in `cut`. */
export function packetFromReview(review: Review, commitLinesIn: string[]): CheckPacket {
  const journeyName = new Map(review.journeys.map((j) => [j.id, j.name]));
  const nodes = codeToCheckOrder(review); // as the draft lists them
  const L = PACKET_LIMITS.listItems;

  const fullDraft: CheckPacket["draft"] = {
    whereItMatters: review.entries.slice(0, L).map((e) => ({
      kind: e.kind,
      name: clip(String(e.label)),
      ...(typeof e.journey === "string" ? { journey: clip(e.journey) } : {}),
      repo: clip(String(e.repo)),
    })),
    writes: review.writes.slice(0, L).map(clip),
    readsOnly: review.readsOnly.slice(0, L).map(clip),
    beforeDeploying: review.risks.slice(0, L).map((r) => ({
      kind: r.kind,
      file: clip(String(r.file)),
      ...(typeof r.detail === "string" && r.detail !== "" ? { detail: clip(r.detail) } : {}),
    })),
    codeToCheck: nodes.slice(0, L).map((n) => ({
      name: clip(n.symbol),
      change: changeOf(n),
      file: clip(`${n.repo}/${n.file}`),
      added: count(n.added),
      removed: count(n.removed),
      journeys: n.journeys.map((id) => journeyName.get(id)).filter((x): x is string => x !== undefined).map(clip),
    })),
    alsoChanged: review.files
      .filter((f) => !f.onChain)
      .slice(0, L)
      .map((f) => ({ file: clip(`${f.repo}/${f.file}`), kind: fileKind(String(f.file)), added: count(f.added), removed: count(f.removed) })),
  };
  const draftTotal: Record<DraftKey, number> = {
    whereItMatters: review.entries.length,
    writes: review.writes.length,
    readsOnly: review.readsOnly.length,
    beforeDeploying: review.risks.length,
    codeToCheck: nodes.length,
    alsoChanged: review.files.filter((f) => !f.onChain).length,
  };
  const draftKept = Object.fromEntries(DRAFT_CUT_ORDER.map((k) => [k, (fullDraft[k] as unknown[]).length])) as Record<DraftKey, number>;
  const draftNow = (): CheckPacket["draft"] =>
    Object.fromEntries(DRAFT_CUT_ORDER.map((k) => [k, (fullDraft[k] as unknown[]).slice(0, draftKept[k])])) as unknown as CheckPacket["draft"];

  // Facts: the names the (full) draft cites, then every other name on the touched chains (the "uncited" pool).
  const { everything, queueNames } = factPool(review);
  const cited0 = citedBy(fullDraft, queueNames);
  const uncited = {} as Record<FactKey, string[]>;
  const uncitedKept = {} as Record<FactKey, number>;
  const factTotal = {} as Record<FactKey, number>;
  for (const k of FACT_KEYS) {
    const all = sortedUnique(everything[k].map((x) => clip(String(x))));
    const cited = new Set(cited0[k]);
    uncited[k] = all.filter((x) => !cited.has(x));
    factTotal[k] = sortedUnique([...all, ...cited0[k]]).length;
    uncitedKept[k] = Math.min(uncited[k].length, Math.max(0, L - cited0[k].length));
  }

  // Code: each hunk ≤ 60 lines; then one per-function line cap shared evenly so all of it fits in 400 lines.
  const source: SourceHunks[] = nodes.slice(0, L).map((n) => ({
    name: clip(n.symbol),
    file: clip(`${n.repo}/${n.file}`),
    hunks: n.hunks.map((h) => ({
      at: `@@ -${count(h.oldStart)},${count(h.oldLines)} +${count(h.newStart)},${count(h.newLines)} @@`,
      lines: h.lines.slice(0, PACKET_LIMITS.hunkLines).map((l) => clip(String(l))),
      long: h.lines.length > PACKET_LIMITS.hunkLines,
    })),
  }));
  const allHunkLines = nodes.reduce((n, x) => n + x.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const maxPerFunction = source.reduce((m, f) => Math.max(m, f.hunks.reduce((k, h) => k + h.lines.length, 0)), 0);
  let lineCap = largest(maxPerFunction, (cap) => totalLines(source, cap) <= PACKET_LIMITS.totalHunkLines);

  /** Lines a function keeps beyond `lineCap`: the budget an even cut leaves unused, given in draft order. */
  const extra = new Map<string, number>();
  const commitsAll = commitLinesIn.map(clip);
  let commitsKept = Math.min(commitsAll.length, PACKET_LIMITS.commitLines);

  const assemble = (): CheckPacket => {
    const draft = draftNow();
    const cited = citedBy(draft, queueNames);
    const facts = Object.fromEntries(FACT_KEYS.map((k) => [k, [...cited[k], ...uncited[k].slice(0, uncitedKept[k])]])) as CheckPacket["facts"];
    // Only the code of functions the draft still lists.
    const listed = new Set(draft.codeToCheck.map((c) => c.name));
    const { hunks, longIncluded } = hunksAt(source.filter((f) => listed.has(f.name)), lineCap, extra);
    const cut: string[] = [];
    const keptOf = (key: string, kept: number, of: number, unit = ""): void => {
      if (kept < of) cut.push(`${key}: kept ${kept} of ${of}${unit}`);
    };
    for (const k of DRAFT_CUT_ORDER) keptOf(`draft.${k}`, (draft[k] as unknown[]).length, draftTotal[k]);
    const keptLines = hunks.reduce((n, h) => n + h.lines.length, 0);
    keptOf("hunk lines", keptLines, allHunkLines);
    if (longIncluded > 0) cut.push(`hunks: ${longIncluded} hunk${longIncluded === 1 ? "" : "s"} longer than ${PACKET_LIMITS.hunkLines} lines, each cut to at most ${PACKET_LIMITS.hunkLines}`);
    keptOf("commits", commitsKept, commitsAll.length, " lines");
    for (const k of FACT_KEYS) keptOf(`facts.${k}`, facts[k].length, factTotal[k]);
    return {
      version: 1,
      repoId: review.repoId,
      base: review.base,
      head: review.head,
      baseRef: clip(review.baseRef),
      draft,
      hunks,
      commits: commitsAll.slice(0, commitsKept),
      facts,
      cut,
    };
  };
  const fits = (): boolean => packetText(assemble()).length <= PACKET_LIMITS.chars;

  // 1. Fact names the draft does not cite, longest list first.
  while (!fits()) {
    const k = FACT_KEYS.filter((x) => uncitedKept[x] > 0).sort(
      (a, b) => JSON.stringify(uncited[b].slice(0, uncitedKept[b])).length - JSON.stringify(uncited[a].slice(0, uncitedKept[a])).length,
    )[0];
    if (k === undefined) break;
    uncitedKept[k]--;
  }
  // 2. Commit lines beyond the first few.
  while (!fits() && commitsKept > KEEP_COMMIT_LINES) commitsKept--;
  // 3. Every function's code, evenly.
  if (!fits()) {
    const was = lineCap;
    lineCap = largest(was, (cap) => {
      lineCap = cap;
      return cap === 0 || fits();
    });
  }
  // 3b. What the even cut (and the 400-line cap's rounding) left unused goes to the changed functions in draft
  //     order — the most important first — so a long list of functions does not leave every one with no code.
  let used = totalLines(source, lineCap);
  for (const f of source) {
    const own = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    const most = Math.min(own - Math.min(own, lineCap), PACKET_LIMITS.totalHunkLines - used);
    if (most <= 0) continue;
    const more = largest(most, (n) => {
      extra.set(f.name, n);
      return n === 0 || fits();
    });
    if (more > 0) extra.set(f.name, more);
    else extra.delete(f.name);
    used += more;
  }
  // 4. The remaining commit lines.
  while (!fits() && commitsKept > 0) commitsKept--;
  // 5. Draft items with their facts, what codeloom detected last.
  for (const k of DRAFT_CUT_ORDER) while (!fits() && draftKept[k] > 0) draftKept[k]--;
  return assemble();
}

/** Commit subjects and body lines of base..head (oldest first, blank lines dropped, bodies indented). */
function commitLines(dir: string, base: string, head: string): string[] {
  const raw = git(dir, ["log", "--reverse", "--no-color", "--format=%B%x00", `${base}..${head}`]);
  const lines: string[] = [];
  for (const message of raw.split("\0")) {
    const parts = message.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
    if (parts.length === 0) continue;
    lines.push(parts[0]!.trim(), ...parts.slice(1).map((l) => `  ${l.trim()}`));
  }
  return lines;
}

/** Where the reviewed history lives: the repo (`repoId`), or the workspace root when `repoId` is "". */
export function reviewedDir(start: string, repoId: string): string {
  const ws = loadWorkspace(start);
  if (repoId === "") return ws.root;
  const ref = ws.repos.find((r) => r.id === repoId);
  return ref ? repoAbsPath(ws.root, ref) : ws.root;
}

/** The check packet for an already-built Review: reads its commit messages from the reviewed repo. Read only. */
export function packetForReview(start: string, review: Review): CheckPacket {
  return packetFromReview(review, commitLines(reviewedDir(start, review.repoId), review.base, review.head));
}

/** The check packet for `merge-base(baseRef, HEAD)..HEAD` (0.5 spec §3): builds the Review (as `codeloom
 * review` does, same `--repo` rules) and reads the commit messages. Read only: keeping the packet for
 * save_pr_review is saved.ts's rememberPacket. */
export function buildCheckPacket(start: string, baseRef: string, opts: { repoId?: string } = {}): CheckPacket {
  return packetForReview(start, buildReview(start, baseRef, opts.repoId !== undefined ? { repoId: opts.repoId } : {}));
}
