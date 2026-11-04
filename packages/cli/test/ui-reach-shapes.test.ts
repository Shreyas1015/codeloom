import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { linkUi } from "../src/linker/link.js";
import { createCallResolver, walkCallers } from "../src/linker/resolve-calls.js";
import type { CallResolver, SymbolRef } from "../src/linker/resolve-calls.js";
import { resolveImport } from "../src/indexer/resolve-imports.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { EndpointsFile, HttpMethod, UiPage } from "../src/store/schemas.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

/** Two repos in memory: `uiFiles` (a web app with one page, `CustomersPage` in src/pages/CustomersPage.tsx)
 * and an API with `routes`. Returns each UI call as [call, route, page paths "symbol(confidence)[@line]"]. */
function linkTwoRepos(uiFiles: Record<string, string>, routes: Array<[HttpMethod, string]>): string[][] {
  const ctx = ctxWith("axios", "react", "react-router-dom");
  const rels = Object.keys(uiFiles).sort();
  const files = new Set(rels);
  const ep = finalizeEndpoints("ui", rels.map((rel) => runAdapters(rel, uiFiles[rel]!, ctx)), (from, spec) => resolveImport(from, spec, files, []));
  const index: RepoCodeIndex = new Map(rels.map((rel) => [rel, buildFileCodeIndex(parsed(rel, uiFiles[rel]!))]));
  const pages: UiPage[] = [{
    route: "/customers", file: "src/pages/CustomersPage.tsx", line: 2, framework: "react-router", component: { name: "CustomersPage" },
  }];
  const ui: RepoData = { ref: { id: "ui", path: "ui", role: "ui" }, abs: "/ws/ui", graph: graphStub(), endpoints: { ...ep, pages } };
  const apiRoutes: EndpointsFile["routes"] = routes.map(([method, path]) => ({
    method, path, handler: `${method} ${path}`, inline: true, framework: "express",
    at: { file: "src/app.ts", line: 1, symbol: `${method} ${path}` },
  }));
  const api: RepoData = {
    ref: { id: "api", path: "api", role: "api", apiBase: ["VITE_API_URL"] }, abs: "/ws/api", graph: graphStub(),
    endpoints: {
      version: 2, repo: "api", pages: [], httpCalls: [], httpClients: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [],
      routes: apiRoutes,
    },
  };
  const ws: WorkspaceData = { root: "/ws", name: "ws", repos: [ui, api], links: [] };
  const resolvers = new Map([["ui", createCallResolver({ repo: "ui", index, files, aliases: [] })]]);
  return linkUi({ ws, resolvers }).map((l) => [
    `${l.call.method} ${l.call.path}`,
    l.target.kind === "route" ? `${l.target.route.repo}:${l.target.route.route.method} ${l.target.route.effectivePath}` : l.target.kind,
    ...l.pages.map((p) => p.path.map((s) => `${s.symbol}(${s.confidence})${s.line !== undefined ? `@${s.line}` : ""}`).join(">")),
  ]);
}

// v0.2a §2: more shapes the UI reverse walk follows. All at best "param"; anything else stays unresolved.

function resolverOf(files: Record<string, string>): CallResolver {
  const index: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) index.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return createCallResolver({ repo: "ui", index, files: new Set(Object.keys(files)), aliases: [] });
}

const ref = (file: string, symbol: string): SymbolRef => ({ repo: "ui", file, symbol });

function callsOf(resolver: CallResolver, file: string, symbol: string): string[] {
  return resolver.callsFrom(ref(file, symbol)).map((c) =>
    `${c.site.line}:${c.site.kind ?? "call"}->${c.target.file}#${c.target.symbol} (${c.confidence})`);
}

const API = "src/api/customers.ts";
const PAGE = "src/pages/CustomersPage.tsx";
const apiFile = [
  "export async function saveCustomer(d: unknown) { return fetch('/customers', { method: 'POST' }); }",
  "export async function loadCustomers() { return fetch('/customers'); }",
  "export const invoiceApi = { pay(id: string) { return fetch(`/invoices/${id}/pay`, { method: 'POST' }); } };",
].join("\n");

describe("a function passed as a call argument (fn-arg)", () => {
  it("useMutation(saveCustomer) and { onSuccess: refresh } in an object argument, at param", () => {
    const r = resolverOf({
      [API]: apiFile,
      [PAGE]: [
        "import { useMutation, useQuery } from '@tanstack/react-query';",
        "import { saveCustomer, loadCustomers, invoiceApi } from '../api/customers';",
        "export default function CustomersPage() {",
        "  const refresh = () => loadCustomers();",
        "  const m = useMutation(saveCustomer);",
        "  const q = useQuery({ queryFn: loadCustomers, onSuccess: refresh, mutationFn: invoiceApi.pay });",
        "  return null;",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "CustomersPage")).toEqual([
      `5:fn-arg->${API}#saveCustomer (param)`,
      `6:fn-arg->${API}#loadCustomers (param)`,
      `6:fn-arg->${PAGE}#refresh (param)`,
      `6:fn-arg->${API}#invoiceApi.pay (param)`,
    ]);
    const steps = walkCallers(r, ref(API, "saveCustomer"));
    expect(steps.map((s) => [s.ref.symbol, s.via?.confidence ?? null])).toEqual([["saveCustomer", null], ["CustomersPage", "param"]]);
  });

  it("an imported or local plain function as the callee", () => {
    const r = resolverOf({
      [API]: apiFile,
      "src/util/debounce.ts": "export function debounce(fn: () => void) { return fn; }",
      [PAGE]: [
        "import { debounce } from '../util/debounce';",
        "import { loadCustomers } from '../api/customers';",
        "function runLater(fn: () => void) { return fn; }",
        "export default function CustomersPage() {",
        "  debounce(loadCustomers);",
        "  runLater(loadCustomers);",
        "  return null;",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "CustomersPage")).toEqual([
      "5:call->src/util/debounce.ts#debounce (exact)",
      `5:fn-arg->${API}#loadCustomers (param)`,
      `6:call->${PAGE}#runLater (exact)`,
      `6:fn-arg->${API}#loadCustomers (param)`,
    ]);
  });

  it("not followed: built-in array methods, member callees, globals, non-functions", () => {
    const r = resolverOf({
      [API]: apiFile,
      [PAGE]: [
        "import { loadCustomers, saveCustomer } from '../api/customers';",
        "export default function CustomersPage(props: { ids: string[] }) {",
        "  props.ids.forEach(saveCustomer);",
        "  [1].map(loadCustomers);",
        "  Promise.resolve().then(loadCustomers);",
        "  setTimeout(loadCustomers, 10);",
        "  const total = 3;",
        "  useMemo(total);",
        "  return null;",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "CustomersPage").filter((c) => c.includes("fn-arg"))).toEqual([]);
  });

  it("a guessed target is dropped (precision first)", () => {
    const r = resolverOf({
      "src/a.ts": "export const a = { pay() { return 1; } };",
      [PAGE]: [
        "export default function CustomersPage(o: any) {",
        "  useEffect(o.pay);",
        "  return null;",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "CustomersPage")).toEqual([]);
  });
});

const HOOK = "src/hooks/useCustomer.ts";
const pageWith = (body: string, imports = "import { useCustomer } from '../hooks/useCustomer';") =>
  `${imports}\nexport default function CustomersPage() {\n${body}\n}\n`;

describe("array-returning hooks and nested destructuring", () => {
  it("const [save, state] = useCustomer() with return [save, state]", () => {
    const r = resolverOf({
      [HOOK]: [
        "import { useState } from 'react';",
        "export function useCustomer() {",
        "  const [state] = useState(null);",
        "  const save = () => fetch('/customers', { method: 'POST' });",
        "  return [save, state, () => fetch('/customers/1', { method: 'DELETE' })];",
        "}",
      ].join("\n"),
      [PAGE]: pageWith("  const [save, state, , ] = useCustomer();\n  const [, , remove] = useCustomer();\n  return <button onClick={save} onReset={remove} title={state} />;"),
    });
    const refs = r.callsFrom(ref(PAGE, "CustomersPage")).filter((c) => c.site.kind === "jsx-ref");
    expect(refs.map((c) => [c.target.symbol, c.lines ?? null, c.confidence])).toEqual([
      ["save", null, "param"],
      ["useCustomer", [5, 5], "param"],
    ]);
  });

  it("nested destructuring: const { form: { submit } } = useCustomer(); and const [{ reset }] = …", () => {
    const r = resolverOf({
      [HOOK]: [
        "export function useCustomer() {",
        "  function submit() { return fetch('/customers', { method: 'POST' }); }",
        "  const reset = () => null;",
        "  return { form: { submit, cancel: reset }, list: [reset] };",
        "}",
        "export function useInvoice() {",
        "  const pay = () => fetch('/invoices/1/pay', { method: 'POST' });",
        "  return [{ pay }];",
        "}",
      ].join("\n"),
      [PAGE]: pageWith([
        "  const { form: { submit, cancel: stop }, list: [first] } = useCustomer();",
        "  const [{ pay }] = useInvoice();",
        "  const { form } = useCustomer();",
        "  return <form onSubmit={submit} onReset={stop} onClick={pay} onBlur={form.submit} onFocus={first} />;",
      ].join("\n"), "import { useCustomer, useInvoice } from '../hooks/useCustomer';"),
    });
    const refs = r.callsFrom(ref(PAGE, "CustomersPage")).filter((c) => c.site.kind === "jsx-ref");
    expect(refs.map((c) => `${c.target.symbol} ${c.confidence}`)).toEqual([
      "submit param", "reset param", "pay param", "submit param", "reset param",
    ]);
  });

  it("stays unresolved: mixed object/array returns, a spread before the index, a rest element", () => {
    const r = resolverOf({
      [HOOK]: [
        "export function useCustomer(x: boolean) {",
        "  const save = () => 1;",
        "  if (x) return { save };",
        "  return [save];",
        "}",
        "export function useInvoice(more: unknown[]) {",
        "  const pay = () => 1;",
        "  return [...more, pay];",
        "}",
      ].join("\n"),
      [PAGE]: pageWith([
        "  const [save] = useCustomer(true);",
        "  const { save: s2 } = useCustomer(false);",
        "  const [pay] = useInvoice([]);",
        "  const [...rest] = useInvoice([]);",
        "  return <button onClick={save} onReset={s2} onBlur={pay} onFocus={rest} />;",
      ].join("\n"), "import { useCustomer, useInvoice } from '../hooks/useCustomer';"),
    });
    expect(r.callsFrom(ref(PAGE, "CustomersPage")).filter((c) => c.site.kind === "jsx-ref")).toEqual([]);
  });
});

describe("namespaced hooks (import * as hooks)", () => {
  const hookFile = [
    "export function useCustomer() {",
    "  const save = () => fetch('/customers', { method: 'POST' });",
    "  return { save };",
    "}",
  ].join("\n");

  it("const { save } = hooks.useCustomer(); const c = hooks.useCustomer(); c.save — through a barrel too", () => {
    const r = resolverOf({
      [HOOK]: hookFile,
      "src/hooks/index.ts": "export * from './useCustomer';",
      [PAGE]: pageWith([
        "  const { save } = hooks.useCustomer();",
        "  const c = hooks.useCustomer();",
        "  return <button onClick={save} onReset={c.save} />;",
      ].join("\n"), "import * as hooks from '../hooks';"),
    });
    expect(callsOf(r, PAGE, "CustomersPage")).toEqual([
      `3:call->${HOOK}#useCustomer (exact)`,
      `4:call->${HOOK}#useCustomer (exact)`,
      `5:jsx-ref->${HOOK}#save (param)`,
      `5:jsx-ref->${HOOK}#save (param)`,
    ]);
  });

  it("stays unresolved: a receiver that is not a namespace import, an unknown hook", () => {
    const r = resolverOf({
      [HOOK]: hookFile,
      [PAGE]: pageWith([
        "  const hooks = { useCustomer: () => ({ save: () => 1 }) };",
        "  const { save } = hooks.useCustomer();",
        "  const { save: s2 } = ns.useMissing();",
        "  return <button onClick={save} onReset={s2} />;",
      ].join("\n"), "import * as ns from '../hooks/useCustomer';"),
    });
    expect(r.callsFrom(ref(PAGE, "CustomersPage")).filter((c) => c.site.kind === "jsx-ref")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Two repos: a page reaches an API route only through each shape.
// ---------------------------------------------------------------------------------------------------

const client = [
  "import axios from 'axios';",
  "const client = axios.create({ baseURL: import.meta.env.VITE_API_URL });",
  "export default client;",
].join("\n");
const customersApi = [
  "import client from './client';",
  "export async function saveCustomer(d: unknown) { return client.post('/customers', d); }",
  "export async function loadCustomers() { return client.get('/customers'); }",
  "export async function payInvoice(id: string) { return client.post(`/invoices/${id}/pay`); }",
].join("\n");
const pageOnly = (imports: string, body: string) =>
  `${imports}\nexport default function CustomersPage() {\n${body}\n}\n`;

describe("linkUi: the page reaches a route only through the inline arrow a hook returns", () => {
  it("the hook stop carries the arrow's own first line", () => {
    const rows = linkTwoRepos({
      "src/api/client.ts": client,
      "src/api/customers.ts": customersApi,
      "src/hooks/useCustomer.ts": [
        "import { saveCustomer } from '../api/customers';",
        "export function useCustomer() {",
        "  const ready = true;",
        "  return {",
        "    save: async (d: unknown) => {",
        "      await saveCustomer(d);",
        "    },",
        "  };",
        "}",
      ].join("\n"),
      [PAGE]: pageOnly("import { useCustomer } from '../hooks/useCustomer';",
        "  const { save } = useCustomer();\n  return <button onClick={save} />;"),
    }, [["POST", "/customers"]]);
    expect(rows.find((r) => r[0] === "POST /customers")).toEqual([
      "POST /customers", "api:POST /customers", "CustomersPage(exact)>useCustomer(exact)@5>saveCustomer(exact)",
    ]);
  });
});
