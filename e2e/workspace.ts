import { execFileSync } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
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

/** Runs `git` in `cwd` with a fixed test identity. Exported for specs that build their own commit history
 * on top of a workspace this file creates (e.g. review.spec.ts's single-repo demo-shop and PR branch). */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd, stdio: "pipe" });

export interface Chain {
  id: string;
  routeKey?: string;
  entry: string;
}

/** `.codeloom/chains.json`'s `chains` list, straight off disk (both `openDemoShop`'s workspace and a
 * single-repo one write it to the same place). */
export function readChains(root: string): Chain[] {
  return JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains;
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
    chains: () => readChains(root),
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

/** A temp copy of fixtures/demo-shop as ONE git repo at its root (unlike `openDemoShop`, which makes each
 * child folder its own repo): the shape PR review maps need (design §2, "a workspace that is the repo
 * itself" — `codeloom.workspace.json` at the git root, repos as subfolders). Mirrors the CLI's own
 * `materializeSingleRepo` test helper (packages/cli/test/helpers.ts); duplicated here rather than
 * imported since e2e specs never reach into another package's test folder. Returns the repo root, not
 * yet indexed. */
export function materializeSingleRepoDemoShop(): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-e2e-review-"));
  cpSync(FIXTURE, root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
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
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "add workspace");
  return root;
}

/** Commit `message` in `root` after rewriting `file` (root-relative) with `edit(currentText)` — the
 * single-file form of the CLI's own `commitChange` test helper (packages/cli/test/helpers.ts), duplicated
 * here for the same reason as `materializeSingleRepoDemoShop`. */
export function commitChange(root: string, file: string, edit: (text: string) => string, message: string): void {
  const path = join(root, file);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

const SNAPSHOT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface StaticSite {
  /** Always ends with "/", so relative URLs (`./data/manifest.json`, the dashboard's own `base: "./"`)
   * resolve under the mount path rather than beside it. */
  url: string;
  close(): Promise<void>;
}

/** A tiny static file server for a built snapshot (`codeloom snapshot`'s `--out` dir), mounted under
 * `mountPath` (e.g. "/pr-12") the way GitHub Pages serves `<owner>.github.io/<repo>/pr-<n>/` — proving the
 * dashboard's relative asset paths survive a real sub-path, not just the server root. 127.0.0.1 only; no
 * SPA fallback (a path with no matching file is a plain 404 — the hash-routed dashboard never asks the
 * server for a client-side route, so it never needs one); no `/api` — a snapshot is only ever these static
 * files, nothing dynamic behind them. */
export async function serveSnapshot(dir: string, mountPath: string): Promise<StaticSite> {
  const prefix = mountPath.replace(/\/+$/, "");
  const server: HttpServer = createHttpServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const underMount = pathname === prefix ? "/" : pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : undefined;
    if (underMount === undefined) {
      res.writeHead(404).end("Not found");
      return;
    }
    const rel = underMount === "/" ? "index.html" : underMount.replace(/^\/+/, "");
    const file = join(dir, rel);
    if (file !== dir && !file.startsWith(join(dir, "/"))) {
      // Outside `dir`: refuse rather than resolve ".." upward, even though nothing untrusted reaches this
      // in a test.
      res.writeHead(403).end("Forbidden");
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": SNAPSHOT_MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("codeloom e2e: static snapshot server has no port");
  return {
    url: `http://127.0.0.1:${address.port}${prefix}/`,
    close: () => new Promise<void>((done, reject) => server.close((err) => (err ? reject(err) : done()))),
  };
}
