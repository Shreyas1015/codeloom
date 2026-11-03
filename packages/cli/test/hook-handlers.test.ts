import { describe, expect, it } from "vitest";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver, walkCallers } from "../src/linker/resolve-calls.js";
import type { CallResolver, SymbolRef } from "../src/linker/resolve-calls.js";
import { parsed } from "./adapter-helpers.js";

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
