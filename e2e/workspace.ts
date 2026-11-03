import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// The built CLI (run `pnpm -r build` first): the same code `codeloom dashboard` and `codeloom serve` run.
import { runIndex } from "../packages/cli/dist/commands/index-cmd.js";
import { createServer } from "../packages/cli/dist/mcp/server.js";
import { startDashboardServer, type DashboardServer } from "../packages/cli/dist/web/server.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/demo-shop", import.meta.url));
/** Screenshots for the design review (git-ignored); no pixel diffs are asserted. */
export const SCREENSHOTS = fileURLToPath(new URL("./__screenshots__/", import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd, stdio: "pipe" });

export interface Chain {
  id: string;
  routeKey?: string;
  entry: string;
}

export interface Workspace {
  root: string;
  server: DashboardServer;
  /** The dashboard URL with the session token; the first visit sets the cookie and redirects to `/`. */
  url: string;
  chains(): Chain[];
  close(): Promise<void>;
}

/** A temp copy of fixtures/demo-shop (each repo a git repo, plus a workspace file), indexed unless `indexed: false`,
 * served by the real dashboard server on an OS-assigned 127.0.0.1 port. */
export async function openDemoShop({ indexed = true }: { indexed?: boolean } = {}): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), "codeloom-e2e-demo-shop-"));
  cpSync(FIXTURE, root, { recursive: true });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repo = join(root, entry.name);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  }
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({
      version: 1,
      name: "demo-shop",
      repos: [
        { id: "api", path: "api" },
        { id: "billing", path: "billing" },
        { id: "web", path: "web" },
      ],
      links: [],
    }),
  );
  if (indexed) await runIndex(root);
  const server = await startDashboardServer({ start: root, port: 0 });
  return {
    root,
    server,
    url: server.url,
    chains: () => JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains,
    async close() {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An MCP client on the in-process codeloom MCP server for this workspace, connected the way an agent would. */
export async function mcpClient(root: string): Promise<Client> {
  const server = createServer({ start: root });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "codeloom-e2e", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}
