import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dataError } from "../../errors.js";
import { CODELOOM_DIR } from "../../store/paths.js";
import type { Journey } from "../../store/schemas.js";
import { type JourneySpecCandidates, readSpecCandidates, readSpecsConfig } from "../../store/spec-candidates.js";
import { type JourneySpecs, LinksInputSchema, readSpecs, saveSpecLinks, type SpecState, specState, specsPath } from "../../store/specs.js";
import { JOURNEY_ID_RE } from "../../store/tours.js";
import { compare } from "../../util.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { chainLookup, loadMapState, type MapState } from "../state.js";

// v0.3 spec §2: candidates (from `codeloom index`) → Claude reads them → confirmed links in specs.json.

/** Lines of a doc around each hit, on each side. */
const SNIPPET_LINES = 3;
/** Most characters in one snippet. */
const SNIPPET_CHARS = 1_500;
/** Docs bigger than this are not read for snippets (the indexer skips them too). */
const MAX_DOC_BYTES = 512 * 1024;

function findJourney(state: MapState, id: string): Journey {
  if (!JOURNEY_ID_RE.test(id)) throw dataError(`Bad journey id "${id}": expected j_ and 12 hex characters (list_specs lists them).`);
  const j = state.journeys.find((x) => x.id === id);
  if (!j) throw dataError(`Unknown journey "${id}". list_specs lists every journey.`);
  return j;
}

/** Repos the journey's current chains touch, sorted. */
function journeyRepos(state: MapState, j: Journey): string[] {
  const repos = new Set<string>();
  for (const c of chainLookup(state.chains).resolve(j.chainIds).chains) for (const s of c.stops) repos.add(s.repo);
  return [...repos].sort(compare);
}

/** A doc's lines, when `repo:path` names a readable file inside a workspace repo (never under .codeloom). */
function docLines(state: MapState, repoId: string, file: string): string[] | null {
  const repo = state.ws.repos.find((r) => r.ref.id === repoId);
  if (!repo) return null;
  const abs = resolve(repo.abs, file);
  const rel = relative(repo.abs, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes(CODELOOM_DIR)) return null;
  try {
    if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > MAX_DOC_BYTES) return null;
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    return lines;
  } catch {
    return null;
  }
}

interface Snippet { startLine: number; endLine: number; text: string }

function snippetAt(lines: string[] | null, line: number): Snippet | null {
  if (!lines || line < 1 || line > lines.length) return null;
  const startLine = Math.max(1, line - SNIPPET_LINES);
  const endLine = Math.min(lines.length, line + SNIPPET_LINES);
  return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join("\n").slice(0, SNIPPET_CHARS) };
}

function splitDocRef(ref: string): { repo: string; file: string } {
  const at = ref.indexOf(":");
  return at < 0 ? { repo: "", file: ref } : { repo: ref.slice(0, at), file: ref.slice(at + 1) };
}

// ---- match_specs ----------------------------------------------------------------------------------------

export function matchSpecs(start: string, journeyId: string): Record<string, unknown> {
  const state = loadMapState(start);
  const journey = findJourney(state, journeyId);
  const notes: string[] = [];
  const file = readSpecCandidates(state.ws.root);
  if (!file) notes.push(`No spec candidates yet (.codeloom/spec-candidates.json is missing): run "codeloom index" (or the reindex tool) to find them.`);
  else if (!file.journeys[journeyId]) notes.push("codeloom found no candidate docs or tickets for this journey. If you know of one, you may still save it.");
  const candidates: JourneySpecCandidates = file?.journeys[journeyId] ?? { docs: [], tickets: [] };
  const entry = readSpecs(state.ws.root).journeys[journeyId];
  const { state: spec, checked } = specState(entry, file?.journeys[journeyId]);
  const lines = new Map<string, string[] | null>();
  const docs = candidates.docs.map((d) => {
    const { repo, file: path } = splitDocRef(d.ref);
    if (!lines.has(d.ref)) lines.set(d.ref, docLines(state, repo, path));
    const text = lines.get(d.ref)!;
    return {
      ref: d.ref,
      repo,
      file: path,
      score: d.score,
      count: d.count,
      evidence: d.evidence.map((e) => ({ ...e, snippet: snippetAt(text, e.line) })),
    };
  });
  if (docs.some((d) => lines.get(d.ref) === null)) notes.push("Some candidate docs cannot be read any more (moved or deleted): their snippets are null. Run reindex to refresh the candidates.");
  return {
    journey: { id: journey.id, name: journey.name, area: journey.area },
    state: spec,
    checked,
    checkedAt: entry?.checkedAt ?? null,
    links: entry?.links ?? [],
    docs,
    tickets: candidates.tickets,
    ticketPattern: readSpecsConfig(state.ws.root).ticketPattern,
    notes,
  };
}

// ---- save_spec_links ------------------------------------------------------------------------------------

export function saveSpecLinksTool(start: string, journeyId: string, links: unknown): Record<string, unknown> {
  const state = loadMapState(start);
  findJourney(state, journeyId);
  const parsed = LinksInputSchema.safeParse(links);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - links.${i.path.join(".")}: ${i.message}`);
    throw dataError(`The spec links for ${journeyId} are not valid:\n${lines.join("\n")}`);
  }
  const replaced = readSpecs(state.ws.root).journeys[journeyId] !== undefined;
  const entry = saveSpecLinks(state.ws, journeyId, parsed.data);
  return {
    journeyId,
    links: entry.links,
    checkedAt: entry.checkedAt,
    replaced,
    path: relative(state.ws.root, specsPath(state.ws.root)).split(/[\\/]/).join("/"),
  };
}

// ---- list_specs -----------------------------------------------------------------------------------------

export interface SpecCoverage { total: number; linked: number; candidates: number; none: number; checked: number }

const zero = (): SpecCoverage => ({ total: 0, linked: 0, candidates: 0, none: 0, checked: 0 });

function countInto(c: SpecCoverage, s: SpecState, checked: boolean): void {
  c.total++;
  c[s]++;
  if (checked) c.checked++;
}

export function listSpecs(start: string, args: { repo?: string; area?: string }): Record<string, unknown> {
  const state = loadMapState(start);
  const repoIds = state.ws.repos.map((r) => r.ref.id).sort(compare);
  if (args.repo !== undefined && !repoIds.includes(args.repo)) {
    throw dataError(`Unknown repo "${args.repo}". Repos in this workspace: ${repoIds.join(", ")}.`);
  }
  const specs = readSpecs(state.ws.root);
  const candidates = readSpecCandidates(state.ws.root);
  const all = zero();
  const byRepo: Record<string, SpecCoverage> = {};
  for (const id of args.repo !== undefined ? [args.repo] : repoIds) byRepo[id] = zero();
  const byArea: Record<string, SpecCoverage> = {};
  const journeys: Record<string, unknown>[] = [];
  for (const j of [...state.journeys].sort((a, b) => compare(a.id, b.id))) {
    const repos = journeyRepos(state, j);
    if (args.repo !== undefined && !repos.includes(args.repo)) continue;
    if (args.area !== undefined && j.area !== args.area) continue;
    const entry: JourneySpecs | undefined = specs.journeys[j.id];
    const cands = candidates?.journeys[j.id];
    const { state: s, checked } = specState(entry, cands);
    journeys.push({
      journeyId: j.id,
      name: j.name,
      area: j.area,
      repos,
      state: s,
      checked,
      ...(entry ? { checkedAt: entry.checkedAt } : {}),
      links: entry?.links ?? [],
      candidates: { docs: cands?.docs.length ?? 0, tickets: cands?.tickets.length ?? 0 },
    });
    countInto(all, s, checked);
    for (const r of repos) if (byRepo[r]) countInto(byRepo[r], s, checked);
    countInto((byArea[j.area] ??= zero()), s, checked);
  }
  const known = new Set(state.journeys.map((j) => j.id));
  const olderJourneys = Object.keys(specs.journeys)
    .filter((id) => !known.has(id))
    .sort(compare)
    .map((id) => ({ journeyId: id, checkedAt: specs.journeys[id]!.checkedAt, links: specs.journeys[id]!.links }));
  return {
    journeys,
    totals: { all, byRepo, byArea: Object.fromEntries(Object.entries(byArea).sort(([a], [b]) => compare(a, b))) },
    olderJourneys,
    candidatesIndexed: candidates !== null,
  };
}

// ---- registration ---------------------------------------------------------------------------------------

const journeyArg = z.string().min(1).describe("A journey id (j_…).");

export function registerSpecTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "match_specs",
    {
      title: "Match specs",
      description:
        "The candidate specs codeloom found for one journey (no AI): `docs` in the repos that mention the journey's " +
        "routes, pages, tables, queues or code symbols, each hit with the lines around it (`snippet`, ±3 lines), and " +
        "`tickets`: keys (like SHOP-12) in the commits that touched the journey's files, with those commits. Best " +
        "first. Also the journey's spec `state` (linked, candidates, none), whether it was `checked`, the links " +
        "already saved and the ticket pattern. Candidates are only hints: read them and the code before saving " +
        "any with save_spec_links. Read only.",
      inputSchema: { journey: journeyArg },
    },
    withErrors((args: { journey: string }) => matchSpecs(opts.start, args.journey)),
  );

  server.registerTool(
    "save_spec_links",
    {
      title: "Save spec links",
      description:
        "Save the specs that really describe a journey to .codeloom/specs.json (committed, shared with the team), " +
        "replacing that journey's saved links. `links`: [{kind: doc | ticket, ref, reason}]; a doc `ref` is " +
        '"<repo>:<path>" and the file must exist in that repo; a ticket `ref` is its key and must match the ' +
        "workspace ticket pattern. `reason` is one plain line on why it fits. `links: []` records that the journey " +
        "was checked and has no spec. Marks the journey checked.",
      inputSchema: { journey: journeyArg, links: LinksInputSchema },
    },
    withErrors((args: { journey: string; links: unknown }) => saveSpecLinksTool(opts.start, args.journey, args.links)),
  );

  server.registerTool(
    "list_specs",
    {
      title: "List specs",
      description:
        "Spec coverage of the journeys: per journey its state (linked = has a saved link; candidates = not checked " +
        "yet and codeloom found candidates; none = checked with no spec, or not checked and nothing found), " +
        "whether it was checked, its saved links and how many candidates wait; totals per repo and per area; and " +
        "saved links of journeys that no longer exist (`olderJourneys`). Filter by repo or area. Read only.",
      inputSchema: { repo: z.string().min(1).optional(), area: z.string().optional() },
    },
    withErrors((args: { repo?: string; area?: string }) => listSpecs(opts.start, args), "Filter by repo or area."),
  );
}
