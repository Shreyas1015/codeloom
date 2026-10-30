import type ts from "typescript";
import type { DbAccess, HttpCall, ModelDef, QueueOp, Route, TableDef, UiPage } from "../store/schemas.js";

export interface ParsedFile {
  rel: string;
  content: string;
  /** Present for JS/TS files. */
  sf?: ts.SourceFile;
}

export interface AdapterContext {
  /** Every dependency named in any package.json in the repo. */
  deps: Set<string>;
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
