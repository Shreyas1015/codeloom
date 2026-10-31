import { joinPaths } from "./paths.js";
import type { EndpointsFile, Mount, Route } from "../store/schemas.js";
import { compare } from "../util.js";

export interface EffectiveRoute {
  repo: string;
  route: Route;
  effectivePath: string;
  mountsKnown: boolean;
  mounts: Mount[];
}

const TOP_LEVEL_RECEIVERS = new Set(["app", "server", "fastify"]);
const MAX_MOUNT_LEVELS = 5;

function isTopLevelReceiver(name: string): boolean {
  return TOP_LEVEL_RECEIVERS.has(name);
}

/** Mounts (excluding nest-global) that place `routerName`, declared in `file`, under a prefix. */
function mountsFor(mounts: Mount[], file: string, routerName: string): Mount[] {
  return mounts.filter((m) => {
    if (m.kind === "nest-global") return false;
    if (m.target.file !== undefined) return m.target.file === file;
    return m.at.file === file && m.target.name === routerName;
  });
}

interface Chain {
  prefix: string;
  mounts: Mount[];
  /** True when some mount along this chain could not be resolved any further out — the outer
   * router was never itself mounted anywhere codeloom could see (orphaned), the walk hit a mount
   * cycle, or it exceeded MAX_MOUNT_LEVELS. `prefix`/`mounts` are still the best partial result;
   * callers should treat an all-incomplete route as `mountsKnown: false`. */
  incomplete: boolean;
}

/** Sentinel for "couldn't go any further out" — a dead end, a cycle, or the depth cap. Distinct from
 * `[]` (no mount even claims this file/router), which lets a genuine top-level receiver terminate a
 * chain cleanly via the `bases` fallback below. */
const UNRESOLVED: Chain[] = [{ prefix: "", mounts: [], incomplete: true }];

/** All distinct outward prefix chains that apply to `routerName` declared in `file`, outermost mount
 * first in each chain's `mounts`. Cycle-guarded by `${file}#${routerName}`, capped at MAX_MOUNT_LEVELS. */
function resolveChains(mounts: Mount[], file: string, routerName: string, visited: Set<string>, depth: number): Chain[] {
  if (depth > MAX_MOUNT_LEVELS) return UNRESOLVED;
  const key = `${file}#${routerName}`;
  if (visited.has(key)) return UNRESOLVED;
  const seen = new Set(visited);
  seen.add(key);
  const matches = mountsFor(mounts, file, routerName);
  const out: Chain[] = [];
  for (const m of matches) {
    if (isTopLevelReceiver(m.on) || m.on === "") {
      out.push({ prefix: m.prefix, mounts: [m], incomplete: false });
      continue;
    }
    const outer = resolveChains(mounts, m.at.file, m.on, seen, depth + 1);
    const bases: Chain[] = outer.length > 0 ? outer : UNRESOLVED;
    for (const base of bases) {
      out.push({ prefix: joinPaths(base.prefix, m.prefix), mounts: [...base.mounts, m], incomplete: base.incomplete });
    }
  }
  return out;
}

export function effectiveRoutes(endpoints: EndpointsFile): EffectiveRoute[] {
  const nonNestMounts = endpoints.mounts.filter((m) => m.kind !== "nest-global");
  const nestGlobal = endpoints.mounts.find((m) => m.kind === "nest-global");
  const out: EffectiveRoute[] = [];

  for (const route of endpoints.routes) {
    if (route.framework === "nest") {
      out.push({
        repo: endpoints.repo,
        route,
        effectivePath: nestGlobal ? joinPaths(nestGlobal.prefix, route.path) : route.path,
        mountsKnown: true,
        mounts: nestGlobal ? [nestGlobal] : [],
      });
      continue;
    }
    const chains = route.router === undefined ? [] : resolveChains(nonNestMounts, route.at.file, route.router, new Set(), 0);
    if (chains.length === 0) {
      const known = nonNestMounts.length === 0 || route.router === undefined || isTopLevelReceiver(route.router);
      out.push({ repo: endpoints.repo, route, effectivePath: route.path, mountsKnown: known, mounts: [] });
      continue;
    }
    // A mount chain that dead-ends (orphaned outer router), cycles, or exceeds the depth cap is
    // `incomplete`: keep its best partial prefix as effectivePath, but mark mountsKnown: false. When
    // only some chains for this route are incomplete, drop them and keep the complete ones.
    const complete = chains.filter((c) => !c.incomplete);
    const chosen = complete.length > 0 ? complete : chains;
    const known = complete.length > 0;
    const sorted = [...chosen].sort((a, b) => compare(a.prefix, b.prefix));
    for (const chain of sorted) {
      out.push({ repo: endpoints.repo, route, effectivePath: joinPaths(chain.prefix, route.path), mountsKnown: known, mounts: chain.mounts });
    }
  }
  return out;
}

export function routeKey(r: EffectiveRoute): string {
  return `${r.repo}:${r.route.method} ${r.effectivePath}`;
}
