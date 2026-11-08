/** Spec candidates (v0.3 spec §1): for each journey, the docs that mention its routes, pages, tables,
 * queues or stop symbols, and the ticket keys of the commits that touched its stop files. No AI, no
 * network: repo docs and `git log` only. Written by `codeloom index` to `<ws>/.codeloom/spec-candidates.json`. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";
import { BUILTIN_METHOD_NAMES } from "../linker/resolve-calls.js";
import { BUILTIN_METHOD_NAMES as CHECK_BUILTIN_METHOD_NAMES, GLOBAL_BUILTINS } from "../check/noise.js";
import { chainLookup } from "../mcp/state.js";
import { CodeloomError } from "../errors.js";
import { readJson, writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import {
  ChainsFileSchema, DEFAULT_TICKET_IGNORE_PREFIXES, DEFAULT_TICKET_PATTERN, JourneysFileSchema,
  type Chain, type Journey, type SpecCandidatesFile, type SpecDocCandidate, type SpecDocEvidence, type SpecDocHitKind,
  type SpecJourneyCandidates, type SpecsConfig, type SpecTicketCandidate, type SpecTicketEvidence,
} from "../store/schemas.js";
import { compare } from "../util.js";
import { git } from "../workspace/git.js";

export const MAX_DOC_BYTES = 512 * 1024;
export const MAX_CANDIDATES = 20;
export const MAX_EVIDENCE = 5;
export const MAX_COMMITS = 500;
const MAX_SUBJECT = 120;
const MIN_BARE_SYMBOL = 6;
const WEIGHT: Record<SpecDocHitKind, number> = { route: 3, page: 3, table: 2, queue: 2, symbol: 1 };

// ---------------------------------------------------------------------------------------------------
// Journey terms
// ---------------------------------------------------------------------------------------------------

export interface JourneyTerms {
  journey: string;
  routes: Array<{ method: string; path: string }>;
  pages: string[];
  tables: string[];
  queues: string[];
  symbols: string[];
}

/** Names too generic to mean anything as a bare word in a doc: the resolver's and check's built-in method
 * names, JS globals, and a few words every codebase uses. */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_METHOD_NAMES, ...CHECK_BUILTIN_METHOD_NAMES, ...GLOBAL_BUILTINS,
  "constructor", "default", "anonymous", "handler", "render", "module", "exports",
]);

const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** A qualified symbol (`CustomerService.create`) always counts; a bare name only when it has at least 6
 * characters and is not a built-in / generic name. Anything that is not an identifier path never does. */
export function symbolTermOk(symbol: string): boolean {
  if (!SYMBOL_RE.test(symbol)) return false;
  if (symbol.includes(".")) return true;
  return symbol.length >= MIN_BARE_SYMBOL && !GENERIC_NAMES.has(symbol);
}

const PARAM_SEGMENT = /^(?::.+|\{[^}]*\}|\[{1,2}(?:\.\.\.)?[^\]]*\]{1,2}|<[^>]*>|\$\{[^}]*\}|\*)$/;

/** A path with every param segment (`:id`, `{id}`, `[id]`, `[...slug]`, `<id>`, `${id}`, `*`) as `:` and
 * no trailing slash, so the forms compare equal. */
export function normalizePath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.split("/").map((seg) => (PARAM_SEGMENT.test(seg) ? ":" : seg)).join("/");
}

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort(compare);

/** Queue terms: the label, plus the routing key alone for an `exchange:key` label. */
function queueTerms(label: string): string[] {
  const i = label.lastIndexOf(":");
  return i >= 0 && i < label.length - 1 ? [label, label.slice(i + 1)] : [label];
}

/** The terms a doc can mention for a journey, from its chains: route stops (`METHOD path`), call stops
 * whose path no route stop has, the page path of `page:` entries, tables/models, queues and stop symbols
 * (after symbolTermOk). Sorted and de-duplicated. */
export function journeyTerms(journey: string, chains: readonly Chain[]): JourneyTerms {
  const routes = new Map<string, { method: string; path: string }>();
  const calls: Array<{ method: string; path: string }> = [];
  const pages: string[] = [];
  const tables: string[] = [];
  const queues: string[] = [];
  const symbols: string[] = [];
  for (const chain of chains) {
    const page = /^page:[^:]+:(.+)$/.exec(chain.entry);
    if (page && page[1] !== "/") pages.push(page[1]!);
    for (const s of chain.stops) {
      if (symbolTermOk(s.symbol)) symbols.push(s.symbol);
      const label = s.label ?? "";
      if (s.kind === "route") {
        const m = /^(\S+) (\/.*)$/.exec(label);
        if (m && m[2] !== "/") routes.set(`${m[1]} ${normalizePath(m[2]!)}`, { method: m[1]!, path: m[2]! });
      } else if (s.kind === "call" && label.startsWith("/") && label !== "/") {
        calls.push({ method: s.op ?? "ANY", path: label });
      } else if (s.kind === "db" && label !== "") {
        tables.push(label);
      } else if ((s.kind === "publish" || s.kind === "consume") && label !== "") {
        queues.push(...queueTerms(label));
      }
    }
  }
  for (const c of calls) {
    const key = `${c.method} ${normalizePath(c.path)}`;
    if (!routes.has(key)) routes.set(key, c);
  }
  return {
    journey,
    routes: [...routes.entries()].sort(([a], [b]) => compare(a, b)).map(([, r]) => r),
    pages: sortedUnique(pages),
    tables: sortedUnique(tables),
    queues: sortedUnique(queues),
    symbols: sortedUnique(symbols),
  };
}

// ---------------------------------------------------------------------------------------------------
// Doc scanning
// ---------------------------------------------------------------------------------------------------

interface PathEntry { journey: string; kind: "route" | "page"; term: string; method?: string }
interface WordEntry { journey: string; kind: "table" | "queue" | "symbol"; term: string }

export interface TermIndex {
  paths: Map<string, PathEntry[]>;
  words: Map<string, WordEntry[]>;
}

/** One index over every journey's terms, so each doc is read and tokenised once. */
export function buildTermIndex(all: readonly JourneyTerms[]): TermIndex {
  const paths = new Map<string, PathEntry[]>();
  const words = new Map<string, WordEntry[]>();
  const seen = new Set<string>();
  const add = <E>(map: Map<string, E[]>, key: string, e: E, dedupe: string) => {
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    map.set(key, [...(map.get(key) ?? []), e]);
  };
  for (const t of all) {
    for (const r of t.routes) {
      const key = normalizePath(r.path);
      add(paths, key, { journey: t.journey, kind: "route", term: r.path, method: r.method }, `${t.journey}\0route\0${r.method}\0${key}`);
    }
    for (const p of t.pages) {
      const key = normalizePath(p);
      add(paths, key, { journey: t.journey, kind: "page", term: p }, `${t.journey}\0page\0${key}`);
    }
    for (const x of t.tables) add(words, x, { journey: t.journey, kind: "table", term: x }, `${t.journey}\0table\0${x}`);
    for (const q of t.queues.flatMap(queueTerms)) add(words, q, { journey: t.journey, kind: "queue", term: q }, `${t.journey}\0queue\0${q}`);
    for (const s of t.symbols) {
      if (symbolTermOk(s)) add(words, s, { journey: t.journey, kind: "symbol", term: s }, `${t.journey}\0symbol\0${s}`);
    }
  }
  return { paths, words };
}

export interface DocHit { journey: string; kind: SpecDocHitKind; term: string; line: number; col: number }

// A path token: an optional URL scheme + host (whose path is what counts), then `/...` up to a delimiter.
const PATH_TOKEN = /(https?:\/\/[^\s/`'"()<>]+)?(\/[^\s`'"()<>,;|*!?#&\\]*)/g;
const PATH_BEFORE = /[\w.~\-/:$@]/;
const METHOD_BEFORE = /(?:^|[^A-Za-z])(GET|POST|PUT|PATCH|DELETE)\s+[`'"]?$/;
// A word token: identifier segments joined by `.`, `:` or `-` (`CustomerService.create`, `billing:invoice.paid`).
const WORD_TOKEN = /[A-Za-z_$][\w$]*(?:[.:-][A-Za-z_$0-9][\w$]*)*/g;
const WORD_BEFORE = /[\w$./\-:@#]/;

/** Every whole-token mention of an indexed term in `text`, in doc order (line, then column). A route
 * mention with a different method written before it is not a hit. */
export function scanDoc(text: string, index: TermIndex): DocHit[] {
  const out: DocHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineHits: DocHit[] = [];
    if (index.paths.size > 0 && line.includes("/")) {
      for (const m of line.matchAll(PATH_TOKEN)) {
        const col = m.index! + (m[1]?.length ?? 0);
        if (!m[1] && m.index! > 0 && PATH_BEFORE.test(line[m.index! - 1]!)) continue;
        const raw = m[2]!.replace(/[.,:]+$/, "");
        if (raw === "" || raw === "/") continue;
        const entries = index.paths.get(normalizePath(raw));
        if (!entries) continue;
        const method = m[1] ? undefined : METHOD_BEFORE.exec(line.slice(0, m.index!))?.[1];
        for (const e of entries) {
          if (e.kind === "page") {
            lineHits.push({ journey: e.journey, kind: "page", term: e.term, line: li + 1, col });
          } else if (!method || e.method === "ANY" || e.method === method) {
            lineHits.push({ journey: e.journey, kind: "route", term: method ? `${method} ${e.term}` : e.term, line: li + 1, col });
          }
        }
      }
    }
    if (index.words.size > 0) {
      for (const m of line.matchAll(WORD_TOKEN)) {
        if (m.index! > 0 && WORD_BEFORE.test(line[m.index! - 1]!)) continue;
        const token = m[0];
        let entries = index.words.get(token);
        if (!entries && /[:-]/.test(token)) {
          entries = token.split(/[:-]/).flatMap((part) => index.words.get(part) ?? []);
        }
        for (const e of entries ?? []) lineHits.push({ journey: e.journey, kind: e.kind, term: e.term, line: li + 1, col: m.index! });
      }
    }
    lineHits.sort((a, b) => a.col - b.col);
    out.push(...lineHits);
  }
  return out;
}

/** Built-in doc globs (gitignore syntax, so `README*` and `*.md` match at any depth). */
const DOC_GLOBS = ["/docs/**", "README*", "**/adr/**", "*.md", "*.mdx", "*.txt"];

/** Whether a repo-relative file is a doc: the built-in globs plus `specs.docs`, minus `specs.ignoreDocs`.
 * The repo's own ignore rules (and `.codeloom`, node_modules, build output) are already applied by the
 * file list this is used on. */
export function makeDocFilter(specs: SpecsConfig | undefined): (rel: string) => boolean {
  const take = ignore({ ignorecase: false }).add([...DOC_GLOBS, ...(specs?.docs ?? [])]);
  const skip = ignore({ ignorecase: false }).add(specs?.ignoreDocs ?? []);
  return (rel) => take.ignores(rel) && !skip.ignores(rel);
}

function readDoc(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_DOC_BYTES) return null;
    const text = readFileSync(abs, "utf8");
    return text.includes("\0") ? null : text; // binary
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------------------------

/** The ticket keys in `text` (first-seen order, no repeats): matches of `specs.ticketPattern` (default
 * `\b[A-Z][A-Z0-9]+-\d+\b`) whose prefix (before the first `-`) is not in `specs.ignorePrefixes`
 * (default CVE, UTF, ISO, RFC, SHA). */
export function makeTicketMatcher(specs: SpecsConfig | undefined): (text: string) => string[] {
  const pattern = new RegExp(specs?.ticketPattern ?? DEFAULT_TICKET_PATTERN, "g");
  const ignored = new Set(specs?.ignorePrefixes ?? DEFAULT_TICKET_IGNORE_PREFIXES);
  return (text) => {
    const keys = new Set<string>();
    for (const m of text.matchAll(pattern)) {
      const key = m[0];
      if (key === "" || ignored.has(key.split("-")[0]!)) continue;
      keys.add(key);
    }
    return [...keys];
  };
}

/** The branch a merge commit subject names (`Merge branch 'x'`, `Merge remote-tracking branch 'x'`,
 * `Merge pull request #1 from owner/x`), else undefined. */
export function mergeBranch(subject: string): string | undefined {
  const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject) ?? /^Merge pull request #\d+ from (\S+)/.exec(subject);
  return m?.[1];
}

export interface LogCommit { sha: string; merge: boolean; time: number; subject: string; body: string; files: string[] }

const LOG_FORMAT = "--format=%x1e%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1f";

/** Parse `git log --name-only` output in LOG_FORMAT. */
export function parseGitLog(out: string): LogCommit[] {
  return out.split("\x1e").filter((r) => r.trim() !== "").map((rec) => {
    const [sha = "", parents = "", time = "0", subject = "", body = "", rest = ""] = rec.split("\x1f");
    return {
      sha, merge: parents.trim().split(/\s+/).filter(Boolean).length > 1, time: Number(time) || 0, subject, body,
      files: rest.split("\n").filter((f) => f !== ""),
    };
  });
}

/** Paths per `git log` call, so the command line stays far below the OS argument limit. */
const PATHS_PER_CALL = 1000;

/** The last MAX_COMMITS commits of HEAD that changed any of `files`, newest first, each with the files
 * (of `files`) it changed. The pathspec keeps git from walking whole trees (a big root commit of loose
 * objects takes seconds otherwise); `--full-history` keeps merge commits, listed with the files their
 * branch brought in (diff against the first parent), so a merged branch's name counts. No history (or
 * not a git repo) → []. */
function repoLog(repoAbs: string, files: readonly string[]): LogCommit[] {
  const base = [
    "-c", "core.quotePath=false", "--literal-pathspecs", "log", "-n", String(MAX_COMMITS), "--no-renames",
    "--name-only", "--full-history", LOG_FORMAT,
  ];
  const bySha = new Map<string, LogCommit & { order: number }>();
  let order = 0;
  for (let i = 0; i < files.length; i += PATHS_PER_CALL) {
    const paths = files.slice(i, i + PATHS_PER_CALL);
    let commits: LogCommit[] = [];
    for (const extra of [["--diff-merges=first-parent"], []]) {
      try {
        commits = parseGitLog(git(repoAbs, [...base, ...extra, "HEAD", "--", ...paths], { maxBuffer: 256 * 1024 * 1024 }));
        break;
      } catch (err) {
        if (err instanceof CodeloomError) throw err;
      }
    }
    for (const c of commits) {
      const seen = bySha.get(c.sha);
      if (seen) seen.files = [...new Set([...seen.files, ...c.files])];
      else bySha.set(c.sha, { ...c, order: order++ });
    }
  }
  return [...bySha.values()]
    .sort((a, b) => b.time - a.time || a.order - b.order)
    .slice(0, MAX_COMMITS)
    .map(({ order: _order, ...c }) => c);
}

// ---------------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------------

export interface CandidateRepo { id: string; abs: string; files: Iterable<string> }

const byScoreThenRef = (a: { score: number; ref: string }, b: { score: number; ref: string }) =>
  b.score - a.score || compare(a.ref, b.ref);

/** Build spec-candidates.json content for `journeys` (every one gets an entry, keys sorted). */
export function buildSpecCandidates(input: {
  repos: readonly CandidateRepo[]; chains: readonly Chain[]; journeys: readonly Journey[]; specs?: SpecsConfig;
}): SpecCandidatesFile {
  const journeys = [...input.journeys].sort((a, b) => compare(a.id, b.id));
  const repos = [...input.repos].sort((a, b) => compare(a.id, b.id));
  const lookup = chainLookup(input.chains);
  const chainsOf = new Map(journeys.map((j) => [j.id, lookup.resolve(j.chainIds).chains]));
  const out: Record<string, SpecJourneyCandidates> = {};
  if (journeys.length === 0) return { version: 1, journeys: out };

  // Docs: one pass over every doc against every journey's terms.
  const index = buildTermIndex(journeys.map((j) => journeyTerms(j.id, chainsOf.get(j.id)!)));
  const docHits = new Map<string, Map<string, DocHit[]>>(); // journey -> doc ref -> hits
  const isDoc = makeDocFilter(input.specs);
  for (const repo of repos) {
    for (const rel of [...repo.files].filter(isDoc).sort(compare)) {
      const text = readDoc(join(repo.abs, rel));
      if (text === null) continue;
      const ref = `${repo.id}:${rel}`;
      for (const h of scanDoc(text, index)) {
        const perDoc = docHits.get(h.journey) ?? new Map<string, DocHit[]>();
        docHits.set(h.journey, perDoc);
        const list = perDoc.get(ref);
        if (list) list.push(h);
        else perDoc.set(ref, [h]);
      }
    }
  }

  // Tickets: one git log per repo over every journey's stop files in it.
  const matchKeys = makeTicketMatcher(input.specs);
  const allStopFiles = new Map<string, Set<string>>();
  for (const j of journeys) {
    for (const c of chainsOf.get(j.id)!) for (const s of c.stops) allStopFiles.set(s.repo, (allStopFiles.get(s.repo) ?? new Set()).add(s.file));
  }
  const logs = new Map<string, { commits: LogCommit[]; byFile: Map<string, number[]> }>();
  for (const repo of repos) {
    const files = allStopFiles.get(repo.id);
    if (!files) continue;
    const commits = repoLog(repo.abs, [...files].sort(compare));
    const byFile = new Map<string, number[]>();
    commits.forEach((c, i) => c.files.forEach((f) => {
      const list = byFile.get(f);
      if (list) list.push(i);
      else byFile.set(f, [i]);
    }));
    logs.set(repo.id, { commits, byFile });
  }

  for (const j of journeys) {
    const docs: SpecDocCandidate[] = [...(docHits.get(j.id) ?? new Map<string, DocHit[]>()).entries()].map(([ref, hits]) => ({
      ref,
      score: hits.reduce((n, h) => n + WEIGHT[h.kind], 0),
      count: hits.length,
      evidence: hits.slice(0, MAX_EVIDENCE).map((h): SpecDocEvidence => ({ kind: h.kind, term: h.term, file: ref.slice(ref.indexOf(":") + 1), line: h.line })),
    }));

    const stopFiles = new Map<string, Set<string>>();
    for (const c of chainsOf.get(j.id)!) for (const s of c.stops) stopFiles.set(s.repo, (stopFiles.get(s.repo) ?? new Set()).add(s.file));
    const tickets = new Map<string, SpecTicketEvidence[]>();
    for (const repo of repos) {
      const files = stopFiles.get(repo.id);
      if (!files) continue;
      const log = logs.get(repo.id)!;
      const touched = new Map<number, string[]>(); // commit index -> stop files it changed
      for (const f of files) for (const i of log.byFile.get(f) ?? []) touched.set(i, [...(touched.get(i) ?? []), f]);
      for (const i of [...touched.keys()].sort((a, b) => a - b)) {
        const c = log.commits[i]!;
        const branch = c.merge ? mergeBranch(c.subject) : undefined;
        const keys = new Set([...matchKeys(`${c.subject}\n${c.body}`), ...(branch ? matchKeys(branch) : [])]);
        const file = touched.get(i)!.sort(compare)[0]!;
        const subject = c.subject.length > MAX_SUBJECT ? `${c.subject.slice(0, MAX_SUBJECT - 1)}…` : c.subject;
        for (const key of keys) tickets.set(key, [...(tickets.get(key) ?? []), { repo: repo.id, commit: c.sha.slice(0, 7), file, subject }]);
      }
    }
    const ticketCandidates: SpecTicketCandidate[] = [...tickets.entries()].map(([ref, ev]) => ({
      ref, score: ev.length, count: ev.length, evidence: ev.slice(0, MAX_EVIDENCE),
    }));

    out[j.id] = {
      docs: docs.sort(byScoreThenRef).slice(0, MAX_CANDIDATES),
      tickets: ticketCandidates.sort(byScoreThenRef).slice(0, MAX_CANDIDATES),
    };
  }
  return { version: 1, journeys: out };
}

/** The `codeloom index` step (after the linker): read chains.json and journeys.json, build the candidates
 * and write `<ws>/.codeloom/spec-candidates.json` only when its content changes. Returns whether it wrote. */
export function writeSpecCandidates(root: string, repos: readonly CandidateRepo[], specs?: SpecsConfig): boolean {
  const dir = join(root, CODELOOM_DIR);
  const chains = readJson(join(dir, FILES.chains), ChainsFileSchema)?.chains ?? [];
  const journeys = readJson(join(dir, FILES.journeys), JourneysFileSchema, { handWritten: true })?.journeys ?? [];
  const file = buildSpecCandidates({ repos, chains, journeys, ...(specs ? { specs } : {}) });
  return writeJsonIfChanged(join(dir, FILES.specCandidates), file);
}
