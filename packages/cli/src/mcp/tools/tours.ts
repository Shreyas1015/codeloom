import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dataError } from "../../errors.js";
import {
  CheckInputSchema,
  type JourneyProgressView,
  type LevelCounts,
  progressView,
  recordCheck,
} from "../../store/progress.js";
import type { RepoData } from "../../store/read.js";
import type { Chain, ChainStop, Journey } from "../../store/schemas.js";
import { stopKey } from "../../store/stop-key.js";
import {
  FileHasher,
  JOURNEY_ID_RE,
  readTour,
  type TourDraft,
  TourDraftSchema,
  tourPath,
  tourRemovedStops,
  tourStaleStops,
  writeTour,
} from "../../store/tours.js";
import { compare } from "../../util.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { chainLookup, formatNodeRef, loadMapState, type MapState } from "../state.js";
import { neighbors } from "./graph.js";

// ---- shared ------------------------------------------------------------------------------------------

function findJourney(state: MapState, id: string): Journey {
  if (!JOURNEY_ID_RE.test(id)) throw dataError(`Bad journey id "${id}": expected j_ and 12 hex characters (get_progress lists them).`);
  const j = state.journeys.find((x) => x.id === id);
  if (!j) throw dataError(`Unknown journey "${id}". get_progress lists every journey.`);
  return j;
}

function repoOf(state: MapState, id: string): RepoData {
  const r = state.ws.repos.find((x) => x.ref.id === id);
  if (!r) throw dataError(`Unknown repo "${id}". Repos in this workspace: ${state.ws.repos.map((x) => x.ref.id).join(", ")}.`);
  return r;
}

/** A repo-relative path that stays inside the repo; undefined when it would leave it. */
function insideRepo(repo: RepoData, file: string): string | undefined {
  const abs = resolve(repo.abs, file);
  const rel = relative(repo.abs, abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : abs;
}

/** File lines, cached per call (a journey reads the same file for many stops). */
class Sources {
  private readonly cache = new Map<string, string[] | null>();
  lines(abs: string): string[] | null {
    if (!this.cache.has(abs)) {
      let lines: string[] | null = null;
      try {
        const text = readFileSync(abs, "utf8");
        lines = text.split("\n");
        if (text.endsWith("\n")) lines.pop();
      } catch {
        lines = null;
      }
      this.cache.set(abs, lines);
    }
    return this.cache.get(abs)!;
  }
}

// ---- build_tour_context: code, types, shapes, db ---------------------------------------------------------

/** Lines of code around a stop on each side. */
const SLICE_LINES = 30;
/** Most characters in one stop's code slice. */
const SLICE_CHARS = 8_000;
/** Most lines / characters of one declaration, shape or table definition. */
const BLOCK_LINES = 40;
const BLOCK_CHARS = 2_000;
const MAX_TYPES = 15;
const MAX_SHAPES = 12;
const MAX_NEIGHBORS = 20;

interface CodeSlice { startLine: number; endLine: number; text: string; truncated: boolean }

function sliceAround(lines: string[], line: number): CodeSlice {
  const startLine = Math.max(1, line - SLICE_LINES);
  const endLine = Math.max(startLine, Math.min(lines.length, line + SLICE_LINES));
  const full = lines.slice(startLine - 1, endLine).join("\n");
  if (full.length <= SLICE_CHARS) return { startLine, endLine, text: full, truncated: false };
  const text = full.slice(0, SLICE_CHARS);
  return { startLine, endLine: startLine + text.split("\n").length - 1, text, truncated: true };
}

/** From a 1-based line, the statement or block that starts there: lines until the brackets opened on it
 * close again (or the line ends a statement), at most BLOCK_LINES lines / BLOCK_CHARS characters. */
function blockAt(lines: string[], line: number): string {
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = line - 1; i < lines.length && out.length < BLOCK_LINES; i++) {
    const l = lines[i]!;
    out.push(l);
    for (const ch of l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
      if (ch === "{" || ch === "(" || ch === "[") {
        depth++;
        opened = true;
      } else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (opened ? depth <= 0 : /[;,]\s*$|^\s*$/.test(l) || i > line + 2) break;
  }
  const text = out.join("\n");
  return text.length > BLOCK_CHARS ? text.slice(0, BLOCK_CHARS) : text;
}

const DECL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/;

/** Type-like declarations (interface, type, class, enum) in a file: name → 1-based line (first wins). */
function declarations(lines: string[]): Map<string, number> {
  const out = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = l.match(DECL_RE);
    if (m && !out.has(m[2]!)) out.set(m[2]!, i + 1);
  });
  return out;
}

/** `export default class X` line in a file (a default import may rename it). */
function defaultClassLine(lines: string[]): number | undefined {
  const i = lines.findIndex((l) => /^\s*export\s+default\s+(?:abstract\s+)?class\b/.test(l));
  return i < 0 ? undefined : i + 1;
}

/** Local name → { source, isDefault } for every import in a file. */
function imports(text: string): Map<string, { source: string; isDefault: boolean }> {
  const out = new Map<string, { source: string; isDefault: boolean }>();
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1]!;
    const source = m[2]!;
    const named = clause.match(/\{([\s\S]*)\}/);
    const def = clause.replace(/\{[\s\S]*\}/, "").replace(/\*\s+as\s+\w+/, "").replace(/,/g, " ").trim();
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) out.set(def, { source, isDefault: true });
    for (const part of named?.[1]?.split(",") ?? []) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const [, local] = p.match(/^[\w$]+\s+as\s+([\w$]+)$/) ?? [undefined, p];
      if (local && /^[A-Za-z_$][\w$]*$/.test(local)) out.set(local, { source, isDefault: false });
    }
  }
  return out;
}

const EXTS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"];

/** The repo file an import source points at: relative paths by extension, else (aliases like
 * `#models/customer`) the file the graph says the stop file imports with that last path segment. */
function resolveImport(repo: RepoData, fromFile: string, source: string, graphImports: string[]): string | undefined {
  if (source.startsWith(".")) {
    const base = posix.join(posix.dirname(fromFile), source);
    for (const ext of EXTS) {
      const cand = base + ext;
      if (insideRepo(repo, cand) && existsSync(join(repo.abs, cand))) return cand;
    }
    return undefined;
  }
  const last = source.split("/").pop()!;
  return graphImports.find((f) => posix.basename(f).replace(/\.[^.]+$/, "") === last);
}

interface TypeRef { name: string; file?: string; line?: number; text?: string; from?: string }

/** The types a code slice uses: capitalised identifiers declared in the stop's file or in a repo file it
 * imports (with their declaration), and those imported from a package (named with where they come from). */
function typesUsed(repo: RepoData, file: string, stopLine: number, slice: string, sources: Sources): TypeRef[] {
  const abs = insideRepo(repo, file);
  const lines = abs ? sources.lines(abs) : null;
  if (!lines) return [];
  const local = declarations(lines);
  const imported = imports(lines.join("\n"));
  const fileNode = `file:${file}`;
  const graphImports = repo.graph.edges
    .filter((e) => e.source === fileNode && e.type === "imports" && e.target.startsWith("file:"))
    .map((e) => e.target.slice("file:".length))
    .sort(compare);
  const names = [...new Set([...slice.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)].map((m) => m[0]))].sort(compare);
  const out: TypeRef[] = [];
  for (const name of names) {
    if (out.length >= MAX_TYPES) break;
    const at = local.get(name);
    if (at !== undefined) {
      const text = blockAt(lines, at);
      // The class the stop sits in is the stop's own code, not a type it uses.
      if (at <= stopLine && stopLine < at + text.split("\n").length) continue;
      out.push({ name, file, line: at, text });
      continue;
    }
    const imp = imported.get(name);
    if (!imp) continue;
    const target = resolveImport(repo, file, imp.source, graphImports);
    const targetAbs = target ? insideRepo(repo, target) : undefined;
    const tLines = targetAbs ? sources.lines(targetAbs) : null;
    if (target && tLines) {
      const line = declarations(tLines).get(name) ?? (imp.isDefault ? defaultClassLine(tLines) : undefined);
      if (line !== undefined) {
        out.push({ name, file: target, line, text: blockAt(tLines, line) });
        continue;
      }
    }
    if (!imp.source.startsWith(".") && !target) out.push({ name, from: imp.source });
  }
  return out;
}

type ShapeKind = "schema" | "validator" | "request" | "response" | "type";

const SHAPE_PATTERNS: Array<[ShapeKind, RegExp]> = [
  ["schema", /\bz\.(?:object|strictObject|array|union|discriminatedUnion)\(|\b(?:Joi|yup)\.object\(/],
  ["validator", /\bvine\.(?:compile|object)\(|\bschema\.create\(|\.validate(?:Using)?\(|@Is[A-Z]\w*\(|\bvalidator\.\w+\(/],
  ["request", /\b(?:req|request)\.(?:body|params|query|input|only|all|qs)\b|\bparams\.\w+|\bbody\s*\(\)\s*as\b/],
  ["response", /\b(?:res|response)\.(?:json|send|status|created|ok|noContent|badRequest|notFound)\(|\bResponse\.json\(|\bNextResponse\.json\(/],
  ["type", /\(\s*\w+\s*:\s*\{[^}]*\}/],
];

interface Shape { kind: ShapeKind; line: number; text: string }

/** Request/response shapes in a code slice: schemas, validators, where the request is read (with any
 * cast or inline type), and what is sent back. Each as the statement it starts. */
function shapesIn(lines: string[], slice: CodeSlice): Shape[] {
  const out: Shape[] = [];
  for (let line = slice.startLine; line <= slice.endLine && out.length < MAX_SHAPES; line++) {
    const l = lines[line - 1] ?? "";
    if (/^\s*(?:\/\/|\*|import\b)/.test(l)) continue;
    const kind = SHAPE_PATTERNS.find(([, re]) => re.test(l))?.[0];
    // An inline parameter type is the signature line; anything else is the statement it starts.
    if (kind) out.push({ kind, line, text: kind === "type" ? l.trim() : blockAt(lines, line).trim() });
  }
  return out;
}

interface DbDetail {
  table?: string;
  model?: string;
  op: string;
  via: string;
  statement: string;
  tableDef: { file: string; line: number; source: string; text: string } | null;
  modelDef: { file: string; source: string } | null;
}

/** A db stop's access (endpoints.json dbAccess at that line, else in that file and symbol), the
 * statement, and where its table and model are defined (with the table definition's text). */
function dbDetail(repo: RepoData, s: ChainStop, sources: Sources): DbDetail | undefined {
  const all = repo.endpoints.dbAccess;
  const a = all.find((x) => x.at.file === s.file && x.at.line === s.line)
    ?? all.find((x) => x.at.file === s.file && x.at.symbol === s.symbol && (s.label === undefined || x.table === s.label));
  if (!a) return undefined;
  const abs = insideRepo(repo, s.file);
  const lines = abs ? sources.lines(abs) : null;
  const table = a.table ?? s.label;
  const def = table === undefined ? undefined : repo.endpoints.tables.find((t) => t.name === table);
  let tableDef: DbDetail["tableDef"] = null;
  if (def) {
    const defAbs = insideRepo(repo, def.file);
    const defLines = defAbs ? sources.lines(defAbs) : null;
    const text = !defLines ? "" : defLines.length <= 2 * BLOCK_LINES ? defLines.join("\n") : defLines.slice(def.line - 1, def.line - 1 + BLOCK_LINES).join("\n");
    tableDef = { file: def.file, line: def.line, source: def.source, text: text.slice(0, BLOCK_CHARS * 2) };
  }
  const model = a.model === undefined ? undefined : repo.endpoints.models.find((m) => m.model === a.model);
  return {
    ...(table !== undefined ? { table } : {}),
    ...(a.model !== undefined ? { model: a.model } : {}),
    op: a.op,
    via: a.via,
    statement: lines ? blockAt(lines, a.at.line).trim() : "",
    tableDef,
    modelDef: model ? { file: model.file, source: model.source } : null,
  };
}

// ---- build_tour_context ---------------------------------------------------------------------------------

export function buildTourContext(start: string, journeyId: string, chainId?: string): Record<string, unknown> {
  const state = loadMapState(start);
  const journey = findJourney(state, journeyId);
  const resolved = chainLookup(state.chains).resolve(journey.chainIds);
  let chains: Chain[] = resolved.chains;
  if (chainId !== undefined) {
    chains = chains.filter((c) => c.id === chainId);
    if (chains.length === 0) {
      throw dataError(`Chain "${chainId}" is not one of journey ${journeyId}'s chains (${resolved.chains.map((c) => c.id).join(", ") || "none"}).`);
    }
  }
  const hasher = new FileHasher(state.ws);
  const sources = new Sources();
  const firstAt = new Map<string, { chainId: string; stopIndex: number }>();
  const files = new Map<string, { repo: string; file: string }>();
  const stops: Record<string, unknown>[] = [];
  for (const c of chains) {
    c.stops.forEach((s, stopIndex) => {
      const key = stopKey(s);
      const base: Record<string, unknown> = {
        chainId: c.id, stopIndex, key, lane: s.lane, kind: s.kind, repo: s.repo, file: s.file, line: s.line, symbol: s.symbol,
        ...(s.label !== undefined ? { label: s.label } : {}),
        ...(s.op !== undefined ? { op: s.op } : {}),
        confidence: s.hop.confidence,
        ...(s.nodeId !== undefined ? { ref: formatNodeRef({ repo: s.repo, nodeId: s.nodeId }) } : {}),
        ...(s.from !== undefined ? { from: s.from } : {}),
        fileHash: hasher.hash(s.repo, s.file),
      };
      const first = firstAt.get(key);
      if (first) {
        stops.push({ ...base, sameAs: first });
        return;
      }
      firstAt.set(key, { chainId: c.id, stopIndex });
      files.set(JSON.stringify([s.repo, s.file]), { repo: s.repo, file: s.file });
      const repo = state.ws.repos.find((r) => r.ref.id === s.repo);
      const abs = repo ? insideRepo(repo, s.file) : undefined;
      const lines = abs ? sources.lines(abs) : null;
      if (!repo || !lines) {
        stops.push({ ...base, code: null, codeUnavailable: `${s.repo}:${s.file} cannot be read (the map may be stale; run reindex).`, types: [], shapes: [], neighbors: [] });
        return;
      }
      const code = sliceAround(lines, s.line);
      const db = s.lane === "db" ? dbDetail(repo, s, sources) : undefined;
      const near = s.nodeId !== undefined && repo.graph.nodes.some((n) => n.id === s.nodeId)
        ? neighbors(repo, s.nodeId, { direction: "both", depth: 1, limit: MAX_NEIGHBORS, edgeTypes: ["calls"] }).neighbors
        : [];
      stops.push({
        ...base,
        code,
        types: typesUsed(repo, s.file, s.line, code.text, sources),
        shapes: shapesIn(lines, code),
        ...(db ? { db } : {}),
        neighbors: near,
      });
    });
  }

  let tour: Record<string, unknown> | null = null;
  const notes: string[] = [];
  try {
    const t = readTour(state.ws.root, journeyId);
    if (t) {
      const current = chains.flatMap((c) => c.stops.map((s, stopIndex) => ({ chainId: c.id, stopIndex, key: stopKey(s) })));
      tour = {
        writtenAt: t.writtenAt,
        stops: t.stops.length,
        staleStops: tourStaleStops(t, state.ws).map((s) => s.key),
        removedStops: tourRemovedStops(t, current).map((s) => s.key),
        check: t.check,
      };
    }
  } catch (e) {
    notes.push(`The saved tour cannot be read (${e instanceof Error ? e.message : String(e)}); save_tour will replace it.`);
  }
  if (resolved.missing.length > 0) notes.push(`Chain ids no longer in the map: ${resolved.missing.join(", ")}.`);

  return {
    journey: { id: journey.id, name: journey.name, area: journey.area, note: journey.note },
    chains: chains.map((c) => ({ id: c.id, name: c.name, entry: c.entry, routeKey: c.routeKey, stopCount: c.stops.length })),
    stops,
    files: [...files.values()]
      .sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file))
      .map((f) => ({ ...f, fileHash: hasher.hash(f.repo, f.file) })),
    tour,
    notes,
  };
}

// ---- save_tour ------------------------------------------------------------------------------------------

/** Checks a tour draft against the journey as the map has it now: every stop is one of the journey's
 * chain stops (chainId, stopIndex and key agree), no stop twice, data journey steps name journey stops,
 * file notes name a real file in a workspace repo. Returns the journey's stop keys the tour leaves out. */
function checkDraftAgainstJourney(state: MapState, journey: Journey, draft: TourDraft): string[] {
  const chains = new Map(chainLookup(state.chains).resolve(journey.chainIds).chains.map((c) => [c.id, c]));
  const problems: string[] = [];
  if (draft.stops.length === 0) problems.push("stops: a tour needs at least one stop (build_tour_context lists them).");
  const seen = new Set<string>();
  draft.stops.forEach((s, i) => {
    const c = chains.get(s.chainId);
    if (!c) {
      problems.push(`stops.${i}: chain "${s.chainId}" is not one of the journey's chains (${[...chains.keys()].join(", ")}).`);
      return;
    }
    const stop = c.stops[s.stopIndex];
    if (!stop) {
      problems.push(`stops.${i}: chain ${s.chainId} has no stop ${s.stopIndex} (it has ${c.stops.length}).`);
      return;
    }
    if (stopKey(stop) !== s.key) problems.push(`stops.${i}: key does not match stop ${s.stopIndex} of ${s.chainId}; use the key build_tour_context gives.`);
    const id = `${s.chainId}#${s.stopIndex}`;
    if (seen.has(id)) problems.push(`stops.${i}: stop ${s.stopIndex} of ${s.chainId} is in the tour twice.`);
    seen.add(id);
  });
  const keys = new Set([...chains.values()].flatMap((c) => c.stops.map(stopKey)));
  draft.dataJourney.steps.forEach((s, i) => {
    if (!keys.has(s.stopKey)) problems.push(`dataJourney.steps.${i}: stopKey is not a stop of this journey.`);
  });
  draft.fileNotes.forEach((f, i) => {
    const repo = state.ws.repos.find((r) => r.ref.id === f.repo);
    if (!repo) {
      problems.push(`fileNotes.${i}: Unknown repo "${f.repo}". Repos in this workspace: ${state.ws.repos.map((r) => r.ref.id).join(", ")}.`);
      return;
    }
    const abs = insideRepo(repo, f.file);
    if (!abs) problems.push(`fileNotes.${i}: ${f.file} is outside repo "${f.repo}".`);
    else if (!existsSync(abs)) problems.push(`fileNotes.${i}: ${f.repo}:${f.file} does not exist.`);
  });
  if (problems.length > 0) throw dataError(`The tour for ${journey.id} does not fit the journey:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const covered = new Set(draft.stops.map((s) => s.key));
  return [...keys].filter((k) => !covered.has(k));
}

export function saveTour(start: string, journeyId: string, tour: unknown): Record<string, unknown> {
  const state = loadMapState(start);
  const journey = findJourney(state, journeyId);
  const parsed = TourDraftSchema.safeParse(tour);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw dataError(`The tour for ${journeyId} is not valid:\n${lines.join("\n")}`);
  }
  const uncovered = checkDraftAgainstJourney(state, journey, parsed.data);
  const replaced = existsSync(tourPath(state.ws.root, journeyId));
  const written = writeTour(state.ws.root, journeyId, parsed.data, { ws: state.ws });
  return {
    journeyId,
    path: relative(state.ws.root, tourPath(state.ws.root, journeyId)).split(/[\\/]/).join("/"),
    replaced,
    writtenAt: written.writtenAt,
    writtenAtCommit: written.writtenAtCommit,
    stops: written.stops.length,
    uncoveredStops: uncovered,
  };
}

// ---- get_progress ---------------------------------------------------------------------------------------

const zero = (): LevelCounts => ({ total: 0, none: 0, seen: 0, toured: 0, understood: 0, needsReWalk: 0 });

/** Like the dashboard: a journey that needs a re-walk is not counted as understood but as toured, until it
 * passes check-me again (needsReWalk still counts it). */
function countInto(c: LevelCounts, j: JourneyProgressView): void {
  c.total++;
  const rewalk = j.needsReWalk.length > 0;
  c[j.level === "understood" && rewalk ? "toured" : j.level]++;
  if (rewalk) c.needsReWalk++;
}

export function getProgress(start: string, args: { repo?: string; area?: string }): Record<string, unknown> {
  const state = loadMapState(start);
  if (args.repo !== undefined) repoOf(state, args.repo);
  const view = progressView(state);
  const journeys = view.journeys.filter(
    (j) => (args.repo === undefined || j.repos.includes(args.repo)) && (args.area === undefined || j.area === args.area),
  );
  const all = zero();
  const byRepo: Record<string, LevelCounts> = {};
  const repoIds = args.repo !== undefined ? [args.repo] : state.ws.repos.map((r) => r.ref.id).sort(compare);
  for (const id of repoIds) byRepo[id] = zero();
  const byArea: Record<string, LevelCounts> = {};
  for (const j of journeys) {
    countInto(all, j);
    for (const r of j.repos) if (byRepo[r]) countInto(byRepo[r], j);
    countInto((byArea[j.area] ??= zero()), j);
  }
  const left = journeys
    .filter((j) => j.level !== "understood" || j.needsReWalk.length > 0)
    .sort((a, b) => compare(a.area, b.area) || compare(a.name, b.name) || compare(a.journeyId, b.journeyId))
    .map((j) => ({ journeyId: j.journeyId, name: j.name, area: j.area, level: j.level, reWalkStops: j.needsReWalk.length }));
  return {
    workspaceId: view.workspaceId,
    journeys,
    totals: { all, byRepo, byArea: Object.fromEntries(Object.entries(byArea).sort(([a], [b]) => compare(a, b))) },
    left,
    olderJourneys: view.olderJourneys,
    olderTours: view.olderTours,
  };
}

// ---- record_check ---------------------------------------------------------------------------------------

/** A pass needs at least this many answered questions (check-me asks 3). */
const PASS_QUESTIONS = 3;

export interface RecordCheckArgs {
  journey: string;
  questions: string[];
  answers: string[];
  verdict: "pass" | "fail";
  notes: string;
}

export function recordCheckTool(start: string, args: RecordCheckArgs): Record<string, unknown> {
  const state = loadMapState(start);
  findJourney(state, args.journey);
  if (args.answers.length !== args.questions.length) {
    throw dataError(`Give one answer for each question: got ${args.questions.length} questions and ${args.answers.length} answers.`);
  }
  if (args.verdict === "pass" && args.questions.length < PASS_QUESTIONS) {
    throw dataError(`A pass needs at least ${PASS_QUESTIONS} questions answered (got ${args.questions.length}).`);
  }
  const { journey: _journey, ...input } = args;
  const p = recordCheck(state, args.journey, input);
  return {
    journeyId: args.journey,
    verdict: args.verdict,
    understood: p.understoodAt !== undefined,
    ...(p.understoodAt !== undefined ? { understoodAt: p.understoodAt } : {}),
    checks: p.checks.length,
  };
}

// ---- registration ---------------------------------------------------------------------------------------

const journeyArg = z.string().min(1).describe("A journey id (j_…).");
const checkShape = CheckInputSchema.shape;

export function registerTourTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "build_tour_context",
    {
      title: "Build tour context",
      description:
        "Everything needed to write a journey's tour, in one call. For each stop of each chain (in chain order): its " +
        "`key`, `chainId` and `stopIndex` (what save_tour needs), the code around it (30 lines each side), the types " +
        "it uses (with their declaration when it is in the repo), request/response shapes found in that code " +
        "(schemas, validators, where the request is read, what is sent back), for db stops the table, operation, " +
        "statement and table definition, its neighbours through method calls, and its file's current hash. A stop " +
        "shared by several chains carries its context once (`sameAs` points at it). `tour` says whether a tour is " +
        "saved, which of its stops are out of date or removed, and its 3 check questions. Read only.",
      inputSchema: {
        journey: journeyArg,
        chain: z.string().min(1).optional().describe("Only this chain (ch_…) of the journey, for a very large journey."),
      },
    },
    withErrors(
      (args: { journey: string; chain?: string }) => buildTourContext(opts.start, args.journey, args.chain),
      "Pass `chain` (one of the journey's chain ids) to build the context one chain at a time.",
    ),
  );

  server.registerTool(
    "save_tour",
    {
      title: "Save tour",
      description:
        "Save a journey's tour to .codeloom/tours/<journey>.json (committed with the code; replaces any saved one). " +
        "`tour` has `stops` [{chainId, stopIndex, key, explanation}] (Flow), `dataJourney` {input, steps [{stopKey, " +
        "sql?, note}], output}, `fileNotes` [{repo, file, notes [{kind: trap | note, text}]}] and `check`: exactly 3 " +
        "{question, expected: [key points]}. Every stop and step must be one of the journey's stops, as " +
        "build_tour_context gives them; file notes must name real files. codeloom computes the file hashes and " +
        "commits itself: any the agent sends are ignored. Returns the journey stops the tour leaves out.",
      inputSchema: { journey: journeyArg, tour: TourDraftSchema },
    },
    withErrors((args: { journey: string; tour: unknown }) => saveTour(opts.start, args.journey, args.tour)),
  );

  server.registerTool(
    "get_progress",
    {
      title: "Get progress",
      description:
        "Your own progress through the journeys (kept in ~/.codeloom, never committed): per journey its level " +
        "(none, seen = opened in the dashboard, toured = all four tour phases viewed, understood = passed check-me), " +
        "the stops to re-walk because their code changed since you passed, and the last check; totals per repo and " +
        "per area, where a journey that needs a re-walk counts as toured, not understood, until it passes again; and `left`, the journeys not yet understood (or needing a re-walk), by area. Filter by repo or area. Read only.",
      inputSchema: { repo: z.string().min(1).optional(), area: z.string().optional() },
    },
    withErrors((args: { repo?: string; area?: string }) => getProgress(opts.start, args), "Filter by repo or area."),
  );

  server.registerTool(
    "record_check",
    {
      title: "Record check",
      description:
        "Record the result of a check-me session for a journey in your personal progress: the questions asked, the " +
        "user's answers, the verdict and your notes. `pass` (only when every answer was acceptable against the code; " +
        "at least 3 questions) marks the journey understood, with the stops' current file hashes and commits " +
        "computed by codeloom. `fail` is kept in the history and never changes understood. The only way to mark a " +
        "journey understood.",
      inputSchema: {
        journey: journeyArg,
        questions: checkShape.questions.min(1),
        answers: checkShape.answers,
        verdict: checkShape.verdict,
        notes: checkShape.notes,
      },
    },
    withErrors((args: RecordCheckArgs) => recordCheckTool(opts.start, args)),
  );
}
