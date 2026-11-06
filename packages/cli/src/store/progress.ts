import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { chainLookup, type MapState } from "../mcp/state.js";
import { compare } from "../util.js";
import { gitHead } from "../workspace/repos.js";
import { DOCTOR_HINT, writeJsonAtomic } from "./json.js";
import { keyIdentity, parseStopKey, type PlacedStop, stopKey } from "./stop-key.js";
import { FileHasher, JOURNEY_ID_RE, listTours, readTour, sortKeysDeep, type StoreWorkspace } from "./tours.js";

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
  /** The workspace name and repo ids the file's id was made from (written on every update), so doctor can
   * find the progress of the same workspace after its repo set changed. Older files lack it. */
  workspace: z.object({ name: z.string(), repos: z.array(z.string()) }).optional(),
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

/** The real path of `p`: its deepest existing ancestor resolved through symlinks, plus the rest. */
function realish(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(realish(up), basename(abs));
  }
}

function isInside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The workspace's progress file. Throws (exit 2) if it would land inside the workspace or inside any of
 * its repo folders (after following symlinks): progress is personal and must never be committed. */
export function progressPath(ws: Pick<StoreWorkspace, "root" | "name" | "repos">): string {
  const path = join(codeloomHome(), PROGRESS_DIR, `${workspaceId(ws)}.json`);
  const real = realish(path);
  const hint = `progress is personal and never committed. Point CODELOOM_HOME outside the workspace and its repos.`;
  if (isInside(realish(ws.root), real)) {
    throw dataError(`The progress file ${path} would be inside the workspace (${ws.root}); ${hint}`);
  }
  for (const r of ws.repos) {
    if (isInside(realish(r.abs), real)) throw dataError(`The progress file ${path} would be inside repo "${r.ref.id}" (${r.abs}); ${hint}`);
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

/** Lock timing: wait up to `waitMs` for another writer; a lock older than `staleMs` is left over from a
 * crashed process and is removed. */
export const PROGRESS_LOCK = { waitMs: 5_000, staleMs: 30_000 } as const;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);

/** Run `fn` holding `<progress>.lock` (created with "wx"), so the MCP server and the dashboard server never
 * lose each other's writes. Retries with a short backoff; gives up after PROGRESS_LOCK.waitMs (exit 2). */
function withProgressLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + PROGRESS_LOCK.waitMs;
  let delay = 5;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let age: number | undefined;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile: try again
    }
    if (age > PROGRESS_LOCK.staleMs) {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw dataError(
        `Your progress file ${path} is busy: another codeloom holds ${lock}. Try again; if no codeloom is running, ` +
          `delete ${lock}.`,
      );
    }
    sleep(delay);
    delay = Math.min(delay * 2, 100);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Under the lock: read, change one journey's entry, and write atomically (sorted keys) only when the file
 * changes. A corrupt file throws before any write. */
function update(ws: ProgressWorkspace, journeyId: string, fn: (p: JourneyProgress) => void): JourneyProgress {
  checkJourneyId(journeyId);
  const path = progressPath(ws);
  return withProgressLock(path, () => {
    const file = readProgress(ws);
    const before = existsSync(path) ? JSON.stringify(sortKeysDeep(file)) : undefined;
    const entry: JourneyProgress = structuredClone(file.journeys[journeyId] ?? { checks: [] });
    fn(entry);
    file.journeys[journeyId] = entry;
    file.workspace = { name: ws.name, repos: ws.repos.map((r) => r.ref.id).sort(compare) };
    const next = sortKeysDeep(file);
    if (JSON.stringify(next) !== before) writeJsonAtomic(path, next);
    return entry;
  });
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

/** Every stop of the journey's current chains with its place (chain id, index): what a saved stop is
 * matched against (`stopMatcher`). Unknown journey → CodeloomError (exit 2). */
export function journeyPlacedStops(state: Pick<MapState, "chains" | "journeys">, journeyId: string): PlacedStop[] {
  const j = findJourney(state, journeyId);
  return chainLookup(state.chains).resolve(j.chainIds).chains.flatMap((c) => c.stops.map((s, stopIndex) => ({ chainId: c.id, stopIndex, key: stopKey(s) })));
}

/** The hash recorded for a current stop: by its exact key, else by its line-free identity (all stops with
 * one identity share a file, so they share a hash). */
function savedHash(stopHashes: Record<string, string> | undefined, byIdentity: Map<string, string>, key: string): string | undefined {
  const exact = stopHashes?.[key];
  if (exact !== undefined) return exact;
  const id = keyIdentity(key);
  return id === null ? undefined : byIdentity.get(id);
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
  /** For an understood journey: its current stops (current stopKeys) whose file changed since understoodAt
   * (or that are new since), in journey stop order; a stop is matched to its saved hash by its line-free
   * identity, so a moved line is not "new". Empty otherwise. */
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
  /** Journey ids with progress or a tour but no longer in journeys.json (renamed/merged/split), sorted. */
  olderJourneys: string[];
  /** The olderJourneys that have a tour file (Tour mode can still open them), sorted. */
  olderTours: string[];
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
    let needsReWalk: string[] = [];
    if (level === "understood") {
      const byIdentity = new Map<string, string>();
      for (const [k, h] of Object.entries(p!.stopHashes ?? {})) {
        const id = keyIdentity(k);
        if (id !== null && !byIdentity.has(id)) byIdentity.set(id, h);
      }
      needsReWalk = keys.filter((k) => {
        const was = savedHash(p!.stopHashes, byIdentity, k);
        return was === undefined || hasher.hashStop(k) !== was;
      });
    }
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
  const olderTours = listTours(state.ws.root).filter((id) => !known.has(id));
  const olderJourneys = [...new Set([...Object.keys(file.journeys), ...olderTours])].filter((id) => !known.has(id)).sort(compare);
  return {
    workspaceId: workspaceId(state.ws),
    path: progressPath(state.ws),
    journeys,
    totals: { all, byRepo, byArea: sortKeysDeep(byArea) },
    olderJourneys,
    olderTours,
  };
}

/** Other progress files whose recorded workspace name is `ws.name` but whose id differs: the same workspace
 * before its repo set changed (the id hashes the repo ids). Unreadable files are skipped. Sorted paths. */
export function otherProgressFiles(ws: Pick<StoreWorkspace, "root" | "name" | "repos">): string[] {
  const path = progressPath(ws);
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(compare)) {
    const p = join(dir, name);
    if (!name.endsWith(".json") || p === path) continue;
    try {
      const r = ProgressFileSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
      if (r.success && r.data.workspace?.name === ws.name) out.push(p);
    } catch {
      // not ours to judge
    }
  }
  return out;
}
