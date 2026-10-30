import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EndpointsFile, TableDef } from "../store/schemas.js";
import { JS_EXT, parseSource } from "./ast.js";
import { detectDb } from "./db.js";
import { detectHttpCalls } from "./http-calls.js";
import { detectPages } from "./pages.js";
import { detectQueues } from "./queues.js";
import { detectRoutes } from "./routes.js";
import { type AdapterContext, type EndpointsPart, emptyPart, type ParsedFile } from "./types.js";

export function loadContext(repoAbs: string, files: string[]): AdapterContext {
  const deps = new Set<string>();
  for (const rel of files) {
    if (rel !== "package.json" && !rel.endsWith("/package.json")) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(repoAbs, rel), "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[key] ?? {})) deps.add(name);
      }
    } catch {
      // A broken package.json only means fewer adapters apply.
    }
  }
  return { deps };
}

export function runAdapters(rel: string, content: string, ctx: AdapterContext): EndpointsPart {
  const part = emptyPart();
  const isJs = JS_EXT.test(rel) && !rel.endsWith(".d.ts");
  if (!isJs && !rel.endsWith(".prisma") && !rel.endsWith(".sql")) return part;
  const file: ParsedFile = { rel, content, sf: isJs ? parseSource(rel, content) : undefined };
  part.pages.push(...detectPages(file, ctx));
  part.httpCalls.push(...detectHttpCalls(file));
  part.routes.push(...detectRoutes(file, ctx));
  const db = detectDb(file, ctx);
  part.dbAccess.push(...db.dbAccess);
  part.tables.push(...db.tables);
  part.models.push(...db.models);
  part.queues.push(...detectQueues(file, ctx));
  return part;
}

const byLoc = <T extends { at: { file: string; line: number } }>(a: T, b: T) =>
  a.at.file.localeCompare(b.at.file) || a.at.line - b.at.line;

export function finalizeEndpoints(repo: string, parts: EndpointsPart[]): EndpointsFile {
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
    version: 1,
    repo,
    pages: all.pages.sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file)),
    httpCalls: all.httpCalls.sort(byLoc),
    routes: all.routes.sort(byLoc),
    dbAccess: dbAccess.sort(byLoc),
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    models: all.models.sort((a, b) => a.model.localeCompare(b.model)),
    queues: all.queues.sort(byLoc),
  };
}
