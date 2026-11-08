import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { compare } from "../util.js";
import { readJson, writeJsonAtomic } from "./json.js";
import { CODELOOM_DIR } from "./paths.js";
import {
  compileTicketPattern,
  DEFAULT_IGNORE_PREFIXES,
  DEFAULT_TICKET_PATTERN,
  type JourneySpecCandidates,
  readSpecsConfig,
  type TicketRules,
} from "./spec-candidates.js";
import { JOURNEY_ID_RE, sortKeysDeep, type StoreWorkspace } from "./tours.js";

// v0.3 spec §2: the spec links Claude confirmed per journey. Committed, team-shared, written only by the
// save_spec_links MCP tool (the dashboard only reads it).

export const SPECS_FILE = "specs.json";

export const SPEC_LIMITS = { links: 50, reason: 500, ref: 1000 } as const;

export const SpecLinkKindSchema = z.enum(["doc", "ticket"]);
export type SpecLinkKind = z.infer<typeof SpecLinkKindSchema>;

/** What the agent sends: `ref` is `repo:path` for a doc, the ticket key for a ticket. */
export const SpecLinkInputSchema = z.object({
  kind: SpecLinkKindSchema,
  ref: z.string().min(1).max(SPEC_LIMITS.ref),
  reason: z.string().trim().min(1).max(SPEC_LIMITS.reason),
});
export type SpecLinkInput = z.infer<typeof SpecLinkInputSchema>;

export const SpecLinkSchema = SpecLinkInputSchema.extend({ savedAt: z.iso.datetime() });
export type SpecLink = z.infer<typeof SpecLinkSchema>;

/** A journey with `checkedAt` and no links is "confirmed: no spec". */
export const JourneySpecsSchema = z.object({
  links: z.array(SpecLinkSchema).max(SPEC_LIMITS.links),
  checkedAt: z.iso.datetime(),
});
export type JourneySpecs = z.infer<typeof JourneySpecsSchema>;

export const SpecsFileSchema = z.object({
  version: z.literal(1),
  journeys: z.record(z.string().regex(JOURNEY_ID_RE), JourneySpecsSchema),
});
export type SpecsFile = z.infer<typeof SpecsFileSchema>;

export const LinksInputSchema = z.array(SpecLinkInputSchema).max(SPEC_LIMITS.links);

export function specsPath(root: string): string {
  return join(root, CODELOOM_DIR, SPECS_FILE);
}

/** Missing → no entries. Bad JSON or shape → CodeloomError (exit 2; fix by hand: it holds agent work). */
export function readSpecs(root: string): SpecsFile {
  return readJson(specsPath(root), SpecsFileSchema, { handWritten: true }) ?? { version: 1, journeys: {} };
}

// ---- spec state ------------------------------------------------------------------------------------

/** linked: ≥ 1 link. candidates: not checked, has candidates. none: checked with no links, or not checked
 * and no candidates. `checked` tells "confirmed none" from "not checked". */
export type SpecState = "linked" | "candidates" | "none";

export function specState(entry: JourneySpecs | undefined, candidates: JourneySpecCandidates | undefined): { state: SpecState; checked: boolean } {
  const checked = entry !== undefined;
  if (entry && entry.links.length > 0) return { state: "linked", checked };
  if (!checked && candidates && candidates.docs.length + candidates.tickets.length > 0) return { state: "candidates", checked };
  return { state: "none", checked };
}

// ---- validation ------------------------------------------------------------------------------------

/** Why a ticket key is not acceptable (undefined when it is): it must match the workspace ticket pattern as
 * a whole and must not start with an ignored prefix (CVE-…, RFC-…). Missing rules take the defaults. */
export function ticketKeyProblem(key: string, rules: Partial<TicketRules>): string | undefined {
  const pattern = rules.ticketPattern ?? DEFAULT_TICKET_PATTERN;
  const re = compileTicketPattern(pattern);
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const whole = [...key.matchAll(global)].some((m) => m.index === 0 && m[0] === key);
  if (!whole) return `"${key}" does not match the ticket pattern /${pattern}/ (specs.ticketPattern).`;
  const prefix = /^[A-Za-z0-9]+/.exec(key)?.[0];
  const ignored = rules.ignorePrefixes ?? DEFAULT_IGNORE_PREFIXES;
  if (prefix !== undefined && ignored.includes(prefix)) return `"${key}" starts with ${prefix}, which is ignored (specs.ignorePrefixes): it is not a ticket.`;
  return undefined;
}

/** A doc ref `repo:path` → its normalised form, or a problem. The file must exist in that workspace repo,
 * stay inside it, and not be under .codeloom. */
function checkDocRef(ws: Pick<StoreWorkspace, "repos">, ref: string): { ref: string } | { problem: string } {
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) return { problem: `"${ref}" is not a doc ref: use "<repo>:<path>", e.g. "shop-api:docs/customers.md".` };
  const id = ref.slice(0, at);
  const repo = ws.repos.find((r) => r.ref.id === id);
  if (!repo) return { problem: `Unknown repo "${id}" in "${ref}". Repos in this workspace: ${ws.repos.map((r) => r.ref.id).join(", ")}.` };
  const file = posix.normalize(ref.slice(at + 1).split("\\").join("/"));
  const abs = resolve(repo.abs, file);
  const rel = relative(repo.abs, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { problem: `"${ref}" is outside repo "${id}".` };
  if (file.split("/").includes(CODELOOM_DIR)) return { problem: `"${ref}" is codeloom's own data, not a spec.` };
  if (!existsSync(abs) || !statSync(abs).isFile()) return { problem: `"${ref}" does not exist (no file ${file} in repo "${id}").` };
  return { ref: `${id}:${file}` };
}

export interface SaveSpecLinksOptions {
  /** Defaults to now. */
  now?: Date;
  /** Ticket rules; default: the workspace file's `specs` block. */
  config?: Partial<TicketRules>;
}

/** Replace a journey's entry in specs.json: validate every link (doc refs exist in the repo, ticket keys
 * match the pattern, no duplicates), sort them by kind then ref, keep `savedAt` of a link saved before with
 * the same kind, ref and reason, stamp the rest and `checkedAt` with now. `[]` = confirmed none. Other
 * journeys' entries are kept. Checking the journey exists is the caller's job. Throws CodeloomError
 * (exit 2) and writes nothing on any problem. */
export function saveSpecLinks(
  ws: Pick<StoreWorkspace, "root" | "repos">,
  journeyId: string,
  links: readonly SpecLinkInput[],
  opts: SaveSpecLinksOptions = {},
): JourneySpecs {
  if (!JOURNEY_ID_RE.test(journeyId)) throw dataError(`Bad journey id "${journeyId}": expected j_ and 12 hex characters.`);
  const parsed = LinksInputSchema.safeParse(links);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - links.${i.path.join(".")}: ${i.message}`);
    throw dataError(`The spec links for ${journeyId} are not valid:\n${lines.join("\n")}`);
  }
  const rules = opts.config ?? readSpecsConfig(ws.root);
  const problems: string[] = [];
  const seen = new Set<string>();
  const clean: SpecLinkInput[] = [];
  parsed.data.forEach((l, i) => {
    let ref = l.ref.trim();
    if (l.kind === "doc") {
      const r = checkDocRef(ws, ref);
      if ("problem" in r) return problems.push(`links.${i}: ${r.problem}`);
      ref = r.ref;
    } else {
      const p = ticketKeyProblem(ref, rules);
      if (p) return problems.push(`links.${i}: ${p}`);
    }
    const id = `${l.kind}\0${ref}`;
    if (seen.has(id)) return problems.push(`links.${i}: ${l.kind} "${ref}" is listed twice.`);
    seen.add(id);
    clean.push({ kind: l.kind, ref, reason: l.reason });
  });
  if (problems.length > 0) throw dataError(`The spec links for ${journeyId} were not saved:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  const file = readSpecs(ws.root); // a broken file throws here, before anything is written
  const now = (opts.now ?? new Date()).toISOString();
  const before = new Map((file.journeys[journeyId]?.links ?? []).map((l) => [`${l.kind}\0${l.ref}\0${l.reason}`, l.savedAt]));
  const entry: JourneySpecs = {
    links: clean
      .map((l) => ({ ...l, savedAt: before.get(`${l.kind}\0${l.ref}\0${l.reason}`) ?? now }))
      .sort((a, b) => compare(a.kind, b.kind) || compare(a.ref, b.ref)),
    checkedAt: now,
  };
  file.journeys[journeyId] = entry;
  writeJsonAtomic(specsPath(ws.root), sortKeysDeep(file));
  return entry;
}
