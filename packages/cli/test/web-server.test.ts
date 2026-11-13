import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { type DashboardServer, startDashboardServer } from "../src/web/server.js";
import { makeRepo, materializeFixture } from "./helpers.js";

const TOKEN = "a".repeat(64);
const INDEX_HTML = '<!doctype html><html><body><div id="root"></div><script src="/assets/index-AbCd1234.js"></script></body></html>';
const JS = "console.log('dashboard');";

/** A temp dashboard dist: index.html plus a hashed js file, like Vite's output. */
export function makeAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-dash-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  writeFileSync(join(dir, "assets", "index-AbCd1234.js"), JS);
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  return dir;
}

interface Res { status: number; headers: IncomingHttpHeaders; body: string }

/** A raw GET (node:http, so the path reaches the server exactly as written: no client-side URL normalising). */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The session cookie for a server (named per port, so two dashboards never share one). */
const cookie = (token = TOKEN, port = server.port) => ({ cookie: `codeloom_session_${port}=${token}` });

let demo: string;
let assets: string;
let server: DashboardServer;

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  assets = makeAssetsDir();
  server = await startDashboardServer({ start: demo, port: 0, assetsDir: assets, token: TOKEN, watch: false });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe("startDashboardServer", () => {
  it("returns the token URL on 127.0.0.1 with the chosen port", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toBe(TOKEN);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${TOKEN}`);
  });

  it("generates a random 32-byte hex token when none is given", async () => {
    const s = await startDashboardServer({ start: demo, port: 0, assetsDir: assets, watch: false });
    try {
      expect(s.token).toMatch(/^[0-9a-f]{64}$/);
      expect(s.token).not.toBe(TOKEN);
    } finally {
      await s.close();
    }
  });

  it("binds 127.0.0.1 only", async () => {
    const listen = vi.spyOn(http.Server.prototype, "listen");
    const s = await startDashboardServer({ start: demo, port: 0, assetsDir: assets, token: TOKEN, watch: false });
    try {
      expect(listen).toHaveBeenCalled();
      const srv = listen.mock.contexts.at(-1) as http.Server;
      const addr = srv.address();
      expect(addr && typeof addr === "object" && addr.address).toBe("127.0.0.1");
      expect(addr && typeof addr === "object" && addr.port).toBe(s.port);
    } finally {
      listen.mockRestore();
      await s.close();
    }
  });

  it("fails clearly when the dashboard is not built (no assetsDir and none found)", async () => {
    // assetsDir pointing at a folder with no index.html is rejected the same way.
    const empty = mkdtempSync(join(tmpdir(), "codeloom-empty-"));
    await expect(startDashboardServer({ start: demo, port: 0, assetsDir: empty, token: TOKEN, watch: false })).rejects.toThrow(
      CodeloomError,
    );
  });

  it("close() frees the port promptly even with a kept-alive connection open", async () => {
    const s = await startDashboardServer({ start: demo, port: 0, assetsDir: assets, token: TOKEN, watch: false });
    const port = s.port;
    const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });
    try {
      const r = await new Promise<{ status: number; free: number }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
          res.resume();
          res.on("end", () => setImmediate(() => resolve({ status: res.statusCode ?? 0, free: Object.keys(agent.freeSockets).length })));
        });
        req.on("error", reject);
        req.end();
      });
      expect(r.status).toBe(200);
      // The socket is parked in the agent's free pool: a live keep-alive connection to the server.
      expect(r.free).toBe(1);
      const t0 = Date.now();
      await s.close();
      expect(Date.now() - t0).toBeLessThan(1000);
      await new Promise<void>((resolve, reject) => {
        const probe = createNetServer();
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
      });
    } finally {
      agent.destroy();
    }
  });

  it("an explicit port that is in use → CodeloomError naming the port", async () => {
    await expect(
      startDashboardServer({ start: demo, port: server.port, assetsDir: assets, token: TOKEN, watch: false }),
    ).rejects.toThrow(new RegExp(`Port ${server.port} is in use`));
  });

  it("with no port, takes the first free port from 4747 upward (4747 busy → 4748)", async () => {
    const occupy = (port: number) =>
      new Promise<ReturnType<typeof createNetServer> | null>((resolve) => {
        const blocker = createNetServer();
        blocker.once("error", () => resolve(null)); // already busy (someone else holds it): fine too
        blocker.listen(port, "127.0.0.1", () => resolve(blocker));
      });
    const blocker = await occupy(4747);
    // 4748 must be free for the assertion to mean anything.
    const probe = await occupy(4748);
    expect(probe, "port 4748 is busy on this machine").not.toBeNull();
    await new Promise<void>((r) => probe!.close(() => r()));
    try {
      const s = await startDashboardServer({ start: demo, assetsDir: assets, token: TOKEN, watch: false });
      try {
        expect(s.port).toBe(4748);
        expect(s.url).toBe(`http://127.0.0.1:4748/?token=${TOKEN}`);
      } finally {
        await s.close();
      }
    } finally {
      await new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r()));
    }
  });
});

describe("token flow", () => {
  it("/api/* without the session cookie → 401 JSON error", async () => {
    const r = await get(server.port, "/api/overview");
    expect(r.status).toBe(401);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(r.body).error).toMatch(/token/i);
  });

  it("/api/* with a wrong cookie → 401", async () => {
    expect((await get(server.port, "/api/overview", cookie("b".repeat(64)))).status).toBe(401);
    expect((await get(server.port, "/api/overview", cookie("short"))).status).toBe(401);
  });

  it("/api/* with ?token= but no cookie → 401 (the token only travels in the cookie)", async () => {
    expect((await get(server.port, `/api/overview?token=${TOKEN}`)).status).toBe(401);
  });

  it("GET /?token= sets the HttpOnly SameSite=Strict cookie and redirects to the clean URL; the cookie then works on /api/overview", async () => {
    const r = await get(server.port, `/?token=${TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/");
    const set = r.headers["set-cookie"]?.[0] ?? "";
    expect(set).toContain(`codeloom_session_${server.port}=${TOKEN}`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    const sent = set.split(";")[0]!;
    const api = await get(server.port, "/api/overview", { cookie: `other=1; ${sent}` });
    expect(api.status).toBe(200);
  });

  it("keeps the other query params and path when stripping the token", async () => {
    const r = await get(server.port, `/map?repo=api&token=${TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/map?repo=api");
  });

  it("the redirect never points off-site (no protocol-relative //host Location)", async () => {
    for (const path of [`/.//evil.com/?token=${TOKEN}`, `/x/..//evil.com?token=${TOKEN}`, `//evil.com?token=${TOKEN}`]) {
      const r = await get(server.port, path);
      expect(r.status, path).toBe(302);
      const loc = r.headers.location ?? "";
      expect(loc, path).toMatch(/^\/(?!\/)/);
      expect(loc, path).not.toMatch(/^\/\//);
    }
  });

  it("two dashboards on two ports keep separate cookies (neither clobbers the other)", async () => {
    const tokB = "c".repeat(64);
    const b = await startDashboardServer({ start: demo, port: 0, assetsDir: assets, token: tokB, watch: false });
    try {
      // The browser keeps cookies per host, not per port: both servers' cookies go to both servers.
      const setA = (await get(server.port, `/?token=${TOKEN}`)).headers["set-cookie"]![0]!.split(";")[0]!;
      const setB = (await get(b.port, `/?token=${tokB}`, { host: `127.0.0.1:${b.port}` })).headers["set-cookie"]![0]!.split(";")[0]!;
      expect(setA.split("=")[0]).not.toBe(setB.split("=")[0]);
      const jar = { cookie: `${setA}; ${setB}` };
      expect((await get(server.port, "/api/overview", jar)).status).toBe(200);
      expect((await get(b.port, "/api/overview", { host: `127.0.0.1:${b.port}`, ...jar })).status).toBe(200);
      // A's cookie alone does not open B.
      expect((await get(b.port, "/api/overview", { host: `127.0.0.1:${b.port}`, cookie: setA })).status).toBe(401);
    } finally {
      await b.close();
    }
  });

  it("GET /?token=<wrong> → 401, no cookie", async () => {
    const r = await get(server.port, "/?token=nope");
    expect(r.status).toBe(401);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
});

describe("Host guard (DNS rebinding)", () => {
  it("accepts 127.0.0.1:<port> and localhost:<port>", async () => {
    expect((await get(server.port, "/", { host: `127.0.0.1:${server.port}` })).status).toBe(200);
    expect((await get(server.port, "/", { host: `localhost:${server.port}` })).status).toBe(200);
  });

  it("any other Host → 403, on static and API paths alike", async () => {
    expect((await get(server.port, "/", { host: "evil.example.com" })).status).toBe(403);
    expect((await get(server.port, "/", { host: `evil.example.com:${server.port}` })).status).toBe(403);
    expect((await get(server.port, "/", { host: "127.0.0.1:1" })).status).toBe(403);
    expect((await get(server.port, "/api/overview", { host: "evil.example.com", ...cookie() })).status).toBe(403);
    expect((await get(server.port, `/?token=${TOKEN}`, { host: "evil.example.com" })).headers["set-cookie"]).toBeUndefined();
  });

  it("[::1]:<port> → 403 (the server binds 127.0.0.1; only 127.0.0.1 and localhost names are allowed)", async () => {
    expect((await get(server.port, "/", { host: `[::1]:${server.port}` })).status).toBe(403);
  });

  it("a port mismatch → 403 (127.0.0.1 or localhost with another port, or no port)", async () => {
    const other = server.port === 65535 ? 65534 : server.port + 1;
    expect((await get(server.port, "/", { host: `localhost:${other}` })).status).toBe(403);
    expect((await get(server.port, "/", { host: `127.0.0.1:${other}` })).status).toBe(403);
    expect((await get(server.port, "/", { host: "127.0.0.1" })).status).toBe(403);
    expect((await get(server.port, "/", { host: "localhost" })).status).toBe(403);
  });

  it("a missing Host header (HTTP/1.0) → 403", async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(server.port, "127.0.0.1", () => sock.write("GET / HTTP/1.0\r\n\r\n"));
      let out = "";
      sock.setEncoding("utf8");
      sock.on("data", (c) => (out += c));
      sock.on("end", () => resolve(out));
      sock.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 403 /);
  });
});

describe("static files", () => {
  it("/ → index.html with Cache-Control: no-cache", async () => {
    const r = await get(server.port, "/");
    expect(r.status).toBe(200);
    expect(r.body).toBe(INDEX_HTML);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("a hashed asset → its content type and an immutable cache", async () => {
    const r = await get(server.port, "/assets/index-AbCd1234.js");
    expect(r.status).toBe(200);
    expect(r.body).toBe(JS);
    expect(r.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("an unhashed file → no-cache", async () => {
    const r = await get(server.port, "/favicon.svg");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/svg+xml");
    expect(r.headers["cache-control"]).toBe("no-cache");
  });

  it("SPA fallback: unknown non-API paths → index.html", async () => {
    for (const path of ["/journeys/j_123", "/map?repo=api&dir=src", "/some/deep/route"]) {
      const r = await get(server.port, path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toBe(INDEX_HTML);
      expect(r.headers["cache-control"], path).toBe("no-cache");
    }
  });

  it("a missing file with an extension → 404, not index.html", async () => {
    expect((await get(server.port, "/assets/missing-XyZ98765.js")).status).toBe(404);
  });

  it("unknown /api/ paths → 404 JSON (never the SPA)", async () => {
    const r = await get(server.port, "/api/nope", cookie());
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error).toBeTruthy();
  });

  it("path traversal never leaves the assets folder → 404", async () => {
    for (const path of [
      "/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/assets/..%5c..%5cindex.html",
      "/%2E%2E/package.json",
      "/a%00b",
      "/%zz",
    ]) {
      const r = await get(server.port, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain("root:");
    }
  });

  it("a symlink inside the assets folder that points outside → 404", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codeloom-secret-"));
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(join(outside, "secret.txt"), join(assets, "leak.txt"));
    symlinkSync(outside, join(assets, "leakdir"));
    for (const path of ["/leak.txt", "/leakdir/secret.txt"]) {
      const r = await get(server.port, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain("TOP SECRET");
    }
  });

  it("HEAD answers with the headers and no body (static and API)", async () => {
    const head = (path: string, headers: Record<string, string> = {}) =>
      new Promise<Res>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, path, method: "HEAD", headers, agent: false },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const page = await head("/");
    expect(page.status).toBe(200);
    expect(page.body).toBe("");
    expect(page.headers["content-length"]).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    const api = await head("/api/overview", cookie());
    expect(api.status).toBe(200);
    expect(api.body).toBe("");
    expect(Number(api.headers["content-length"])).toBeGreaterThan(0);
    expect((await head("/api/overview")).status).toBe(401);
  });

  it("only GET and HEAD are allowed", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: server.port, path: "/api/overview", method: "POST", headers: cookie(), agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});

describe("<base href> injection (relative dashboard asset links, design spec §7)", () => {
  // The built dashboard now uses vite's base: "./" (relative asset links, so the same build also works
  // hosted at https://<owner>.github.io/<repo>/pr-<n>/). Served live at an arbitrary path depth (e.g.
  // /journeys/x), relative links would otherwise resolve against the wrong folder; the live server fixes
  // that itself by injecting <base href="/"> right after <head>, once, on every index.html response.
  const HEAD_INDEX_HTML =
    '<!doctype html><html><head><meta charset="UTF-8" /><title>codeloom</title></head><body><div id="root"></div><script type="module" src="./assets/index-AbCd1234.js"></script></body></html>';

  function makeHeadAssetsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-dash-head-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), HEAD_INDEX_HTML);
    writeFileSync(join(dir, "assets", "index-AbCd1234.js"), JS);
    return dir;
  }

  it("GET /journeys/x: the HTML has <base href=\"/\"> right after <head>, exactly once", async () => {
    const headAssets = makeHeadAssetsDir();
    const s = await startDashboardServer({ start: demo, port: 0, assetsDir: headAssets, token: TOKEN, watch: false });
    try {
      const r = await get(s.port, "/journeys/x", cookie(TOKEN, s.port));
      expect(r.status).toBe(200);
      expect(r.body).toContain('<head>\n    <base href="/">');
      expect(r.body.split('<base href="/">').length - 1).toBe(1);
      // Nothing else about the page changed.
      expect(r.body).toContain('<script type="module" src="./assets/index-AbCd1234.js"></script>');
    } finally {
      await s.close();
    }
  });

  it("/assets/<file> still serves normally alongside the injected index.html", async () => {
    const headAssets = makeHeadAssetsDir();
    const s = await startDashboardServer({ start: demo, port: 0, assetsDir: headAssets, token: TOKEN, watch: false });
    try {
      const r = await get(s.port, "/assets/index-AbCd1234.js");
      expect(r.status).toBe(200);
      expect(r.body).toBe(JS);
      expect(r.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    } finally {
      await s.close();
    }
  });

  it("an index.html with no <head> tag (e.g. the test fixture's own INDEX_HTML) is served byte-identical", async () => {
    // Guards the existing "/ -> index.html" test above: a fixture with no literal "<head>" must never be
    // mangled by the injection (there is nothing to insert after).
    const r = await get(server.port, "/");
    expect(r.body).toBe(INDEX_HTML);
  });
});

describe("security headers on every response", () => {
  it("nosniff and no-referrer on 200/302/401/403/404/405 and API JSON", async () => {
    const p = server.port;
    const responses: Array<[string, Res]> = [
      ["static 200", await get(p, "/")],
      ["api 200", await get(p, "/api/overview", cookie())],
      ["redirect 302", await get(p, `/?token=${TOKEN}`)],
      ["api 401", await get(p, "/api/overview")],
      ["static 401", await get(p, "/?token=nope")],
      ["403", await get(p, "/", { host: "evil.example.com" })],
      ["api 404", await get(p, "/api/nope", cookie())],
      ["static 404", await get(p, "/../x")],
    ];
    const post = await new Promise<Res>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: p, path: "/", method: "POST", agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" }));
      });
      req.on("error", reject);
      req.end();
    });
    responses.push(["405", post]);
    for (const [name, r] of responses) {
      expect(r.headers["x-content-type-options"], name).toBe("nosniff");
      expect(r.headers["referrer-policy"], name).toBe("no-referrer");
    }
  });
});

describe("/api/overview", () => {
  it("is workspaceOverview plus indexStatus and mcpConnected", async () => {
    const r = await get(server.port, "/api/overview", cookie());
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(r.body);
    expect(body.name).toBe("demo-shop");
    expect(body.repos.map((x: { id: string }) => x.id)).toEqual(["api", "billing", "web"]);
    expect(body.chains.total).toBeGreaterThan(0);
    expect(body.indexStatus.repos.map((x: { id: string }) => x.id)).toEqual(["api", "billing", "web"]);
    expect(body.mcpConnected).toBe(false);
  });

  it("does not block the server: a static request answers while an overview waits on a slow git", async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = mkdtempSync(join(tmpdir(), "codeloom-slowgit-"));
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 1\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const fast = JSON.parse((await get(server.port, "/api/overview", cookie())).body);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${savedPath}`;
    try {
      const t0 = Date.now();
      const overview = get(server.port, "/api/overview", cookie());
      await new Promise((r) => setTimeout(r, 150));
      const page = await get(server.port, "/");
      const pageAt = Date.now() - t0;
      const slow = await overview;
      const overviewAt = Date.now() - t0;
      expect(page.status).toBe(200);
      expect(slow.status).toBe(200);
      // Every git call takes ≥ 1 s (they may run in parallel), so the overview takes ≥ ~1 s; the page
      // must answer while it is still waiting, not after.
      expect(overviewAt).toBeGreaterThan(900);
      expect(pageAt).toBeLessThan(overviewAt - 600);
      expect(JSON.parse(slow.body).indexStatus).toEqual(fast.indexStatus);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("mcpConnected is true once .mcp.json has a codeloom entry (read fresh)", async () => {
    writeFileSync(join(demo, ".mcp.json"), JSON.stringify({ mcpServers: { codeloom: { command: "npx", args: ["codeloom", "serve"] } } }));
    const body = JSON.parse((await get(server.port, "/api/overview", cookie())).body);
    expect(body.mcpConnected).toBe(true);
  });

  it("a repo that is not indexed → 409 with code not-indexed", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const s = await startDashboardServer({ start: repo, port: 0, assetsDir: assets, token: TOKEN, watch: false });
    try {
      const r = await get(s.port, "/api/overview", { host: `127.0.0.1:${s.port}`, ...cookie(TOKEN, s.port) });
      expect(r.status).toBe(409);
      const body = JSON.parse(r.body);
      expect(body.code).toBe("not-indexed");
      expect(body.error).toContain("codeloom index");
    } finally {
      await s.close();
    }
  });

  it("a folder that is neither a workspace nor a git repo → 409 with code no-workspace", async () => {
    const plain = mkdtempSync(join(tmpdir(), "codeloom-plain-"));
    const s = await startDashboardServer({ start: plain, port: 0, assetsDir: assets, token: TOKEN, watch: false });
    try {
      const r = await get(s.port, "/api/overview", { host: `127.0.0.1:${s.port}`, ...cookie(TOKEN, s.port) });
      expect(r.status).toBe(409);
      const body = JSON.parse(r.body);
      expect(body.code).toBe("no-workspace");
      expect(body.error).toContain("codeloom init");
    } finally {
      await s.close();
    }
  });

  it("a bad data file → 409 with code bad-data", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    await runIndex(repo);
    writeFileSync(join(repo, ".codeloom", "chains.json"), "{ not json");
    const s = await startDashboardServer({ start: repo, port: 0, assetsDir: assets, token: TOKEN, watch: false });
    try {
      const r = await get(s.port, "/api/overview", { host: `127.0.0.1:${s.port}`, ...cookie(TOKEN, s.port) });
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body).code).toBe("bad-data");
    } finally {
      await s.close();
    }
  });
});

afterEach(() => vi.restoreAllMocks());
