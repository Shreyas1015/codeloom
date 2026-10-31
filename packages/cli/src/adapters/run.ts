import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { EndpointsFile, HttpClient, Mount, QueueOp, Route, TableDef } from "../store/schemas.js";
import { compare } from "../util.js";
import { JS_EXT, parseSource } from "./ast.js";
import { detectDb } from "./db.js";
import { detectHttpCalls, detectHttpClients } from "./http-calls.js";
import { detectPages } from "./pages.js";
import { detectQueues } from "./queues.js";
import { detectMounts, detectRoutes } from "./routes.js";
import { type AdapterContext, type EndpointsPart, emptyPart, type MountDraft, type ParsedFile, type RepoContext, type RouteDraft } from "./types.js";

function readDeps(abs: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(abs, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[key] ?? {})) deps.add(name);
    }
  } catch {
    // A broken package.json only means fewer adapters apply.
  }
  return deps;
}

/** Each file gets the deps of its nearest package.json at or above it (unioned with the repo
 * root's, for hoisted monorepo deps) and that package's folder; no package.json above -> empty set. */
export function loadContext(repoAbs: string, files: string[]): RepoContext {
  const byDir = new Map<string, Set<string>>();
  for (const rel of files) {
    if (rel !== "package.json" && !rel.endsWith("/package.json")) continue;
    byDir.set(posix.dirname(rel) === "." ? "" : posix.dirname(rel), readDeps(join(repoAbs, rel)));
  }
  const rootDeps = byDir.get("") ?? new Set<string>();
  const contexts = new Map<string, AdapterContext>();
  const forDir = (dir: string): AdapterContext => {
    const cached = contexts.get(dir);
    if (cached) return cached;
    let ctx: AdapterContext;
    if (byDir.has(dir)) ctx = { deps: new Set([...rootDeps, ...byDir.get(dir)!]), packageRoot: dir };
    else if (dir === "") ctx = { deps: new Set(), packageRoot: "" };
    else ctx = forDir(posix.dirname(dir) === "." ? "" : posix.dirname(dir));
    contexts.set(dir, ctx);
    return ctx;
  };
  const key = [...byDir.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([dir, deps]) => `${dir || "."}:${[...deps].sort().join("|")}`)
    .join(";");
  return {
    key,
    contextFor: (rel) => forDir(posix.dirname(rel) === "." ? "" : posix.dirname(rel)),
  };
}

export function runAdapters(rel: string, content: string, ctx: AdapterContext): EndpointsPart {
  const part = emptyPart();
  const isJs = JS_EXT.test(rel) && !rel.endsWith(".d.ts");
  if (!isJs && !rel.endsWith(".prisma") && !rel.endsWith(".sql")) return part;
  const file: ParsedFile = { rel, content, sf: isJs ? parseSource(rel, content) : undefined };
  part.pages.push(...detectPages(file, ctx));
  part.httpCalls.push(...detectHttpCalls(file));
  part.httpClients.push(...detectHttpClients(file));
  part.routes.push(...detectRoutes(file, ctx));
  part.mounts.push(...detectMounts(file, ctx));
  const db = detectDb(file, ctx);
  part.dbAccess.push(...db.dbAccess);
  part.tables.push(...db.tables);
  part.models.push(...db.models);
  part.queues.push(...detectQueues(file, ctx));
  return part;
}

/** Turn a draft route's handlerImport into handlerFile, and drop the internal field. Never mutates
 * the draft (drafts are cached and must keep their specifier for later runs). */
function resolveHandler(draft: RouteDraft, resolve?: ImportResolver): Route {
  const { handlerImport, ...route } = draft;
  if (handlerImport && !route.handlerFile && resolve) {
    const file = resolve(route.at.file, handlerImport);
    if (file) route.handlerFile = file;
  }
  return route;
}

/** Turn a draft mount's targetImport into target.file, and drop the internal field. Mirrors
 * resolveHandler. Task 1 only wires the plumbing; nothing produces a MountDraft with targetImport
 * set until Task 3 (detectMounts), so this is exercised there. */
function resolveMount(draft: MountDraft, resolve?: ImportResolver): Mount {
  const { targetImport, ...mount } = draft;
  if (targetImport && !mount.target.file && resolve) {
    const file = resolve(mount.at.file, targetImport);
    if (file) mount.target = { ...mount.target, file };
  }
  return mount;
}

const byLoc = <T extends { at: { file: string; line: number } }>(a: T, b: T) =>
  compare(a.at.file, b.at.file) || a.at.line - b.at.line;

const byHttpClient = (a: HttpClient, b: HttpClient) =>
  compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name);

const byMount = (a: Mount, b: Mount) =>
  compare(a.at.file, b.at.file) || a.at.line - b.at.line || compare(a.prefix, b.prefix);

const byQueue = (a: QueueOp, b: QueueOp) =>
  byLoc(a, b) || compare(a.op, b.op) || compare(a.exchange ?? "", b.exchange ?? "") || compare(a.routingKey ?? "", b.routingKey ?? "");

/** Resolves a module specifier written in `fromRel` to a repo file (null when it is not in the repo). */
export type ImportResolver = (fromRel: string, specifier: string) => string | null;

export function finalizeEndpoints(repo: string, parts: EndpointsPart[], resolveImport?: ImportResolver): EndpointsFile {
  const all = emptyPart();
  for (const p of parts) {
    for (const key of Object.keys(all) as Array<keyof EndpointsPart>) {
      (all[key] as unknown[]).push(...(p[key] as unknown[]));
    }
  }
  // First-wins collision rule: only set a key if not already present (matches tables dedup behavior)
  const exact = new Map<string, string>();
  for (const m of all.models) if (!exact.has(m.model)) exact.set(m.model, m.table);
  const lower = new Map<string, string>();
  for (const m of all.models) {
    const lower_key = m.model.toLowerCase();
    if (!lower.has(lower_key)) lower.set(lower_key, m.table);
  }
  const dbAccess = all.dbAccess.map((a) => {
    if (a.table || !a.model) return a;
    const table = exact.get(a.model) ?? lower.get(a.model.toLowerCase());
    return table ? { ...a, table } : a;
  });
  const tables = new Map<string, TableDef>();
  for (const t of all.tables) if (!tables.has(t.name)) tables.set(t.name, t);
  for (const m of all.models) {
    if (!tables.has(m.table)) tables.set(m.table, { name: m.table, file: m.file, line: 1, source: "model" });
  }
  return {
    version: 2,
    repo,
    pages: all.pages.sort((a, b) => compare(a.route, b.route) || compare(a.file, b.file)),
    httpCalls: all.httpCalls.sort(byLoc),
    httpClients: all.httpClients.sort(byHttpClient),
    routes: all.routes.map((r) => resolveHandler(r, resolveImport)).sort(byLoc),
    mounts: all.mounts.map((m) => resolveMount(m, resolveImport)).sort(byMount),
    dbAccess: dbAccess.sort(byLoc),
    tables: [...tables.values()].sort((a, b) => compare(a.name, b.name)),
    models: all.models.sort((a, b) => compare(a.model, b.model)),
    queues: all.queues.sort(byQueue),
  };
}
