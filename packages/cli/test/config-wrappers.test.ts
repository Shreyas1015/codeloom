import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { linkUi } from "../src/linker/link.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import { ChainsFileSchema } from "../src/store/schemas.js";
import type { EndpointsFile, UiPage } from "../src/store/schemas.js";
import { ctxWith, parsed } from "./adapter-helpers.js";
import { makeRepo } from "./helpers.js";

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

const route = (method: EndpointsFile["routes"][number]["method"], path: string): EndpointsFile["routes"][number] => ({
  method, path, handler: `${method} ${path}`, inline: true, framework: "express",
  at: { file: "src/routes.ts", line: 1, symbol: `${method} ${path}` },
});

/** Resolve "./x", "../x" and "@/x" against the ui files by basename, like the indexer's alias resolution. */
function resolverOf(files: string[]) {
  return (from: string, spec: string): string | null => {
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
    const name = spec.split("/").pop()!;
    return files.find((f) => f.replace(/\.(t|j)sx?$/, "").endsWith(`/${name}`)) ?? null;
  };
}

/** A UI repo indexed for real (adapters + code index) and an API repo with the given routes and apiBase. */
function link(uiFiles: Record<string, string>, pages: UiPage[], apiBase = ["VITE_API_URL"]) {
  const ctx = ctxWith("axios", "react", "react-router-dom");
  const rels = Object.keys(uiFiles);
  const ep = finalizeEndpoints("ui", rels.map((rel) => runAdapters(rel, uiFiles[rel]!, ctx)), resolverOf(rels));
  const idx: RepoCodeIndex = new Map(rels.map((rel) => [rel, buildFileCodeIndex(parsed(rel, uiFiles[rel]!))]));
  const ui: RepoData = { ref: { id: "ui", path: "ui", role: "ui" }, abs: "/ws/ui", graph: graphStub(), endpoints: { ...ep, pages } };
  const apiEp: EndpointsFile = {
    version: 2, repo: "api", pages: [], httpCalls: [], httpClients: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [],
    routes: [route("GET", "/customers"), route("POST", "/customers"), route("GET", "/customers/:id"), route("DELETE", "/invoices/:id")],
  };
  const api: RepoData = { ref: { id: "api", path: "api", role: "api", apiBase }, abs: "/ws/api", graph: graphStub(), endpoints: apiEp };
  const other: RepoData = {
    ref: { id: "billing", path: "billing", role: "api", apiBase: ["VITE_BILLING_URL"] }, abs: "/ws/billing", graph: graphStub(),
    endpoints: { ...apiEp, repo: "billing", routes: [route("GET", "/customers")] },
  };
  const ws: WorkspaceData = { root: "/ws", name: "ws", repos: [ui, api, other], links: [] };
  const resolvers = new Map([
    ["ui", createCallResolver({ repo: "ui", index: idx, files: new Set(rels), aliases: [] })],
  ]);
  return linkUi({ ws, resolvers });
}

const show = (links: ReturnType<typeof link>) => links.map((l) => [
  `${l.call.at.file}#${l.call.at.symbol}`,
  `${l.call.method} ${l.call.path}`,
  l.call.via ?? "adapter",
  l.target.kind === "route" ? `${l.target.route.repo}:${l.target.route.route.method} ${l.target.route.effectivePath} (${l.target.confidence})` : `${l.target.kind}`,
  l.pages.map((p) => `${p.page.route}:${p.path.map((s) => s.symbol).join(">")}`).join(","),
]);

const clientTs = `import axios from "axios";
const API_URL = import.meta.env.VITE_API_URL;
const client = axios.create({ baseURL: API_URL });
export default client;
`;

const httpTs = `import client from "./client";
export async function httpClient({ method, url, data }) {
  const response = await client({ method, url, data });
  return response.data;
}
`;

describe("config-object HTTP calls through an axios instance (hardening H2)", () => {
  it("links page -> hook -> data function -> client(config) to the API route chosen by apiBase", () => {
    const links = link({
      "src/api/client.ts": clientTs,
      "src/api/customers.ts": `import client from "./client";
export async function getCustomer(id) {
  const config = { method: "GET", url: \`/customers/\${id}\` };
  const res = await client(config);
  return res.data;
}
export const listCustomers = () => client({ url: "/customers" });
`,
      "src/hooks/useCustomer.ts": `import { getCustomer, listCustomers } from "../api/customers";
export function useCustomer(id) { return getCustomer(id); }
export function useCustomers() { return listCustomers(); }
`,
      "src/pages/CustomerPage.tsx": `import { useCustomer, useCustomers } from "../hooks/useCustomer";
export default function CustomerPage() { const c = useCustomer("1"); const all = useCustomers(); return <div>{c}{all}</div>; }
`,
    }, [{ route: "/customers/:id", file: "src/pages/CustomerPage.tsx", line: 2, framework: "react-router", component: { name: "CustomerPage" } }]);
    // GET /customers exists in both backends: the client's env base (VITE_API_URL) picks "api" via apiBase.
    expect(show(links)).toEqual([
      ["src/api/customers.ts#getCustomer", "GET /customers/:id", "adapter", "api:GET /customers/:id (exact)",
        "/customers/:id:CustomerPage>useCustomer>getCustomer"],
      ["src/api/customers.ts#listCustomers", "GET /customers", "adapter", "api:GET /customers (exact)",
        "/customers/:id:CustomerPage>useCustomers>listCustomers"],
    ]);
  });

  it("turns calls to a { method, url } wrapper into HTTP calls at the caller, at best param", () => {
    const links = link({
      "src/api/client.ts": clientTs,
      "src/api/http.ts": httpTs,
      "src/api/customers.ts": `import { httpClient } from "./http";
export const listCustomers = () => httpClient({ method: "GET", url: "/customers" });
export const createCustomer = (data) => httpClient({ method: "post", url: "/customers", data });
export const removeInvoice = (id) => httpClient({ method: "DELETE", url: \`/invoices/\${id}\` });
export function lookup(id) {
  const config = { url: \`/customers/\${id}\` };
  return httpClient(config);
}
`,
    }, []);
    const derived = links.filter((l) => l.call.via === "wrapper");
    expect(show(derived)).toEqual([
      ["src/api/customers.ts#listCustomers", "GET /customers", "wrapper", "api:GET /customers (exact)", ""],
      ["src/api/customers.ts#createCustomer", "POST /customers", "wrapper", "api:POST /customers (exact)", ""],
      ["src/api/customers.ts#removeInvoice", "DELETE /invoices/:id", "wrapper", "api:DELETE /invoices/:id (exact)", ""],
      ["src/api/customers.ts#lookup", "GET /customers/:id", "wrapper", "api:GET /customers/:id (exact)", ""],
    ]);
    expect(derived.every((l) => l.call.confidence === "param")).toBe(true);
    // The wrapper's own inner call has no readable url: reported unresolved, never guessed.
    expect(show(links.filter((l) => l.call.via !== "wrapper"))).toEqual([
      ["src/api/http.ts#httpClient", "GET ", "adapter", "unresolved", ""],
    ]);
  });

  it("follows a request(config) wrapper and a wrapper with its own base", () => {
    const links = link({
      "src/api/client.ts": clientTs,
      "src/api/request.ts": `import client from "./client";
const BILLING = import.meta.env.VITE_BILLING_URL;
export function request(config) { return client.request(config); }
export function billing({ method, url }) { return client({ method, url: \`\${BILLING}\${url}\` }); }
`,
      "src/api/customers.ts": `import { request, billing } from "./request";
export const one = (id) => request({ url: \`/customers/\${id}\` });
export const billed = () => billing({ url: "/customers" });
`,
    }, []);
    expect(show(links.filter((l) => l.call.via === "wrapper"))).toEqual([
      ["src/api/customers.ts#one", "GET /customers/:id", "wrapper", "api:GET /customers/:id (exact)", ""],
      ["src/api/customers.ts#billed", "GET /customers", "wrapper", "billing:GET /customers (exact)", ""],
    ]);
    const billed = links.find((l) => l.call.at.symbol === "billed")!;
    expect(billed.call.base).toBe("import.meta.env.VITE_BILLING_URL");
    expect(billed.target.kind === "route" && billed.target.route.repo).toBe("billing");
  });

  it("leaves a wrapper call whose method or url cannot be read unresolved", () => {
    const links = link({
      "src/api/client.ts": clientTs,
      "src/api/http.ts": httpTs,
      "src/api/customers.ts": `import { httpClient } from "./http";
export const a = (m) => httpClient({ method: m, url: "/customers" });
export const b = (u) => httpClient({ method: "GET", url: u });
export const c = (cfg) => httpClient(cfg);
`,
    }, []);
    expect(show(links.filter((l) => l.call.via === "wrapper"))).toEqual([
      ["src/api/customers.ts#a", "GET ", "wrapper", "unresolved", ""],
      ["src/api/customers.ts#b", "GET ", "wrapper", "unresolved", ""],
      ["src/api/customers.ts#c", "GET ", "wrapper", "unresolved", ""],
    ]);
  });

  it("does not treat a function forwarding a config to a non-client as a wrapper", () => {
    const links = link({
      "src/lib/log.ts": "export function record(e) { return e; }\n",
      "src/api/http.ts": `import { record } from "../lib/log";
export function track({ method, url }) { return record({ method, url }); }
`,
      "src/api/customers.ts": `import { track } from "./http";
export const a = () => track({ method: "GET", url: "/customers" });
`,
    }, []);
    expect(links).toEqual([]);
  });
});

describe("codeloom index: axios instance + config wrapper workspace (hardening H2)", () => {
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "codeloom-h2-"));
    makeRepo({
      "package.json": JSON.stringify({ name: "web", dependencies: { axios: "^1", react: "^18", "react-router-dom": "^6" } }),
      "src/api/client.ts": clientTs,
      "src/api/http.ts": httpTs,
      "src/api/customers.ts": [
        "import client from './client';",
        "import { httpClient } from './http';",
        "export async function getCustomer(id: string) {",
        "  const config = { method: 'GET', url: `/customers/${id}` };",
        "  const res = await client(config);",
        "  return res.data;",
        "}",
        "export const createCustomer = (data: unknown) => httpClient({ method: 'POST', url: '/customers', data });",
        "",
      ].join("\n"),
      "src/hooks/useCustomer.ts": [
        "import { getCustomer, createCustomer } from '../api/customers';",
        "export function useCustomer(id: string) { return getCustomer(id); }",
        "export function useCreateCustomer() { return (d: unknown) => createCustomer(d); }",
        "",
      ].join("\n"),
      "src/pages/CustomerPage.tsx": [
        "import { useCustomer, useCreateCustomer } from '../hooks/useCustomer';",
        "export default function CustomerPage() { const c = useCustomer('1'); const save = useCreateCustomer(); return <button onClick={() => save(c)} />; }",
        "",
      ].join("\n"),
      "src/App.tsx": [
        "import { Route, Routes } from 'react-router-dom';",
        "import CustomerPage from './pages/CustomerPage';",
        "export const App = () => <Routes><Route path=\"/customers/:id\" element={<CustomerPage />} /></Routes>;",
        "",
      ].join("\n"),
    }, join(root, "web"));
    makeRepo({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "^4" } }),
      "src/app.ts": [
        "import express from 'express';",
        "const app = express();",
        "app.get('/customers/:id', (req, res) => { res.json({}); });",
        "app.post('/customers', (req, res) => { res.json({}); });",
        "",
      ].join("\n"),
    }, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "h2",
      repos: [{ id: "api", path: "api", role: "api", apiBase: ["VITE_API_URL"] }, { id: "web", path: "web", role: "ui" }],
      links: [],
    }));
    return root;
  }

  it("links both calls from the page, and re-runs byte-identical", async () => {
    const root = workspace();
    await runIndex(root);
    const path = join(root, ".codeloom", "chains.json");
    const first = readFileSync(path, "utf8");
    const file = ChainsFileSchema.parse(JSON.parse(first));
    expect(file.uiReach!.map((f) => [f.symbol, f.method, f.path, f.reached])).toEqual([
      ["getCustomer", "GET", "/customers/:id", true],
      ["createCustomer", "POST", "/customers", true],
    ]);
    const routeKeys = file.chains.filter((c) => c.entry.startsWith("page:")).map((c) => c.routeKey).sort();
    expect(routeKeys).toEqual(expect.arrayContaining([expect.stringContaining("GET /customers/:id"), expect.stringContaining("POST /customers")]));
    expect((await runIndex(root)).linker.wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
  });
});
