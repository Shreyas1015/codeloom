import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { readJson, writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR } from "../store/paths.js";
import { resolveCommit } from "../workspace/diff.js";
import { loadWorkspace } from "../workspace/repos.js";
import { type CheckPacket, reviewedDir } from "./packet.js";

// Claude's checked review of a PR (0.5 spec §3), written only by the save_pr_review MCP tool. This is the trust
// boundary for Claude's output: the head must be HEAD of the reviewed repo, every name in a structured field
// must be one of the check packet's facts, and every free-text field is length-capped here and escaped when
// rendered (markdown.ts). Kept in <ws>/.codeloom/reviews/ — local only, never committed (a "*" .gitignore in
// that folder keeps it out of git whatever the workspace's commit-or-keep-local choice).

export const REVIEWS_DIR = "reviews";
/** A full git object id (SHA-1, or SHA-256): the only thing ever used as a file name here. */
const HEAD_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const Head = z.string().regex(HEAD_RE, "head is not a full commit id (40 hex characters)");

export const PR_REVIEW_LIMITS = { whatItDoes: 400, line: 200, name: 300, whereItMatters: 5, writes: 10, beforeDeploying: 10, codeToCheck: 8, notes: 3 } as const;

/** C0 and C1 control characters (terminal escapes, newlines, …): never allowed in anything Claude saves. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const text = (max: number) =>
  z.string().trim().min(1).max(max).refine((v) => !CONTROL.test(v), "must not contain a control character (newline, escape, …)");
const L = PR_REVIEW_LIMITS;

/** What Claude sends to save_pr_review. codeloom's detected writes, deploy risks and changed functions always
 * stay: Claude may only attach a `note` to one of them (same name / file) or add an item. "Where it matters" (a
 * judgement ranking) is replaced when given; any section left out keeps the draft's lines. */
export const PrReviewInputShape = {
  head: Head.describe("The packet's `head`: the full commit id of HEAD in the reviewed repo."),
  whatItDoes: text(L.whatItDoes).describe("What the PR does, in 1–2 plain sentences."),
  whereItMatters: z
    .array(z.object({ name: text(L.name).describe("A route, page or queue from facts.routes / facts.pages / facts.queues."), why: text(L.line).optional() }).strict())
    .max(L.whereItMatters)
    .optional()
    .describe("Replaces the draft's Where it matters."),
  writes: z
    .array(z.object({ name: text(L.name).describe("A table or queue from facts.tables / facts.queues."), note: text(L.line).optional() }).strict())
    .max(L.writes)
    .optional()
    .describe("Notes on the detected writes (same name), or writes to add. Detected writes always stay."),
  beforeDeploying: z
    .array(z.object({ file: text(L.name).optional().describe("A changed file from facts.files."), note: text(L.line) }).strict())
    .max(L.beforeDeploying)
    .optional()
    .describe("Notes on the detected risks (same file), or risks to add. Detected risks always stay."),
  codeToCheck: z
    .array(z.object({ name: text(L.name).describe("A function from facts.functions."), note: text(L.line).optional() }).strict())
    .max(L.codeToCheck)
    .optional()
    .describe("Notes on the changed functions (same name), or functions to add. Changed functions always stay."),
  notes: z.array(text(L.line)).max(L.notes).optional().describe("Anything else a reviewer should know."),
};
export const PrReviewInputSchema = z.object(PrReviewInputShape).strict();
export type PrReviewInput = z.infer<typeof PrReviewInputSchema>;

export const SavedPrReviewSchema = PrReviewInputSchema.extend({
  version: z.literal(1),
  repoId: z.string(),
  base: Head,
  savedAt: z.iso.datetime(),
}).strict();
export type SavedPrReview = z.infer<typeof SavedPrReviewSchema>;

/** The check packet as kept for save_pr_review (only the parts it checks against). */
const KeptPacketSchema = z
  .object({
    version: z.literal(1),
    repoId: z.string(),
    base: Head,
    head: Head,
    facts: z.object({
      functions: z.array(z.string()),
      routes: z.array(z.string()),
      pages: z.array(z.string()),
      queues: z.array(z.string()),
      tables: z.array(z.string()),
      files: z.array(z.string()),
      journeys: z.array(z.string()),
    }),
  })
  .loose();

function reviewsDir(root: string): string {
  return join(root, CODELOOM_DIR, REVIEWS_DIR);
}

/** Creates .codeloom/reviews/ with a "*" .gitignore, so nothing in it is ever committed. */
function ensureReviewsDir(root: string): string {
  const dir = reviewsDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore) || readFileSync(ignore, "utf8") !== "*\n") writeFileSync(ignore, "*\n");
  return dir;
}

function checkedHead(head: string): string {
  if (!HEAD_RE.test(head)) throw dataError(`${JSON.stringify(head)} is not a full commit id.`);
  return head;
}

/** Keeps the packet Claude is given (<ws>/.codeloom/reviews/<head>.packet.json), so save_pr_review can check
 * Claude's names against exactly the facts it saw. Returns the file's path. */
export function rememberPacket(start: string, packet: CheckPacket): string {
  const { root } = loadWorkspace(start);
  const path = join(ensureReviewsDir(root), `${checkedHead(packet.head)}.packet.json`);
  writeJsonAtomic(path, packet);
  return path;
}

/** The saved, checked review for `head`, or null when there is none (or `head` is not a commit id). A file that
 * cannot be read (bad JSON, another version, a bad shape) is ignored — the draft is shown instead — with one
 * line passed to `warn`. */
export function loadPrReview(start: string, head: string, warn: (line: string) => void = () => {}): SavedPrReview | null {
  if (!HEAD_RE.test(head)) return null;
  const { root } = loadWorkspace(start);
  const path = join(reviewsDir(root), `${head}.json`);
  if (!existsSync(path)) return null;
  const ignored = (why: string): null => {
    warn(`codeloom: ignoring the saved review ${path} (${why}); showing the draft.`);
    return null;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return ignored("not valid JSON");
  }
  const parsed = SavedPrReviewSchema.safeParse(raw);
  if (!parsed.success) {
    const version = (raw as { version?: unknown } | null)?.version;
    return ignored(version !== 1 ? `version ${JSON.stringify(version ?? null)}, not 1` : "unexpected shape");
  }
  return parsed.data.head === head ? parsed.data : null;
}

const MAX_LISTED_NAMES = 30;

/** `Class.member` (a capitalised name of 2+ characters, then a member of 2+) and snake_case identifiers in
 * prose. "e.g.", "U.S." and ordinary words do not match. */
const MEMBER_RE = /\b[A-Z][A-Za-z0-9_$]+(?:\.[A-Za-z_$][A-Za-z0-9_$]+)+\b/g;
const SNAKE_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;

/** Every string in a parsed JSON value (not its JSON text, whose escapes like "\\t" would glue onto a name). */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Whether `token` appears in `text` as a whole name: "Service.create" is not in "CustomerService.create", nor
 * "api_key" in "secret_api_key". */
function hasWholeToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}

function identifiersIn(text: string): string[] {
  return [...(text.match(MEMBER_RE) ?? []), ...(text.match(SNAKE_RE) ?? [])];
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED_NAMES).map((n) => JSON.stringify(n));
  return names.length > MAX_LISTED_NAMES ? `${shown.join(", ")}, +${names.length - MAX_LISTED_NAMES} more` : shown.join(", ") || "(none)";
}

/** Validate Claude's review and save it to <ws>/.codeloom/reviews/<head>.json. Refused (dataError, nothing
 * written) when the input is malformed, no check packet was built for `head`, `head` is not HEAD of the
 * reviewed repo any more, or a structured field names anything that is not in the packet's facts (every bad
 * name is listed). */
export function savePrReview(start: string, input: unknown, opts: { now?: () => Date } = {}): { path: string; review: SavedPrReview } {
  const parsed = PrReviewInputSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw dataError(`The review is not valid:\n${lines.join("\n")}`);
  }
  const data = parsed.data;
  const { root } = loadWorkspace(start);
  const packetPath = join(reviewsDir(root), `${data.head}.packet.json`);
  const packet = readJson(packetPath, KeptPacketSchema);
  if (packet === null || packet.head !== data.head) {
    throw dataError(`No check packet for head ${data.head}. Build it first (the pr_check_packet tool, the check-pr prompt or "codeloom review --packet") and use its \`head\`.`);
  }
  const dir = reviewedDir(root, packet.repoId);
  const now = resolveCommit(dir, "HEAD");
  if (now !== data.head) {
    throw dataError(`head ${data.head} is not HEAD of ${packet.repoId === "" ? "the workspace" : `repo "${packet.repoId}"`} (HEAD is ${now ?? "unknown"}). Build a new check packet for HEAD and check that instead.`);
  }

  const f = packet.facts;
  const problems: string[] = [];
  const check = (field: string, names: Array<string | undefined>, allowed: readonly string[], what: string) => {
    const ok = new Set(allowed);
    const bad = names.filter((n): n is string => n !== undefined && !ok.has(n));
    if (bad.length > 0) problems.push(`  - ${field}: not ${what} in the packet: ${listNames([...new Set(bad)])}. Allowed: ${listNames(allowed)}.`);
  };
  check("whereItMatters", (data.whereItMatters ?? []).map((x) => x.name), [...f.routes, ...f.pages, ...f.queues], "a route, page or queue");
  check("writes", (data.writes ?? []).map((x) => x.name), [...f.tables, ...f.queues], "a table or queue");
  check("beforeDeploying", (data.beforeDeploying ?? []).map((x) => x.file), f.files, "a changed file");
  check("codeToCheck", (data.codeToCheck ?? []).map((x) => x.name), f.functions, "a function");
  // Free text may name code too: a Name.member or snake_case identifier must appear somewhere in the packet (its
  // facts, or the code and commits it shows), so text Claude did not get from the packet cannot slip in.
  const packetText = stringsIn(packet).join("\n");
  const free = [
    data.whatItDoes,
    ...(data.notes ?? []),
    ...(data.whereItMatters ?? []).map((x) => x.why),
    ...(data.writes ?? []).map((x) => x.note),
    ...(data.beforeDeploying ?? []).map((x) => x.note),
    ...(data.codeToCheck ?? []).map((x) => x.note),
  ].filter((t): t is string => typeof t === "string");
  const unknown = [...new Set(free.flatMap(identifiersIn))].filter((id) => !hasWholeToken(packetText, id));
  if (unknown.length > 0) problems.push(`  - free text: names not in the packet: ${listNames(unknown)}. Describe them in plain words, or use names from the packet.`);
  if (problems.length > 0) {
    throw dataError(`The review names things that are not in the check packet (use only names from its facts):\n${problems.join("\n")}`);
  }

  const review: SavedPrReview = {
    version: 1,
    repoId: packet.repoId,
    base: packet.base,
    ...data,
    savedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  const path = join(ensureReviewsDir(root), `${data.head}.json`);
  writeJsonAtomic(path, review);
  return { path, review };
}
