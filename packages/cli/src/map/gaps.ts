import { createHash } from "node:crypto";
import { basename } from "node:path";
import { absoluteHost } from "../adapters/ast.js";
import { uncalledRoutes } from "../check/report.js";
import { callBase, callPathWithClient, pairQueues, unplacedProxies } from "../linker/link.js";
import { effectiveRoutes, type EffectiveRoute, routeCandidate } from "../linker/mounts.js";
import { pickRoute, type RouteCandidate } from "../linker/paths.js";
import { journeysByChain, loadMapState, type MapState } from "../mcp/state.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { Chain, HttpCall, HttpClient, QueueOp, UnresolvedBase } from "../store/schemas.js";
import { compare } from "../util.js";
import { readRegistry } from "../workspace/registry.js";
import { packageName } from "../workspace/repos.js";
import { isInternalHost, matchBase, type NamedRepo } from "../linker/hints.js";
import { type AloneInfo, aloneInGroup } from "./alone.js";
import { type Answer, type AnswerKind, applyAnswers, type LinkConfig, readAnswers, withAnsweredQueues } from "./answers.js";

// 0.6 spec §5: what codeloom could not settle about the map, as short questions for the user (through Claude:
// the map-interview prompt). Only facts already in the map are used: the saved endpoints, chains.json and
// journeys.json. Nothing is guessed: each gap says what is missing and which answers would close it.

export const MAX_GAPS = 40;
export const MAX_GAPS_CHARS = 12_000;
const MAX_EVIDENCE = 2;
const MAX_SUGGEST = 3;
const MAX_LINE = 120;

export type GapKind =
  | "repo-alone"
  | "unconnected-repo"
  | "unknown-base"
  | "unplaced-proxy"
  | "ambiguous-match"
  | "call-no-route"
  | "queue-no-consumer"
  | "queue-no-publisher"
  | "queue-unknown"
  | "route-no-caller"
  | "unclear-role";

/** Order among gaps that affect as many journeys and chains: whole repos first, single routes last. */
const KIND_ORDER: GapKind[] = [
  "repo-alone", "unconnected-repo", "unknown-base", "unplaced-proxy", "ambiguous-match", "call-no-route", "queue-no-consumer", "queue-no-publisher",
  "queue-unknown", "route-no-caller", "unclear-role",
];

export interface Gap {
  /** `g_` + 12 hex: stable while the thing it is about exists (kind + what it is about). */
  id: string;
  kind: GapKind;
  /** Named journeys and chains it touches (what it is ranked by); left out when 0. */
  journeys?: number;
  chains?: number;
  question: string;
  /** Where it is in the code: "<repo> <file>:<line> <symbol>: …" (at most 2 lines; `more` counts the rest). */
  evidence: string[];
  more?: number;
  /** The answer kinds that would close it, "|"-joined (shapes in `answerShapes`). */
  close: string;
  /** Answers proposed from the evidence, ready for save_map_answers (JSON, at most 3). Only a proposal: ask. */
  suggest?: string[];
  /** Other gaps about the same repo or thing: one answer may close them all. */
  related?: string[];
}

export interface MapGapsResult {
  /** Every open gap (answered-as-expected ones are left out). */
  open: number;
  shown: number;
  gaps: Gap[];
  answerShapes: Record<AnswerKind, string>;
  /** Present when gaps were left out to stay within 40 items / 12,000 characters. */
  next?: string;
}

export const ANSWER_SHAPES: Record<AnswerKind, string> = {
  env: '{kind:"env",name,repo,from}: from\'s calls through base name go to repo',
  external: '{kind:"external",base,name?,from}: to another service',
  proxy: '{kind:"proxy",repo,from:"/prefix",to,stripPrefix?}',
  link: '{kind:"link",from:"<repo>:<file>#<symbol>",to:"route:<repo>:<METHOD> <path>"|"queue:<repo>:<queue>"|"<repo>:<file>#<symbol>"}',
  role: '{kind:"role",repo,role:"ui"|"api"|"worker"|"lib"}',
  "ignore-repo": '{kind:"ignore-repo",repo}: not part of this system',
  "queue-alias": '{kind:"queue-alias",publish,consume}',
  "ignore-gap": '{kind:"ignore-gap",gap:"g_…"}: expected',
  "join-group": '{kind:"join-group",repo,group}: send alone',
  "queue-name": '{kind:"queue-name",repo,at:"<file>:<line>",queue?,exchange?,routingKey?}',
};

/** A gap while it is being built: the repos it is about and its chains, for ranking and `related`. */
interface Draft {
  kind: GapKind;
  key: string;
  question: string;
  evidence: string[];
  close: AnswerKind[];
  suggest: Answer[];
  repos: Set<string>;
  chains: Set<string>;
}

export const gapId = (kind: GapKind, key: string): string =>
  `g_${createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 12)}`;

const cut = (s: string, n = MAX_LINE) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- words: matching a name to a repo without guessing a link ------------------------------------------------

const STOP = new Set([
  "api", "app", "apps", "url", "uri", "base", "host", "next", "public", "vite", "react", "env", "service", "server",
  "svc", "http", "https", "www", "com", "net", "org", "dev", "prod", "staging", "internal", "local", "localhost",
  "the", "get", "set", "load", "fetch", "create", "update", "delete", "remove", "list", "use", "handle", "handler",
  "data", "new", "all", "index", "main", "src", "lib", "path", "client", "endpoint", "queue", "exchange", "event",
]);

/** Lower-case words of a name (camelCase, snake_case, kebab, dots, slashes), plural "s" dropped, short and
 * generic words left out. */
export function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
    const w = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/** Each repo's own words: those of its id that not every repo has (a shared "demo-" or company prefix says nothing). */
function repoWords(ids: string[]): Map<string, Set<string>> {
  const all = ids.map((id) => words(id));
  const common = ids.length > 1 ? [...all[0]!].filter((w) => all.every((s) => s.has(w))) : [];
  return new Map(ids.map((id, i) => [id, new Set([...all[i]!].filter((w) => !common.includes(w)))]));
}

/** The one repo whose words `name` shares, else undefined (none, or more than one: no proposal). */
function oneRepoNamedBy(name: string, repoW: Map<string, Set<string>>, except?: string): string | undefined {
  const w = words(name);
  const hits = [...repoW].filter(([id, rw]) => id !== except && shares(w, rw)).map(([id]) => id);
  return hits.length === 1 ? hits[0] : undefined;
}

// ---- call sites -----------------------------------------------------------------------------------------------

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/;

export { callBase };

/** A call in the map, with the base answers name it by. `template`: an HTTP wrapper's own inner call
 * (`fetch(`${BASE}${path}`)` inside `request(path)`): no call of its own — its callers are, each at its line. */
export interface MapCall { repo: RepoData; call: HttpCall; base?: ReturnType<typeof callBase>; template?: true }

const callSiteKey = (repo: string, c: { file: string; line: number; method: string; path: string }) =>
  `${repo}\0${c.file}\0${c.line}\0${c.method}\0${c.path}`;

/** What mapCalls reads from the saved link besides the repos. */
export type MapCallsLink = Pick<MapState, "unresolvedBases" | "wrapperCalls" | "chains">;

/** Every HTTP call in the map: each repo's own (endpoints.json), plus the calls the linker found that endpoints.json
 * does not hold — those made through a repo's own wrapper functions, recorded at the caller — when the linker
 * could not place their base (chains.json `unresolvedBases`, 0.6 §2–§3). A call's base: the unresolved base the
 * linker listed it under, else its own (callBase); a backend's relative URL (a call the linker walked to from a
 * handler: a code-lane call stop) is named by its client (`axios`) whether or not it is placed yet, so an answer
 * about it stays valid once it took effect. */
export function mapCalls(repos: RepoData[], link: MapCallsLink): MapCall[] {
  const listed = new Map<string, UnresolvedBase>();
  for (const ub of link.unresolvedBases) for (const c of ub.calls) listed.set(callSiteKey(c.repo, c), ub);
  const wrappers = new Set(link.wrapperCalls.map((w) => `${w.repo}\0${w.wrapper.replace("#", "\0")}`));
  const serviceSites = new Set(link.chains.flatMap((c) => c.stops
    .filter((s) => s.kind === "call" && s.lane === "code").map((s) => `${s.repo}\0${s.file}\0${s.line}`)));
  const byId = new Map(repos.map((r) => [r.ref.id, r]));
  const own = new Set<string>();
  const out: MapCall[] = [];
  for (const repo of repos) {
    const clients = repo.endpoints.httpClients;
    for (const call of repo.endpoints.httpCalls) {
      const k = callSiteKey(repo.ref.id, { ...call.at, method: call.method, path: call.path });
      own.add(k);
      const ub = listed.get(k);
      const service = serviceSites.has(`${repo.ref.id}\0${call.at.file}\0${call.at.line}`);
      const base = ub ? { base: ub.base, kind: ub.kind } : callBase(call, clients, { relative: service });
      const template = wrappers.has(`${repo.ref.id}\0${call.at.file}\0${call.at.symbol}`);
      out.push({ repo, call, ...(base ? { base } : {}), ...(template ? { template: true as const } : {}) });
    }
  }
  // Calls through a wrapper, at the caller's line, with the base the wrapper (or the caller) gives them.
  for (const w of link.wrapperCalls) {
    const repo = byId.get(w.repo);
    if (!repo) continue;
    const k = callSiteKey(w.repo, { ...w.call.at, method: w.call.method, path: w.call.path });
    if (own.has(k)) continue;
    own.add(k);
    const ub = listed.get(k);
    const service = serviceSites.has(`${w.repo}\0${w.call.at.file}\0${w.call.at.line}`);
    const base = ub ? { base: ub.base, kind: ub.kind } : callBase(w.call, repo.endpoints.httpClients, { relative: service });
    out.push({ repo, call: w.call, ...(base ? { base } : {}) });
  }
  for (const [k, ub] of listed) {
    if (own.has(k)) continue;
    const c = ub.calls.find((x) => callSiteKey(x.repo, x) === k)!;
    const repo = byId.get(c.repo);
    if (!repo) continue;
    // Through a wrapper: the call as the linker derived it, at the caller's line.
    const call: HttpCall = {
      method: c.method, path: c.path, raw: c.path, resolved: true, client: "", kind: c.path === "" ? "unknown" : "literal",
      at: { file: c.file, line: c.line, symbol: c.symbol },
    };
    out.push({ repo, call, base: { base: ub.base, kind: ub.kind } });
  }
  return out;
}

/** Bases the workspace file places for every caller (a repo's apiBase, an external service). */
function fileBases(cfg: LinkConfig): Set<string> {
  const out = new Set<string>();
  const add = (entry: string) => {
    out.add(entry.trim());
    const host = absoluteHost(entry);
    if (host !== undefined) out.add(host);
  };
  for (const r of cfg.repos) for (const b of r.apiBase ?? []) add(b);
  for (const e of cfg.external ?? []) for (const b of e.apiBase) add(b);
  return out;
}

const inSet = (base: string, known: Set<string>) =>
  known.has(base) || known.has(base.replace(/:\d+$/, "")) || known.has(base.toLowerCase());

type Site = { repo: string; file: string; line: number };
const siteKey = (s: Site) => `${s.repo}\0${s.file}\0${s.line}`;

/** What became of a call, from chains.json: the routes it reached (repo, confidence, reason). */
interface Routed {
  repos: Set<string>; guess: boolean; tie: boolean; outside: boolean;
  /** The routes it reached, as link refs ("route:<repo>:<METHOD> <path>"). */
  routes: Set<string>;
}

function routedCalls(chains: Chain[]): Map<string, Routed> {
  const out = new Map<string, Routed>();
  for (const c of chains) {
    if (c.routeKey === "") continue;
    c.stops.forEach((s, i) => {
      if (s.kind !== "route" || i === 0) return;
      const call = c.stops[s.from ?? i - 1];
      if (call?.kind !== "call") return;
      const k = siteKey(call);
      const r = out.get(k) ?? { repos: new Set<string>(), guess: false, tie: false, outside: false, routes: new Set<string>() };
      r.repos.add(s.repo);
      if (s.label) r.routes.add(`route:${s.repo}:${s.label}`);
      if (s.hop.confidence === "guess") r.guess = true;
      if (s.hop.reason?.startsWith("tie between")) r.tie = true;
      if (s.hop.reason === "matched outside the hinted backends") r.outside = true;
      out.set(k, r);
    });
  }
  return out;
}

/** Chains holding a call stop or an unresolved entry at each call site. */
function chainsBySite(chains: Chain[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (s: Site, id: string) => out.set(siteKey(s), (out.get(siteKey(s)) ?? new Set()).add(id));
  for (const c of chains) {
    for (const s of c.stops) if (s.kind === "call") add(s, c.id);
    for (const u of c.unresolved) add(u.at, c.id);
  }
  return out;
}

/** The repos (other than the caller's) with a route the call's path matches, with that route's link ref. */
function servingRoutes(call: HttpCall, clients: HttpClient[], repos: RepoData[], routes: Map<string, EffectiveRoute[]>, except: string): Array<{ repo: string; ref: string }> {
  if (call.kind === "unknown") return [];
  const path = callPathWithClient(call, clients);
  return repos.filter((r) => r.ref.id !== except).flatMap((r) => {
    const picked = pickRoute(call.method, path, (routes.get(r.ref.id) ?? [])
      .map(routeCandidate));
    return picked ? [{ repo: r.ref.id, ref: `route:${r.ref.id}:${picked.item.route.method} ${picked.item.effectivePath}` }] : [];
  });
}

const callLabel = (call: HttpCall) => (call.kind === "unknown" ? `URL not readable (${cut(call.raw, 40)})` : `${call.method} ${call.path}`);
const at = (repo: string, a: { file: string; line: number; symbol: string }) => `${repo} ${a.file}:${a.line} ${a.symbol}`;
/** A base as shown: long expressions are cut for reading only; keys, answers and matching use the full text. */
const show = (base: string) => cut(base, 60);

// ---- the gaps -------------------------------------------------------------------------------------------------

export interface GapsInput {
  state: MapState;
  cfg: LinkConfig;
}

/** Every open gap, ranked (journeys, then chains affected), answered-as-expected ones left out. */
export function computeGaps(input: GapsInput): Gap[] {
  const { state, cfg } = input;
  const refs = new Map(cfg.repos.map((r) => [r.id, r]));
  const repos = state.ws.repos.filter((r) => !cfg.ignored.has(r.ref.id)).map((r) => ({
    ...r, ref: refs.get(r.ref.id) ?? r.ref, endpoints: withAnsweredQueues(r.endpoints, r.ref.id, cfg.queueNames),
  }));
  const ids = repos.map((r) => r.ref.id);
  const repoW = repoWords(ids);
  const routes = new Map(repos.map((r) => [r.ref.id, effectiveRoutes(r.endpoints)]));
  const chains = state.chains.filter((c) => !c.stops.some((s) => cfg.ignored.has(s.repo)));
  const routed = routedCalls(chains);
  const bySite = chainsBySite(chains);
  const externalSites = new Set(state.external.map((f) => siteKey(f)));
  const fromFile = fileBases(cfg);
  const drafts: Draft[] = [];
  const chainsAt = (s: Site) => bySite.get(siteKey(s)) ?? new Set<string>();

  // -- calls: grouped by (calling repo, base), else one gap per call that matched nothing (or guessed a tie) -------
  type CallInfo = { repo: RepoData; call: HttpCall; base?: ReturnType<typeof callBase>; status: "ok" | "guess" | "external" | "none"; r?: Routed };
  const unresolvedSites = new Set(state.unresolvedBases.flatMap((ub) => ub.calls.map((c) => siteKey(c))));
  // A proxy route's own forwarding call is the proxy: asked about as the route (an unplaced-proxy gap), never alone.
  const forwarding = new Set(repos.flatMap((r) => r.endpoints.routes.flatMap((rt) => (rt.forwards ? [siteKey({ repo: r.ref.id, ...rt.forwards.at })] : []))));
  const calls: CallInfo[] = mapCalls(repos, state).filter((c) => !c.template && !forwarding.has(siteKey({ repo: c.repo.ref.id, ...c.call.at }))).map(({ repo, call, base }): CallInfo => {
    const site = { repo: repo.ref.id, file: call.at.file, line: call.at.line };
    const r = routed.get(siteKey(site));
    const status = r ? (r.guess ? "guess" : "ok") : externalSites.has(siteKey(site)) ? "external" : "none";
    return { repo, call, ...(base ? { base } : {}), status, ...(r ? { r } : {}) };
  });
  /** The answer placing `base` for `caller`, if any (one for that repo first). */
  const hintOf = (caller: string, base: string) =>
    cfg.baseHints.find((h) => h.from === caller && h.base === base) ?? cfg.baseHints.find((h) => h.from === undefined && h.base === base);
  const isQuestion = (b: NonNullable<CallInfo["base"]>, site?: Site) => {
    // A base the linker itself could not place (unknown, ambiguous, a public host naming a repo) is a question.
    if (site !== undefined && unresolvedSites.has(siteKey(site))) return true;
    if (b.kind !== "host") return true;
    if (LOOPBACK.test(b.base)) return false;
    // A public host (api.stripe.com) is another company's service; a bare service name (billing:4000) or one
    // naming a repo here is a question.
    return !b.base.replace(/:\d+$/, "").includes(".") || oneRepoNamedBy(b.base, repoW) !== undefined;
  };
  const byBase = new Map<string, CallInfo[]>();
  for (const c of calls) {
    if (!c.base || (!isQuestion(c.base, { repo: c.repo.ref.id, ...c.call.at }) && !hintOf(c.repo.ref.id, c.base.base))) continue;
    const k = `${c.repo.ref.id}\0${c.base.base}`;
    byBase.set(k, [...(byBase.get(k) ?? []), c]);
  }
  const callersOf = new Map<string, Set<string>>();
  for (const k of byBase.keys()) {
    const [caller, base] = k.split("\0") as [string, string];
    callersOf.set(base, (callersOf.get(base) ?? new Set()).add(caller));
  }
  // A backend's calls (a non-UI repo's, or any call a handler walk reaches) go to services: a proposal for them
  // never names a UI repo (its API or proxy routes serve its own pages, not other services).
  const uiRepos = new Set(repos.filter((r) => {
    const role = cfg.roles.get(r.ref.id) ?? r.ref.role;
    return role === "ui" || (r.endpoints.pages.length > 0 && role !== "api");
  }).map((r) => r.ref.id));
  const serviceSiteSet = new Set(chains.flatMap((ch) => ch.stops.filter((st) => st.kind === "call" && st.lane === "code").map((st) => siteKey(st))));
  // The repo the linker's own hint sends a base to (its name names exactly one repo with routes: 0.6 §2).
  const named: NamedRepo[] = repos.filter((r) => r.endpoints.routes.length > 0).map((r) => ({
    id: r.ref.id, names: [r.ref.id, basename(r.abs), packageName(r.abs)].filter((n): n is string => !!n),
  }));
  const hintedRepo = (b: NonNullable<CallInfo["base"]>): string | undefined => {
    if (b.kind === "expr" || b.kind === "relative" || (b.kind === "host" && !isInternalHost(b.base))) return undefined;
    const m = matchBase({ kind: b.kind, text: b.base }, named);
    return m.kind === "one" ? m.repo : undefined;
  };
  const inBaseGap = new Set<CallInfo>();
  for (const [k, list] of byBase) {
    const [caller, base] = k.split("\0") as [string, string];
    const answered = hintOf(caller, base);
    const byName = answered === undefined && !inSet(base, fromFile) && list[0]?.base ? hintedRepo(list[0].base) : undefined;
    // Placed by the user's answer, the workspace file, or the linker's own hint from the base's name.
    const hint = answered ?? (byName !== undefined && byName !== caller ? { base, repo: byName } : undefined);
    const placed = hint !== undefined || inSet(base, fromFile);
    // Placed by an answer or the workspace file: a question only when its calls still land nowhere there (a
    // wrong answer shows as calls "matched outside the hinted backends", or matching nothing).
    // Placed by the hint alone: a call whose URL cannot be read is asked about as that call, not as the base.
    const unsettled = list.filter((c) => (placed ? (c.status === "none" || c.r?.outside === true) && !(answered === undefined && c.call.kind === "unknown") : c.status !== "ok"));
    if (unsettled.length === 0) continue;
    for (const c of list) if (!(placed && answered === undefined && c.call.kind === "unknown")) inBaseGap.add(c);
    const chainIds = new Set(unsettled.flatMap((c) => [...chainsAt({ repo: caller, ...c.call.at })]));
    const ties = new Set<string>();
    const evidence = unsettled.map((c) => {
      let what: string;
      const serving = c.status === "ok" || c.status === "external" ? [] : servingRoutes(c.call, c.repo.endpoints.httpClients, repos, routes, caller).map((x) => x.repo);
      if (c.status === "guess") {
        for (const s of serving) ties.add(s);
        what = c.r?.tie && serving.length > 1 ? `tie ${serving.join("|")} (guessed ${[...c.r.repos].join(", ")})` : `guessed ${[...(c.r?.repos ?? [])].join(", ")}`;
      } else if (c.status === "none" && new Set(serving).size > 1) {
        // Two repos serve it equally well: no link is guessed (0.6), the answer says which.
        for (const s of serving) ties.add(s);
        what = `tie ${serving.join("|")} (no link)`;
      } else what = c.status === "external" ? "treated as another service" : "no route matches";
      return cut(`${at(caller, c.call.at)}: ${callLabel(c.call)} → ${what}`);
    });
    // The calls through it that already matched, with where: an answer moves them too.
    for (const c of list) {
      if (unsettled.includes(c) || !c.r) continue;
      evidence.push(cut(`${at(caller, c.call.at)}: ${callLabel(c.call)} → matched ${[...c.r.repos].join(", ")}`));
    }
    const name = show(base);
    const shared = (callersOf.get(base)?.size ?? 1) > 1;
    const relative = list.some((c) => c.base?.kind === "relative");
    const whose = relative ? `${caller}'s relative URLs through ${name}` : shared ? `${caller}'s ${name}` : name;
    const backend = relative || !uiRepos.has(caller) || list.some((c) => serviceSiteSet.has(siteKey({ repo: caller, ...c.call.at })));
    const allowed = (id: string) => !backend || !uiRepos.has(id);
    for (const t of [...ties]) if (!allowed(t)) ties.delete(t);
    // A proposal only from evidence: the one other repo the base's name names, else the one repo every call
    // through it that did match went to. Always for this caller only.
    // Where its matched calls already go, by repo: with some, a repo is proposed only when it serves a clear
    // majority of them (≥ 70%) — never by its name or one path against that evidence; else the split is shown.
    const matchedBy = new Map<string, number>();
    for (const c of list) if (c.status === "ok") for (const r of c.r?.repos ?? []) matchedBy.set(r, (matchedBy.get(r) ?? 0) + 1);
    const matchedTotal = [...matchedBy.values()].reduce((a, b) => a + b, 0);
    const byCount = [...matchedBy.entries()].sort(([a, x], [b, y]) => y - x || compare(a, b));
    if (byCount.length > 1) evidence.splice(1, 0, cut(`matched: ${byCount.map(([r, n]) => `${r} ${n}`).join(", ")}`));
    let target: string | undefined;
    if (matchedTotal > 0) {
      const [top, n] = byCount[0]!;
      if (n / matchedTotal >= 0.7 && top !== caller && allowed(top)) target = top;
    } else target = oneRepoNamedBy(base, new Map([...repoW].filter(([id]) => id !== caller && allowed(id))));
    if (target === undefined && !placed && matchedTotal === 0) {
      // Else the one other repo serving every readable call through it (a proposal to ask about, never a link).
      const readable = unsettled.filter((c) => c.call.kind !== "unknown");
      const serving = readable.map((c) => new Set(servingRoutes(c.call, c.repo.endpoints.httpClients, repos, routes, caller).map((x) => x.repo).filter(allowed)));
      const all = serving.length > 0 ? [...serving[0]!].filter((id) => serving.every((x) => x.has(id))) : [];
      if (all.length === 1 && serving.every((x) => x.size === 1)) target = all[0];
    }
    if (placed && target === hint?.repo) target = undefined; // the answer given already: no use proposing it again
    const maybe = target !== undefined ? ` (${target}?)` : ties.size > 0 ? ` (${[...ties].sort(compare).join(" or ")}?)` : "";
    const question = placed
      ? `${plural(unsettled.length, "call")} through ${whose} ${unsettled.length === 1 ? "matches" : "match"} no route ${hint?.repo !== undefined ? `in ${hint.repo}, where ${answered ? "your answer" : "its name"} sends them` : "where the workspace file sends them"}. Where do they go${maybe}?`
      : relative
        ? `Where do ${caller}'s relative URLs through ${name} go (their base is set outside the code): one of your repos${maybe}, or another service?`
        : `Where does ${whose} point: one of your repos${maybe}, or another service?`;
    // Placed calls that match nothing where the answer sends them can still go to the route they matched: a link
    // for each such call (the one route it reached outside the answered repo).
    const links: Answer[] = placed
      ? unsettled.flatMap((c) => (c.r?.outside && c.r.routes.size === 1 && allowed([...c.r.routes][0]!.split(":")[1]!)
        ? [{ kind: "link" as const, from: `${caller}:${c.call.at.file}#${c.call.at.symbol}`, to: [...c.r.routes][0]! }] : []))
      : [];
    drafts.push({
      kind: "unknown-base", key: `${caller}:${base}`, question, evidence,
      close: placed ? ["env", "link", "external", "ignore-gap"] : ["env", "external", "ignore-gap"],
      suggest: [...(target !== undefined ? [{ kind: "env" as const, name: base, repo: target, from: caller }] : []), ...links],
      repos: ties.size > 0 || target !== undefined ? new Set([...ties, ...(target ? [target] : [])]) : new Set([caller]), chains: chainIds,
    });
  }

  const uncalled = uncalledRoutes(repos, chains);
  // No proposal for a call codeloom cannot read: a link is proposed only from a real path match (method + path
  // against the route), never from name words (billingRequest ~ /billing/…); Claude reads the snippet and asks.

  // No line number in a call's key: an edit above the call keeps its id (and an ignore-gap answer for it). Two
  // calls alike in one function (same method and path) are told apart by their order in it.
  const seenInFunction = new Map<string, number>();
  const callKey = (c: CallInfo) => {
    const base = `${c.repo.ref.id}:${c.call.at.file}:${c.call.at.symbol}:${c.call.method}:${c.call.path}`;
    const n = seenInFunction.get(base) ?? 0;
    seenInFunction.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  };
  const keys = new Map([...calls].sort((a, b) => compare(a.repo.ref.id, b.repo.ref.id) || compare(a.call.at.file, b.call.at.file) || a.call.at.line - b.call.at.line)
    .map((c) => [c, callKey(c)] as const));
  for (const c of calls) {
    if (inBaseGap.has(c)) continue;
    const id = c.repo.ref.id;
    const site = { repo: id, ...c.call.at };
    const key = keys.get(c)!;
    // A call to a public host (api.stripe.com) is another company's service: nothing to settle.
    if (c.base?.kind === "host" && !LOOPBACK.test(c.base.base) && !isQuestion(c.base)) continue;
    // Two repos serve the call equally well: codeloom links neither (0.6), the user says which.
    const tiedRepos = c.status === "none" && c.call.kind !== "unknown"
      ? servingRoutes(c.call, c.repo.endpoints.httpClients, repos, routes, id) : [];
    if (new Set(tiedRepos.map((x) => x.repo)).size > 1) {
      const from = `${id}:${c.call.at.file}#${c.call.at.symbol}`;
      drafts.push({
        kind: "ambiguous-match", key,
        question: `${id} calls ${c.call.method} ${c.call.path} (${c.call.at.symbol}), which ${tiedRepos.map((x) => x.repo).join(" and ")} both serve. Which one gets it?`,
        evidence: [
          cut(`${at(id, c.call.at)}: ${callLabel(c.call)} → tie, no link`),
          cut(`answer with a link from "${from}" to one of: ${tiedRepos.map((x) => x.ref).join(" | ")}`, 300),
        ],
        close: ["link", "ignore-gap"], suggest: [], repos: new Set(tiedRepos.map((x) => x.repo)), chains: chainsAt(site),
      });
    } else if (c.status === "none") {
      const pages = chains.filter((ch) => chainsAt(site).has(ch.id) && ch.entry.startsWith("page:")).map((ch) => ch.entry.split(":").slice(2).join(":"));
      const where = pages.length > 0 ? ` (${plural(pages.length, "page")}: ${[...new Set(pages)].sort(compare).slice(0, 3).join(", ")})` : "";
      drafts.push({
        kind: "call-no-route", key,
        question: c.call.kind === "unknown"
          ? `codeloom cannot read the URL ${c.call.at.symbol} calls (${id} ${c.call.at.file}:${c.call.at.line}). Which route does it call?`
          : `${id} calls ${c.call.method} ${c.call.path} (${c.call.at.file}:${c.call.at.line}) but no repo serves it. Who does: a repo behind a proxy, or another service?`,
        evidence: [cut(`${at(id, c.call.at)}: ${callLabel(c.call)}${where}`)],
        close: c.call.kind === "unknown" ? ["link", "ignore-gap"] : ["proxy", "link", "external", "ignore-gap"],
        suggest: [], repos: new Set([id]), chains: chainsAt(site),
      });
    } else if (c.status === "guess" && c.r?.tie) {
      const serving = servingRoutes(c.call, c.repo.endpoints.httpClients, repos, routes, id);
      if (new Set(serving.map((x) => x.repo)).size < 2) continue; // a tie inside one repo: not a question about repos
      const from = `${id}:${c.call.at.file}#${c.call.at.symbol}`;
      drafts.push({
        kind: "ambiguous-match", key,
        question: `${id} calls ${c.call.method} ${c.call.path} (${c.call.at.symbol}), which ${serving.map((x) => x.repo).join(" and ")} both serve. Which one gets it?`,
        evidence: [
          cut(`${at(id, c.call.at)}: ${callLabel(c.call)} → guessed ${[...c.r.repos].join(", ")}`),
          cut(`answer with a link from "${from}" to one of: ${serving.map((x) => x.ref).join(" | ")}`, 300),
        ],
        close: ["link", "ignore-gap"], suggest: [], repos: new Set(serving.map((x) => x.repo)), chains: chainsAt(site),
      });
    }
  }

  // -- a proxy route whose forwarding codeloom could not place: one gap per route prefix --------------------------
  for (const p of unplacedProxies({ repos, external: cfg.external ?? [], baseHints: cfg.baseHints })) {
    const proxyChains = new Set(chains.filter((c) => c.stops.some((s) => s.kind === "route" && s.repo === p.repo
      && p.routes.some((r) => r.at.file === s.file && r.at.line === s.line))).map((c) => c.id));
    const fw = p.forwards;
    const why = {
      "no-base": "codeloom cannot read its base",
      ambiguous: `its base ${show(fw.base ?? "")} could be ${(p.candidates ?? []).join(" or ")}`,
      unknown: `its base ${show(fw.base ?? "")} names no repo here`,
      path: "codeloom cannot read the path it forwards to",
    }[p.reason];
    // A proposal only from evidence: the repos the base could be, else the one repo the prefix's own words name.
    const named = p.candidates ?? [oneRepoNamedBy(p.from, repoW, p.repo)].filter((id): id is string => id !== undefined);
    drafts.push({
      kind: "unplaced-proxy", key: `${p.repo}:${p.from}`,
      question: `Where does ${p.repo}'s ${p.from}/* proxy route forward (${why})? Which repo serves those calls${named.length > 0 ? ` (${named.join(" or ")}?)` : ""}, or another service?`,
      evidence: [
        cut(`${p.repo} ${p.routes[0]!.at.file}:${p.routes[0]!.at.line} ${p.routes.map((r) => r.method).join("|")} ${p.routes[0]!.path}`),
        cut(`forwards at ${fw.at.file}:${fw.at.line} ${fw.at.symbol}: ${fw.raw}`),
      ],
      close: ["proxy", "ignore-gap"],
      suggest: named.map((to) => ({ kind: "proxy" as const, repo: p.repo, from: p.from, to })),
      repos: new Set([p.repo, ...named]), chains: proxyChains,
    });
  }

  // -- routes nothing calls: one gap per repo --------------------------------------------------------------------
  const uncalledByRepo = new Map<string, EffectiveRoute[]>();
  for (const r of uncalled) uncalledByRepo.set(r.repo, [...(uncalledByRepo.get(r.repo) ?? []), r]);
  for (const [repo, list] of uncalledByRepo) {
    const routeChains = new Set(chains.filter((c) => c.stops.some((s) => s.kind === "route" && s.repo === repo
      && list.some((r) => r.route.at.file === s.file && r.route.at.line === s.line && r.route.method === s.op))).map((c) => c.id));
    const first = list[0]!;
    drafts.push({
      kind: "route-no-caller", key: repo,
      question: list.length === 1
        ? `Nothing in the map calls ${repo}'s ${first.route.method} ${first.effectivePath}. Which page or service calls it, or is it called from outside?`
        : `${plural(list.length, "route")} in ${repo} have no caller in the map (e.g. ${first.route.method} ${first.effectivePath}). Who calls them, or are they called from outside?`,
      evidence: list.map((r) => cut(`${repo} ${r.route.at.file}:${r.route.at.line} ${r.route.method} ${r.effectivePath} → ${r.route.handler}`)),
      close: ["link", "proxy", "ignore-gap"], suggest: [], repos: new Set([repo]), chains: routeChains,
    });
  }

  // -- queues: a publish no consumer receives, a consumer nothing publishes to --------------------------------------
  const wsData: WorkspaceData = { ...state.ws, repos, ...(cfg.queueAliases.length > 0 ? { queueAliases: cfg.queueAliases } : {}) };
  const pairs = pairQueues(wsData);
  const opSite = (repo: string, q: QueueOp) => `${repo}\0${q.at.file}\0${q.at.line}\0${q.op}\0${q.queue}`;
  const pairedPublish = new Set(pairs.map((p) => opSite(p.repoFrom, p.publish)));
  const pairedConsume = new Set(pairs.map((p) => opSite(p.repoTo, p.consume)));
  const orphanPub: Array<{ repo: string; q: QueueOp }> = [];
  const orphanCon: Array<{ repo: string; q: QueueOp }> = [];
  for (const r of repos) {
    for (const q of r.endpoints.queues) {
      if (q.op === "publish" && !pairedPublish.has(opSite(r.ref.id, q))) orphanPub.push({ repo: r.ref.id, q });
      if (q.op === "consume" && !pairedConsume.has(opSite(r.ref.id, q))) orphanCon.push({ repo: r.ref.id, q });
    }
  }
  const group = (list: typeof orphanPub) => {
    const m = new Map<string, typeof orphanPub>();
    for (const x of list) m.set(`${x.repo}\0${x.q.queue}`, [...(m.get(`${x.repo}\0${x.q.queue}`) ?? []), x]);
    return [...m.values()];
  };
  const queueWords = (q: QueueOp) => words(`${q.queue} ${q.routingKey ?? ""}`);
  /** The one orphan on the other side whose name shares a word with `q` (in another repo or not). */
  const partner = (q: QueueOp, others: typeof orphanPub) => {
    const names = [...new Set(others.filter((o) => shares(queueWords(q), queueWords(o.q))).map((o) => o.q.queue))];
    return names.length === 1 ? names[0] : undefined;
  };
  for (const list of group(orphanPub)) {
    const { repo, q } = list[0]!;
    const consume = partner(q, orphanCon);
    const pubChains = new Set(chains.filter((c) => c.stops.some((s) => s.kind === "publish" && s.repo === repo && list.some((x) => x.q.at.file === s.file && x.q.at.line === s.line))).map((c) => c.id));
    const via = q.exchange !== undefined ? ` (exchange ${q.exchange}, key ${q.routingKey ?? ""})` : "";
    drafts.push({
      kind: "queue-no-consumer", key: `${repo}:${q.queue}`,
      question: `${repo} publishes "${q.queue}"${via} but no repo here consumes it. Which queue receives it${consume ? ` ("${consume}"?)` : ""}, or is the consumer outside this system?`,
      evidence: [
        ...list.map((x) => cut(`${at(repo, x.q.at)}: publishes ${x.q.queue}${via}`)),
        ...(orphanCon.length > 0 ? [cut(`consumers nothing publishes to: ${[...new Set(orphanCon.map((o) => `${o.repo} ${o.q.queue}`))].join(", ")}`)] : []),
      ],
      close: ["queue-alias", "ignore-gap"],
      suggest: consume ? [{ kind: "queue-alias", publish: q.queue, consume }] : [],
      repos: new Set([repo, ...orphanCon.filter((o) => o.q.queue === consume).map((o) => o.repo)]), chains: pubChains,
    });
  }
  for (const list of group(orphanCon)) {
    const { repo, q } = list[0]!;
    const publish = partner(q, orphanPub);
    const conChains = new Set(chains.filter((c) => c.entry.startsWith(`consumer:${repo}:${q.queue}#`)).map((c) => c.id));
    drafts.push({
      kind: "queue-no-publisher", key: `${repo}:${q.queue}`,
      question: `${repo} consumes "${q.queue}" but nothing here publishes to it. Which publish feeds it${publish ? ` ("${publish}"?)` : ""}, or does it come from outside?`,
      evidence: list.map((x) => cut(`${at(repo, x.q.at)}: consumes ${x.q.queue}`)),
      close: ["queue-alias", "ignore-gap"],
      suggest: publish ? [{ kind: "queue-alias", publish, consume: q.queue }] : [],
      repos: new Set([repo, ...orphanPub.filter((o) => o.q.queue === publish).map((o) => o.repo)]), chains: conChains,
    });
  }

  // -- a publish / consume whose names codeloom could not read (a runtime value): one gap per place -------------------
  for (const r of repos) {
    const id = r.ref.id;
    for (const u of r.endpoints.queueUnknown ?? []) {
      const verb = u.op === "publish" ? "publishes" : "consumes";
      const missing = u.missing.map((m) => (m === "routingKey" ? "routing key" : m)).join(" and ");
      const known = [u.queue !== undefined ? `queue ${u.queue}` : "", u.exchange !== undefined ? `exchange ${u.exchange}` : "",
        u.routingKey !== undefined ? `key ${u.routingKey}` : ""].filter(Boolean).join(", ");
      const touching = new Set(chains.filter((c) => c.stops.some((s) => s.repo === id && s.file === u.at.file && s.symbol === u.at.symbol)).map((c) => c.id));
      drafts.push({
        kind: "queue-unknown", key: `${id}:${u.at.file}:${u.at.line}:${u.op}`,
        question: `${id} ${verb} with a ${missing} codeloom cannot read (a runtime value). Which ${u.missing.includes("queue") ? "queue" : "exchange and routing key"} is it, or is it expected?`,
        evidence: [cut(`${at(id, u.at)}: ${verb} ${known || "?"}; unknown: ${missing}${u.handler ? `; handler ${u.handler.symbol}` : ""}`)],
        close: ["queue-name", "ignore-gap"], suggest: [], repos: new Set([id]), chains: touching,
      });
    }
  }

  // -- a repo alone in its group (another remote owner than its system's): which group its calls match ------------
  if (state.ws.group !== undefined && repos.length === 1) {
    const only = repos[0]!;
    let alone: AloneInfo | null = null;
    try {
      alone = aloneInGroup(readRegistry(), state.ws.group, { id: only.ref.id, endpoints: only.endpoints });
    } catch {
      alone = null; // a registry that cannot be read: doctor reports it
    }
    if (alone) {
      const g = alone;
      drafts.push({
        kind: "repo-alone", key: `${g.repo}:${g.group}`,
        question: g.suggest
          ? `${g.repo} is the only repo in group ${g.group}, so its calls reach nothing; they go to ${g.suggest}'s repos. Join ${g.suggest}?`
          : `${g.repo} is the only repo in group ${g.group}, so its calls reach nothing. Does it belong with another group's repos?`,
        evidence: [
          `${g.repo}: ${plural(g.calls, "call")} match no route in ${g.group}`,
          ...g.matches.map((m) => `${m.group}: ${m.matched} of ${g.calls} calls match its repos${m.named ? ` (${m.named.slice(0, 2).join(", ")})` : ""}`),
        ],
        close: ["join-group", "ignore-gap"],
        suggest: g.suggest ? [{ kind: "join-group", repo: g.repo, group: g.suggest }] : [],
        repos: new Set([g.repo]), chains: new Set(chains.map((c) => c.id)),
      });
    }
  }

  // -- repos: not connected to the rest of the group, or with no clear role ---------------------------------------
  if (repos.length >= 2) {
    const connected = new Set<string>();
    for (const c of chains) {
      const rs = new Set(c.stops.map((s) => s.repo));
      if (rs.size > 1) for (const r of rs) connected.add(r);
    }
    const catchAll = repos.filter((r) => r.endpoints.pages.length > 0).flatMap((r) => (routes.get(r.ref.id) ?? [])
      .filter((er) => /\*/.test(er.effectivePath))
      .map((er) => ({ repo: r.ref.id, er, prefix: er.effectivePath.split("/").filter((seg) => seg !== "" && !seg.startsWith(":") && !seg.includes("*")).join("/") })));
    for (const r of repos) {
      const id = r.ref.id;
      const role = cfg.roles.get(id) ?? r.ref.role;
      if (connected.has(id) || role === "lib") continue;
      const nRoutes = routes.get(id)?.length ?? 0;
      const nQueues = r.endpoints.queues.filter((q) => q.op !== "bind").length;
      const nothing = r.endpoints.pages.length === 0 && nRoutes === 0 && nQueues === 0;
      if (nothing && role !== undefined) continue; // the user already said what it is
      const own = chains.filter((c) => c.stops.some((s) => s.repo === id)).map((c) => c.id);
      const counts = `${plural(r.endpoints.pages.length, "page")}, ${plural(nRoutes, "route")}, ${plural(r.endpoints.httpCalls.length, "call")}, ${plural(nQueues, "queue op")}`;
      if (nothing) {
        drafts.push({
          kind: "unclear-role", key: id,
          question: `${id} has no pages, routes or queues. Is it a library, a worker, or not part of this system?`,
          evidence: [counts], close: ["role", "ignore-repo", "ignore-gap"], suggest: [], repos: new Set([id]), chains: new Set(own),
        });
        continue;
      }
      const suggest: Answer[] = [];
      const evidence = [counts];
      for (const c of catchAll) {
        if (c.repo === id || c.prefix === "" || oneRepoNamedBy(c.prefix, repoW, c.repo) !== id) continue;
        evidence.push(cut(`${c.repo} ${c.er.route.at.file}:${c.er.route.at.line} serves ${c.er.effectivePath}: a proxy to ${id}?`));
        suggest.push({ kind: "proxy", repo: c.repo, from: `/${c.prefix}`, to: id });
      }
      drafts.push({
        kind: "unconnected-repo", key: id,
        question: `${id} is not connected to the other repos: how do they reach it, or is it not part of this system?`,
        evidence, close: ["proxy", "env", "link", "queue-alias", "role", "ignore-repo", "ignore-gap"],
        suggest, repos: new Set([id]), chains: new Set(own),
      });
    }
  }

  return rank(drafts, state, cfg);
}

function rank(drafts: Draft[], state: MapState, cfg: LinkConfig): Gap[] {
  const journeysOf = journeysByChain(state);
  const scored = drafts.map((d) => {
    const journeys = new Set([...d.chains].flatMap((c) => journeysOf.get(c) ?? []));
    return { d, id: gapId(d.kind, d.key), journeys: journeys.size, chains: d.chains.size };
  }).filter((g) => !cfg.ignoredGaps.has(g.id));
  scored.sort((a, b) => b.journeys - a.journeys || b.chains - a.chains
    || KIND_ORDER.indexOf(a.d.kind) - KIND_ORDER.indexOf(b.d.kind) || compare(a.d.key, b.d.key));
  return scored.map(({ d, id, journeys, chains }) => {
    // Related: the same proposed answer would close both, or one is about a whole repo the other concerns.
    const answersOf = (x: Draft) => new Set(x.suggest.map((a) => JSON.stringify(a)));
    const repoLevel = (x: Draft) => x.kind === "unconnected-repo" || x.kind === "unclear-role" || x.kind === "repo-alone";
    const related = scored.filter((o) => o.id !== id && (
      [...answersOf(o.d)].some((a) => answersOf(d).has(a))
      || (repoLevel(d) && [...o.d.repos].some((r) => d.repos.has(r)))
      || (repoLevel(o.d) && [...d.repos].some((r) => o.d.repos.has(r)))
    )).map((o) => o.id);
    const gap: Gap = {
      id, kind: d.kind, ...(journeys > 0 ? { journeys } : {}), ...(chains > 0 ? { chains } : {}), question: d.question,
      evidence: d.evidence.slice(0, MAX_EVIDENCE),
      ...(d.evidence.length > MAX_EVIDENCE ? { more: d.evidence.length - MAX_EVIDENCE } : {}),
      close: d.close.join("|"),
      ...(d.suggest.length > 0 ? { suggest: d.suggest.slice(0, MAX_SUGGEST).map((a) => JSON.stringify(a)) } : {}),
      ...(related.length > 0 ? { related: related.slice(0, 3) } : {}),
    };
    return gap;
  });
}

/** The size a result is measured by: its JSON as map_gaps sends it (and `codeloom gaps --json` prints it). */
export const gapsChars = (r: MapGapsResult) => JSON.stringify(r).length;

/** The ranked gaps cut to at most 40 items and 12,000 characters (the best-ranked first). */
export function capGaps(all: Gap[], max = MAX_GAPS, maxChars = MAX_GAPS_CHARS): MapGapsResult {
  const out: MapGapsResult = { open: all.length, shown: 0, gaps: [], answerShapes: ANSWER_SHAPES };
  const withNext = (r: MapGapsResult): MapGapsResult => (r.shown < r.open
    ? { ...r, next: `${r.open - r.shown} more not shown: answer these first, then call map_gaps again.` }
    : r);
  for (const g of all) {
    if (out.gaps.length >= max) break;
    const trial = withNext({ ...out, shown: out.gaps.length + 1, gaps: [...out.gaps, g] });
    if (gapsChars(trial) > maxChars) break;
    out.gaps.push(g);
    out.shown = out.gaps.length;
  }
  return withNext(out);
}

/** The map, its effective config (workspace file + answers) and every open gap. */
export function loadGaps(start: string): { state: MapState; cfg: LinkConfig; answers: Answer[]; gaps: Gap[] } {
  const state = loadMapState(start);
  const answers = readAnswers(state.ws.root);
  const cfg = applyAnswers({ repos: state.ws.repos.map((r) => r.ref), links: state.ws.links, ...(state.ws.external ? { external: state.ws.external } : {}) }, answers);
  return { state, cfg, answers, gaps: computeGaps({ state, cfg }) };
}

/** map_gaps / `codeloom gaps --json`. */
export function mapGaps(start: string): MapGapsResult {
  return capGaps(loadGaps(start).gaps);
}
