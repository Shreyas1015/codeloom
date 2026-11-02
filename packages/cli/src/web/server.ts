import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, sep } from "node:path";
import { CodeloomError } from "../errors.js";
import { handleApi, sendJson } from "./api.js";
import { locateDashboardAssets } from "./assets.js";

export interface DashboardServerOptions {
  /** Workspace or repo folder. */
  start: string;
  /** Default: the first free port from 4747 upward (20 tries), else one the OS assigns. 0 = OS-assigned. */
  port?: number;
  /** Default: locateDashboardAssets(); tests pass a temp dir. */
  assetsDir?: string;
  /** Default: randomBytes(32).toString("hex"); tests pass one. */
  token?: string;
  /** Default true: push live changes over /api/events (added with the events stream; tests may disable). */
  watch?: boolean;
}

export interface DashboardServer {
  /** http://127.0.0.1:<port>/?token=<token> */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4747;
const PORT_TRIES = 20;
export const SESSION_COOKIE = "codeloom_session";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Vite's content-hashed output: assets/<name>-<hash>.<ext> (the hash is 8+ base64url characters). */
const HASHED = /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** Headers on every response: no MIME sniffing, and never leak the ?token= URL through a Referer. */
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sendText(res: ServerResponse, status: number, text: string, head = false): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : text);
}

/** The file under `root` that the raw request path names, or null when it would escape `root`, names
 * nothing, or is malformed. Works on the raw path (each segment percent-decoded on its own), so "..",
 * "%2e%2e" and encoded slashes/backslashes/NULs are all refused rather than normalised away; the
 * resolved real path (symlinks followed) must still lie inside root's real path. */
function resolveStatic(root: string, rawPath: string): { file: string; rel: string } | "bad" | "missing" {
  const segs: string[] = [];
  for (const raw of rawPath.split("/")) {
    if (raw === "") continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return "bad";
    }
    if (seg === "." || seg === ".." || /[/\\\0]/.test(seg)) return "bad";
    segs.push(seg);
  }
  if (segs.length === 0) return "missing";
  const candidate = join(root, ...segs);
  if (!existsSync(candidate)) return "missing";
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return "missing";
  }
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + sep)) return "bad";
  if (!statSync(real).isFile()) return "missing";
  return { file: real, rel: segs.join("/") };
}

function sendFile(res: ServerResponse, file: string, rel: string, head: boolean): void {
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = rel.startsWith("assets/") && HASHED.test(rel);
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": type,
    "Content-Length": statSync(file).size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (head) {
    res.end();
    return;
  }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

/** Listen on HOST:port; resolves with the bound port, rejects with the listen error (e.g. EADDRINUSE). */
function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

async function choosePort(server: Server, wanted: number | undefined): Promise<number> {
  if (wanted !== undefined) {
    try {
      return await listenOn(server, wanted);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new CodeloomError(`Port ${wanted} is in use. Pick another with --port, or leave it out to use a free one.`);
      }
      throw err;
    }
  }
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_TRIES; p++) {
    try {
      return await listenOn(server, p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    }
  }
  return listenOn(server, 0);
}

/** The dashboard's local web server: the built dashboard's static files (SPA fallback to index.html) and
 * the read-only /api/* JSON endpoints. Binds 127.0.0.1 only. Every /api/* request needs the session cookie,
 * which the first `GET /?token=<token>` sets (then redirects to the same URL without the token). The Host
 * header must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding guard). Only GET and HEAD. */
export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  const assetsDir = opts.assetsDir ?? locateDashboardAssets();
  if (!existsSync(join(assetsDir, "index.html"))) {
    throw new CodeloomError(
      `The dashboard is not built (${assetsDir} has no index.html). Run "pnpm --filter @codeloom/dashboard build".`,
    );
  }
  const token = opts.token ?? randomBytes(32).toString("hex");
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host;
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
      sendText(res, 403, "Forbidden: this server only answers to 127.0.0.1 and localhost.");
      return;
    }
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) {
      res.setHeader("Allow", "GET, HEAD");
      sendText(res, 405, "Method not allowed: the dashboard server is read-only.");
      return;
    }
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
    const url = new URL(rawUrl, `http://${HOST}:${port}`);

    if (rawPath === "/api" || rawPath.startsWith("/api/")) {
      if (!sameToken(cookieValue(req, SESSION_COOKIE), token)) {
        sendJson(res, 401, { error: 'Missing or wrong session token. Open the URL that "codeloom dashboard" printed.' }, head);
        return;
      }
      await handleApi(res, opts.start, url, { head });
      return;
    }

    if (url.searchParams.has("token")) {
      if (!sameToken(url.searchParams.get("token") ?? undefined, token)) {
        sendText(res, 401, 'Wrong session token. Open the URL that "codeloom dashboard" printed.', head);
        return;
      }
      url.searchParams.delete("token");
      res.writeHead(302, {
        ...BASE_HEADERS,
        "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: url.pathname + url.search,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    const found = resolveStatic(assetsDir, rawPath);
    if (found === "bad") {
      sendText(res, 404, "Not found.", head);
      return;
    }
    if (found !== "missing") {
      sendFile(res, found.file, found.rel, head);
      return;
    }
    // SPA fallback: a route-like path (no extension in its last segment) gets index.html; a missing
    // file (e.g. an old hashed asset) is a plain 404 so the browser never runs HTML as a script.
    const last = rawPath.slice(rawPath.lastIndexOf("/") + 1);
    if (last.includes(".")) {
      sendText(res, 404, "Not found.", head);
      return;
    }
    sendFile(res, join(assetsDir, "index.html"), "index.html", head);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, `codeloom hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  port = await choosePort(server, opts.port);

  let closed: Promise<void> | undefined;
  return {
    url: `http://${HOST}:${port}/?token=${token}`,
    port,
    token,
    close() {
      closed ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
