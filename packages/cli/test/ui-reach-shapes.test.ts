import { describe, expect, it } from "vitest";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver, walkCallers } from "../src/linker/resolve-calls.js";
import type { CallResolver, SymbolRef } from "../src/linker/resolve-calls.js";
import { parsed } from "./adapter-helpers.js";

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
