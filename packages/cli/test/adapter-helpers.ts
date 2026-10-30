import { JS_EXT, parseSource } from "../src/adapters/ast.js";
import type { AdapterContext, ParsedFile } from "../src/adapters/types.js";

export function parsed(rel: string, code = ""): ParsedFile {
  return { rel, content: code, sf: JS_EXT.test(rel) ? parseSource(rel, code) : undefined };
}

export function ctxWith(...deps: string[]): AdapterContext {
  return { deps: new Set(deps), packageRoot: "" };
}

/** Context for a file inside the package at `packageRoot` (e.g. "apps/web"). */
export function ctxIn(packageRoot: string, ...deps: string[]): AdapterContext {
  return { deps: new Set(deps), packageRoot };
}
