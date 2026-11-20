import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CodeloomError } from "../errors.js";
import { sendText } from "./http.js";
import { HOST, resolveStatic, sendFile } from "./server.js";

// `codeloom pr`'s local web server: a written snapshot folder (index.html, assets/, data/*.json) served as plain
// files on 127.0.0.1, exactly as a static host would serve it. No /api and no SPA fallback — the snapshot's
// dashboard uses hash routes, so the server only ever sees "/" and real file paths. Same path safety as the
// dashboard server (resolveStatic: no "..", no encoded slashes, nothing outside the folder, symlinks included),
// and the same DNS-rebinding guard (the Host header must be 127.0.0.1:<port> or localhost:<port>).

export interface StaticSite {
  /** http://127.0.0.1:<port>/ */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serves `dir` on 127.0.0.1 (`port`, default one the OS picks). GET and HEAD only. */
export async function serveStaticSite(dir: string, opts: { port?: number }): Promise<StaticSite> {
  let port = 0;
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const head = req.method === "HEAD";
    const host = req.headers.host;
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
      sendText(res, 403, "Forbidden: this server only answers to 127.0.0.1 and localhost.", head);
      return;
    }
    if (req.method !== "GET" && !head) {
      res.setHeader("Allow", "GET, HEAD");
      sendText(res, 405, "Method not allowed: this is a read-only snapshot.");
      return;
    }
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
    const found = resolveStatic(dir, rawPath === "/" || rawPath === "" ? "/index.html" : rawPath);
    if (found === "bad") {
      sendText(res, 400, "Bad path.", head);
      return;
    }
    if (found === "missing") {
      sendText(res, 404, "Not found.", head);
      return;
    }
    sendFile(res, found.file, found.rel, head);
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "codeloom could not serve this file.");
    }
  });
  port = await new Promise<number>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "EADDRINUSE" ? new CodeloomError(`Port ${opts.port} is in use. Pick another with --port, or leave it out to use a free one.`) : err);
    });
    server.listen(opts.port ?? 0, HOST, () => resolve((server.address() as AddressInfo).port));
  });
  return {
    url: `http://${HOST}:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
