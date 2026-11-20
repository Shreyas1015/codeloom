import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapGaps } from "../../map/gaps.js";
import { SaveMapAnswersShape, saveMapAnswers } from "../../map/save.js";
import { fail } from "../result.js";
import type { ServerOptions } from "../server.js";

// 0.6 spec §5: the map-interview's two tools. Their results are sent once, as compact JSON text (no indentation,
// and no structuredContent copy, which would send the same data twice): the interview's whole point is to cost
// few tokens.

function compact(fn: (args: unknown) => Record<string, unknown>): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(fn(args)) }] };
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerMapTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "map_gaps",
    {
      title: "Map gaps",
      description:
        "What codeloom could not settle about the map, as short questions, the ones touching most journeys first (at " +
        "most 40, at most 12,000 characters): repos not connected to the rest, call bases (env vars, hosts) it cannot " +
        "place, calls matching no route, routes nothing calls, queues with no consumer or publisher, calls two repos " +
        "could serve, repos with no clear role. Each gap has the evidence (repo, file:line, the name), a question, " +
        "the answer kinds that would close it (shapes in answerShapes) and sometimes a proposed answer. Answer with " +
        "save_map_answers. The map-interview prompt walks the user through them.",
      inputSchema: {},
    },
    compact(() => mapGaps(opts.start) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    "save_map_answers",
    {
      title: "Save map answers",
      description:
        "Save the user's answers about the map to the group's .codeloom/answers.json (a workspace folder's own " +
        ".codeloom/ otherwise): env var / host → repo (per calling repo: `from`), another service, proxy rules, manual " +
        "links, repo roles, repos to leave out, queue aliases, gaps that are expected. Every repo, env var / host, route, " +
        "file, symbol, queue and gap id must exist in the map, an env answer's repo must serve some of those calls, and " +
        "no link codeloom was sure of may get weaker, else nothing is saved and the problems are listed. Then the map " +
        "is linked again from the saved data (no repo is parsed again; the dashboard updates by itself) and the result " +
        "says which gaps closed or opened and which chains appeared. Every later index of any repo keeps the answers.",
      inputSchema: SaveMapAnswersShape,
    },
    compact((args) => saveMapAnswers(opts.start, args) as unknown as Record<string, unknown>),
  );
}
