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

  it("treats any receiver's .create({ baseURL }) bound to a variable as a client (deliberately permissive)", () => {
    expect(clients(`export const client = got.create({ baseURL: "/api" });`)).toEqual(["client got baseLiteral=/api"]);
  });

  it("records a client with no options as having neither baseLiteral nor baseExpr", () => {
    const [found] = detectHttpClients(parsed("src/lib.ts", `export const api = axios.create();`));
    expect(found).toMatchObject({ name: "api", factory: "axios" });
    expect(found).not.toHaveProperty("baseLiteral");
    expect(found).not.toHaveProperty("baseExpr");
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
});
