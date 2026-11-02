// Stdio smoke test: the built `codeloom serve` bin, driven by the SDK's own stdio client. If anything
// but MCP frames reached stdout, the client would fail to parse it and these calls would error.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runInit } from "../src/commands/init.js";
import { commitAll, materializeFixture } from "./helpers.js";
import { CATALOGUE } from "./mcp-catalogue.js";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(CLI_DIR, "dist", "bin.js");

/** Skip the rebuild when CI is set and dist/bin.js already exists (CI runs `build` before `test`). */
function skipBuild(env: NodeJS.ProcessEnv, binExists: boolean): boolean {
  return Boolean(env.CI) && binExists;
}

describe("skipBuild", () => {
  it("skips only in CI with an existing dist/bin.js", () => {
    expect(skipBuild({ CI: "true" }, true)).toBe(true);
    expect(skipBuild({ CI: "true" }, false)).toBe(false);
    expect(skipBuild({}, true)).toBe(false);
  });
});

describe("codeloom serve over stdio", { timeout: 120_000 }, () => {
  let shop: string;
  let client: Client;
  let stderr = "";
  /** A stdout line that is not a JSON-RPC message surfaces here (the transport cannot parse it). */
  const protocolErrors: Error[] = [];

  beforeAll(async () => {
    // Build codeloom and the workspace packages it depends on, so dist/bin.js matches src. CI builds
    // before it tests, so there the existing dist is used as is.
    if (!skipBuild(process.env, existsSync(BIN))) {
      execFileSync("pnpm", ["--filter", "codeloom...", "build"], { cwd: CLI_DIR, stdio: "pipe" });
    }
    shop = materializeFixture("demo-shop");
    runInit(shop);
    for (const r of ["api", "billing", "web"]) commitAll(join(shop, r));
    await runIndex(shop);
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "serve"], cwd: shop, stderr: "pipe" });
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    client = new Client({ name: "stdio-smoke", version: "0.0.0" });
    client.onerror = (e) => protocolErrors.push(e);
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  it("lists exactly the catalogue tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CATALOGUE].sort());
  });

  it("answers workspace_overview with only protocol frames on stdout", async () => {
    const r = (await client.callTool({ name: "workspace_overview", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const overview = r.structuredContent as { repos: Array<{ id: string }> };
    expect(overview.repos.map((x) => x.id)).toEqual(["demo-api", "demo-billing", "demo-web"]);
    // the startup line goes to stderr, never stdout
    expect(stderr).toMatch(/codeloom MCP server running on stdio/);
    expect(protocolErrors).toEqual([]);
  });
});
