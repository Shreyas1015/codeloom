import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { chainLookup, type MapState } from "../mcp/state.js";
import { compare } from "../util.js";
import { gitHead } from "../workspace/repos.js";
import { DOCTOR_HINT, writeJsonAtomic } from "./json.js";
import { parseStopKey, stopKey } from "./stop-key.js";
import { FileHasher, JOURNEY_ID_RE, readTour, sortKeysDeep, type StoreWorkspace } from "./tours.js";

/** Personal progress (spec §2): `<CODELOOM_HOME or ~/.codeloom>/progress/<workspaceId>.json`. Never
 * written under the workspace, never committed. */
export const PROGRESS_DIR = "progress";

/** The four Tour mode phases; all four must be viewed to mark a journey toured. */
export const TOUR_PHASES = ["flow", "data-journey", "file-notes", "check"] as const;
export type TourPhase = (typeof TOUR_PHASES)[number];

export const PROGRESS_LIMITS = { items: 10, text: 4000 } as const;

const Iso = z.iso.datetime();
const Commits = z.record(z.string(), z.string());

export const CheckRecordSchema = z.object({
  at: Iso,
  questions: z.array(z.string().max(PROGRESS_LIMITS.text)).max(PROGRESS_LIMITS.items),
  answers: z.array(z.string().max(PROGRESS_LIMITS.text)).max(PROGRESS_LIMITS.items),
  verdict: z.enum(["pass", "fail"]),
  notes: z.string().max(PROGRESS_LIMITS.text),
  /** Git HEAD per repo the journey touches, when the check was recorded (computed by codeloom). */
  commit: Commits,
});
export type CheckRecord = z.infer<typeof CheckRecordSchema>;

export const JourneyProgressSchema = z.object({
  seenAt: Iso.optional(),
  touredAt: Iso.optional(),
  /** Set only by recordCheck with verdict "pass". */
  understoodAt: Iso.optional(),
  understoodAtCommit: Commits.optional(),
  /** stopKey → sha256 of the stop's file at understoodAt. */
  stopHashes: z.record(z.string(), z.string()).optional(),
  checks: z.array(CheckRecordSchema),
});
export type JourneyProgress = z.infer<typeof JourneyProgressSchema>;

export const ProgressFileSchema = z.object({
  version: z.literal(1),
  /** By journey id. */
  journeys: z.record(z.string(), JourneyProgressSchema),
});
export type ProgressFile = z.infer<typeof ProgressFileSchema>;

/** What record_check takes from the agent (no hashes, no commits, no timestamps). */
export const CheckInputSchema = CheckRecordSchema.pick({ questions: true, answers: true, verdict: true, notes: true });
export type CheckInput = z.infer<typeof CheckInputSchema>;

export type ProgressLevel = "none" | "seen" | "toured" | "understood";

type ProgressWorkspace = Pick<StoreWorkspace, "root" | "name" | "repos">;
/** The parts of MapState progress needs (journeys and the chains they resolve to). */
export type ProgressState = { ws: ProgressWorkspace } & Pick<MapState, "chains" | "journeys">;
export interface Clock { now?: Date }

/** sha256 of the workspace name + sorted repo ids, first 16 hex chars: the same for any clone at any path. */
export function workspaceId(ws: Pick<StoreWorkspace, "name" | "repos">): string {
  const ids = ws.repos.map((r) => r.ref.id).sort(compare);
  return createHash("sha256").update(JSON.stringify([ws.name, ids])).digest("hex").slice(0, 16);
}

/** `$CODELOOM_HOME` when set (tests), else `~/.codeloom`. */
export function codeloomHome(): string {
  const env = process.env.CODELOOM_HOME;
  return env !== undefined && env !== "" ? resolve(env) : join(homedir(), ".codeloom");
}

/** The workspace's progress file. Throws (exit 2) if it would land inside the workspace: progress is
 * personal and must never be committed. */
export function progressPath(ws: Pick<StoreWorkspace, "root" | "name" | "repos">): string {
  const path = join(codeloomHome(), PROGRESS_DIR, `${workspaceId(ws)}.json`);
  const rel = relative(resolve(ws.root), path);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    throw dataError(
      `The progress file ${path} would be inside the workspace (${ws.root}); progress is personal and never committed. ` +
        `Point CODELOOM_HOME outside the workspace.`,
    );
  }
  return path;
}

function corrupt(path: string, detail: string): Error {
  return dataError(
    `Your progress file ${path} is corrupt (${detail}). codeloom never overwrites it: fix it by hand, or move it ` +
      `away to start your progress over.\n${DOCTOR_HINT}`,
  );
}

/** Missing file → empty progress. Bad JSON or shape → CodeloomError (exit 2); the file is left as it is. */
export function readProgress(ws: ProgressWorkspace): ProgressFile {
  const path = progressPath(ws);
  if (!existsSync(path)) return { version: 1, journeys: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw corrupt(path, "not valid JSON");
  }
  const r = ProgressFileSchema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw corrupt(path, `unexpected shape: ${where}`);
  }
  return r.data;
}

function checkJourneyId(journeyId: string): void {
  if (!JOURNEY_ID_RE.test(journeyId)) throw dataError(`Bad journey id "${journeyId}": expected j_ and 12 hex characters.`);
}

/** Read, change one journey's entry, write atomically (sorted keys). A corrupt file throws before any write. */
function update(ws: ProgressWorkspace, journeyId: string, fn: (p: JourneyProgress) => void): JourneyProgress {
  checkJourneyId(journeyId);
  const file = readProgress(ws);
  const entry: JourneyProgress = file.journeys[journeyId] ?? { checks: [] };
  fn(entry);
  file.journeys[journeyId] = entry;
  writeJsonAtomic(progressPath(ws), sortKeysDeep(file));
  return entry;
}

const stamp = (c: Clock | undefined) => (c?.now ?? new Date()).toISOString();

/** The journey was opened in the dashboard. Keeps the first time. Never sets toured or understood. */
export function markSeen(ws: ProgressWorkspace, journeyId: string, clock?: Clock): JourneyProgress {
  return update(ws, journeyId, (p) => {
    p.seenAt ??= stamp(clock);
  });
}

/** All four tour phases were viewed in Tour mode. Needs every phase in TOUR_PHASES and a tour file.
 * Keeps the first time. Never sets understood. */
export function markToured(ws: ProgressWorkspace, journeyId: string, phases: readonly string[], clock?: Clock): JourneyProgress {
  checkJourneyId(journeyId);
  const unknown = phases.filter((p) => !(TOUR_PHASES as readonly string[]).includes(p));
  if (unknown.length > 0) throw dataError(`Unknown tour phase ${unknown.map((p) => JSON.stringify(p)).join(", ")}: use ${TOUR_PHASES.join(", ")}.`);
  const missing = TOUR_PHASES.filter((p) => !phases.includes(p));
  if (missing.length > 0) throw dataError(`Not every tour phase was viewed: missing ${missing.join(", ")}.`);
  if (readTour(ws.root, journeyId) === null) throw dataError(`Journey ${journeyId} has no tour yet, so it cannot be toured.`);
  return update(ws, journeyId, (p) => {
    p.touredAt ??= stamp(clock);
  });
}

function findJourney(state: Pick<MapState, "journeys">, journeyId: string) {
  checkJourneyId(journeyId);
  const j = state.journeys.find((x) => x.id === journeyId);
  if (!j) throw dataError(`Unknown journey "${journeyId}".`);
  return j;
}

/** The journey's current stops as stopKeys: its chains (by id, then alias) sorted by id, stops in chain
 * order, deduped. Unknown journey → CodeloomError (exit 2). */
export function journeyStopKeys(state: Pick<MapState, "chains" | "journeys">, journeyId: string): string[] {
  const j = findJourney(state, journeyId);
  const keys = new Set<string>();
  for (const c of chainLookup(state.chains).resolve(j.chainIds).chains) for (const s of c.stops) keys.add(stopKey(s));
  return [...keys];
}

function reposOf(keys: readonly string[]): string[] {
  return [...new Set(keys.map((k) => parseStopKey(k)!.repo))].sort(compare);
}

function commitsFor(ws: ProgressWorkspace, repos: readonly string[]): Record<string, string> {
  const abs = new Map(ws.repos.map((r) => [r.ref.id, r.abs]));
  const out: Record<string, string> = {};
  for (const id of repos) {
    const a = abs.get(id);
    if (a !== undefined) out[id] = gitHead(a);
  }
  return out;
}

/** The only way to set "understood": append a check; on "pass", set understoodAt, understoodAtCommit
 * and stopHashes (all computed here, never by the agent). A "fail" never sets or clears understood. */
export function recordCheck(state: ProgressState, journeyId: string, input: CheckInput, clock?: Clock): JourneyProgress {
  const parsed = CheckInputSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw dataError(`The check for ${journeyId} is not valid:\n${lines.join("\n")}`);
  }
  const keys = journeyStopKeys(state, journeyId);
  const commit = commitsFor(state.ws, reposOf(keys));
  const at = stamp(clock);
  return update(state.ws, journeyId, (p) => {
    p.checks.push({ at, ...parsed.data, commit });
    if (parsed.data.verdict !== "pass") return;
    const hasher = new FileHasher(state.ws);
    const stopHashes: Record<string, string> = {};
    for (const k of keys) {
      const h = hasher.hashStop(k);
      if (h !== null) stopHashes[k] = h;
    }
    p.understoodAt = at;
    p.understoodAtCommit = commit;
    p.stopHashes = stopHashes;
  });
}

export interface JourneyProgressView {
  journeyId: string;
  name: string;
  area: string;
  /** Repos the journey's stops touch, sorted. */
  repos: string[];
  level: ProgressLevel;
  /** For an understood journey: its current stops whose file changed since understoodAt (or that are new
   * since), in journey stop order. Empty otherwise. */
  needsReWalk: string[];
  lastCheck: CheckRecord | null;
  seenAt?: string;
  touredAt?: string;
  understoodAt?: string;
}

/** Journeys by their exact level (none + seen + toured + understood = total); needsReWalk counts the
 * understood ones with stops to re-walk. */
export interface LevelCounts {
  total: number;
  none: number;
  seen: number;
  toured: number;
  understood: number;
  needsReWalk: number;
}

export interface ProgressView {
  workspaceId: string;
  path: string;
  /** Every journey in journeys.json, sorted by id. */
  journeys: JourneyProgressView[];
  totals: { all: LevelCounts; byRepo: Record<string, LevelCounts>; byArea: Record<string, LevelCounts> };
  /** Journey ids with progress but no longer in journeys.json (renamed/merged/split), sorted. */
  olderJourneys: string[];
}

const zero = (): LevelCounts => ({ total: 0, none: 0, seen: 0, toured: 0, understood: 0, needsReWalk: 0 });

function levelOf(p: JourneyProgress | undefined): ProgressLevel {
  if (p?.understoodAt) return "understood";
  if (p?.touredAt) return "toured";
  if (p?.seenAt) return "seen";
  return "none";
}

/** Per journey: level, stops to re-walk and last check; totals for all, per repo (every workspace repo)
 * and per area. Corrupt progress file → CodeloomError (exit 2). */
export function progressView(state: ProgressState): ProgressView {
  const file = readProgress(state.ws);
  const hasher = new FileHasher(state.ws);
  const all = zero();
  const byRepo: Record<string, LevelCounts> = {};
  for (const id of state.ws.repos.map((r) => r.ref.id).sort(compare)) byRepo[id] = zero();
  const byArea: Record<string, LevelCounts> = {};
  const count = (c: LevelCounts, v: JourneyProgressView) => {
    c.total++;
    c[v.level]++;
    if (v.needsReWalk.length > 0) c.needsReWalk++;
  };
  const journeys: JourneyProgressView[] = [];
  for (const j of [...state.journeys].sort((a, b) => compare(a.id, b.id))) {
    const p = file.journeys[j.id];
    const keys = journeyStopKeys(state, j.id);
    const level = levelOf(p);
    const needsReWalk = level === "understood"
      ? keys.filter((k) => {
          const was = p!.stopHashes?.[k];
          return was === undefined || hasher.hashStop(k) !== was;
        })
      : [];
    const v: JourneyProgressView = {
      journeyId: j.id,
      name: j.name,
      area: j.area,
      repos: reposOf(keys),
      level,
      needsReWalk,
      lastCheck: p?.checks.at(-1) ?? null,
      ...(p?.seenAt ? { seenAt: p.seenAt } : {}),
      ...(p?.touredAt ? { touredAt: p.touredAt } : {}),
      ...(p?.understoodAt ? { understoodAt: p.understoodAt } : {}),
    };
    journeys.push(v);
    count(all, v);
    for (const r of v.repos) count((byRepo[r] ??= zero()), v);
    count((byArea[j.area] ??= zero()), v);
  }
  const known = new Set(state.journeys.map((j) => j.id));
  const olderJourneys = Object.keys(file.journeys).filter((id) => !known.has(id)).sort(compare);
  return {
    workspaceId: workspaceId(state.ws),
    path: progressPath(state.ws),
    journeys,
    totals: { all, byRepo, byArea: sortKeysDeep(byArea) },
    olderJourneys,
  };
}
