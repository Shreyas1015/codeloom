import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { linkUi } from "../src/linker/link.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import { ChainsFileSchema } from "../src/store/schemas.js";
import type { EndpointsFile, UiPage } from "../src/store/schemas.js";
import { makeRepo } from "./helpers.js";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver, walkCallers } from "../src/linker/resolve-calls.js";
import type { CallResolver, SymbolRef } from "../src/linker/resolve-calls.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

// H10: handlers a React hook returns in an object literal, destructured (or read off the result) in a component.

function resolverOf(files: Record<string, string>): CallResolver {
  const index: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) index.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return createCallResolver({ repo: "ui", index, files: new Set(Object.keys(files)), aliases: [] });
}

const ref = (file: string, symbol: string): SymbolRef => ({ repo: "ui", file, symbol });

/** Every resolved call / jsx-ref made by `symbol` in `file`, as "line:kind->file#symbol (confidence)". */
function callsOf(resolver: CallResolver, file: string, symbol: string): string[] {
  return resolver.callsFrom(ref(file, symbol)).map((c) =>
    `${c.site.line}:${c.site.kind ?? "call"}->${c.target.file}#${c.target.symbol} (${c.confidence})`);
}

const HOOK = "src/hooks/useCustomerForm.ts";
const PAGE = "src/pages/NewCustomer.tsx";

const page = (body: string, imports = "import { useCustomerForm } from '../hooks/useCustomerForm';") =>
  `${imports}\nexport default function NewCustomer() {\n${body}\n}\n`;

describe("hook handlers destructured from an imported hook (H10)", () => {
  it("shorthand key -> a named inner function of the hook, as a jsx-ref, at param", () => {
    const r = resolverOf({
      [HOOK]: [
        "import { createCustomer } from '../api/customers';",
        "export function useCustomerForm() {",
        "  async function handleSubmit(e: unknown) { await createCustomer(e); }",
        "  return { handleSubmit };",
        "}",
      ].join("\n"),
      "src/api/customers.ts": "export async function createCustomer(d: unknown) { return d; }",
      [PAGE]: page("  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;"),
    });
    expect(callsOf(r, PAGE, "NewCustomer")).toEqual([
      `3:call->${HOOK}#useCustomerForm (exact)`,
      `4:jsx-ref->${HOOK}#handleSubmit (param)`,
    ]);
    const callers = r.callersOf(ref(HOOK, "handleSubmit"));
    expect(callers.map((c) => [c.from.symbol, c.call.confidence, c.call.via])).toEqual([["NewCustomer", "param", "hook"]]);
    // The whole way back from the data function to the page.
    const steps = walkCallers(r, ref("src/api/customers.ts", "createCustomer"));
    expect(steps.map((s) => s.ref.symbol)).toEqual(["createCustomer", "handleSubmit", "NewCustomer"]);
  });

  it("renamed key -> a const arrow; a destructuring alias; a plain call of the destructured name", () => {
    const r = resolverOf({
      [HOOK]: [
        "export function useCustomerForm() {",
        "  const submit = async () => { await fetch('/customers', { method: 'POST' }); };",
        "  const destroy = (id: string) => fetch(`/customers/${id}`, { method: 'DELETE' });",
        "  return { handleSubmit: submit, onDelete: destroy };",
        "}",
      ].join("\n"),
      [PAGE]: page([
        "  const { handleSubmit, onDelete: remove } = useCustomerForm();",
        "  const onClick = () => remove('1');",
        "  return <form onSubmit={handleSubmit}><button onClick={remove} /></form>;",
      ].join("\n")),
    });
    expect(callsOf(r, PAGE, "NewCustomer")).toEqual([
      `3:call->${HOOK}#useCustomerForm (exact)`,
      `5:jsx-ref->${HOOK}#submit (param)`,
      `5:jsx-ref->${HOOK}#destroy (param)`,
    ]);
    expect(callsOf(r, PAGE, "onClick")).toEqual([`4:call->${HOOK}#destroy (param)`]);
  });

  it("an inline arrow under the key -> the hook's own symbol, with the arrow's lines", () => {
    const r = resolverOf({
      [HOOK]: [
        "export function useCustomerForm() {",
        "  return {",
        "    handleSubmit: async (e: unknown) => {",
        "      await fetch('/customers', { method: 'POST' });",
        "    },",
        "    reset() { return null; },",
        "  };",
        "}",
      ].join("\n"),
      [PAGE]: page("  const { handleSubmit, reset } = useCustomerForm();\n  return <form onSubmit={handleSubmit} onReset={reset} />;"),
    });
    const calls = r.callsFrom(ref(PAGE, "NewCustomer")).filter((c) => c.site.kind === "jsx-ref");
    expect(calls.map((c) => [c.target.symbol, c.lines, c.confidence])).toEqual([
      ["useCustomerForm", [3, 5], "param"],
      ["useCustomerForm", [6, 6], "param"],
    ]);
  });

  it("useCallback handlers: inline under the key, or a const the key names", () => {
    const r = resolverOf({
      [HOOK]: [
        "import { useCallback } from 'react';",
        "export function useCustomerForm() {",
        "  const submit = useCallback(async () => {",
        "    await fetch('/customers', { method: 'POST' });",
        "  }, []);",
        "  return { handleSubmit: submit, reset: useCallback(() => null, []) };",
        "}",
      ].join("\n"),
      [PAGE]: page("  const { handleSubmit, reset } = useCustomerForm();\n  return <form onSubmit={handleSubmit} onReset={reset} />;"),
    });
    const calls = r.callsFrom(ref(PAGE, "NewCustomer")).filter((c) => c.site.kind === "jsx-ref");
    expect(calls.map((c) => [c.target.symbol, c.lines])).toEqual([["useCustomerForm", [3, 5]], ["useCustomerForm", [6, 6]]]);
  });

  it("const form = useCustomerForm(): form.handleSubmit as a jsx-ref and as a call", () => {
    const r = resolverOf({
      [HOOK]: [
        "export const useCustomerForm = () => {",
        "  function submit() { return fetch('/customers', { method: 'POST' }); }",
        "  return { handleSubmit: submit };",
        "};",
      ].join("\n"),
      [PAGE]: page([
        "  const form = useCustomerForm();",
        "  const go = () => form.handleSubmit();",
        "  return <form onSubmit={form.handleSubmit} />;",
      ].join("\n")),
    });
    expect(callsOf(r, PAGE, "NewCustomer")).toEqual([
      `3:call->${HOOK}#useCustomerForm (exact)`,
      `5:jsx-ref->${HOOK}#submit (param)`,
    ]);
    expect(callsOf(r, PAGE, "go")).toEqual([`4:call->${HOOK}#submit (param)`]);
  });

  it("an arrow hook with an expression body returning a literal; a key naming a module-level function", () => {
    const r = resolverOf({
      [HOOK]: [
        "import { createCustomer } from '../api/customers';",
        "function remove() { return fetch('/x', { method: 'DELETE' }); }",
        "export const useCustomerForm = () => ({ handleSubmit: createCustomer, remove });",
      ].join("\n"),
      "src/api/customers.ts": "export async function createCustomer(d: unknown) { return d; }",
      [PAGE]: page("  const { handleSubmit, remove } = useCustomerForm();\n  return <form onSubmit={handleSubmit} onReset={remove} />;"),
    });
    expect(callsOf(r, PAGE, "NewCustomer").slice(1)).toEqual([
      "4:jsx-ref->src/api/customers.ts#createCustomer (param)",
      `4:jsx-ref->${HOOK}#remove (param)`,
    ]);
  });

  it("a hook declared in the page's own file", () => {
    const r = resolverOf({
      [PAGE]: [
        "function useInvoiceActions() {",
        "  const pay = () => fetch('/invoices/1/pay', { method: 'POST' });",
        "  return { pay };",
        "}",
        "export default function InvoicePage() {",
        "  const { pay } = useInvoiceActions();",
        "  return <button onClick={pay} />;",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "InvoicePage")).toEqual([
      `6:call->${PAGE}#useInvoiceActions (exact)`,
      `7:jsx-ref->${PAGE}#pay (param)`,
    ]);
  });

  it("the hook is followed through a barrel re-export", () => {
    const r = resolverOf({
      [HOOK]: "export function useCustomerForm() { const save = () => 1; return { save }; }",
      "src/hooks/index.ts": "export * from './useCustomerForm';",
      [PAGE]: page("  const { save } = useCustomerForm();\n  return <button onClick={save} />;", "import { useCustomerForm } from '../hooks';"),
    });
    expect(callsOf(r, PAGE, "NewCustomer").slice(1)).toEqual([`4:jsx-ref->${HOOK}#save (param)`]);
  });
});

describe("hook handlers that stay unresolved (H10, precision first)", () => {
  const unresolved = (hook: string, body: string) => {
    const r = resolverOf({
      [HOOK]: hook,
      "src/other.ts": "export const helpers = { handleSubmit() { return 1; } };\nexport function submit() { return 2; }\n",
      [PAGE]: page(body),
    });
    // Every site in the page except the hook calls themselves.
    const sites = r.fileIndex(PAGE)!.calls.filter((s) => s.kind === "jsx-ref" || s.callee.kind !== "ident" || !/^(use[A-Z]|make)/.test(s.callee.name));
    return sites.flatMap((s) => {
      const c = r.resolve(PAGE, s);
      return c ? [`${c.target.file}#${c.target.symbol}`] : [];
    });
  };

  it("a key the hook does not return", () => {
    expect(unresolved(
      "export function useCustomerForm() { const submit = () => 1; return { submit }; }",
      "  const { handleSubmit } = useCustomerForm();\n  const form = useCustomerForm();\n  form.handleSubmit();\n  return <form onSubmit={handleSubmit} onReset={form.handleSubmit} />;",
    )).toEqual([]);
  });

  it("a hook returning a non-literal (another hook's result, a variable)", () => {
    expect(unresolved(
      "import { useForm } from 'react-hook-form';\nexport function useCustomerForm() { return useForm(); }",
      "  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
    expect(unresolved(
      "export function useCustomerForm() { const submit = () => 1; const api = { handleSubmit: submit }; return api; }",
      "  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
  });

  it("a hook with one literal return and one non-literal return", () => {
    expect(unresolved(
      "export function useCustomerForm(x: unknown) { const submit = () => 1; if (x) return x; return { handleSubmit: submit }; }",
      "  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
  });

  it("a key whose value is not a function the hook declares (state), even when a same-named function exists", () => {
    expect(unresolved(
      "import { useState } from 'react';\nexport function useCustomerForm() { const [submit] = useState(null); return { handleSubmit: submit }; }\nfunction submit() { return 1; }",
      "  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
  });

  it("a key a later spread may override; a rest element", () => {
    expect(unresolved(
      "export function useCustomerForm(base: object) { const submit = () => 1; return { handleSubmit: submit, ...base }; }",
      "  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
    expect(unresolved(
      "export function useCustomerForm() { const submit = () => 1; return { handleSubmit: submit }; }",
      "  const { ...rest } = useCustomerForm();\n  return <form onSubmit={rest.handleSubmit} />;",
    )).toEqual([]);
  });

  it("a name shadowed by an inner parameter", () => {
    expect(unresolved(
      "export function useCustomerForm() { const submit = () => 1; return { handleSubmit: submit }; }",
      "  const { handleSubmit } = useCustomerForm();\n  const Inner = ({ handleSubmit }: any) => <form onSubmit={handleSubmit} />;\n  return null;",
    )).toEqual([]);
  });

  it("a non-hook function's result is not followed", () => {
    expect(unresolved(
      "export function useCustomerForm() { return null; }\nexport function makeHandlers() { const submit = () => 1; return { handleSubmit: submit }; }",
      "  const { handleSubmit } = makeHandlers();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
  });

  it("an inner function name the file declares twice (ambiguous by name)", () => {
    expect(unresolved(
      [
        "export function useCustomerForm() { const submit = () => 1; return { handleSubmit: submit }; }",
        "export function useInvoiceForm() { const submit = () => 2; return { handleSubmit: submit }; }",
      ].join("\n"),
      "  const { handleSubmit } = useCustomerForm();\n  return <form onSubmit={handleSubmit} />;",
    )).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// End to end: page -> <form onSubmit={handleSubmit}> -> the hook's submit -> data function -> client(config) -> route.
// ---------------------------------------------------------------------------------------------------

const uiFiles: Record<string, string> = {
  "src/api/client.ts": [
    "import axios from 'axios';",
    "const client = axios.create({ baseURL: import.meta.env.VITE_API_URL });",
    "export default client;",
    "",
  ].join("\n"),
  "src/api/customers.ts": [
    "import client from './client';",
    "export async function createCustomer(data: unknown) {",
    "  const res = await client({ method: 'POST', url: '/customers', data });",
    "  return res.data;",
    "}",
    "export async function removeInvoice(id: string) {",
    "  const config = { method: 'DELETE', url: `/invoices/${id}` };",
    "  return client(config);",
    "}",
    "",
  ].join("\n"),
  "src/hooks/useCustomerForm.ts": [
    "import { useCallback } from 'react';",
    "import { createCustomer, removeInvoice } from '../api/customers';",
    "export function useCustomerForm() {",
    "  async function submit(e: unknown) {",
    "    await createCustomer(e);",
    "  }",
    "  const onDelete = useCallback((id: string) => removeInvoice(id), []);",
    "  return { handleSubmit: submit, onDelete };",
    "}",
    "",
  ].join("\n"),
  "src/pages/NewCustomerPage.tsx": [
    "import { useCustomerForm } from '../hooks/useCustomerForm';",
    "export default function NewCustomerPage() {",
    "  const { handleSubmit, onDelete: remove } = useCustomerForm();",
    "  return <form onSubmit={handleSubmit}><button onClick={() => remove('1')} /></form>;",
    "}",
    "",
  ].join("\n"),
};

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

describe("linkUi: a page reaches an API route only through a destructured hook handler (H10)", () => {
  const route = (method: "POST" | "DELETE", path: string): EndpointsFile["routes"][number] => ({
    method, path, handler: `${method} ${path}`, inline: true, framework: "express",
    at: { file: "src/app.ts", line: 1, symbol: `${method} ${path}` },
  });

  it("links both calls back to the page", () => {
    const ctx = ctxWith("axios", "react", "react-router-dom");
    const rels = Object.keys(uiFiles);
    const byName = (_from: string, spec: string) =>
      rels.find((f) => f.replace(/\.(t|j)sx?$/, "").endsWith(`/${spec.split("/").pop()}`)) ?? null;
    const ep = finalizeEndpoints("ui", rels.map((rel) => runAdapters(rel, uiFiles[rel]!, ctx)), byName);
    const index: RepoCodeIndex = new Map(rels.map((rel) => [rel, buildFileCodeIndex(parsed(rel, uiFiles[rel]!))]));
    const pages: UiPage[] = [{
      route: "/customers/new", file: "src/pages/NewCustomerPage.tsx", line: 2, framework: "react-router", component: { name: "NewCustomerPage" },
    }];
    const ui: RepoData = { ref: { id: "ui", path: "ui", role: "ui" }, abs: "/ws/ui", graph: graphStub(), endpoints: { ...ep, pages } };
    const api: RepoData = {
      ref: { id: "api", path: "api", role: "api", apiBase: ["VITE_API_URL"] }, abs: "/ws/api", graph: graphStub(),
      endpoints: {
        version: 2, repo: "api", pages: [], httpCalls: [], httpClients: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [],
        routes: [route("POST", "/customers"), route("DELETE", "/invoices/:id")],
      },
    };
    const ws: WorkspaceData = { root: "/ws", name: "ws", repos: [ui, api], links: [] };
    const resolvers = new Map([["ui", createCallResolver({ repo: "ui", index, files: new Set(rels), aliases: [] })]]);
    const links = linkUi({ ws, resolvers });
    expect(links.map((l) => [
      `${l.call.method} ${l.call.path}`,
      l.target.kind === "route" ? `${l.target.route.repo}:${l.target.route.effectivePath}` : l.target.kind,
      l.pages.map((p) => `${p.page.route}:${p.path.map((s) => `${s.symbol}(${s.confidence})`).join(">")}`),
    ])).toEqual([
      ["POST /customers", "api:/customers", ["/customers/new:NewCustomerPage(param)>submit(exact)>createCustomer(exact)"]],
      ["DELETE /invoices/:id", "api:/invoices/:id", ["/customers/new:NewCustomerPage(exact)>useCustomerForm(exact)>removeInvoice(exact)"]],
    ]);
  });
});

describe("codeloom index: two repos, a page reaching a route through a destructured hook handler (H10)", () => {
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "codeloom-h10-"));
    makeRepo({
      "package.json": JSON.stringify({ name: "web", dependencies: { axios: "^1", react: "^18", "react-router-dom": "^6" } }),
      ...uiFiles,
      "src/App.tsx": [
        "import { Route, Routes } from 'react-router-dom';",
        "import NewCustomerPage from './pages/NewCustomerPage';",
        "export const App = () => <Routes><Route path=\"/customers/new\" element={<NewCustomerPage />} /></Routes>;",
        "",
      ].join("\n"),
    }, join(root, "web"));
    makeRepo({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "^4" } }),
      "src/app.ts": [
        "import express from 'express';",
        "const app = express();",
        "app.post('/customers', (req, res) => { res.json({}); });",
        "app.delete('/invoices/:id', (req, res) => { res.json({}); });",
        "",
      ].join("\n"),
    }, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "h10",
      repos: [{ id: "api", path: "api", role: "api", apiBase: ["VITE_API_URL"] }, { id: "web", path: "web", role: "ui" }],
      links: [],
    }));
    return root;
  }

  it("builds a page -> route chain through the hook's submit, and re-runs byte-identical", async () => {
    const root = workspace();
    await runIndex(root);
    const path = join(root, ".codeloom", "chains.json");
    const first = readFileSync(path, "utf8");
    const file = ChainsFileSchema.parse(JSON.parse(first));
    expect(file.uiReach!.map((f) => [f.symbol, f.method, f.path, f.reached])).toEqual([
      ["createCustomer", "POST", "/customers", true],
      ["removeInvoice", "DELETE", "/invoices/:id", true],
    ]);
    const post = file.chains.find((c) => c.entry.startsWith("page:") && c.routeKey?.includes("POST /customers"));
    expect(post?.stops.map((s) => `${s.repo}:${s.kind}:${s.symbol}:${s.hop.confidence}`)).toEqual(expect.arrayContaining([
      "web:page:NewCustomerPage:exact", "web:function:submit:param", "web:function:createCustomer:exact",
    ]));
    expect(post?.stops.some((s) => s.repo === "api" && s.kind === "route")).toBe(true);
    expect((await runIndex(root)).linker.wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
  });
});
