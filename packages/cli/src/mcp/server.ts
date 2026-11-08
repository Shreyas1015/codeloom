import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { IndexRunResult } from "../commands/index-cmd.js";
import { VERSION } from "../version.js";
import { registerPrompts } from "./prompts.js";
import { registerCheckTools } from "./tools/check.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerJourneyTools } from "./tools/journeys.js";
import { registerSpecTools } from "./tools/specs.js";
import { registerTourTools } from "./tools/tours.js";
import { registerViewTools } from "./tools/views.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

export interface ServerOptions {
  /** Workspace or repo folder (process.cwd() for serve). */
  start: string;
  /** Default runIndex; injectable for tests. */
  reindex?: (start: string) => Promise<IndexRunResult>;
  /** Passed to traces (tests stub it). */
  fetchImpl?: typeof fetch;
  /** Traces window; tests fix it. */
  now?: () => Date;
}

/** The codeloom MCP server with every tool registered. Tools read the map fresh on every call.
 * Nothing here may write to stdout: on stdio that stream carries only MCP protocol frames. */
export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "codeloom", version: VERSION });
  registerWorkspaceTools(server, opts);
  registerGraphTools(server, opts);
  registerJourneyTools(server, opts);
  registerCheckTools(server, opts);
  registerTourTools(server, opts);
  registerSpecTools(server, opts);
  registerViewTools(server, opts);
  registerPrompts(server, opts);
  return server;
}

/** On stdio, stdout carries only MCP protocol frames: send console.log / info / debug (from codeloom or
 * any dependency) to stderr instead, formatted as console.error would. Returns a function that puts
 * the original methods back (for tests). */
export function guardStdout(): () => void {
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(format(...args) + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => Object.assign(console, original);
}

/** guardStdout + createServer + StdioServerTransport. Resolves once connected; stdin keeps the process alive. */
export async function runServe(start: string): Promise<void> {
  guardStdout();
  const server = createServer({ start });
  await server.connect(new StdioServerTransport());
}
