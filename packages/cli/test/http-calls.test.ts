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

// ---------------------------------------------------------------------------------------------------
// Task 4 follow-up (spec §4): generated-client verbs (openapi-fetch's client.GET/POST/...) and a local
// single-argument factory whose literal call-site argument flows into a templated baseUrl.
// ---------------------------------------------------------------------------------------------------

describe("detectHttpCalls — generated client verbs", () => {
  it("recognizes uppercase method-style calls (openapi-fetch's client.GET/POST/...)", () => {
    expect(calls(`
      export function getCustomer(id: string) { return apiClient.GET("/customers/{id}", { params: { path: { id } } }); }
      export function createCustomer(body: unknown) { return apiClient.POST("/customers", { body }); }
    `)).toEqual([
      "GET [/customers/{id}] ok literal @getCustomer",
      "POST [/customers] ok literal @createCustomer",
    ]);
  });

  it("still finds ordinary lowercase method-style calls (no regression)", () => {
    expect(calls(`export const list = () => apiClient.get("/customers");`)).toEqual(["GET [/customers] ok literal @list"]);
  });
});

describe("detectHttpClients — local client factories", () => {
  const clients = (code: string) =>
    detectHttpClients(parsed("src/lib.ts", code)).map(
      (c) => `${c.name} ${c.factory}${c.baseLiteral ? ` baseLiteral=${c.baseLiteral}` : ""}${c.baseExpr ? ` baseExpr=${c.baseExpr}` : ""}`,
    );

  it("folds a single-literal-argument factory's templated baseUrl into each call site's own client", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(path) { return path; }
      function backendClient(backend) {
        const client = createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) });
        return client;
      }
      export const apiClient = backendClient("api");
      export const billingClient = backendClient("billing");
    `)).toEqual([
      "apiClient createClient baseLiteral=/api/api",
      "billingClient createClient baseLiteral=/api/billing",
    ]);
  });

  it("folds an arrow factory whose body is a single return expression (no intermediate const)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      const backendClient = (backend) => createClient({ baseUrl: \`/api/\${backend}\` });
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("does not fold when the call-site argument isn't a literal", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) { return createClient({ baseUrl: \`/api/\${backend}\` }); }
      export function make(name) { return backendClient(name); }
    `)).toEqual([]);
  });

  it("does not fold a factory whose baseUrl has a dynamic piece beyond its own parameter", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) { return createClient({ baseUrl: \`/api/\${backend}/\${suffix}\` }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("requires a baseUrl/baseURL/prefixUrl option on the bare factory call (the existing client-creation signal)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) { return createClient({ headers: { backend } }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not treat a two-parameter function as a factory (narrow, single-argument pattern only)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend, extra) { return createClient({ baseUrl: \`/api/\${backend}\` }); }
      export const apiClient = backendClient("api", "x");
    `)).toEqual([]);
  });

  // Review fix 6: a bare call needs a real import signal, not just a baseUrl option (which an unrelated
  // helper like `buildLink({ baseUrl })` could carry too).
  it("does not fold a bare call whose callee is not imported from a known client package", () => {
    expect(clients(`
      function buildLink(opts) { return opts; }
      function backendClient(backend) { return buildLink({ baseUrl: \`/api/\${backend}\` }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("folds a bare call imported from a known client package under any local name", () => {
    expect(clients(`
      import makeClient from "openapi-fetch";
      function backendClient(backend) { return makeClient({ baseUrl: \`/api/\${backend}\` }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient makeClient baseLiteral=/api/api"]);
  });

  // Review fix 3(a): a reassigned or incremented parameter must never be folded — its value at return
  // time is not simply the call-site argument.
  it("does not fold when the factory reassigns its parameter", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        backend = backend + "-v2";
        return createClient({ baseUrl: \`/api/\${backend}\` });
      }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not fold when the factory increments/decrements its parameter", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        backend++;
        return createClient({ baseUrl: \`/api/\${backend}\` });
      }
      export const apiClient = backendClient(1);
    `)).toEqual([]);
  });

  // Review fix 1 (round 2, item 2): a destructuring reassignment of the parameter must be caught too,
  // not just a bare `name = ...` or `++`/`--`.
  it("does not fold when the factory reassigns its parameter via array destructuring", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        [backend] = ["x"];
        return createClient({ baseUrl: \`/api/\${backend}\` });
      }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not fold when the factory reassigns its parameter via object destructuring", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        ({ backend } = { backend: "x" });
        return createClient({ baseUrl: \`/api/\${backend}\` });
      }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  // Review fix 3(b): the intermediate binding must be `const` — a `let` that gets reassigned before
  // `return` would make the returned value something other than what the first declaration bound.
  it("does not fold through a `let` intermediate binding", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        let client = createClient({ baseUrl: \`/api/\${backend}\` });
        client = otherClient();
        return client;
      }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("still folds through a `const` intermediate binding (no regression)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        const client = createClient({ baseUrl: \`/api/\${backend}\` });
        return client;
      }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  // Review fix 3 (round 2, item 3): the module-level binding of the factory's own result must also be
  // `const` — a `let` that later gets reassigned would make the name mean something other than the
  // folded factory call.
  it("does not fold when the module-level binding of the factory call itself is `let`", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) { return createClient({ baseUrl: \`/api/\${backend}\` }); }
      export let apiClient = backendClient("api");
      apiClient = null;
    `)).toEqual([]);
  });

  it("still folds a module-level `const` binding of the factory call (no regression)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) { return createClient({ baseUrl: \`/api/\${backend}\` }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  // Review fix 3(c): only a local "origin wrapper" (returns its own parameter, optionally origin-prefixed)
  // is unwrapped around the baseUrl template — a call that could reshape the path (e.g. append a version)
  // must leave the factory unfolded rather than being trusted as transparent.
  it("does not fold through a wrapper call that appends to the path instead of merely returning it", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function withVersion(path) { return \`\${path}/v2\`; }
      function backendClient(backend) { return createClient({ baseUrl: withVersion(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("still unwraps a one-argument origin wrapper that merely returns its own parameter (no regression)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(path) { return path; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("unwraps an origin wrapper that prefixes an origin expression before its own parameter", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(path) { return \`\${location.origin}\${path}\`; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("also unwraps window.location.origin and globalThis.location.origin prefixes (no regression)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin1(path) { return \`\${window.location.origin}\${path}\`; }
      function backendClient1(backend) { return createClient({ baseUrl: sameOrigin1(\`/api/\${backend}\`) }); }
      export const apiClient1 = backendClient1("api");

      function sameOrigin2(path) { return \`\${globalThis.location.origin}\${path}\`; }
      function backendClient2(backend) { return createClient({ baseUrl: sameOrigin2(\`/api/\${backend}\`) }); }
      export const apiClient2 = backendClient2("api");
    `)).toEqual([
      "apiClient1 createClient baseLiteral=/api/api",
      "apiClient2 createClient baseLiteral=/api/api",
    ]);
  });

  // Review fix 1 (round 2): an origin wrapper's prefix must be empty or exactly an origin reference —
  // round 1 trusted *any* one-argument prefix, so a wrapper that actually changes the host (or just adds
  // a fixed path segment) was wrongly treated as transparent.
  it("does not unwrap a wrapper whose prefix is a fixed literal path segment (not an origin)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      const gateway = (p) => \`/gateway\${p}\`;
      function backendClient(backend) { return createClient({ baseUrl: gateway(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a wrapper whose prefix is a string + concat (not an origin)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function gateway(p) { return "/gateway" + p; }
      function backendClient(backend) { return createClient({ baseUrl: gateway(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a wrapper whose prefix is a free variable, even one initialised from a literal (not an origin)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      const GW = "/gateway";
      function gateway(p) { return \`\${GW}\${p}\`; }
      function backendClient(backend) { return createClient({ baseUrl: gateway(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a wrapper whose prefix is a third-party absolute URL (not an origin)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function gateway(p) { return \`https://pay.example.com\${p}\`; }
      function backendClient(backend) { return createClient({ baseUrl: gateway(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  // Review fix (round 3): a conditional origin check — the real-world SSR/test-fallback shape — is now
  // also trusted, but only when at least one branch is the real `location.origin`-family check and every
  // other branch is the parameter alone or a *path-free* origin (a bare scheme+host literal, or an
  // unresolved `process.env.X`/`import.meta.env.X` read) — never a literal or host that carries a path.
  it("unwraps the real-world SSR-fallback shape: a conditional inside the template, origin in one branch, a path-free literal in the other", () => {
    // Recreated with neutral names from the actual app's own helper (ADR-004): same-origin in the
    // browser, a fixed localhost fallback outside it (SSR / tests), where `fetch` cannot resolve a
    // relative URL.
    expect(clients(`
      import createClient from "openapi-fetch";
      const sameOrigin = (path) =>
        \`\${typeof window === "undefined" ? "http://localhost" : window.location.origin}\${path}\`;
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("unwraps a top-level conditional (not nested in a template) with a path-free literal + origin.location, either branch order", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) { return cond ? "http://localhost:3000" + p : window.location.origin + p; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("unwraps an if/else (not just a ternary) returning in each branch, one of them the real origin check", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) {
        if (typeof window === "undefined") { return "http://localhost" + p; }
        else { return window.location.origin + p; }
      }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("unwraps a conditional whose only env-var branch is a bare process.env/import.meta.env read", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) { return cond ? process.env.FALLBACK_ORIGIN + p : window.location.origin + p; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("does not unwrap a conditional whose non-origin branch's literal carries a path (round 3's own example)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) { return cond ? "https://pay.example.com/v2" + p : window.location.origin + p; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a conditional whose non-origin branch is a fixed path segment, not a host (round 3's own example)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) { return cond ? "/gateway" + p : window.location.origin + p; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a conditional with no real origin-check branch at all (two path-free hosts, neither is location.origin)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) { return cond ? "http://localhost:3000" + p : "http://localhost:4000" + p; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a conditional whose non-origin branch returns a free variable instead of the parameter", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) { return cond ? otherVar : window.location.origin + p; }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("still rejects a single (non-conditional) path-free-origin prefix with no real origin check at all (no regression)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function gateway(p) { return "http://localhost:3000" + p; }
      function backendClient(backend) { return createClient({ baseUrl: gateway(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("follows a nested conditional (a conditional inside one branch of another) the same way", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) {
        return cond1
          ? (cond2 ? "http://localhost:3000" + p : window.location.origin + p)
          : p;
      }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  // Review fix (round 4): a guard clause with no `else` hid its own return from every earlier version
  // of this (which only looked at a block's top-level statements, or a single top-level if/else) — so
  // the function looked, to the old code, as if it always ran its final statement. Both of the review's
  // own bad examples must still not fold once the guard's own return is actually seen and classified.
  it("does not unwrap a wrapper whose guard clause (no else) returns the parameter with text appended", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) {
        if (condA) { return p + "/v2"; }
        return window.location.origin + p;
      }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not unwrap a wrapper whose guard clause (no else) returns a real-looking third-party host with no path", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) {
        if (condA) { return \`https://pay.example.com\${p}\`; }
        return window.location.origin + p;
      }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("unwraps a guard clause (no else) whose own return is itself a valid origin leaf (a loopback fallback)", () => {
    // Every return now classifies cleanly: the guard's `"http://localhost:3000" + p` is a path-free
    // (loopback) origin, the fall-through `window.location.origin + p` is the real origin check — so
    // this one does fold, the same as the equivalent ternary/if-else-with-both-arms shapes already do.
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) {
        if (typeof window === "undefined") return "http://localhost:3000" + p;
        return window.location.origin + p;
      }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual(["apiClient createClient baseLiteral=/api/api"]);
  });

  it("does not fold a factory with an early return of a different client (a guard clause the old top-level-only check never saw)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        if (useOther) { return otherClient; }
        const client = createClient({ baseUrl: \`/api/\${backend}\` });
        return client;
      }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  // allReturns' own fail-safe: a construct it does not model anywhere in the body means never fold,
  // for both the wrapper and the factory.
  it("does not unwrap an origin wrapper whose body contains a loop (unmodeled control flow)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function sameOrigin(p) {
        for (const x of []) { /* no-op */ }
        return window.location.origin + p;
      }
      function backendClient(backend) { return createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) }); }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });

  it("does not fold a factory whose body contains a try/catch (unmodeled control flow)", () => {
    expect(clients(`
      import createClient from "openapi-fetch";
      function backendClient(backend) {
        try {
          const client = createClient({ baseUrl: \`/api/\${backend}\` });
          return client;
        } catch (e) {
          throw e;
        }
      }
      export const apiClient = backendClient("api");
    `)).toEqual([]);
  });
});
