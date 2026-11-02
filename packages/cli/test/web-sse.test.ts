import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../src/store/json.js";
import { type DashboardServer, startDashboardServer } from "../src/web/server.js";

const TOKEN = "b".repeat(64);
/** A minimal dashboard dist (the server only needs index.html). */
function makeAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-dash-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-sse-"));
  for (const r of ["api", "web"]) mkdirSync(join(root, r, ".codeloom"), { recursive: true });
  mkdirSync(join(root, ".codeloom"), { recursive: true });
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "ws", repos: [{ id: "api", path: "api" }, { id: "web", path: "web" }], links: [] }),
  );
  return root;
}

interface Stream {
  res: IncomingMessage;
  req: ClientRequest;
  text: () => string;
  waitFor: (needle: string, ms?: number) => Promise<void>;
  ended: Promise<void>;
}

/** Open /api/events with the session cookie and buffer what arrives. */
function openStream(port: number, opts: { cookie?: boolean; method?: string } = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (opts.cookie !== false) headers.cookie = `codeloom_session_${port}=${TOKEN}`;
    const req = http.request({ host: "127.0.0.1", port, path: "/api/events", method: opts.method ?? "GET", headers, agent: false }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (buf += c));
      const ended = new Promise<void>((r) => {
        res.on("end", r);
        res.on("close", r);
      });
      resolve({
        res,
        req,
        text: () => buf,
        ended,
        async waitFor(needle, ms = 2000) {
          const until = Date.now() + ms;
          while (!buf.includes(needle)) {
            if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buf)}`);
            await sleep(20);
          }
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** A plain GET with the cookie. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, cookie: `codeloom_session_${port}=${TOKEN}` }, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

const servers: DashboardServer[] = [];
async function serve(start: string, extra: { watch?: boolean; pingMs?: number } = {}): Promise<DashboardServer> {
  const s = await startDashboardServer({ start, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, ...extra });
  servers.push(s);
  // fs.watch needs a moment to arm; macOS FSEvents may replay the setup writes just after.
  await sleep(500);
  return s;
}
afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length) await servers.pop()!.close();
});

const changeFrame = (keys: string[]) => `event: change\ndata: ${JSON.stringify({ keys })}\n\n`;

describe("/api/events", () => {
  it("needs the session cookie", async () => {
    const s = await serve(makeWorkspace(), { watch: false });
    const stream = await openStream(s.port, { cookie: false });
    expect(stream.res.statusCode).toBe(401);
  });

  it("is an event stream; a journeys.json write arrives as {keys:[journeys]} within 2 s", async () => {
    const ws = makeWorkspace();
    const s = await serve(ws);
    const stream = await openStream(s.port);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.res.headers["x-content-type-options"]).toBe("nosniff");
    writeJsonAtomic(join(ws, ".codeloom", "journeys.json"), { version: 1, journeys: [] });
    await stream.waitFor(changeFrame(["journeys"]));
  });

  it("a repo's graph.json change → repo:<id>, sent to every open stream", async () => {
    const ws = makeWorkspace();
    const s = await serve(ws);
    const a = await openStream(s.port);
    const b = await openStream(s.port);
    writeJsonAtomic(join(ws, "api", ".codeloom", "graph.json"), { nodes: [] });
    await a.waitFor(changeFrame(["repo:api"]));
    await b.waitFor(changeFrame(["repo:api"]));
  });

  it("sends a ': ping' comment on the ping interval", async () => {
    const s = await serve(makeWorkspace(), { watch: false, pingMs: 100 });
    const stream = await openStream(s.port);
    await stream.waitFor(": ping\n\n", 1000);
  });

  it("opens without loading the map (works before init) and does not block other requests", async () => {
    const empty = mkdtempSync(join(tmpdir(), "codeloom-sse-empty-"));
    const s = await serve(empty);
    const stream = await openStream(s.port);
    expect(stream.res.statusCode).toBe(200);
    const overview = await get(s.port, "/api/overview");
    expect(overview.status).toBe(409);
    expect(JSON.parse(overview.body).code).toBe("no-workspace");
    // The workspace file appearing is pushed as a workspace change.
    writeFileSync(join(empty, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "ws", repos: [], links: [] }));
    await stream.waitFor(changeFrame(["workspace"]));
  });

  it("stops writing to a client that disconnected", async () => {
    const ws = makeWorkspace();
    const s = await serve(ws, { pingMs: 50 });
    const stream = await openStream(s.port);
    await stream.waitFor(": ping");
    stream.req.destroy();
    await stream.ended;
    await sleep(100);
    const write = vi.spyOn(http.ServerResponse.prototype, "write");
    writeJsonAtomic(join(ws, ".codeloom", "journeys.json"), { n: 1 });
    await sleep(600);
    expect(write).not.toHaveBeenCalled();
  });

  it("HEAD answers the headers and ends", async () => {
    const s = await serve(makeWorkspace(), { watch: false });
    const stream = await openStream(s.port, { method: "HEAD" });
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    await stream.ended;
  });

  it("close() ends open streams and stops watching", async () => {
    const ws = makeWorkspace();
    const s = await startDashboardServer({ start: ws, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, pingMs: 50 });
    const stream = await openStream(s.port);
    await stream.waitFor(": ping");
    const t0 = Date.now();
    await s.close();
    await stream.ended;
    expect(Date.now() - t0).toBeLessThan(1000);
    const write = vi.spyOn(http.ServerResponse.prototype, "write");
    writeJsonAtomic(join(ws, ".codeloom", "journeys.json"), { n: 1 });
    await sleep(600);
    expect(write).not.toHaveBeenCalled();
  });

  it("with watch: false the stream opens but never reports changes", async () => {
    const ws = makeWorkspace();
    const s = await serve(ws, { watch: false });
    const stream = await openStream(s.port);
    writeJsonAtomic(join(ws, ".codeloom", "journeys.json"), { n: 1 });
    await sleep(700);
    expect(stream.text()).not.toContain("event: change");
  });
});
