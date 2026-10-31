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
}

/** All distinct outward prefix chains that apply to `routerName` declared in `file`, outermost mount
 * first in each chain's `mounts`. Cycle-guarded by `${file}#${routerName}`, capped at MAX_MOUNT_LEVELS. */
function resolveChains(mounts: Mount[], file: string, routerName: string, visited: Set<string>, depth: number): Chain[] {
  if (depth > MAX_MOUNT_LEVELS) return [];
  const key = `${file}#${routerName}`;
  if (visited.has(key)) return [];
  const seen = new Set(visited);
  seen.add(key);
  const matches = mountsFor(mounts, file, routerName);
  const out: Chain[] = [];
  for (const m of matches) {
    const outer = isTopLevelReceiver(m.on) || m.on === "" ? [] : resolveChains(mounts, m.at.file, m.on, seen, depth + 1);
    const bases: Chain[] = outer.length > 0 ? outer : [{ prefix: "", mounts: [] }];
    for (const base of bases) out.push({ prefix: joinPaths(base.prefix, m.prefix), mounts: [...base.mounts, m] });
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
    const sorted = [...chains].sort((a, b) => compare(a.prefix, b.prefix));
    for (const chain of sorted) {
      out.push({ repo: endpoints.repo, route, effectivePath: joinPaths(chain.prefix, route.path), mountsKnown: true, mounts: chain.mounts });
    }
  }
  return out;
}

export function routeKey(r: EffectiveRoute): string {
  return `${r.repo}:${r.route.method} ${r.effectivePath}`;
}
