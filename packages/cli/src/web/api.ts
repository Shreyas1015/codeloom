import type { ServerResponse } from "node:http";
import { mcpEntryState } from "../commands/init.js";
import { CodeloomError } from "../errors.js";
import { indexStatus, workspaceOverview } from "../mcp/tools/workspace.js";
import { loadWorkspace } from "../workspace/repos.js";
import { sendJson } from "./http.js";

/** An error with an HTTP status, thrown by a route handler (bad query → 400, unknown id → 404). */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (code) this.code = code;
  }
}

/** What a route handler gets: the workspace start folder, the parsed URL (for query params) and the
 * `:name` path params, already URL-decoded. */
export interface ApiContext {
  start: string;
  url: URL;
  params: Record<string, string>;
}

export type ApiHandler = (ctx: ApiContext) => unknown | Promise<unknown>;

/** One GET route: `path` is a pattern like "/api/journeys/:id" (a `:name` segment matches one
 * non-empty path segment). Every route returns JSON; the SSE stream is handled by the server. */
export interface ApiRoute {
  path: string;
  handler: ApiHandler;
}

/** /api/overview: workspaceOverview & { indexStatus, mcpConnected } — mcpConnected is whether .mcp.json
 * at the workspace root has a codeloom entry (the same read-only check `codeloom doctor` uses). */
export function overview(start: string): Record<string, unknown> {
  const base = workspaceOverview(start);
  const root = loadWorkspace(start).root;
  const mcp = mcpEntryState(root);
  return { ...base, indexStatus: indexStatus(start), mcpConnected: mcp === "present" || mcp === "kept-custom" };
}

/** The route table. Every handler reads the store fresh on each request (no cache), like the MCP tools. */
export const API_ROUTES: ApiRoute[] = [{ path: "/api/overview", handler: ({ start }) => overview(start) }];

/** The route matching `pathname` and its decoded params, or null. A param that does not decode → no match. */
export function matchRoute(
  routes: ApiRoute[],
  pathname: string,
): { route: ApiRoute; params: Record<string, string> } | null {
  const segs = pathname.split("/");
  for (const route of routes) {
    const pat = route.path.split("/");
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length && ok; i++) {
      const p = pat[i]!;
      const s = segs[i]!;
      if (p.startsWith(":")) {
        try {
          const v = decodeURIComponent(s);
          if (v) params[p.slice(1)] = v;
          else ok = false;
        } catch {
          ok = false;
        }
      } else if (p !== s) ok = false;
    }
    if (ok) return { route, params };
  }
  return null;
}

/** The HTTP status and body for an error thrown by a handler: HttpError keeps its own; a store
 * dataError (exit 2) → 409 with code "not-indexed" (run codeloom index) or "bad-data" (a bad file),
 * except "Unknown …" (an id/repo that does not exist) → 404 and "Bad …" (a malformed argument) → 400;
 * anything else → 500. */
export function errorResponse(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } };
  }
  if (err instanceof CodeloomError) {
    if (err.code === "not-indexed") return { status: 409, body: { error: err.message, code: "not-indexed" } };
    if (err.message.startsWith("Unknown ")) return { status: 404, body: { error: err.message } };
    if (err.message.startsWith("Bad ")) return { status: 400, body: { error: err.message } };
    if (err.exitCode === 2) return { status: 409, body: { error: err.message, code: "bad-data" } };
    return { status: 500, body: { error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: `codeloom hit an unexpected error: ${message}` } };
}

/** Answer one (already authenticated) /api/* GET from the route table. Unknown path → 404. */
export async function handleApi(
  res: ServerResponse,
  start: string,
  url: URL,
  opts: { head?: boolean; routes?: ApiRoute[] } = {},
): Promise<void> {
  const found = matchRoute(opts.routes ?? API_ROUTES, url.pathname);
  if (!found) {
    sendJson(res, 404, { error: `Unknown API path ${url.pathname}` }, opts.head);
    return;
  }
  try {
    const body = await found.route.handler({ start, url, params: found.params });
    sendJson(res, 200, body, opts.head);
  } catch (err) {
    const { status, body } = errorResponse(err);
    sendJson(res, status, body, opts.head);
  }
}
