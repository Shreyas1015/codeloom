import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compare } from "../../util.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { loadMapState } from "../state.js";

const distinct = (xs: string[]) => new Set(xs).size;

/** workspace_overview: repos with their counts, chain totals, journey totals, chains in no journey. */
export function workspaceOverview(start: string): Record<string, unknown> {
  const state = loadMapState(start);
  const repos = state.ws.repos.map((r) => ({
    id: r.ref.id,
    path: r.ref.path,
    ...(r.ref.role ? { role: r.ref.role } : {}),
    files: r.graph.nodes.filter((n) => n.type === "file").length,
    nodes: r.graph.nodes.length,
    edges: r.graph.edges.length,
    pages: r.endpoints.pages.length,
    routes: r.endpoints.routes.length,
    calls: r.endpoints.httpCalls.length,
    tables: distinct(r.endpoints.tables.map((t) => t.name)),
    queues: distinct(r.endpoints.queues.map((q) => q.queue)),
  }));
  repos.sort((a, b) => compare(a.id, b.id));
  const byConfidence = { exact: 0, param: 0, guess: 0 };
  for (const c of state.chains) byConfidence[c.confidence]++;
  const named = new Set(state.journeys.flatMap((j) => j.chainIds));
  return {
    name: state.ws.name,
    repos,
    chains: { total: state.chains.length, complete: state.chains.filter((c) => c.complete).length, byConfidence },
    journeys: { total: state.journeys.length, orphaned: state.journeys.filter((j) => j.status === "orphaned").length },
    unnamedChains: state.chains.filter((c) => !named.has(c.id)).length,
  };
}

export function registerWorkspaceTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "workspace_overview",
    {
      title: "Workspace overview",
      description:
        "Start here. Lists the repos in this codeloom workspace with their size (files, nodes, pages, routes, " +
        "HTTP calls, tables, queues), how many request chains the map holds and how complete they are, how many " +
        "journeys are named, and how many chains belong to no journey yet.",
    },
    withErrors(() => workspaceOverview(opts.start)),
  );
}
