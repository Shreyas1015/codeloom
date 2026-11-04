import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { ChainsFileSchema } from "../src/store/schemas.js";
import { makeRepo } from "./helpers.js";
import type { KnowledgeGraph } from "@codeloom/core";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";
import type { CallResolver } from "../src/linker/resolve-calls.js";
import { linkAll } from "../src/linker/link.js";
import { buildChains } from "../src/linker/chains.js";
import { hopsFromChains } from "../src/evals/score.js";
import { buildCheckReport } from "../src/check/report.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { EndpointsFile, HttpCall, Route } from "../src/store/schemas.js";
import { parsed } from "./adapter-helpers.js";

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

function endpoints(repo: string, partial: Partial<EndpointsFile>): EndpointsFile {
  return {
    version: 2, repo, pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [],
    dbAccess: [], tables: [], models: [], queues: [], ...partial,
  };
}

function repo(id: string, ep: Partial<EndpointsFile>, opts?: { role?: "ui" | "api"; apiBase?: string[] }): RepoData {
  return { ref: { id, path: id, ...opts }, abs: `/ws/${id}`, graph: graphStub(), endpoints: endpoints(id, ep) };
}

function resolverFor(files: Record<string, string>, repoId: string): CallResolver {
  const idx: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) idx.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return createCallResolver({ repo: repoId, index: idx, files: new Set(idx.keys()), aliases: [] });
}

function ws(repos: RepoData[]): WorkspaceData {
  return { root: "/ws", name: "ws", repos, links: [] };
}

function fetchCall(file: string, line: number, symbol: string, method: HttpCall["method"], path: string): HttpCall {
  return { method, path, raw: `"${path}"`, resolved: true, client: "fetch", at: { file, line, symbol }, kind: "literal" };
}

function link(repos: RepoData[], files: Record<string, Record<string, string>>) {
  const w = ws(repos);
  const resolvers = new Map(repos.map((r) => [r.ref.id, resolverFor(files[r.ref.id] ?? {}, r.ref.id)]));
  const links = linkAll({ ws: w, resolvers });
  const chains = buildChains(w, links);
  return { w, links, chains, report: buildCheckReport(chains, w, links.uiReach) };
}

describe("call-entry chains for realworld-shaped wrapper calls (H3b)", () => {
  // Shape copied from realworld ui/src/agent.js and a class-component page.
  const agentJs = `import superagentPromise from 'superagent-promise';
import _superagent from 'superagent';
const superagent = superagentPromise(_superagent, global.Promise);
const API_ROOT = 'https://conduit.productionready.io/api';
const responseBody = res => res.body;
const requests = {
  get: url =>
    superagent.get(\`\${API_ROOT}\${url}\`).then(responseBody),
  post: (url, body) =>
    superagent.post(\`\${API_ROOT}\${url}\`, body).then(responseBody),
};
const Auth = {
  current: () =>
    requests.get('/user'),
};
const Articles = {
  all: page =>
    requests.get('/articles'),
  get: slug =>
    requests.get(\`/articles/\${slug}\`),
};
export default { Articles, Auth };
`;
  const homeJs = `import React from 'react';
import agent from '../agent';
class Home extends React.Component {
  componentWillMount() {
    this.props.onLoad(agent.Articles.all());
  }
  render() { return null; }
}
export default Home;
`;
  const indexJs = `import Home from './components/Home';
export const routes = <Route path="/" component={Home} />;
`;
  const route = (method: Route["method"], path: string): Route => ({
    method, path, handler: `${method} ${path}`, inline: true, framework: "express",
    at: { file: "src/routes.ts", line: 1, symbol: `${method} ${path}` },
  });

  function realworld() {
    const ui = repo("ui", {
      pages: [{ route: "/", file: "src/index.js", line: 2, framework: "react-router", component: { name: "Home", importSource: "./components/Home" } }],
    }, { role: "ui" });
    const api = repo("api", { routes: [route("GET", "/api/user"), route("GET", "/api/articles"), route("GET", "/api/articles/:slug")] }, {
      role: "api", apiBase: ["conduit.productionready.io"],
    });
    return link([ui, api], { ui: { "src/agent.js": agentJs, "src/components/Home.js": homeJs, "src/index.js": indexJs } });
  }

  it("writes one call-entry chain per wrapper call no page reaches, scored as ui-api hops", () => {
    const { chains } = realworld();
    const callChains = chains.filter((c) => c.entry.startsWith("call:"));
    // v0.2a §4: Home's componentWillMount reaches Articles.all from the page, so it has a page chain instead.
    expect(callChains.map((c) => [c.entry, c.name]).sort()).toEqual([
      ["call:ui:src/agent.js#Articles.get", "GET /api/articles/:slug · Articles.get"],
      ["call:ui:src/agent.js#Auth.current", "GET /api/user · Auth.current"],
    ]);
    for (const c of callChains) {
      expect(c.stops.some((s) => s.kind === "page")).toBe(false);
      expect(c.stops[0]!.hop.confidence).toBe("param");
      expect(c.confidence).not.toBe("exact");
    }
    const hops = hopsFromChains(chains).filter((h) => h.hop.type === "ui-api");
    expect(hops.map((h) => `${h.hop.type === "ui-api" ? `${h.hop.from.symbol} -> ${h.hop.to.method} ${h.hop.to.path}` : ""} @${h.confidence}`).sort()).toEqual([
      "Articles.all -> GET /api/articles @param",
      "Articles.get -> GET /api/articles/:slug @param",
      "Auth.current -> GET /api/user @param",
    ]);
  });

  it("records the reach facts and lists every unreached call under ui-unreached", () => {
    const { links, report } = realworld();
    expect(links.uiReach.map((f) => `${f.symbol}:${f.reached}`)).toEqual(["Auth.current:false", "Articles.all:true", "Articles.get:false"]);
    expect(report.items.filter((i) => i.kind === "ui-unreached").map((i) => i.symbol)).toEqual(["Auth.current", "Articles.get"]);
  });

  it("a call reached by a page gets a page chain, no call-entry chain", () => {
    const ui = repo("ui", {
      pages: [{ route: "/", file: "src/index.js", line: 2, framework: "react-router", component: { name: "Home", importSource: "./components/Home" } }],
    }, { role: "ui" });
    const api = repo("api", { routes: [route("GET", "/api/articles")] }, { role: "api", apiBase: ["conduit.productionready.io"] });
    const home = `import agent from '../agent';
export default function Home() {
  return <button onClick={() => agent.Articles.all()} />;
}
`;
    const { chains, links } = link([ui, api], { ui: { "src/agent.js": agentJs, "src/components/Home.js": home, "src/index.js": indexJs } });
    expect(chains.some((c) => c.entry === "call:ui:src/agent.js#Articles.all")).toBe(false);
    expect(chains.some((c) => c.entry === "page:ui:/" && c.routeKey === "api:GET /api/articles")).toBe(true);
    expect(links.uiReach.find((f) => f.symbol === "Articles.all")!.reached).toBe(true);
  });
});

describe("reach facts drive ui-unreached (H3b)", () => {
  it("a page with two handlers hitting the same route lists neither as unreached", () => {
    const page = [
      "export default function Editor() {",
      "  const save = async () => {",
      "    await fetch('/api/post', { method: 'POST' })",
      "  }",
      "  const publish = async () => {",
      "    await fetch('/api/post', { method: 'POST' })",
      "  }",
      "  return <Form onSave={save} onPublish={publish} />",
      "}",
      "",
    ].join("\n");
    const app = repo("app", {
      pages: [{ route: "/edit", file: "src/app/edit/page.tsx", line: 1, framework: "next-app" }],
      httpCalls: [
        fetchCall("src/app/edit/page.tsx", 3, "save", "POST", "/api/post"),
        fetchCall("src/app/edit/page.tsx", 6, "publish", "POST", "/api/post"),
      ],
      routes: [{ method: "POST", path: "/api/post", handler: "default", inline: false, framework: "next-api", at: { file: "src/pages/api/post.ts", line: 1, symbol: "handler" }, handlerFile: "src/pages/api/post.ts" }],
    });
    const { links, chains, report } = link([app], {
      app: { "src/app/edit/page.tsx": page, "src/pages/api/post.ts": "export default function handler(req, res) { res.json({}) }\n" },
    });
    // The two calls share one page chain (same entry and route), so only one call stop survives there.
    expect(chains.filter((c) => c.entry === "page:app:/edit")).toHaveLength(1);
    // v0.2a §4: the call the page chain dropped keeps a call-entry chain, so its UI → API hop is still there.
    expect(chains.filter((c) => c.entry.startsWith("call:")).map((c) => c.entry)).toEqual(["call:app:src/app/edit/page.tsx#publish"]);
    expect(links.uiReach.map((f) => [f.symbol, f.reached])).toEqual([["save", true], ["publish", true]]);
    expect(report.items.filter((i) => i.kind === "ui-unreached")).toEqual([]);
  });

  it("Express handler -> service -> notify -> fetch is backend code, never listed", () => {
    const files = {
      "web/app/page.tsx": "export default function Home() { return null }\n",
      "server/orders.ts": "import { placeOrder } from './svc';\nexport function createOrder(req, res) { placeOrder(req.body); res.json({}) }\n",
      "server/svc.ts": "import { notify } from './notify';\nexport function placeOrder(o) { notify(o) }\n",
      "server/notify.ts": "export async function notify(o) {\n  await fetch('/hooks/order', { method: 'POST' })\n}\n",
    };
    const app = repo("app", {
      pages: [{ route: "/", file: "web/app/page.tsx", line: 1, framework: "next-app" }],
      httpCalls: [fetchCall("server/notify.ts", 2, "notify", "POST", "/hooks/order")],
      routes: [{ method: "POST", path: "/orders", handler: "createOrder", inline: false, framework: "express", at: { file: "server/routes.ts", line: 3, symbol: "<module>" }, handlerFile: "server/orders.ts" }],
    });
    const { links, chains, report } = link([app], { app: files });
    expect(links.uiReach).toEqual([]);
    expect(chains.some((c) => c.entry.startsWith("call:"))).toBe(false);
    expect(report.items.filter((i) => i.kind === "ui-unreached")).toEqual([]);
  });

  it("a fetch inside an inline route callback is backend code", () => {
    const files = {
      "web/app/page.tsx": "export default function Home() { return null }\n",
      "server/app.ts": "app.post('/orders', async (req, res) => {\n  await fetch('/hooks/order', { method: 'POST' })\n  res.json({})\n})\n",
    };
    const app = repo("app", {
      pages: [{ route: "/", file: "web/app/page.tsx", line: 1, framework: "next-app" }],
      httpCalls: [fetchCall("server/app.ts", 2, "<module>", "POST", "/hooks/order")],
      routes: [{ method: "POST", path: "/orders", handler: "POST /orders", inline: true, framework: "express", at: { file: "server/app.ts", line: 1, symbol: "<module>" }, handlerFile: "server/app.ts", handlerLines: [1, 4] }],
    });
    expect(link([app], { app: files }).links.uiReach).toEqual([]);
  });

  it("a cron fetch in a backend-only repo (no pages) is never listed", () => {
    const worker = repo("worker", { httpCalls: [fetchCall("src/cron.ts", 2, "sync", "POST", "/api/sync")] });
    const api = repo("api", { routes: [{ method: "POST", path: "/api/sync", handler: "POST /api/sync", inline: true, framework: "express", at: { file: "src/routes.ts", line: 1, symbol: "<module>" } }] });
    const { links, chains, report } = link([api, worker], {
      worker: { "src/cron.ts": "export async function sync() {\n  await fetch('/api/sync', { method: 'POST' })\n}\n" },
    });
    expect(links.uiReach).toEqual([]);
    expect(chains.some((c) => c.entry.startsWith("call:"))).toBe(false);
    expect(report.items.filter((i) => i.kind === "ui-unreached")).toEqual([]);
  });

  it("an unreached UI call that matches no route is listed but gets no chain", () => {
    const app = repo("app", {
      pages: [{ route: "/", file: "src/app/page.tsx", line: 1, framework: "next-app" }],
      httpCalls: [fetchCall("src/lib/orphan.ts", 2, "orphan", "GET", "/api/nowhere")],
      routes: [{ method: "GET", path: "/api/other", handler: "GET /api/other", inline: true, framework: "express", at: { file: "src/routes.ts", line: 1, symbol: "<module>" } }],
    });
    const { links, chains, report } = link([app], {
      app: { "src/app/page.tsx": "export default function Home() { return null }\n", "src/lib/orphan.ts": "export async function orphan() {\n  await fetch('/api/nowhere')\n}\n" },
    });
    expect(links.uiReach).toEqual([{ repo: "app", file: "src/lib/orphan.ts", line: 2, symbol: "orphan", method: "GET", path: "/api/nowhere", reached: false }]);
    expect(chains.some((c) => c.entry.startsWith("call:"))).toBe(false);
    expect(report.items.filter((i) => i.kind === "ui-unreached").map((i) => i.detail)).toEqual([
      "GET /api/nowhere: call at src/lib/orphan.ts:2 is not reached from any page",
    ]);
  });
});

describe("call-entry chains and reach facts are deterministic (H3b)", () => {
  // A minimal realworld-shaped workspace: a React UI whose calls go through a default-exported agent
  // object, and an Express API. Written here, not copied from fixtures/.
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "codeloom-h3b-"));
    makeRepo({
      "package.json": JSON.stringify({ name: "ui", dependencies: { react: "^16", "react-router-dom": "^4", superagent: "^3" } }),
      "src/agent.js": [
        "import _superagent from 'superagent';",
        "const superagent = _superagent;",
        "const API_ROOT = 'https://conduit.example.io/api';",
        "const requests = {",
        "  get: url => superagent.get(`${API_ROOT}${url}`).then(r => r.body),",
        "};",
        "const Tags = { getAll: () => requests.get('/tags') };",
        "const Auth = { current: () => requests.get('/user') };",
        "export default { Auth, Tags };",
        "",
      ].join("\n"),
      "src/components/Home.js": [
        "import React from 'react';",
        "import agent from '../agent';",
        "class Home extends React.Component {",
        "  componentWillMount() { this.props.onLoad(agent.Tags.getAll()); }",
        "  render() { return null; }",
        "}",
        "export default Home;",
        "",
      ].join("\n"),
      "src/index.js": [
        "import React from 'react';",
        "import { Route } from 'react-router-dom';",
        "import Home from './components/Home';",
        "export const App = () => <Route path=\"/\" component={Home} />;",
        "",
      ].join("\n"),
    }, join(root, "ui"));
    makeRepo({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "^4" } }),
      "src/app.ts": [
        "import express from 'express';",
        "const app = express();",
        "app.get('/api/tags', (req, res) => { res.json([]); });",
        "app.get('/api/user', (req, res) => { res.json({}); });",
        "",
      ].join("\n"),
    }, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "h3b",
      repos: [{ id: "api", path: "api", role: "api", apiBase: ["conduit.example.io"] }, { id: "ui", path: "ui", role: "ui" }],
      links: [],
    }));
    return root;
  }

  it("writes call: chains and uiReach, byte-identical on warm and cold re-runs", async () => {
    const root = workspace();
    await runIndex(root);
    const path = join(root, ".codeloom", "chains.json");
    const first = readFileSync(path, "utf8");
    const file = ChainsFileSchema.parse(JSON.parse(first));
    // v0.2a §4: the class page's componentWillMount reaches Tags.getAll.
    expect(file.chains.filter((c) => c.entry.startsWith("call:")).map((c) => c.name).sort()).toEqual([
      "GET /api/user · Auth.current",
    ]);
    expect(file.uiReach!.map((f) => [f.symbol, f.path, f.reached])).toEqual([
      ["Tags.getAll", "/api/tags", true], ["Auth.current", "/api/user", false],
    ]);
    expect((await runIndex(root)).linker.wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
    for (const repo of ["api", "ui"]) rmSync(join(root, repo, ".codeloom", "fingerprints.json"), { force: true });
    await runIndex(root);
    expect(readFileSync(path, "utf8")).toBe(first);
  }, 60_000);
});

describe("backend reach ignores guessed edges and role-ui repos (final review item 3)", () => {
  const agentJs = [
    "export const Articles = {",
    "  all: () => fetch('/api/articles'),",
    "};",
    "",
  ].join("\n");
  const serverJs = [
    "export function getY(req, res) {",
    "  return res.json(cache.all());",
    "}",
    "",
  ].join("\n");
  const homeJs = "export default function Home() { return null; }\n";
  const articlesRoute: Route = {
    method: "GET", path: "/api/articles", handler: "getY", inline: false, framework: "express",
    at: { file: "src/routes.js", line: 1, symbol: "<module>" }, handlerFile: "src/server.js",
  };

  it("a backend handler's guessed call into UI code does not make that UI call backend", () => {
    const app = repo("app", {
      pages: [{ route: "/", file: "src/pages/Home.js", line: 1, framework: "react-router", component: { name: "Home", importSource: "./pages/Home" } }],
      routes: [articlesRoute],
      httpCalls: [fetchCall("src/agent.js", 2, "Articles.all", "GET", "/api/articles")],
    });
    const files = { "src/agent.js": agentJs, "src/server.js": serverJs, "src/pages/Home.js": homeJs };
    // Sanity: the guess edge really exists, so the old walk would have followed it.
    const resolver = resolverFor(files, "app");
    expect(resolver.callersOf({ repo: "app", file: "src/agent.js", symbol: "Articles.all" })
      .map(({ from, call }) => `${from.symbol}@${call.confidence}`)).toEqual(["getY@guess"]);

    const { links, chains } = link([app], { app: files });
    expect(links.uiReach.map((f) => `${f.symbol}:${f.reached}`)).toEqual(["Articles.all:false"]);
    expect(chains.filter((c) => c.entry.startsWith("call:")).map((c) => c.entry)).toEqual(["call:app:src/agent.js#Articles.all"]);
  });

  it("a role-ui repo with no detected pages keeps its calls as UI calls", () => {
    const ui = repo("ui", { httpCalls: [fetchCall("src/agent.js", 2, "Articles.all", "GET", "/api/articles")] }, { role: "ui" });
    const api = repo("api", { routes: [{ ...articlesRoute, handler: "GET /api/articles", inline: true, handlerFile: undefined }] }, { role: "api" });
    const { links, chains } = link([ui, api], { ui: { "src/agent.js": agentJs } });
    expect(links.uiReach.map((f) => `${f.repo}:${f.symbol}:${f.reached}`)).toEqual(["ui:Articles.all:false"]);
    expect(chains.filter((c) => c.entry.startsWith("call:")).map((c) => c.entry)).toEqual(["call:ui:src/agent.js#Articles.all"]);
  });
});
