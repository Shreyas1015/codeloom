import { describe, expect, it } from "vitest";
import { detectHttpCalls } from "../src/adapters/http-calls.js";
import { parsed } from "./adapter-helpers.js";

const calls = (code: string) =>
  detectHttpCalls(parsed("src/lib.ts", code)).map((c) => `${c.method} ${c.path} ${c.resolved ? "ok" : "?"} @${c.at.symbol}`);

describe("detectHttpCalls", () => {
  it("finds fetch with and without a method", () => {
    expect(calls(`
      export async function getCustomer(id: string) { return fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/customers/\${id}\`); }
      export async function saveCustomer(b: unknown) { return fetch("/api/customers", { method: "post", body: JSON.stringify(b) }); }
    `)).toEqual(["GET /api/customers/:id ok @getCustomer", "POST /api/customers ok @saveCustomer"]);
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
      "POST /api/customers ok @useCreateCustomer",
      "DELETE /api/customers/:id ok @remove",
      "PUT /api/ping ok @raw",
      "GET /api/customers ok @CustomersClient.list",
    ]);
  });

  it("keeps unresolved URLs honestly", () => {
    expect(calls(`export function go(url: string) { return fetch(url); }`)).toEqual(["GET url ? @go"]);
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
      "PATCH /api/ping ok @ping",
    ]);
  });

  it("still finds a real client variable named api", () => {
    expect(
      calls(`export const api = axios.create(); export const load = () => api.get("/api/customers");`),
    ).toEqual(["GET /api/customers ok @load"]);
  });

  it("does not drop a template URL whose base is an empty head (leading ${BASE})", () => {
    expect(
      calls(`
      export const api = axios.create();
      export const one = (id: string) => api.get(\`\${API}/customers/\${id}\`);
    `),
    ).toEqual(["GET /customers/:id ok @one"]);
  });

  it("resolves a router receiver name to its nearest in-scope declaration, not file-wide", () => {
    expect(
      calls(`
      function setupRouter() { const api = express.Router(); api.get("/health", h); return api; }
      export function useClient() { const api = axios.create(); return api.get("/api/customers"); }
    `),
    ).toEqual(["GET /api/customers ok @useClient"]);
  });
});
