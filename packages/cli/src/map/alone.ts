import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isInternalHost, matchBase, type NamedRepo } from "../linker/hints.js";
import { callBase, callPathWithClient } from "../linker/link.js";
import { effectiveRoutes, routeCandidate } from "../linker/mounts.js";
import { pickRoute, type RouteCandidate } from "../linker/paths.js";
import { readEndpoints } from "../store/read.js";
import { packageName } from "../workspace/repos.js";
import type { EndpointsFile, HttpCall } from "../store/schemas.js";
import { compare } from "../util.js";
import { groupWorkspace, type RegistryFile } from "../workspace/registry.js";

// 0.6 Task E: a repo whose remote owner differs from its system's (a frontend under another team's account that
// calls the main team's backends) is grouped alone by the remote rule, so its calls connect to nothing. codeloom
// says so, and names the one other group whose routes its calls match — only when one clearly does: never a guess.

export interface AloneInfo {
  repo: string;
  group: string;
  /** Its calls that match no route in its own group (calls to public hosts left out). */
  calls: number;
  /** Other groups whose repos some of those calls go to — a route matching the call (exact or by parameter), or
   * a call base naming exactly one of its repos (`CORE_SERVICE_URL` → core) — most first. `named`: those bases. */
  matches: Array<{ group: string; matched: number; named?: string[] }>;
  /** The one group that clearly matches: the most calls, at least half of them, and twice the next group's. */
  suggest?: string;
}

const candidates = (eps: EndpointsFile[]) => eps.flatMap((ep) => effectiveRoutes(ep)
  .map((er): RouteCandidate<unknown> => routeCandidate(er)));

/** Is `repo` (its id and endpoints) the only repo of `group`, with calls matching no route there? Then which other
 * groups of the registry its calls match, read from each member's saved endpoints.json (nothing is parsed). */
export function aloneInGroup(reg: RegistryFile, group: string, repo: { id: string; endpoints: EndpointsFile }): AloneInfo | null {
  if (groupWorkspace(reg, group).repos.length !== 1) return null;
  // Only when there is another group to join: alone in the only group is just a first repo.
  const others = [...new Set(reg.repos.map((e) => e.group))].filter((g) => g !== group).sort(compare);
  if (others.length === 0) return null;
  const clients = repo.endpoints.httpClients;
  const own = candidates([repo.endpoints]);
  const pathOf = (c: HttpCall) => callPathWithClient(c, clients);
  const loose = repo.endpoints.httpCalls.filter((c) => {
    if (c.kind === "unknown") return false;
    const base = callBase(c, clients);
    if (base?.kind === "host" && !isInternalHost(base.base) && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base.base)) return false;
    return pickRoute(c.method, pathOf(c), own) === null;
  });
  if (loose.length === 0) return null;
  const matches: AloneInfo["matches"] = [];
  for (const g of others) {
    const members = groupWorkspace(reg, g).repos.flatMap((r) => {
      try {
        const ep = readEndpoints(r.path);
        return ep ? [{ ref: r, ep }] : [];
      } catch {
        return [];
      }
    });
    const routes = candidates(members.map((m) => m.ep));
    if (routes.length === 0) continue;
    // The names each repo with routes goes by: its id, folder, remote repo name and package name (as hints match).
    const named: NamedRepo[] = members.filter((m) => m.ep.routes.length > 0).map((m) => {
      const remote = reg.repos.find((e) => e.path === m.ref.path)?.remote?.split("/").pop();
      return { id: m.ref.id, names: [m.ref.id, basename(m.ref.path), remote, packageName(m.ref.path)].filter((n): n is string => !!n) };
    });
    const byName = new Map<string, string>();
    const matched = loose.filter((c) => {
      const picked = pickRoute(c.method, pathOf(c), routes);
      if (picked !== null && picked.match.confidence !== "guess") return true;
      const b = callBase(c, clients);
      if (!b || b.kind === "expr" || b.kind === "relative" || (b.kind === "host" && !isInternalHost(b.base))) return false;
      const m = matchBase({ kind: b.kind, text: b.base }, named);
      if (m.kind !== "one") return false;
      byName.set(b.base, m.repo);
      return true;
    }).length;
    if (matched > 0) {
      const names = [...byName.entries()].sort(([a], [b]) => compare(a, b)).map(([base, repo]) => `${base} names ${repo}`);
      matches.push({ group: g, matched, ...(names.length > 0 ? { named: names } : {}) });
    }
  }
  matches.sort((a, b) => b.matched - a.matched || compare(a.group, b.group));
  const [top, next] = matches;
  const clear = top !== undefined && top.matched * 2 >= loose.length && (next === undefined || top.matched >= next.matched * 2);
  return { repo: repo.id, group, calls: loose.length, matches, ...(clear ? { suggest: top.group } : {}) };
}

/** The line `codeloom index` prints for it. */
export function aloneLine(a: AloneInfo): string {
  return a.suggest !== undefined
    ? `${a.repo} is alone in group ${a.group}; to join ${a.suggest}: npx codeloom index --group ${a.suggest}`
    : `${a.repo} is alone in group ${a.group}: its calls match no route here. If it belongs with other repos: npx codeloom index --group <their group>`;
}

/** Git repos in the same folders as the group's repos that are not registered yet (by folder name, sorted): the
 * ones worth indexing next. */
export function unindexedSiblings(reg: RegistryFile, group: string): string[] {
  const registered = new Set(reg.repos.map((e) => e.path));
  const parents = new Set(groupWorkspace(reg, group).repos.map((r) => dirname(r.path)));
  const out = new Set<string>();
  for (const parent of parents) {
    let names: string[] = [];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(parent, n);
      if (n.startsWith(".") || registered.has(p)) continue;
      try {
        if (statSync(p).isDirectory() && existsSync(join(p, ".git"))) out.add(n);
      } catch {
        // unreadable: skip
      }
    }
  }
  return [...out].sort(compare);
}
