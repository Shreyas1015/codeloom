import type ts from "typescript";
import type {
  DbAccess, HttpCall, HttpClient, ModelDef, Mount, QueueOp, Route, RouterDef, TableDef, UiPage,
} from "../store/schemas.js";

/** A route as an adapter sees it: `handlerImport` is the raw module specifier of an imported
 * handler, resolved to `handlerFile` by the indexer (which knows every file and alias) and then dropped. */
export type RouteDraft = Route & { handlerImport?: string };

/** A mount as an adapter sees it: `targetImport` is the raw module specifier of an imported router/plugin,
 * resolved to `target.file` by `finalizeEndpoints` (which knows every file and alias) and then dropped. */
export type MountDraft = Mount & {
  targetImport?: string;
  /** Raw specifier of an imported `on` receiver; resolved to `onFile` by `finalizeEndpoints`. */
  onImport?: string;
};

/** A DB access as an adapter sees it: `modelImport` is the raw module specifier a model was default-imported
 * from, resolved by `finalizeEndpoints` to that file's model class (so a local alias never becomes the model
 * name) and then dropped. */
export type DbAccessDraft = DbAccess & { modelImport?: string };

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
  httpClients: HttpClient[];
  routes: RouteDraft[];
  mounts: MountDraft[];
  routers: RouterDef[];
  dbAccess: DbAccessDraft[];
  tables: TableDef[];
  models: ModelDef[];
  queues: QueueOp[];
}

export function emptyPart(): EndpointsPart {
  return {
    pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [], routers: [], dbAccess: [], tables: [], models: [],
    queues: [],
  };
}
