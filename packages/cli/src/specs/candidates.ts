/** Spec candidates (v0.3 spec §1): for each journey, the docs that mention its routes, pages, tables,
 * queues or stop symbols, and the ticket keys of the commits that touched its stop files. No AI, no
 * network: repo docs and `git log` only. Written by `codeloom index` to `<ws>/.codeloom/spec-candidates.json`. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";
import { BUILTIN_METHOD_NAMES } from "../linker/resolve-calls.js";
import { BUILTIN_METHOD_NAMES as CHECK_BUILTIN_METHOD_NAMES, GLOBAL_BUILTINS } from "../check/noise.js";
import { chainLookup } from "../mcp/state.js";
import { CodeloomError, dataError } from "../errors.js";
import { readJson, writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import {
  ChainsFileSchema, DEFAULT_TICKET_IGNORE_PREFIXES, DEFAULT_TICKET_PATTERN, JourneysFileSchema, MAX_TICKET_KEY, ticketPatternProblem,
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
/** Only the first 4 KB of a commit's subject and body are scanned for ticket keys. */
export const MAX_COMMIT_TEXT = 4 * 1024;
/** Most bytes one `git log` may print; past it the repo's tickets are skipped with a note. */
export const GIT_LOG_MAX_BUFFER = 32 * 1024 * 1024;
/** Per hit kind, times the term's rarity (termWeight): a route or page names a journey, a table rarely does. */
const WEIGHT: Record<SpecDocHitKind, number> = { route: 3, page: 3, symbol: 2, table: 1, queue: 1 };
/** Hit kinds that name the journey itself; a doc with none of them sorts below every doc with one. */
const STRONG_KINDS: ReadonlySet<SpecDocHitKind> = new Set(["route", "page", "symbol"]);

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

/** Names too generic to mean anything in a doc (compared lowercased): the resolver's and check's built-in
 * method names, JS globals, framework receivers (`res`, `router`, `app`) and plain English words every
 * codebase uses. */
const GENERIC_NAMES: ReadonlySet<string> = new Set(
  [
    ...BUILTIN_METHOD_NAMES, ...CHECK_BUILTIN_METHOD_NAMES, ...GLOBAL_BUILTINS,
    "constructor", "default", "anonymous", "handler", "render", "module", "exports",
    "request", "response", "service", "execute", "validate", "listen", "controller", "process",
    "req", "res", "app", "router", "ctx", "server", "express", "next", "this", "self", "log", "json", "use", "send",
  ].map((n) => n.toLowerCase()),
);
const generic = (name: string) => GENERIC_NAMES.has(name.toLowerCase());

const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** A bare name counts when it has at least 6 characters and is not a generic name. A qualified symbol
 * (`CustomerService.create`) counts unless a receiver part is generic (`console.log`, `JSON.stringify`,
 * `res.json`, `router.get`, `app.use`), or its method is generic and its receiver is shorter than 6
 * characters. Anything that is not an identifier path never counts. */
export function symbolTermOk(symbol: string): boolean {
  if (!SYMBOL_RE.test(symbol)) return false;
  const parts = symbol.split(".");
  if (parts.length === 1) return symbol.length >= MIN_BARE_SYMBOL && !generic(symbol);
  const method = parts[parts.length - 1]!;
  const receivers = parts.slice(0, -1);
  if (receivers.some(generic)) return false;
  if (generic(method) && receivers[receivers.length - 1]!.length < MIN_BARE_SYMBOL) return false;
  return true;
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

/** The ticket keys in `text` (first-seen order, no repeats): matches of `specs.ticketPattern` (default:
 * an uppercase key like SHOP-12 that is not part of a longer token) whose prefix (before the first `-`) is
 * not in `specs.ignorePrefixes` (default AC, ADR, CVE, ID, ISO, QA, RFC, SHA, TC, UTF), at most 64
 * characters long. Only the first 4 KB of `text` is scanned. An unsafe pattern (ticketPatternProblem) is a
 * data error; the workspace schema refuses it first. */
export function makeTicketMatcher(specs: SpecsConfig | undefined): (text: string) => string[] {
  const source = specs?.ticketPattern ?? DEFAULT_TICKET_PATTERN;
  const problem = ticketPatternProblem(source);
  if (problem) throw dataError(`specs.ticketPattern ${problem}. Fix it by hand.`);
  const pattern = new RegExp(source, "g");
  const ignored = new Set(specs?.ignorePrefixes ?? DEFAULT_TICKET_IGNORE_PREFIXES);
  return (text) => {
    const keys = new Set<string>();
    for (const m of text.slice(0, MAX_COMMIT_TEXT).matchAll(pattern)) {
      const key = m[0];
      if (key === "" || key.length > MAX_TICKET_KEY || ignored.has(key.split("-")[0]!)) continue;
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
function repoLog(repoAbs: string, files: readonly string[], maxBuffer: number, overflow: () => void): LogCommit[] {
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
        commits = parseGitLog(git(repoAbs, [...base, ...extra, "HEAD", "--", ...paths], { maxBuffer }));
        break;
      } catch (err) {
        if (err instanceof CodeloomError) throw err;
        if ((err as NodeJS.ErrnoException).code === "ENOBUFS" || /maxBuffer/i.test(String((err as Error).message))) {
          overflow();
          return [];
        }
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

/** Scores keep 3 decimals so the committed file is the same on every machine. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A term shared by many journeys counts for little: log(1 + journeys / journeys using the term). */
const termWeight = (journeys: number, using: number) => Math.log(1 + journeys / Math.max(1, using));

export interface BuildSpecCandidatesInput {
  repos: readonly CandidateRepo[];
  chains: readonly Chain[];
  journeys: readonly Journey[];
  specs?: SpecsConfig;
  /** Lines for the user (a git log too big to read, ...). */
  notes?: string[];
  /** Tests only: the git log output limit (default GIT_LOG_MAX_BUFFER). */
  gitMaxBuffer?: number;
}

/** Build spec-candidates.json content for `journeys` (every one gets an entry, keys sorted). Docs score
 * by hit kind times the term's rarity across journeys (termWeight); a doc with only table or queue hits
 * sorts below any doc with a route, page or symbol hit. Tickets score by their commits, each commit
 * weighing 1 / the number of journeys whose stop files it touched, so a key specific to a journey rises
 * above keys of commits that touched shared files. */
export function buildSpecCandidates(input: BuildSpecCandidatesInput): SpecCandidatesFile {
  const journeys = [...input.journeys].sort((a, b) => compare(a.id, b.id));
  const repos = [...input.repos].sort((a, b) => compare(a.id, b.id));
  const lookup = chainLookup(input.chains);
  const chainsOf = new Map(journeys.map((j) => [j.id, lookup.resolve(j.chainIds).chains]));
  const out: Record<string, SpecJourneyCandidates> = {};
  if (journeys.length === 0) return { version: 1, journeys: out };

  // Docs: one pass over every doc against every journey's terms.
  const index = buildTermIndex(journeys.map((j) => journeyTerms(j.id, chainsOf.get(j.id)!)));
  const using = (entries: ReadonlyArray<{ journey: string }> | undefined) => new Set((entries ?? []).map((e) => e.journey)).size;
  const hitWeight = (h: DocHit): number => {
    const isPath = h.kind === "route" || h.kind === "page";
    const key = isPath ? normalizePath(h.term.replace(/^[A-Z]+ (?=\/)/, "")) : h.term;
    return WEIGHT[h.kind] * termWeight(journeys.length, using(isPath ? index.paths.get(key) : index.words.get(key)));
  };
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
  const maxBuffer = input.gitMaxBuffer ?? GIT_LOG_MAX_BUFFER;
  for (const repo of repos) {
    const files = allStopFiles.get(repo.id);
    if (!files) continue;
    const overflow = () => {
      input.notes?.push(
        `spec candidates: the git history of ${repo.id} is too big to read (over ${Math.max(1, Math.round(maxBuffer / (1024 * 1024)))} MB of git log output); its ticket candidates were skipped.`,
      );
    };
    const commits = repoLog(repo.abs, [...files].sort(compare), maxBuffer, overflow);
    const byFile = new Map<string, number[]>();
    commits.forEach((c, i) => c.files.forEach((f) => {
      const list = byFile.get(f);
      if (list) list.push(i);
      else byFile.set(f, [i]);
    }));
    logs.set(repo.id, { commits, byFile });
  }
  // How many journeys each commit touched (by their stop files), for the ticket weights.
  const journeysPerCommit = new Map<string, Map<number, number>>(); // repo -> commit index -> journeys
  for (const j of journeys) {
    const seen = new Map<string, Set<number>>();
    for (const c of chainsOf.get(j.id)!) {
      for (const st of c.stops) {
        const log = logs.get(st.repo);
        if (!log) continue;
        const set = seen.get(st.repo) ?? new Set<number>();
        seen.set(st.repo, set);
        for (const i of log.byFile.get(st.file) ?? []) set.add(i);
      }
    }
    for (const [repo, set] of seen) {
      const per = journeysPerCommit.get(repo) ?? new Map<number, number>();
      journeysPerCommit.set(repo, per);
      for (const i of set) per.set(i, (per.get(i) ?? 0) + 1);
    }
  }

  for (const j of journeys) {
    const docRows = [...(docHits.get(j.id) ?? new Map<string, DocHit[]>()).entries()].map(([ref, hits]) => {
      const doc: SpecDocCandidate = {
        ref,
        score: round3(hits.reduce((n, h) => n + hitWeight(h), 0)),
        count: hits.length,
        evidence: hits.slice(0, MAX_EVIDENCE).map((h): SpecDocEvidence => ({ kind: h.kind, term: h.term, file: ref.slice(ref.indexOf(":") + 1), line: h.line })),
      };
      return { strong: hits.some((h) => STRONG_KINDS.has(h.kind)), doc };
    });
    const docs = docRows
      .sort((a, b) => Number(b.strong) - Number(a.strong) || byScoreThenRef(a.doc, b.doc))
      .map((r) => r.doc);

    const stopFiles = new Map<string, Set<string>>();
    for (const c of chainsOf.get(j.id)!) for (const s of c.stops) stopFiles.set(s.repo, (stopFiles.get(s.repo) ?? new Set()).add(s.file));
    const tickets = new Map<string, { score: number; evidence: SpecTicketEvidence[] }>();
    for (const repo of repos) {
      const files = stopFiles.get(repo.id);
      if (!files) continue;
      const log = logs.get(repo.id)!;
      const touched = new Map<number, string[]>(); // commit index -> stop files it changed
      for (const f of files) for (const i of log.byFile.get(f) ?? []) touched.set(i, [...(touched.get(i) ?? []), f]);
      for (const i of [...touched.keys()].sort((a, b) => a - b)) {
        const c = log.commits[i]!;
        const branch = c.merge ? mergeBranch(c.subject) : undefined;
        // A branch name is matched per `/` part, so `feat/SHOP-14-show` still yields SHOP-14.
        const keys = new Set([...matchKeys(`${c.subject}\n${c.body}`), ...(branch ? branch.split("/").flatMap(matchKeys) : [])]);
        const file = touched.get(i)!.sort(compare)[0]!;
        const subject = c.subject.length > MAX_SUBJECT ? `${c.subject.slice(0, MAX_SUBJECT - 1)}…` : c.subject;
        const weight = 1 / Math.max(1, journeysPerCommit.get(repo.id)?.get(i) ?? 1);
        for (const key of keys) {
          const t = tickets.get(key) ?? { score: 0, evidence: [] };
          t.score += weight;
          t.evidence.push({ repo: repo.id, commit: c.sha.slice(0, 7), file, subject });
          tickets.set(key, t);
        }
      }
    }
    const ticketCandidates: SpecTicketCandidate[] = [...tickets.entries()].map(([ref, t]) => ({
      ref, score: round3(t.score), count: t.evidence.length, evidence: t.evidence.slice(0, MAX_EVIDENCE),
    }));

    out[j.id] = {
      docs: docs.slice(0, MAX_CANDIDATES),
      tickets: ticketCandidates.sort(byScoreThenRef).slice(0, MAX_CANDIDATES),
    };
  }
  return { version: 1, journeys: out };
}

/** The `codeloom index` step (after the linker): read chains.json and journeys.json, build the candidates
 * and write `<ws>/.codeloom/spec-candidates.json` only when its content changes. Returns whether it wrote. */
export function writeSpecCandidates(root: string, repos: readonly CandidateRepo[], specs?: SpecsConfig, notes?: string[]): boolean {
  const dir = join(root, CODELOOM_DIR);
  const chains = readJson(join(dir, FILES.chains), ChainsFileSchema)?.chains ?? [];
  const journeys = readJson(join(dir, FILES.journeys), JourneysFileSchema, { handWritten: true })?.journeys ?? [];
  const file = buildSpecCandidates({ repos, chains, journeys, ...(specs ? { specs } : {}), ...(notes ? { notes } : {}) });
  return writeJsonIfChanged(join(dir, FILES.specCandidates), file);
}
