import { runServe } from "../mcp/server.js";

/** `codeloom serve`: the MCP server on stdio. Logs go to stderr only; stdout carries MCP frames. */
export async function runServeCommand(start: string): Promise<void> {
  await runServe(start);
  process.stderr.write(`codeloom MCP server running on stdio (${start})\n`);
}
