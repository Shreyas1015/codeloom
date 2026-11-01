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

/** A receiver that is an app/server: a top-level name, or created by express()/fastify() in its file.
 * This only identifies "is this an app" — it does NOT by itself mean a mount chain should stop here. An
 * app can itself be a sub-app mounted under another app (`const admin = express(); app.use("/admin",
 * admin)`), so callers must still check `mountsFor` before treating it as a chain terminator. */
function isTopLevelReceiver(routers: Routers, file: string, name: string): boolean {
  return TOP_LEVEL_RECEIVERS.has(name) || routerDef(routers, file, name)?.app === true;
}

/** True when nothing exports `name` from `file`: no outside code could even reference it to mount it
 * elsewhere, so an app with no visible mount is trivially the whole program's entry point. */
function isUnexported(routers: Routers, file: string, name: string): boolean {
  return (routerDef(routers, file, name)?.exports.length ?? 0) === 0;
}

/** Fallback "package" for `file`, used only when its RouterDef carries no `packageRoot` (an older cache
 * entry from before that field existed). isMainApp prefers the real package root — the nearest directory
 * with a package.json, computed per file by AdapterContext.packageRoot and stored on RouterDef by
 * detectRouters — and falls back to this guess, the file's top-level directory, only when that is
 * unavailable. The guess is cruder: it conflates any apps that merely share a top-level directory even
 * when they belong to different nested packages, but it is still enough to separate a monorepo's
 * `service-a/`, `service-b/` from each other, which is the case this exists for. */
function packageOf(file: string): string {
  const slash = file.indexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
}

/** `r`'s real package when known (see `RouterDefSchema.packageRoot`), else the `packageOf` fallback guess.
 * "" is a valid package root (the repo root itself), so this only falls back on `undefined`. */
function packageRootOf(r: RouterDef): string {
  return r.packageRoot ?? packageOf(r.file);
}

/** True when `name`/`file` is a main app: either it's bound to one of the conventional top-level receiver
 * names (`app`/`server`/`fastify`, same set as `TOP_LEVEL_RECEIVERS`), or it is the only express()/fastify()
 * app in its own package (see `packageRootOf`) once apps mounted somewhere else are excluded from that
 * count — those are sub-apps accounted for via their own mount, not candidates for "the package's main
 * app". This also returns true when `name`/`file` isn't backed by a RouterDef at all — a bare
 * `app`/`server`/`fastify` name codeloom couldn't resolve to a declaration. We have no `.listen()`/
 * handler-start signal to work with here (RouterDef only records the `app` flag, not call sites), so this
 * remains a proxy for "looks like the program's entry point," not a certainty — scoped per real package
 * (not merely a shared top-level directory) so a second, unrelated app elsewhere in the repo (another
 * service, an admin sub-app) doesn't downgrade this one's own routes to unknown, and so two unrelated main
 * apps that happen to share a top-level directory (e.g. `packages/a/src/index.ts` and
 * `packages/b/src/index.ts`) aren't lumped into one package and both downgraded. */
function isMainApp(mounts: Mount[], routers: Routers, file: string, name: string): boolean {
  const self = routerDef(routers, file, name);
  if (self?.app !== true) return true;
  if (TOP_LEVEL_RECEIVERS.has(name)) return true;
  const pkg = packageRootOf(self);
  let apps = 0;
  for (const r of routers.values()) {
    if (r.app !== true) continue;
    if (packageRootOf(r) !== pkg) continue;
    if (mountsFor(mounts, routers, r.file, r.name).length > 0) continue;
    apps++;
  }
  return apps <= 1;
}

/** An app/server receiver with no mount anyone can see still ends its route chain `known` when it isn't
 * exported (nothing outside its file could mount it, so this has to be the real prefix) or it is a main
 * app per `isMainApp` (presumably the entry point, exported only for tests/supertest — see the "keeps an
 * exported express() app's own routes known" test). An exported app that isn't a main app is most likely
 * a sub-app whose real mount lives in code codeloom didn't index (conditional, dynamic, etc.); reporting
 * its bare path as `exact` would be a lie, so it comes back `unknown` instead. */
function unmountedAppKnown(mounts: Mount[], routers: Routers, file: string, name: string): boolean {
  return isUnexported(routers, file, name) || isMainApp(mounts, routers, file, name);
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
    if (m.on === "") {
      out.push({ prefix: m.prefix, mounts: [m], incomplete: false });
      continue;
    }
    const on = outerRouter(routers, m);
    if (on !== undefined && isTopLevelReceiver(routers, on.file, on.name)) {
      // `on` is an app/server. It only ends the chain here when nothing mounts it any further out; if
      // something does, it is itself a sub-app and must compose through that outer mount like any other
      // router (this was the H1 regression: an app receiver ended the chain unconditionally).
      const appMounts = mountsFor(mounts, routers, on.file, on.name);
      if (appMounts.length === 0) {
        out.push({ prefix: m.prefix, mounts: [m], incomplete: !unmountedAppKnown(mounts, routers, on.file, on.name) });
        continue;
      }
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
      // Unmounted: known only for a route with no router (adonis/next), one on an app/server itself that
      // `unmountedAppKnown` accepts (see its comment), or — in a repo with no mounts at all — one on a
      // router its file keeps private. A router its file exports is meant to be mounted somewhere; with
      // no mount codeloom can see, its prefix is unknown.
      const exported = route.router !== undefined && !isUnexported(routers, route.at.file, route.router);
      const known =
        route.router === undefined ||
        (isTopLevelReceiver(routers, route.at.file, route.router)
          ? unmountedAppKnown(nonNestMounts, routers, route.at.file, route.router)
          : nonNestMounts.length === 0 && !exported);
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
