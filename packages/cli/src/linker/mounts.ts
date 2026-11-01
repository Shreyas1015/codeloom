import { joinPaths } from "./paths.js";
import type { EndpointsFile, Mount, Route, RouterDef } from "../store/schemas.js";
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

/** Exported routers and apps of one repo, keyed `${file}#${name}`. */
type Routers = Map<string, RouterDef>;

function routerDef(routers: Routers, file: string, name: string): RouterDef | undefined {
  return routers.get(`${file}#${name}`);
}

/** A receiver that is an app/server: a top-level name, or created by express()/fastify() in its file. */
function isTopLevelReceiver(routers: Routers, file: string, name: string): boolean {
  return TOP_LEVEL_RECEIVERS.has(name) || routerDef(routers, file, name)?.app === true;
}

/** Mounts (excluding nest-global) that place `routerName`, declared in `file`, under a prefix. A mount whose
 * target was imported under a known name only places the router `file` exports under that name; one with
 * no known import name (fastify plugins, namespace imports) places every router in `file`; an in-file
 * mount places the same-named local router. */
function mountsFor(mounts: Mount[], routers: Routers, file: string, routerName: string): Mount[] {
  return mounts.filter((m) => {
    if (m.kind === "nest-global") return false;
    if (m.target.file !== undefined) {
      if (m.target.file !== file) return false;
      if (m.target.export === undefined) return true;
      return routerDef(routers, file, routerName)?.exports.includes(m.target.export) === true;
    }
    return m.at.file === file && m.target.name === routerName;
  });
}

/** The router a mount is called on: the local `on` router, or — for a receiver imported from another
 * file — the router that file exports under `onExport` (undefined when it exports none by that name). */
function outerRouter(routers: Routers, m: Mount): { file: string; name: string } | undefined {
  if (m.onFile === undefined) return { file: m.at.file, name: m.on };
  for (const r of routers.values()) {
    if (r.file === m.onFile && m.onExport !== undefined && r.exports.includes(m.onExport)) return { file: r.file, name: r.name };
  }
  return undefined;
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
function resolveChains(mounts: Mount[], routers: Routers, file: string, routerName: string, visited: Set<string>, depth: number): Chain[] {
  if (depth > MAX_MOUNT_LEVELS) return UNRESOLVED;
  const key = `${file}#${routerName}`;
  if (visited.has(key)) return UNRESOLVED;
  const seen = new Set(visited);
  seen.add(key);
  const matches = mountsFor(mounts, routers, file, routerName);
  const out: Chain[] = [];
  for (const m of matches) {
    const on = outerRouter(routers, m);
    if (m.on === "" || (on !== undefined && isTopLevelReceiver(routers, on.file, on.name)) || (m.onFile === undefined && isTopLevelReceiver(routers, m.at.file, m.on))) {
      out.push({ prefix: m.prefix, mounts: [m], incomplete: false });
      continue;
    }
    const outer = on === undefined ? [] : resolveChains(mounts, routers, on.file, on.name, seen, depth + 1);
    const bases: Chain[] = outer.length > 0 ? outer : UNRESOLVED;
    for (const base of bases) {
      out.push({ prefix: joinPaths(base.prefix, m.prefix), mounts: [...base.mounts, m], incomplete: base.incomplete });
    }
  }
  return out;
}

export function effectiveRoutes(endpoints: EndpointsFile): EffectiveRoute[] {
  const routers: Routers = new Map((endpoints.routers ?? []).map((r) => [`${r.file}#${r.name}`, r]));
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
    const chains = route.router === undefined ? [] : resolveChains(nonNestMounts, routers, route.at.file, route.router, new Set(), 0);
    if (chains.length === 0) {
      // Unmounted: known only for a route with no router (adonis/next), one on an app/server itself, or
      // — in a repo with no mounts at all — one on a router its file keeps private. A router its file
      // exports is meant to be mounted somewhere; with no mount codeloom can see, its prefix is unknown.
      const exported = route.router !== undefined && (routerDef(routers, route.at.file, route.router)?.exports.length ?? 0) > 0;
      const known =
        route.router === undefined ||
        isTopLevelReceiver(routers, route.at.file, route.router) ||
        (nonNestMounts.length === 0 && !exported);
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
