import type ts from "typescript";
import type { DbAccess, HttpCall, ModelDef, QueueOp, Route, TableDef, UiPage } from "../store/schemas.js";

export interface ParsedFile {
  rel: string;
  content: string;
  /** Present for JS/TS files. */
  sf?: ts.SourceFile;
}

/** What adapters know about the package a file belongs to. */
export interface AdapterContext {
  /** Dependencies of the file's nearest package.json at or above it, plus the repo root's. */
  deps: Set<string>;
  /** Repo-relative folder of that package.json ("" for the repo root, or when there is none). */
  packageRoot: string;
}

/** Per-file adapter contexts for a whole repo. */
export interface RepoContext {
  contextFor(rel: string): AdapterContext;
  /** Changes whenever any package's dependencies change (part of the cache key). */
  key: string;
}

/** `rel` with its package root removed, so framework folders (app/, pages/) match package-relative. */
export function packageRelative(rel: string, ctx: AdapterContext): string | undefined {
  if (!ctx.packageRoot) return rel;
  return rel.startsWith(`${ctx.packageRoot}/`) ? rel.slice(ctx.packageRoot.length + 1) : undefined;
}

export interface EndpointsPart {
  pages: UiPage[];
  httpCalls: HttpCall[];
  routes: Route[];
  dbAccess: DbAccess[];
  tables: TableDef[];
  models: ModelDef[];
  queues: QueueOp[];
}

export function emptyPart(): EndpointsPart {
  return { pages: [], httpCalls: [], routes: [], dbAccess: [], tables: [], models: [], queues: [] };
}
