import { describe, expect, it } from "vitest";
import { parseSource } from "../src/adapters/ast.js";
import { proxyForward } from "../src/adapters/proxy-forward.js";
import type { ParsedFile } from "../src/adapters/types.js";
import { unplacedProxies } from "../src/linker/link.js";
import type { RepoData } from "../src/store/read.js";
import type { ProxyRule, Route, RouteForward } from "../src/store/schemas.js";

// 0.6 §2: a Next.js catch-all route that forwards through a shared factory in another file (demo-shop names).

function files(map: Record<string, string>) {
  const load = (rel: string): ParsedFile | undefined =>
    map[rel] === undefined ? undefined : { rel, content: map[rel]!, sf: parseSource(rel, map[rel]!) };
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".")
      ? [...from.split("/").slice(0, -1), spec].join("/").split("/").reduce<string[]>((acc, seg) => {
        if (seg === "..") acc.pop();
        else if (seg !== ".") acc.push(seg);
        return acc;
      }, []).join("/")
      : null;
    if (base === null) return null;
    for (const ext of [".ts", ".tsx", "/index.ts"]) if (map[`${base}${ext}`] !== undefined) return `${base}${ext}`;
    return null;
  };
  return { load, resolve };
}

const route = (file: string, path: string, handler = "GET"): Route => ({
  method: handler === "default" ? "ANY" : (handler as Route["method"]), path, handler, inline: false, framework: "next-api",
  at: { file, line: 1, symbol: handler }, handlerFile: file,
});

const FORWARD = `import type { ServiceName } from "./services";

const BASE_KEY: Record<ServiceName, "BILLING_API_URL" | "ORDERS_API_URL"> = {
  billing: "BILLING_API_URL",
  orders: "ORDERS_API_URL",
};

export function upstreamUrl(base: string, segments: readonly string[], search: string): URL | null {
  if (segments.length === 0) return null;
  const url = new URL(\`\${base.replace(/\\/+$/, "")}/\${segments.map(encodeURIComponent).join("/")}\`);
  url.search = search;
  return url;
}

export async function forwardTo(request: Request, service: ServiceName, segments: readonly string[], env: Record<string, string>) {
  const url = upstreamUrl(env[BASE_KEY[service]], segments, new URL(request.url).search);
  if (!url) return Response.json({ error: "bad path" }, { status: 400 });
  return globalThis.fetch(url, { method: request.method, body: await request.arrayBuffer() });
}
`;

const HANDLERS = `import { forwardTo } from "./forward";
import { readEnv } from "../env";

type Ctx = { params: Promise<{ path: string[] }> };

export function serviceRoute(service: "billing" | "orders") {
  return async (request: Request, context: Ctx): Promise<Response> => {
    const { path } = await context.params;
    return forwardTo(request, service, path, readEnv());
  };
}
`;

const ENV = `import { z } from "zod";

const schema = z.object({ BILLING_API_URL: z.string().url(), ORDERS_API_URL: z.string().url() });

export function readEnv() {
  return schema.parse({ BILLING_API_URL: process.env.BILLING_API_URL, ORDERS_API_URL: process.env.ORDERS_API_URL });
}
`;

describe("proxyForward (a catch-all route's forwarding, followed through imports)", () => {
  it("follows a factory in another file down to the fetch, with the service bound from the call site", () => {
    const { load, resolve } = files({
      "app/api/billing/[...path]/route.ts": `import { serviceRoute } from "@/lib/proxy/handlers";\n\nconst handler = serviceRoute("billing");\n\nexport const GET = handler;\nexport const POST = handler;\n`,
      "lib/proxy/handlers.ts": HANDLERS,
      "lib/proxy/forward.ts": FORWARD,
      "lib/env.ts": ENV,
    });
    const fw = proxyForward(route("app/api/billing/[...path]/route.ts", "/api/billing/:path*"), load, resolve);
    expect(fw).toEqual({
      at: { file: "lib/proxy/forward.ts", line: 18, symbol: "forwardTo" },
      raw: "${env.BILLING_API_URL}/${path}", base: "env.BILLING_API_URL", path: "/:path*",
    });
  });

  it("reads a base handed straight to the factory (an env var) and a literal prefix before the rest", () => {
    const { load, resolve } = files({
      "app/api/orders/[...slug]/route.ts": `import { createProxy } from "../../../../lib/create-proxy";\n\nexport const GET = createProxy(process.env.ORDERS_API_URL);\n`,
      "lib/create-proxy.ts": `export function createProxy(base: string | undefined) {
  return async (req: Request, { params }: { params: { slug: string[] } }) => fetch(base + "/v1/" + params.slug.join("/"));
}
`,
    });
    const fw = proxyForward(route("app/api/orders/[...slug]/route.ts", "/api/orders/:slug*"), load, resolve);
    expect(fw).toMatchObject({ base: "process.env.ORDERS_API_URL", path: "/v1/:slug*", at: { file: "lib/create-proxy.ts" } });
  });

  it("reads a base from a config map keyed by the service name", () => {
    const { load, resolve } = files({
      "app/api/billing/[...path]/route.ts": `import { createProxy } from "@/lib/create-proxy";\n\nexport const GET = createProxy("billing");\n`,
      "lib/create-proxy.ts": `import { BASES } from "./bases";

export function createProxy(service: keyof typeof BASES) {
  return (req: Request, ctx: { params: { path: string[] } }) => fetch(\`\${BASES[service]}/\${ctx.params.path.join("/")}\`);
}
`,
      "lib/bases.ts": `export const BASES = { billing: process.env.BILLING_API_URL ?? "http://localhost:4000", orders: process.env.ORDERS_API_URL };\n`,
    });
    const fw = proxyForward(route("app/api/billing/[...path]/route.ts", "/api/billing/:path*"), load, resolve);
    expect(fw).toMatchObject({ base: "process.env.BILLING_API_URL", path: "/:path*" });
  });

  it("still reads a route that forwards in its own file", () => {
    const { load, resolve } = files({
      "app/api/billing/[...path]/route.ts": `export async function POST(req: Request, { params }: { params: { path: string[] } }) {
  return fetch(\`\${process.env.BILLING_API_URL}/billing/\${params.path.join("/")}\`, { method: "POST" });
}
`,
    });
    const fw = proxyForward(route("app/api/billing/[...path]/route.ts", "/api/billing/:path*", "POST"), load, resolve);
    expect(fw).toMatchObject({ base: "process.env.BILLING_API_URL", path: "/billing/:path*", at: { file: "app/api/billing/[...path]/route.ts", symbol: "POST" } });
  });

  it("records a forward whose base cannot be read (no base), and nothing for a catch-all that forwards nothing", () => {
    const { load, resolve } = files({
      "app/api/billing/[...path]/route.ts": `import { createProxy } from "@/lib/create-proxy";\n\nexport const GET = createProxy("billing");\n`,
      "lib/create-proxy.ts": `import { lookupBase } from "some-config-package";

export function createProxy(service: string) {
  return (req: Request, ctx: { params: { path: string[] } }) => fetch(\`\${lookupBase(service)}/\${ctx.params.path.join("/")}\`);
}
`,
      "app/api/auth/[...nextauth]/route.ts": `import NextAuth from "next-auth";\n\nconst handler = NextAuth({ providers: [] });\n\nexport const GET = handler;\n`,
    });
    const fw = proxyForward(route("app/api/billing/[...path]/route.ts", "/api/billing/:path*"), load, resolve);
    expect(fw).toEqual({ at: { file: "lib/create-proxy.ts", line: 4, symbol: "createProxy" }, raw: "${…}/${path}" });
    expect(proxyForward(route("app/api/auth/[...nextauth]/route.ts", "/api/auth/:nextauth*"), load, resolve)).toBeUndefined();
  });

  it("stops after three import hops", () => {
    const hop = (n: number) => `export { createProxy } from "./hop${n + 1}";\n`;
    const { load, resolve } = files({
      "app/api/billing/[...path]/route.ts": `import { createProxy } from "@/lib/hop1";\n\nexport const GET = createProxy("billing");\n`,
      "lib/hop1.ts": hop(1),
      "lib/hop2.ts": hop(2),
      "lib/hop3.ts": hop(3),
      "lib/hop4.ts": `export function createProxy(s: string) {
  return (req: Request, ctx: { params: { path: string[] } }) => fetch(\`\${process.env.BILLING_API_URL}/\${ctx.params.path.join("/")}\`);
}
`,
    });
    expect(proxyForward(route("app/api/billing/[...path]/route.ts", "/api/billing/:path*"), load, resolve)).toBeUndefined();
  });

  it("reads a pages-router catch-all (req.query)", () => {
    const { load, resolve } = files({
      "pages/api/billing/[...path].ts": `export default async function handler(req: any, res: any) {
  const path = (req.query.path as string[]).join("/");
  const r = await fetch(\`\${process.env.BILLING_API_URL}/\${path}\`);
  res.status(r.status).send(await r.text());
}
`,
    });
    const fw = proxyForward(route("pages/api/billing/[...path].ts", "/api/billing/:path*", "default"), load, resolve);
    expect(fw).toMatchObject({ base: "process.env.BILLING_API_URL", path: "/:path*" });
  });
});

describe("unplacedProxies (a forward codeloom could not place is a question)", () => {
  const graph = { version: "1", project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" }, nodes: [], edges: [], layers: [], tour: [] };
  const repoData = (id: string, routes: Route[], proxies?: ProxyRule[]): RepoData => ({
    ref: { id, path: id, ...(proxies ? { proxies } : {}) }, abs: `/g/${id}`, graph: graph as RepoData["graph"],
    endpoints: { version: 2, repo: id, pages: [], httpCalls: [], httpClients: [], routes, mounts: [], dbAccess: [], tables: [], models: [], queues: [] },
  });
  const billingRoute: Route = { method: "POST", path: "/billing/invoices", handler: "createInvoice", inline: false, framework: "express", at: { file: "src/server.ts", line: 1, symbol: "createInvoice" } };
  const at = { file: "lib/forward.ts", line: 3, symbol: "forwardTo" };
  const proxyRoute = (forwards: RouteForward): Route => ({ ...route("app/api/billing/[...path]/route.ts", "/api/billing/:path*"), forwards });
  const reasons = (web: RepoData, ...more: RepoData[]) => unplacedProxies({ repos: [web, repoData("demo-billing", [billingRoute]), ...more] })
    .map((p) => [p.from, p.reason, p.candidates]);

  it("places a forward whose base names one repo, and asks about the rest", () => {
    expect(reasons(repoData("demo-web", [proxyRoute({ at, raw: "", base: "env.BILLING_API_URL", path: "/:path*" })]))).toEqual([]);
    expect(reasons(repoData("demo-web", [proxyRoute({ at, raw: "" })]))).toEqual([["/api/billing", "no-base", undefined]]);
    expect(reasons(repoData("demo-web", [proxyRoute({ at, raw: "", base: "env.PAYMENTS_API_URL", path: "/:path*" })])))
      .toEqual([["/api/billing", "unknown", undefined]]);
    expect(reasons(repoData("demo-web", [proxyRoute({ at, raw: "", base: "env.BILLING_API_URL", path: "/:path*/raw" })])))
      .toEqual([["/api/billing", "path", undefined]]);
    expect(reasons(repoData("demo-web", [proxyRoute({ at, raw: "", base: "env.BILLING_API_URL" })]))).toEqual([["/api/billing", "path", undefined]]);
    expect(reasons(repoData("demo-web", [proxyRoute({ at, raw: "", base: "env.BILLING_API_URL", path: "/:path*" })]), repoData("shop-billing", [billingRoute])))
      .toEqual([["/api/billing", "ambiguous", ["demo-billing", "shop-billing"]]]);
  });

  it("asks nothing once a proxy rule (an answer or the workspace file) covers the prefix", () => {
    const web = repoData("demo-web", [proxyRoute({ at, raw: "" })], [{ from: "/api/billing", to: "demo-billing" }]);
    expect(reasons(web)).toEqual([]);
  });
});
