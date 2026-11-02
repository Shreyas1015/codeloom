import type { ServerResponse } from "node:http";

/** Headers on every dashboard-server response: no MIME sniffing, and never leak the ?token= URL
 * through a Referer. */
export const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

/** A JSON response (never cached). `head` sends the headers only. */
export function sendJson(res: ServerResponse, status: number, body: unknown, head = false): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : text);
}

/** A plain-text response (never cached). `head` sends the headers only. */
export function sendText(res: ServerResponse, status: number, text: string, head = false): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : text);
}
