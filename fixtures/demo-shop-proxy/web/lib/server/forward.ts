import { discover } from "@demo-shop/service-registry";
import type { ServerEnv } from "./env";
import type { ServiceName } from "./services";

const BASE_URL_KEY: Record<ServiceName, keyof ServerEnv> = { billing: "BILLING_API_URL" };

/** The upstream URL for a path, or null when a segment tries to leave the base path. */
export function upstreamUrl(base: string, service: string, segments: readonly string[]): URL | null {
  if (segments.some((s) => s === "..")) return null;
  return new URL(`${base.replace(/\/+$/, "")}/${service}/${segments.map(encodeURIComponent).join("/")}`);
}

export async function forwardTo(request: Request, service: ServiceName, segments: readonly string[], env: ServerEnv) {
  const url = upstreamUrl(env[BASE_URL_KEY[service]], service, segments);
  if (!url) return Response.json({ error: "invalid path" }, { status: 400 });
  return globalThis.fetch(url, { method: request.method, body: request.method === "GET" ? undefined : await request.arrayBuffer() });
}

export async function forwardToLegacy(request: Request, segments: string[]) {
  return fetch(`${discover("legacy")}/${segments.join("/")}`, { method: request.method, body: await request.text() });
}
