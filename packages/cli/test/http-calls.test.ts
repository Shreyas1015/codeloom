import { describe, expect, it } from "vitest";
import { detectHttpCalls, detectHttpClients } from "../src/adapters/http-calls.js";
import { parsed } from "./adapter-helpers.js";

const calls = (code: string) =>
  detectHttpCalls(parsed("src/lib.ts", code)).map(
    (c) => `${c.method} [${c.path}] ${c.resolved ? "ok" : "?"} ${c.kind}${c.base ? ` base=${c.base}` : ""} @${c.at.symbol}`,
  );

describe("detectHttpCalls", () => {
  it("finds fetch with and without a method", () => {
    expect(calls(`
      export async function getCustomer(id: string) { return fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/customers/\${id}\`); }
      export async function saveCustomer(b: unknown) { return fetch("/api/customers", { method: "post", body: JSON.stringify(b) }); }
    `)).toEqual([
      "GET [/api/customers/:id] ok template base=process.env.NEXT_PUBLIC_API_URL @getCustomer",
      "POST [/api/customers] ok literal @saveCustomer",
    ]);
  });

  it("finds axios, client instances and this.http", () => {
    expect(calls(`
      import axios from "axios";
      export const api = axios.create({ baseURL: "/x" });
      export function useCreateCustomer() { return async (input: unknown) => api.post("/api/customers", input); }
      export const remove = (id: string) => axios.delete(\`/api/customers/\${id}\`);
      export const raw = () => axios({ url: "/api/ping", method: "PUT" });
      class CustomersClient { constructor(private http: any) {} list() { return this.http.get("/api/customers"); } }
    `)).toEqual([
      "POST [/api/customers] ok literal @useCreateCustomer",
      "DELETE [/api/customers/:id] ok template @remove",
      "PUT [/api/ping] ok literal @raw",
      "GET [/api/customers] ok literal @CustomersClient.list",
    ]);
  });

  it("keeps unresolved URLs honestly (empty path, kind unknown, no base)", () => {
    expect(calls(`export function go(url: string) { return fetch(url); }`)).toEqual(["GET [] ? unknown @go"]);
  });

  it("does not mistake route registrations for HTTP calls", () => {
    expect(calls(`app.get("/health", handler); router.post("/x", h);`)).toEqual([]);
  });

  it("does not mistake an in-file router/request object for a client call", () => {
    expect(
      calls(`
      import express from "express"; const api = express.Router(); api.get("/customers", list);
      export function h(request: any) { return request.get("Content-Type"); }
    `),
    ).toEqual([]);
  });

  it("finds client.request(config) like axios(config)", () => {
    expect(calls(`export const ping = () => axios.request({ url: "/api/ping", method: "PATCH" });`)).toEqual([
      "PATCH [/api/ping] ok literal @ping",
    ]);
  });

  it("still finds a real client variable named api", () => {
    expect(
      calls(`export const api = axios.create(); export const load = () => api.get("/api/customers");`),
    ).toEqual(["GET [/api/customers] ok literal @load"]);
  });

  it("does not drop a template URL whose base is an empty head (leading ${BASE})", () => {
    expect(
      calls(`
      export const api = axios.create();
      export const one = (id: string) => api.get(\`\${API}/customers/\${id}\`);
    `),
    ).toEqual(["GET [/customers/:id] ok template base=API @one"]);
  });

  it("resolves a router receiver name to its nearest in-scope declaration, not file-wide", () => {
    expect(
      calls(`
      function setupRouter() { const api = express.Router(); api.get("/health", h); return api; }
      export function useClient() { const api = axios.create(); return api.get("/api/customers"); }
    `),
    ).toEqual(["GET [/api/customers] ok literal @useClient"]);
  });

  it("sees a destructured binding and does not skip past it to an outer router", () => {
    expect(
      calls(`
      import express from "express";
      const api = express.Router();
      export function load() { const { api } = someClientFactory(); return api.get("/customers"); }
    `),
    ).toEqual(["GET [/customers] ok literal @load"]);
  });

  it("sees a renamed destructured binding (const { client: api } = make())", () => {
    expect(
      calls(`
      import express from "express";
      const api = express.Router();
      export function load2() { const { client: api } = make(); return api.get("/orders"); }
    `),
    ).toEqual(["GET [/orders] ok literal @load2"]);
  });
});

describe("detectHttpCalls — superagent (H2)", () => {
  it("finds superagent.get/post/put/del/delete when the file imports superagent", () => {
    expect(calls(`
      import superagent from "superagent";
      export const a = () => superagent.get("/api/tags");
      export const b = (body: unknown) => superagent.post("/api/users", body);
      export const c = () => superagent.put("/api/user");
      export const d = (slug: string) => superagent.del(\`/api/articles/\${slug}\`);
      export const e = (slug: string) => superagent.delete(\`/api/articles/\${slug}\`);
    `)).toEqual([
      "GET [/api/tags] ok literal @a",
      "POST [/api/users] ok literal @b",
      "PUT [/api/user] ok literal @c",
      "DELETE [/api/articles/:slug] ok template @d",
      "DELETE [/api/articles/:slug] ok template @e",
    ]);
  });

  it("finds a wrapped superagent binding (superagent-promise) and an `agent` receiver, import-gated", () => {
    expect(calls(`
      import superagentPromise from "superagent-promise";
      import _superagent from "superagent";
      const superagent = superagentPromise(_superagent, global.Promise);
      const agent = _superagent.agent();
      export const a = () => superagent.del("/api/x/1");
      export const b = () => agent.get("/api/y");
      export const c = () => _superagent.patch("/api/z");
    `)).toEqual([
      "DELETE [/api/x/1] ok literal @a",
      "GET [/api/y] ok literal @b",
      "PATCH [/api/z] ok literal @c",
    ]);
  });

  it("finds superagent required via CommonJS", () => {
    expect(calls(`
      const request = require("superagent");
      function go() { return request.del("/api/items/1"); }
    `)).toEqual(["DELETE [/api/items/1] ok literal @go"]);
  });

  it("does not treat .del() or an agent receiver as HTTP without a superagent import", () => {
    expect(calls(`
      const cache = makeCache();
      const agent = makeAgent();
      export const a = () => cache.del("/tmp/x");
      export const b = () => agent.get("/api/y");
      export const c = () => superagent.del("/api/z");
    `)).toEqual([]);
  });
});

describe("detectHttpClients", () => {
  const clients = (code: string) =>
    detectHttpClients(parsed("src/lib.ts", code)).map(
      (c) => `${c.name} ${c.factory}${c.baseLiteral ? ` baseLiteral=${c.baseLiteral}` : ""}${c.baseExpr ? ` baseExpr=${c.baseExpr}` : ""}`,
    );

  it("finds axios.create with a literal baseURL", () => {
    expect(clients(`export const api = axios.create({ baseURL: "/api" });`)).toEqual(["api axios baseLiteral=/api"]);
  });

  it("finds axios.create with a non-literal baseURL", () => {
    expect(clients(`export const billingApi = axios.create({ baseURL: process.env.NEXT_PUBLIC_BILLING_URL });`))
      .toEqual(["billingApi axios baseExpr=process.env.NEXT_PUBLIC_BILLING_URL"]);
  });

  it("finds ky.create and ky.extend with a prefixUrl", () => {
    expect(clients(`
      export const a = ky.create({ prefixUrl: "/api" });
      export const b = ky.extend({ prefixUrl: "/api/v2" });
    `)).toEqual(["a ky baseLiteral=/api", "b ky baseLiteral=/api/v2"]);
  });

  it("finds a known HTTP library's .create({ baseURL }) (got)", () => {
    expect(clients(`export const client = got.create({ baseURL: "/api" });`)).toEqual(["client got baseLiteral=/api"]);
  });

  it("keeps the host of an absolute literal baseURL as baseHost (lowercased, port kept)", () => {
    const [stripe] = detectHttpClients(parsed("src/lib.ts", `export const stripe = axios.create({ baseURL: "https://API.Stripe.com/v1" });`));
    expect(stripe).toMatchObject({ baseLiteral: "/v1", baseHost: "api.stripe.com" });
    const [local] = detectHttpClients(parsed("src/lib.ts", `export const api = axios.create({ baseURL: "http://localhost:3333/api" });`));
    expect(local).toMatchObject({ baseLiteral: "/api", baseHost: "localhost:3333" });
    const [rel] = detectHttpClients(parsed("src/lib.ts", `export const api = axios.create({ baseURL: "/api" });`));
    expect(rel).not.toHaveProperty("baseHost");
  });

  it("records a known library's client with no options as having neither baseLiteral nor baseExpr (axios.create() needs no baseURL)", () => {
    const [found] = detectHttpClients(parsed("src/lib.ts", `export const api = axios.create();`));
    expect(found).toMatchObject({ name: "api", factory: "axios" });
    expect(found).not.toHaveProperty("baseLiteral");
    expect(found).not.toHaveProperty("baseExpr");
  });

  it("does not treat an unknown builder/factory's .create(...) as an HTTP client", () => {
    expect(
      clients(`
      const store = createStore.create();
      const builder = Query.create({ limit: 1 });
    `),
    ).toEqual([]);
  });

  it("treats an unknown receiver's .create({ baseURL }) as a client (factory heuristic)", () => {
    expect(clients(`const api = makeClient.create({ baseURL: "/api" });`)).toEqual(["api makeClient baseLiteral=/api"]);
  });

  it("ignores a create() call that isn't bound to a variable", () => {
    expect(clients(`doSomething(axios.create({ baseURL: "/x" }));`)).toEqual([]);
  });

  it("does not treat ky.extend's plain siblings (not .create/.extend) as clients", () => {
    expect(clients(`export const x = ky.get("/api/customers");`)).toEqual([]);
  });

  it("records the declaration line", () => {
    const [found] = detectHttpClients(parsed("src/lib.ts", `\n\nexport const api = axios.create({ baseURL: "/api" });`));
    expect(found!.line).toBe(3);
  });

  it("captures a bare `baseUrl` option (not just baseURL/prefixUrl)", () => {
    expect(clients(`const api = makeClient.create({ baseUrl: "/api" });`)).toEqual(["api makeClient baseLiteral=/api"]);
  });

  it("recognizes a renamed default import of a known HTTP library", () => {
    expect(
      clients(`
      import Axios from "axios";
      export const api = Axios.create();
    `),
    ).toEqual(["api axios"]);
  });

  it("recognizes a known HTTP library required under a local binding", () => {
    expect(
      clients(`
      const http = require("got");
      const c = http.create({ prefixUrl: "/x" });
    `),
    ).toEqual(["c got baseLiteral=/x"]);
  });

  it("recognizes CJS interop's `<knownLib>.default.create(...)`", () => {
    expect(clients(`export const api = axios.default.create();`)).toEqual(["api axios"]);
  });

  it("does not treat a renamed import of an unknown module as a known library", () => {
    expect(
      clients(`
      import Thing from "./thing";
      const t = Thing.create();
    `),
    ).toEqual([]);
  });
});

describe("H2 fix — type-only superagent imports and fetch init", () => {
  it("does not open the superagent gate on a type-only import", () => {
    expect(calls(`
      import type { SuperAgentStatic } from "superagent";
      import type superagent from "superagent";
      const cache = makeCache();
      export const a = () => cache.del("/tmp/x");
      export const c = () => superagent.del("/api/z");
    `)).toEqual([]);
  });

  it("keeps GET for a direct fetch with a non-literal or spread-only init", () => {
    expect(calls(`
      export const a = (init: RequestInit) => fetch("/api/a", init);
      export const b = (opts: RequestInit) => fetch("/api/b", { ...opts });
    `)).toEqual(["GET [/api/a] ok literal @a", "GET [/api/b] ok literal @b"]);
  });
});

describe("detectHttpCalls — axios instances and config calls (hardening H2)", () => {
  const callsWithClient = (code: string) =>
    detectHttpCalls(parsed("src/lib.ts", code)).map(
      (c) => `${c.method} [${c.path}] ${c.kind}${c.base ? ` base=${c.base}` : ""} client=${c.client} @${c.at.symbol}`,
    );

  it("treats any local axios.create instance as a client, whatever its name", () => {
    expect(callsWithClient(`
      import axios from "axios";
      const backend = axios.create({ baseURL: "/v1" });
      export const listInvoices = () => backend.get("/invoices");
      export const removeInvoice = (id: string) => backend.delete(\`/invoices/\${id}\`);
    `)).toEqual([
      "GET [/invoices] literal client=backend @listInvoices",
      "DELETE [/invoices/:id] template client=backend @removeInvoice",
    ]);
  });

  it("finds client(config) with an object literal: method from config.method (default GET), url from config.url", () => {
    expect(callsWithClient(`
      import axios from "axios";
      const backend = axios.create({ baseURL: process.env.API_URL });
      export const createInvoice = (data: unknown) => backend({ method: "post", url: "/invoices", data });
      export const listInvoices = () => backend({ url: "/invoices" });
    `)).toEqual([
      "POST [/invoices] literal client=backend @createInvoice",
      "GET [/invoices] literal client=backend @listInvoices",
    ]);
  });

  it("follows a const config declared earlier in the same function (one level)", () => {
    expect(callsWithClient(`
      import axios from "axios";
      const backend = axios.create({});
      export async function getCustomer(id: string) {
        const config = { method: "GET", url: \`\${process.env.API_URL}/customers/\${id}\` };
        const res = await backend(config);
        return res.data;
      }
    `)).toEqual([
      "GET [/customers/:id] template base=process.env.API_URL client=backend @getCustomer",
    ]);
  });

  it("follows a config const for plain axios(config) too", () => {
    expect(callsWithClient(`
      import axios from "axios";
      export function saveCustomer(data: unknown) {
        const config = { method: "put", url: "/customers", data };
        return axios(config);
      }
    `)).toEqual(["PUT [/customers] literal client=axios @saveCustomer"]);
  });

  it("does not guess a config it cannot read: the call stays unknown", () => {
    expect(callsWithClient(`
      import axios from "axios";
      const backend = axios.create({});
      export function send(config: any) { return backend(config); }
      export function sendBuilt() { const config = buildConfig(); return backend(config); }
      export function sendNoUrl() { return backend({ method: "get" }); }
    `)).toEqual([
      "GET [] unknown client=backend @send",
      "GET [] unknown client=backend @sendBuilt",
      "GET [] unknown client=backend @sendNoUrl",
    ]);
  });

  it("ignores a call to a non-client function that takes a { url } object", () => {
    expect(callsWithClient(`
      function track(e: any) {}
      export const go = () => track({ url: "/customers" });
    `)).toEqual([]);
  });

  it("uses import.meta.env and process.env bases, and module consts initialised from them", () => {
    expect(callsWithClient(`
      import axios from "axios";
      const backend = axios.create({});
      const API_URL = import.meta.env.VITE_API_URL;
      const BILLING = process.env.BILLING_URL || "http://localhost:4000";
      export const a = () => backend.get(\`\${import.meta.env.VITE_API_URL}/customers\`);
      export const b = () => backend({ url: \`\${API_URL}/customers\` });
      export const c = () => backend.post(BILLING + "/invoices");
    `)).toEqual([
      "GET [/customers] literal base=import.meta.env.VITE_API_URL client=backend @a",
      "GET [/customers] literal base=import.meta.env.VITE_API_URL client=backend @b",
      "POST [/invoices] literal base=process.env.BILLING_URL client=backend @c",
    ]);
  });
});

describe("detectHttpClients — env-backed baseURL (hardening H2)", () => {
  it("resolves a baseURL module const initialised from an env var to the env access", () => {
    const clients = detectHttpClients(parsed("src/client.ts", `
      import axios from "axios";
      const API_URL = import.meta.env.VITE_API_URL ?? "";
      export const backend = axios.create({ baseURL: API_URL });
    `));
    expect(clients).toMatchObject([{ name: "backend", baseExpr: "import.meta.env.VITE_API_URL" }]);
  });
});
