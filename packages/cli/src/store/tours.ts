import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { compare } from "../util.js";
import { gitHead } from "../workspace/repos.js";
import { readJson, writeJsonAtomic } from "./json.js";
import { CODELOOM_DIR } from "./paths.js";
import { parseStopKey, type PlacedStop, stopMatcher } from "./stop-key.js";

/** `.codeloom/tours/` in the workspace root: one committed file per journey (spec §1). */
export const TOURS_DIR = "tours";
export const JOURNEY_ID_RE = /^j_[0-9a-f]{12}$/;

/** Size caps: a tour is agent prose, kept small enough to read and to send over MCP (< 1 MB). */
export const TOUR_LIMITS = {
  explanation: 1500,
  text: 8000,
  note: 1500,
  sql: 4000,
  question: 500,
  expected: 10,
  stops: 300,
  steps: 300,
  files: 300,
  notesPerFile: 30,
} as const;

/** What a tour needs to know about the workspace: its root and each repo's id and folder. `WorkspaceData`
 * (store/read.ts) fits. */
export interface StoreWorkspace {
  root: string;
  name: string;
  repos: ReadonlyArray<{ ref: { id: string }; abs: string }>;
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Key = z.string().min(1).max(4096);

export const TourStopSchema = z.object({
  chainId: z.string().min(1),
  stopIndex: z.number().int().nonnegative(),
  /** The shared stopKey (store/stop-key.ts): lane, repo, file, line, symbol. */
  key: Key,
  /** sha256 of the stop file's content when the tour was written (computed by codeloom). */
  fileHash: Sha256,
  explanation: z.string().max(TOUR_LIMITS.explanation),
});
export type TourStop = z.infer<typeof TourStopSchema>;

export const DataJourneySchema = z.object({
  input: z.string().max(TOUR_LIMITS.text),
  steps: z.array(z.object({
    stopKey: Key,
    sql: z.string().max(TOUR_LIMITS.sql).optional(),
    note: z.string().max(TOUR_LIMITS.note),
  })).max(TOUR_LIMITS.steps),
  output: z.string().max(TOUR_LIMITS.text),
});
export type DataJourney = z.infer<typeof DataJourneySchema>;

export const FileNoteSchema = z.object({
  repo: z.string().min(1),
  file: z.string().min(1),
  notes: z.array(z.object({ kind: z.enum(["trap", "note"]), text: z.string().min(1).max(TOUR_LIMITS.note) })).max(TOUR_LIMITS.notesPerFile),
});
export type FileNote = z.infer<typeof FileNoteSchema>;

export const CheckQuestionSchema = z.object({
  question: z.string().min(1).max(TOUR_LIMITS.question),
  /** Key points the agent judges an answer against. */
  expected: z.array(z.string().min(1).max(TOUR_LIMITS.question)).min(1).max(TOUR_LIMITS.expected),
});
export type CheckQuestion = z.infer<typeof CheckQuestionSchema>;

/** `.codeloom/tours/<journeyId>.json` (spec §1). */
export const TourFileSchema = z.object({
  version: z.literal(1),
  journeyId: z.string().regex(JOURNEY_ID_RE),
  /** The only timestamp: tours are agent content, not derived files. */
  writtenAt: z.iso.datetime(),
  /** Git HEAD per repo the tour's stops and file notes touch, when it was written (computed by codeloom). */
  writtenAtCommit: z.record(z.string(), z.string()),
  stops: z.array(TourStopSchema).max(TOUR_LIMITS.stops),
  dataJourney: DataJourneySchema,
  fileNotes: z.array(FileNoteSchema).max(TOUR_LIMITS.files),
  check: z.array(CheckQuestionSchema).length(3),
});
export type TourFile = z.infer<typeof TourFileSchema>;

/** What the agent supplies (save_tour): a tour without the fields codeloom computes. Unknown keys — an
 * agent-supplied `fileHash`, `writtenAtCommit`, ... — are dropped, never trusted. */
export const TourDraftSchema = z.object({
  stops: z.array(TourStopSchema.omit({ fileHash: true })).max(TOUR_LIMITS.stops),
  dataJourney: DataJourneySchema,
  fileNotes: z.array(FileNoteSchema).max(TOUR_LIMITS.files),
  check: z.array(CheckQuestionSchema).length(3),
});
export type TourDraft = z.input<typeof TourDraftSchema>;

/** sha256 (hex) of a file's bytes; null when it cannot be read. */
export function hashFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Hashes repo files, each at most once (a journey has many stops per file). */
export class FileHasher {
  private readonly cache = new Map<string, string | null>();
  private readonly abs: Map<string, string>;
  constructor(ws: Pick<StoreWorkspace, "repos">) {
    this.abs = new Map(ws.repos.map((r) => [r.ref.id, r.abs]));
  }
  /** null when the repo is not in the workspace or the file cannot be read. */
  hash(repo: string, file: string): string | null {
    const id = JSON.stringify([repo, file]);
    if (!this.cache.has(id)) {
      const abs = this.abs.get(repo);
      this.cache.set(id, abs === undefined ? null : hashFile(join(abs, file)));
    }
    return this.cache.get(id)!;
  }
  /** The stop's file hash, by its stopKey; null when the key is bad or the file is gone. */
  hashStop(key: string): string | null {
    const k = parseStopKey(key);
    return k ? this.hash(k.repo, k.file) : null;
  }
}

function checkJourneyId(journeyId: string): void {
  if (!JOURNEY_ID_RE.test(journeyId)) throw dataError(`Bad journey id "${journeyId}": expected j_ and 12 hex characters.`);
}

export function toursDir(root: string): string {
  return join(root, CODELOOM_DIR, TOURS_DIR);
}

export function tourPath(root: string, journeyId: string): string {
  checkJourneyId(journeyId);
  return join(toursDir(root), `${journeyId}.json`);
}

/** Missing → null. Bad JSON or shape → CodeloomError (exit 2). */
export function readTour(root: string, journeyId: string): TourFile | null {
  return readJson(tourPath(root, journeyId), TourFileSchema, { handWritten: true });
}

/** Journey ids that have a tour file (valid or not), sorted. */
export function listTours(root: string): string[] {
  const dir = toursDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && JOURNEY_ID_RE.test(e.name.slice(0, -".json".length)))
    .map((e) => e.name.slice(0, -".json".length))
    .sort(compare);
}

/** Recursively sort object keys (arrays keep their order) so the written file is deterministic. */
export function sortKeysDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeysDeep) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort(compare)) out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}

export interface WriteTourContext {
  ws: Pick<StoreWorkspace, "repos">;
  /** Defaults to now. */
  now?: Date;
}

/** Validate a draft, compute each stop's `fileHash` and the per-repo `writtenAtCommit` (never trusted from
 * the agent), and write `.codeloom/tours/<journeyId>.json` atomically with sorted keys. Stops are sorted by
 * chain id then stop index and file notes by repo then file; data journey steps, notes and check questions
 * keep their order (they are sequences). Checking the stops against the journey is the caller's job
 * (save_tour). Throws CodeloomError (exit 2) on a bad draft, a bad stop key or an unreadable stop file. */
export function writeTour(root: string, journeyId: string, draft: TourDraft, ctx: WriteTourContext): TourFile {
  const path = tourPath(root, journeyId);
  const parsed = TourDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw dataError(`The tour for ${journeyId} is not valid:\n${lines.join("\n")}`);
  }
  const d = parsed.data;
  const hasher = new FileHasher(ctx.ws);
  const repos = new Set<string>();
  const stops: TourStop[] = d.stops.map((s) => {
    const k = parseStopKey(s.key);
    if (!k) throw dataError(`Bad stop key ${JSON.stringify(s.key)} in the tour for ${journeyId}: use the stop's key from the journey.`);
    const fileHash = hasher.hash(k.repo, k.file);
    if (fileHash === null) throw dataError(`Cannot read ${k.repo}:${k.file} (stop ${s.key}) to hash it for the tour of ${journeyId}.`);
    repos.add(k.repo);
    return { ...s, fileHash };
  });
  stops.sort((a, b) => compare(a.chainId, b.chainId) || a.stopIndex - b.stopIndex);
  const fileNotes = [...d.fileNotes].sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file));
  const abs = new Map(ctx.ws.repos.map((r) => [r.ref.id, r.abs]));
  for (const f of fileNotes) if (abs.has(f.repo)) repos.add(f.repo);
  const writtenAtCommit: Record<string, string> = {};
  for (const id of [...repos].sort(compare)) writtenAtCommit[id] = gitHead(abs.get(id)!);
  const tour: TourFile = sortKeysDeep({
    version: 1 as const,
    journeyId,
    writtenAt: (ctx.now ?? new Date()).toISOString(),
    writtenAtCommit,
    stops,
    dataJourney: d.dataJourney,
    fileNotes,
    check: d.check,
  });
  writeJsonAtomic(path, tour);
  return tour;
}

/** The tour's stops no longer in the journey, in tour order. A stop is matched by its line-free identity
 * (falling back to its chain id and index when two stops share one), so a moved line is not "removed". */
export function tourRemovedStops(tour: TourFile, current: readonly PlacedStop[]): TourStop[] {
  const match = stopMatcher(current);
  return tour.stops.filter((s) => match(s.key, s) === undefined);
}

/** The tour's stops whose file changed since the tour was written (or is gone), in tour order. Line-free:
 * it compares the hash of the stop's file. */
export function tourStaleStops(tour: TourFile, ws: Pick<StoreWorkspace, "repos">): TourStop[] {
  const hasher = new FileHasher(ws);
  return tour.stops.filter((s) => hasher.hashStop(s.key) !== s.fileHash);
}
