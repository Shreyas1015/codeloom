#!/usr/bin/env node
// Pack test, MCP step: drive the INSTALLED `codeloom serve` over stdio with the MCP SDK client that npm
// installed next to it (pack-test.sh copies this file into the temp install folder, so the bare import
// below resolves to <install>/node_modules/@modelcontextprotocol/sdk, not the monorepo's copy).
// Checks: tools/list is exactly the catalogue (v0.3: 25 tools), and workspace_overview answers with the 3 demo-shop repos.
// Usage: node pack-test-mcp.mjs <codeloom bin> <workspace dir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Same list as packages/cli/test/mcp-catalogue.ts.
const CATALOGUE = [
  "build_tour_context",
  "check_chains",
  "delete_view",
  "explain_context",
  "get_journey",
  "get_layers",
  "get_neighbors",
  "get_node",
  "get_progress",
  "impact_of_diff",
  "index_status",
  "list_chains",
  "list_specs",
  "list_views",
  "match_specs",
  "record_check",
  "reindex",
  "save_journeys",
  "save_spec_links",
  "save_summary",
  "save_tour",
  "save_view",
  "search",
  "trace_route",
  "workspace_overview",
];

const [bin, workspace] = process.argv.slice(2);
if (!bin || !workspace) {
  process.stderr.write("usage: node pack-test-mcp.mjs <codeloom bin> <workspace dir>\n");
  process.exit(2);
}

function fail(message) {
  process.stderr.write(`mcp: ${message}\n`);
  process.exit(1);
}

const timer = setTimeout(() => fail("timed out after 60 s"), 60_000);
const transport = new StdioClientTransport({ command: bin, args: ["serve"], cwd: workspace, stderr: "inherit" });
const client = new Client({ name: "codeloom-pack-test", version: "0.0.0" });
const protocolErrors = [];
client.onerror = (e) => protocolErrors.push(e);
await client.connect(transport);

const server = client.getServerVersion();
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
if (JSON.stringify(tools) !== JSON.stringify(CATALOGUE)) {
  fail(`tools/list returned ${tools.length} tools: ${tools.join(", ")}\n  expected: ${CATALOGUE.join(", ")}`);
}

const result = await client.callTool({ name: "workspace_overview", arguments: {} });
if (result.isError) fail(`workspace_overview returned an error: ${JSON.stringify(result.content)}`);
const text = result.content.find((c) => c.type === "text")?.text ?? "";
const overview = result.structuredContent ?? JSON.parse(text);
const repos = overview.repos ?? [];
if (repos.length !== 3) fail(`workspace_overview listed ${repos.length} repos, expected 3: ${text.slice(0, 400)}`);

await client.close();
clearTimeout(timer);
if (protocolErrors.length > 0) fail(`protocol errors (something wrote to stdout?): ${protocolErrors.map(String).join("; ")}`);
process.stdout.write(
  `mcp: server ${server?.name} ${server?.version}, ${tools.length} tools, workspace_overview: ${repos.length} repos\n`,
);
