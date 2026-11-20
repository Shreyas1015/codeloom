import { z } from "zod";
import { linkInputs, runLink, withMapLinkLock, writeLinkOf } from "../commands/index-cmd.js";
import { entryFor, planRegistration, readRegistry, updateRegistry } from "../workspace/registry.js";
import { linkInMemory } from "../linker/run.js";
import { dataError } from "../errors.js";
import { callPathWithClient, type LinkRef, parseLinkRef } from "../linker/link.js";
import { effectiveRoutes, type EffectiveRoute, routeCandidate } from "../linker/mounts.js";
import { pickRoute, type RouteCandidate } from "../linker/paths.js";
import type { RepoData } from "../store/read.js";
import type { Chain, ChainStop, Confidence } from "../store/schemas.js";
import { compare } from "../util.js";
import { type Answer, AnswerSchema, answeredOp, mergeAnswers, readAnswers, writeAnswers } from "./answers.js";
import { type Gap, loadGaps, mapCalls, type MapCallsLink } from "./gaps.js";

// 0.6 spec §5: save_map_answers is the trust boundary for what Claude sends back from the map-interview (as
// save_pr_review is for PR reviews): every repo, env var / host, route, file, symbol, queue and gap it names
// must exist in the map, an `env` answer must send its calls somewhere they match, and no link codeloom was
// sure of may get weaker — else nothing is saved and the problems are listed. Then the map is re-linked from
// the saved data (no repo is parsed again), all under the map's link lock, and the caller is told what changed.

export const MAX_ANSWERS = 50;
const MAX_LISTED = 10;
const MAX_NEW_CHAINS = 3;

export const SaveMapAnswersShape = {
  answers: z.array(AnswerSchema).min(1).max(MAX_ANSWERS)
    .describe("Answers to save (one per gap is typical). Shapes: see map_gaps' answerShapes."),
};
const SaveMapAnswersSchema = z.object(SaveMapAnswersShape).strict();

export interface GapRef { id: string; kind: Gap["kind"] }
export interface ChainLine { name: string; repos: string; complete: boolean }

/** `n` of the answers' own calls that went to `from` ("<repo> <confidence>") before and to `to` now ("no route"
 * when they match nothing), and the open gap that asks about them now. */
export interface Moved { gap?: string; from: string; to: string; n: number }

export interface SaveMapAnswersResult {
  saved: number;
  /** The answers' own calls that were matched for sure and now go elsewhere or less surely (at most 10). */
  moved?: Moved[];
  /** Gaps the answers closed, and gaps that opened (something the new links showed). At most 10 each. */
  closed: GapRef[];
  opened: GapRef[];
  /** Chains that appeared, crossing repos first (at most 3; `moreNewChains` counts the rest). */
  newChains: ChainLine[];
  moreNewChains?: number;
  /** Chains that were there and grew (more stops, or other repos), crossing repos first (at most 3; `moreGrown`). */
  grown?: ChainLine[];
  moreGrown?: number;
  /** Open gaps left, and the map's chains now. */
  open: number;
  chains: { total: number; complete: number };
}

const list = (names: Iterable<string>) => {
  const all = [...new Set(names)].sort(compare);
  return all.length === 0 ? "none" : `${all.slice(0, 12).join(", ")}${all.length > 12 ? `, … (${all.length} in all)` : ""}`;
};

const candidates = (routes: EffectiveRoute[]) =>
  routes.map(routeCandidate);

function symbolExists(repo: RepoData, file: string, symbol: string): boolean {
  const ids = new Set(repo.graph.nodes.map((n) => n.id));
  return ids.has(`function:${file}:${symbol}`) || ids.has(`class:${file}:${symbol}`)
    || repo.endpoints.httpCalls.some((c) => c.at.file === file && c.at.symbol === symbol);
}

type BaseCall = { repo: RepoData; call: RepoData["endpoints"]["httpCalls"][number] };

/** base → calling repo → its calls through that base (every call in the map: see mapCalls). */
function basesInMap(repos: RepoData[], link: MapCallsLink): Map<string, Map<string, BaseCall[]>> {
  const out = new Map<string, Map<string, BaseCall[]>>();
  for (const { repo: r, call, base: b } of mapCalls(repos, link)) {
    if (!b) continue;
    const byCaller = out.get(b.base) ?? new Map<string, BaseCall[]>();
    byCaller.set(r.ref.id, [...(byCaller.get(r.ref.id) ?? []), { repo: r, call }]);
    out.set(b.base, byCaller);
  }
  return out;
}

/** `env` / `external` answers with no `from`, when exactly one repo calls through that base: that repo. */
function fillFrom(answers: Answer[], repos: RepoData[], link: MapCallsLink): Answer[] {
  const bases = basesInMap(repos, link);
  return answers.map((a) => {
    if ((a.kind !== "env" && a.kind !== "external") || a.from !== undefined) return a;
    const callers = [...(bases.get(a.kind === "env" ? a.name : a.base)?.keys() ?? [])];
    return callers.length === 1 ? { ...a, from: callers[0]! } : a;
  });
}

/** Every problem with `answers` against the map (empty when all is well). Exported for doctor's stale-answer check. */
export function answerProblems(answers: Answer[], ctx: Pick<ReturnType<typeof loadGaps>, "state" | "cfg" | "gaps">, opts: { gaps?: boolean } = {}): string[] {
  const repos = ctx.state.ws.repos;
  const byId = new Map(repos.map((r) => [r.ref.id, r]));
  const ids = new Set(byId.keys());
  const routes = new Map(repos.map((r) => [r.ref.id, effectiveRoutes(r.endpoints)]));
  const callsByBase = basesInMap(repos, ctx.state);
  const published = new Set(repos.flatMap((r) => r.endpoints.queues.filter((q) => q.op === "publish").map((q) => q.queue)));
  const consumed = new Set(repos.flatMap((r) => r.endpoints.queues.filter((q) => q.op === "consume").map((q) => q.queue)));
  const out: string[] = [];
  const repoOk = (what: string, id: string) => {
    if (ids.has(id)) return true;
    out.push(`${what}: repo "${id}" is not in the map (repos: ${list(ids)})`);
    return false;
  };
  /** The calls an env / external answer places, or null (with the problem listed). */
  const baseCalls = (what: string, base: string, from: string | undefined) => {
    const byCaller = callsByBase.get(base);
    if (!byCaller) {
      out.push(`${what}: "${base}" is not the base of any call in the map (bases: ${list(callsByBase.keys())})`);
      return null;
    }
    if (from === undefined) {
      if (byCaller.size > 1) {
        out.push(`${what}: ${list(byCaller.keys())} all call through "${base}": say which one with "from" (each may point elsewhere)`);
        return null;
      }
      return [...byCaller.values()].flat();
    }
    if (!repoOk(`${what} from`, from)) return null;
    const own = byCaller.get(from);
    if (!own) {
      out.push(`${what}: ${from} makes no call through "${base}" (callers: ${list(byCaller.keys())})`);
      return null;
    }
    return own;
  };
  const refOk = (what: string, s: string) => {
    const ref: LinkRef | null = parseLinkRef(s);
    if (!ref) return void out.push(`${what}: "${s}" is not "<repo>:<file>#<symbol>", "route:<repo>:<METHOD> <path>" or "queue:<repo>:<queue>"`);
    if (!repoOk(what, ref.repo)) return;
    const repo = byId.get(ref.repo)!;
    const served = new Set(routes.get(ref.repo)!.map((er) => `${er.route.method} ${er.effectivePath}`));
    if (ref.kind === "route" && !served.has(`${ref.method} ${ref.path}`)) {
      out.push(`${what}: ${ref.repo} serves no ${ref.method} ${ref.path} (its routes: ${list(served)})`);
    } else if (ref.kind === "queue" && !repo.endpoints.queues.some((q) => q.queue === ref.queue)) {
      out.push(`${what}: ${ref.repo} has no queue "${ref.queue}" (its queues: ${list(repo.endpoints.queues.map((q) => q.queue))})`);
    } else if (ref.kind === "symbol" && !repo.graph.nodes.some((n) => n.type === "file" && (n.filePath ?? n.id.replace(/^file:/, "")) === ref.file)) {
      out.push(`${what}: ${ref.repo} has no file ${ref.file}`);
    } else if (ref.kind === "symbol" && !symbolExists(repo, ref.file, ref.symbol)) {
      out.push(`${what}: ${ref.repo} ${ref.file} has no function or class "${ref.symbol}"`);
    }
  };
  const gapIds = new Set([...ctx.gaps.map((g) => g.id), ...ctx.cfg.ignoredGaps]);
  for (const a of answers) {
    switch (a.kind) {
      case "env": {
        const placed = baseCalls("env", a.name, a.from);
        if (!repoOk("env", a.repo) || !placed) break;
        // The repo must serve at least one of the calls it is said to get (a wrong answer is caught here).
        const readable = placed.filter((c) => c.call.kind !== "unknown");
        const misses = readable.filter((c) => pickRoute(c.call.method, callPathWithClient(c.call, c.repo.endpoints.httpClients), candidates(routes.get(a.repo)!)) === null);
        if (readable.length > 0 && misses.length === readable.length) {
          out.push(`env: ${a.repo} serves none of the calls through "${a.name}" (${list(misses.map((c) => `${c.call.method} ${c.call.path}`))}); its routes: ${list(routes.get(a.repo)!.map((er) => `${er.route.method} ${er.effectivePath}`))}`);
        }
        break;
      }
      case "external":
        baseCalls("external", a.base, a.from);
        break;
      case "proxy": {
        const ok = repoOk("proxy", a.repo) && repoOk("proxy", a.to);
        if (!ok) break;
        if (a.to === a.repo) {
          out.push(`proxy: "${a.repo}" cannot proxy to its own repo`);
          break;
        }
        const repo = byId.get(a.repo)!;
        const from = a.from.length > 1 ? a.from.replace(/\/+$/, "") : a.from;
        const paths = repo.endpoints.httpCalls.filter((c) => c.kind !== "unknown").map((c) => callPathWithClient(c, repo.endpoints.httpClients));
        if (!paths.some((p) => p === from || p.startsWith(`${from}/`))) {
          out.push(`proxy: no call in ${a.repo} starts with ${a.from} (its call paths: ${list(paths)})`);
        }
        break;
      }
      case "link":
        refOk("link from", a.from);
        refOk("link to", a.to);
        break;
      case "role":
      case "ignore-repo":
        repoOk(a.kind, a.repo);
        break;
      case "queue-alias":
        if (!published.has(a.publish)) out.push(`queue-alias: nothing publishes "${a.publish}" (published: ${list(published)})`);
        if (!consumed.has(a.consume)) out.push(`queue-alias: nothing consumes "${a.consume}" (consumed: ${list(consumed)})`);
        break;
      case "ignore-gap":
        if (opts.gaps !== false && !gapIds.has(a.gap)) out.push(`ignore-gap: ${a.gap} is not an open gap (call map_gaps for the current ones)`);
        break;
      case "queue-name": {
        if (!repoOk("queue-name", a.repo)) break;
        const unknown = byId.get(a.repo)!.endpoints.queueUnknown ?? [];
        const u = unknown.find((x) => `${x.at.file}:${x.at.line}` === a.at);
        if (!u) {
          out.push(`queue-name: ${a.repo} has no publish or consume with an unread name at ${a.at} (places: ${list(unknown.map((x) => `${x.at.file}:${x.at.line}`))})`);
          break;
        }
        if (!answeredOp(u, a)) {
          const need = u.op === "consume" || u.missing.includes("queue") ? "queue" : u.missing.join(" and ");
          out.push(`queue-name: the ${u.op} at ${a.at} needs its ${need}`);
        }
        break;
      }
      case "join-group": {
        if (!repoOk("join-group", a.repo)) break;
        const here = ctx.state.ws.group;
        if (here === undefined) {
          out.push(`join-group: this map is a workspace folder, not a group (edit codeloom.workspace.json to add repos)`);
          break;
        }
        const groups = new Set(readRegistry().repos.map((e) => e.group));
        if (a.group === here) out.push(`join-group: ${a.repo} is already in group "${here}"`);
        else if (!groups.has(a.group)) out.push(`join-group: there is no group "${a.group}" (groups: ${list([...groups].filter((g) => g !== here))})`);
        break;
      }
    }
  }
  return out;
}

// ---- links that must not get weaker ---------------------------------------------------------------------------

const RANK: Record<Confidence, number> = { exact: 0, param: 1, guess: 2 };
const stopId = (s: ChainStop) => `${s.repo} ${s.file}:${s.line} ${s.kind}${s.label ? ` ${s.label}` : ""}`;

/** Every hop (stop → next stop) that `keep` keeps, with its best confidence. A page chain whose call
 * matched no route (routeKey "") is broken already: its hops are no link codeloom was sure of. */
function hops(chains: Chain[], keep: (c: Chain, prev: ChainStop, stop: ChainStop) => boolean = () => true): Map<string, Confidence> {
  const out = new Map<string, Confidence>();
  for (const c of chains) {
    if (c.routeKey === "") continue;
    const legacy = !c.stops.some((s) => s.from !== undefined);
    c.stops.forEach((s, i) => {
      if (i === 0) return;
      const prev = c.stops[legacy ? i - 1 : s.from ?? i - 1];
      if (!prev || !keep(c, prev, s)) return;
      const k = `${stopId(prev)} → ${stopId(s)}`;
      const was = out.get(k);
      if (was === undefined || RANK[s.hop.confidence] < RANK[was]) out.set(k, s.hop.confidence);
    });
  }
  return out;
}

/** A hop that links two things on its own (a call to a route, a publish to a consumer): its confidence is its own
 * match, never only what the chain carried down to it. */
const isLinkHop = (prev: ChainStop, s: ChainStop) => (prev.kind === "call" && s.kind === "route") || (prev.kind === "publish" && s.kind === "consume");

/** Hops that were exact or param before and are gone or weaker after: side effects on calls the answers do not
 * place. Excused: in a chain through a stop the answers place (`placed`: the user said where those go), the hops
 * after it that carry its confidence down (a route matched by a parameter makes its handler's hops "param" there,
 * though they did not change) — but never a call → route or publish → consume hop of another call, which keeps its
 * own check even inside such a chain; and hops into or out of a repo the answers leave out. */
export function weakened(before: Chain[], after: Chain[], ignored: Set<string>, placed: (stop: ChainStop) => boolean): string[] {
  const through = (c: Chain) => c.stops.some(placed);
  const ownCheck = (prev: ChainStop, s: ChainStop) => isLinkHop(prev, s) && !placed(prev);
  const now = hops(after);
  const carried = hops(after, (c, prev, s) => through(c) && !ownCheck(prev, s));
  const out: string[] = [];
  for (const [k, was] of hops(before, (c, prev, s) => !through(c) || ownCheck(prev, s))) {
    if (was === "guess" || carried.has(k)) continue;
    if ([...ignored].some((r) => k.startsWith(`${r} `) || k.includes(` → ${r} `))) continue;
    const is = now.get(k);
    if (is === undefined || RANK[is] > RANK[was]) out.push(`${k} (${was} → ${is ?? "gone"})`);
  }
  return out.sort(compare);
}

/** Where each call the answers place went (its route's repo, best confidence), by call site. */
function callTargets(chains: Chain[], placed: (stop: ChainStop) => boolean): Map<string, { repo: string; confidence: Confidence }> {
  const out = new Map<string, { repo: string; confidence: Confidence }>();
  for (const c of chains) {
    if (c.routeKey === "") continue;
    const legacy = !c.stops.some((s) => s.from !== undefined);
    c.stops.forEach((s, i) => {
      if (s.kind !== "route" || i === 0) return;
      const call = c.stops[legacy ? i - 1 : s.from ?? i - 1];
      if (call?.kind !== "call" || !placed(call)) return;
      const k = `${call.repo} ${call.file}:${call.line}`;
      const was = out.get(k);
      if (!was || RANK[s.hop.confidence] < RANK[was.confidence]) out.set(k, { repo: s.repo, confidence: s.hop.confidence });
    });
  }
  return out;
}

/** The answers' own calls that were matched for sure before and now go elsewhere or less surely, grouped by
 * (from, to), with the open gap that now asks about them. The user should hear about these. */
function movedCalls(before: Chain[], after: Chain[], placed: (stop: ChainStop) => boolean, gaps: Gap[]): Moved[] {
  const was = callTargets(before, placed);
  const now = callTargets(after, placed);
  const groups = new Map<string, Moved>();
  for (const [site, b] of was) {
    if (b.confidence === "guess") continue;
    const a = now.get(site);
    if (a && a.repo === b.repo && RANK[a.confidence] <= RANK[b.confidence]) continue;
    const from = `${b.repo} ${b.confidence}`;
    const to = a ? `${a.repo} ${a.confidence}` : "no route";
    const gap = gaps.find((g) => g.evidence.some((e) => e.startsWith(`${site} `)))?.id;
    const k = `${gap ?? ""}\0${from}\0${to}`;
    const m = groups.get(k) ?? { ...(gap ? { gap } : {}), from, to, n: 0 };
    m.n++;
    groups.set(k, m);
  }
  return [...groups.values()].sort((x, y) => compare(x.from, y.from) || compare(x.to, y.to));
}

/** The stops the answers themselves decide: the calls through an answered base (of its calling repo), the calls
 * in a linked function, the publishes of an aliased queue. */
function placedBy(answers: Answer[], repos: RepoData[], link: MapCallsLink): (prev: ChainStop) => boolean {
  const bases = basesInMap(repos, link);
  const sites = new Set<string>();
  const symbols = new Set<string>();
  const queues = new Set<string>();
  const queueSites = new Set<string>();
  for (const a of answers) {
    if (a.kind === "queue-name") queueSites.add(`${a.repo}\0${a.at}`);
    if (a.kind === "env" || a.kind === "external") {
      const byCaller = bases.get(a.kind === "env" ? a.name : a.base);
      for (const [caller, calls] of byCaller ?? []) {
        if (a.from !== undefined && caller !== a.from) continue;
        for (const c of calls) sites.add(`${caller}\0${c.call.at.file}\0${c.call.at.line}`);
      }
    } else if (a.kind === "link") {
      const from = parseLinkRef(a.from);
      if (from?.kind === "symbol") symbols.add(`${from.repo}\0${from.file}\0${from.symbol}`);
    } else if (a.kind === "queue-alias") queues.add(a.publish);
  }
  return (s) => (s.kind === "call" && (sites.has(`${s.repo}\0${s.file}\0${s.line}`) || symbols.has(`${s.repo}\0${s.file}\0${s.symbol}`)))
    || (s.kind === "publish" && queues.has(s.label ?? ""))
    || ((s.kind === "publish" || s.kind === "consume") && queueSites.has(`${s.repo}\0${s.file}:${s.line}`));
}

const ref = (g: Gap): GapRef => ({ id: g.id, kind: g.kind });

const byInterest = (a: ChainLine, b: ChainLine) =>
  Number(b.repos.includes("→")) - Number(a.repos.includes("→")) || Number(b.complete) - Number(a.complete) || compare(a.name, b.name);

/** What the link changed in chains: those that appeared, and those that were there and grew (more stops or other
 * repos), each crossing repos first, cut to MAX_NEW_CHAINS. `only`: keep chains touching that repo. */
function chainChanges(before: Chain[], after: Chain[], only?: string): Pick<SaveMapAnswersResult, "newChains" | "moreNewChains" | "grown" | "moreGrown"> {
  const was = new Map(before.map((c) => [c.id, c]));
  const keep = (c: Chain) => only === undefined || c.stops.some((st) => st.repo === only);
  const reposOf = (c: Chain) => [...new Set(c.stops.map((st) => st.repo))].join(" ");
  const added = after.filter((c) => !was.has(c.id) && keep(c)).map(chainLine).sort(byInterest);
  const grown = after.filter((c) => {
    const old = was.get(c.id);
    return old !== undefined && keep(c) && (c.stops.length > old.stops.length || reposOf(c) !== reposOf(old));
  }).map(chainLine).sort(byInterest);
  return {
    newChains: added.slice(0, MAX_NEW_CHAINS),
    ...(added.length > MAX_NEW_CHAINS ? { moreNewChains: added.length - MAX_NEW_CHAINS } : {}),
    ...(grown.length > 0 ? { grown: grown.slice(0, MAX_NEW_CHAINS) } : {}),
    ...(grown.length > MAX_NEW_CHAINS ? { moreGrown: grown.length - MAX_NEW_CHAINS } : {}),
  };
}

function chainLine(c: Chain): ChainLine {
  const repos: string[] = [];
  for (const s of c.stops) if (!repos.includes(s.repo)) repos.push(s.repo);
  return { name: c.name, repos: repos.join(" → "), complete: c.complete };
}

/** Validate, save to answers.json, re-link without parsing, and say what changed — all holding the map's link
 * lock, re-reading the saved answers inside it, so two saves at the same time both keep their answers. Throws
 * (nothing saved) when an answer names something the map does not have, sends calls where none matches, or
 * would weaken a link codeloom was sure of. */
export function saveMapAnswers(start: string, input: unknown): SaveMapAnswersResult {
  const parsed = SaveMapAnswersSchema.parse(input);
  const joins = parsed.answers.filter((a) => a.kind === "join-group");
  if (joins.length > 0) {
    if (joins.length !== parsed.answers.length || joins.length > 1) {
      throw dataError("Nothing saved: send a join-group answer on its own (one per call), then call map_gaps again.");
    }
    return joinGroup(start, joins[0] as Extract<Answer, { kind: "join-group" }>);
  }
  return withMapLinkLock(start, () => {
    const before = loadGaps(start);
    const answers = fillFrom(parsed.answers, before.state.ws.repos, before.state);
    const bad = answerProblems(answers, before);
    if (bad.length > 0) throw dataError(`Nothing saved. Fix these and save again:\n${bad.map((b) => `- ${b}`).join("\n")}`);
    const root = before.state.ws.root;
    const old = readAnswers(root);
    const merged = mergeAnswers(old, answers);
    // Answers that only hide gaps change no link: no need to link.
    const relinks = answers.some((a) => a.kind !== "ignore-gap");
    let moved: Moved[] = [];
    let write: (() => void) | undefined;
    let placed: (stop: ChainStop) => boolean = () => false;
    let baseline: Chain[] = [];
    if (relinks) {
      // Read the saved data once and link it twice in memory, without and with the answers: nothing else that
      // changed (a checkout deleted, a newer codeloom) is blamed on them, nothing is written before the check
      // passes, and the link written is the one checked.
      const inputs = linkInputs(start);
      baseline = linkInMemory(inputs.ws, inputs.indexed, old).chains;
      const out = linkInMemory(inputs.ws, inputs.indexed, merged);
      const newlyIgnored = new Set(answers.flatMap((a) => (a.kind === "ignore-repo" ? [a.repo] : [])));
      placed = placedBy(answers, before.state.ws.repos, before.state);
      const lost = weakened(baseline, out.chains, newlyIgnored, placed);
      if (lost.length > 0) {
        throw dataError(
          `Nothing saved: these answers would weaken links codeloom was sure of. Ask again, or answer with a link for the one call:\n` +
          lost.slice(0, MAX_LISTED).map((l) => `- ${l}`).join("\n") + (lost.length > MAX_LISTED ? `\n- … and ${lost.length - MAX_LISTED} more` : ""),
        );
      }
      write = () => writeLinkOf(inputs, out);
    }
    writeAnswers(root, merged);
    write?.();
    const after = loadGaps(start);
    if (relinks) moved = movedCalls(baseline, after.state.chains, placed, after.gaps).slice(0, MAX_LISTED);
    const beforeGaps = new Set(before.gaps.map((g) => g.id));
    const afterGaps = new Set(after.gaps.map((g) => g.id));
    return {
      saved: answers.length,
      closed: before.gaps.filter((g) => !afterGaps.has(g.id)).slice(0, MAX_LISTED).map(ref),
      opened: after.gaps.filter((g) => !beforeGaps.has(g.id)).slice(0, MAX_LISTED).map(ref),
      ...(moved.length > 0 ? { moved } : {}),
      ...chainChanges(before.state.chains, after.state.chains),
      open: after.gaps.length,
      chains: { total: after.state.chains.length, complete: after.state.chains.filter((c) => c.complete).length },
    };
  });
}

/** A `join-group` answer (0.6 Task E): move the repo's registry entry to `group` (as `codeloom index --group` would,
 * and kept for later runs), then link that group from saved data. Nothing is parsed and nothing goes into
 * answers.json. Refused when the repo's id is taken in that group (then the repo must be indexed there). */
function joinGroup(start: string, a: Extract<Answer, { kind: "join-group" }>): SaveMapAnswersResult {
  const before = loadGaps(start);
  const bad = answerProblems([a], before);
  if (bad.length > 0) throw dataError(`Nothing saved. Fix these and save again:\n${bad.map((b) => `- ${b}`).join("\n")}`);
  const repo = before.state.ws.repos.find((r) => r.ref.id === a.repo)!;
  const moved = updateRegistry((reg) => {
    const entry = entryFor(reg, repo.abs);
    if (!entry) return { registry: reg, value: `${a.repo} is not in the registry: run "npx codeloom index --group ${a.group}" inside ${repo.abs}` };
    const [host, owner, ...name] = (entry.remote ?? "").split("/");
    const remote = entry.remote !== undefined && host && owner ? { host, owner, name: name.join("/") } : null;
    const plan = planRegistration(reg, repo.abs, { baseId: entry.id, remote, group: a.group });
    if (plan.entry.id !== entry.id) {
      return { registry: reg, value: `in group "${a.group}" the id ${entry.id} is taken: run "npx codeloom index --group ${a.group}" inside ${repo.abs}` };
    }
    return { registry: plan.registry, value: null };
  });
  if (moved !== null) throw dataError(`Nothing saved: ${moved}`);
  runLink(start);
  const after = loadGaps(start);
  const afterGaps = new Set(after.gaps.map((g) => g.id));
  const beforeGaps = new Set(before.gaps.map((g) => g.id));
  return {
    saved: 1,
    closed: before.gaps.filter((g) => !afterGaps.has(g.id)).slice(0, MAX_LISTED).map(ref),
    opened: after.gaps.filter((g) => !beforeGaps.has(g.id)).slice(0, MAX_LISTED).map(ref),
    ...chainChanges(before.state.chains, after.state.chains, a.repo),
    open: after.gaps.length,
    chains: { total: after.state.chains.length, complete: after.state.chains.filter((c) => c.complete).length },
  };
}
