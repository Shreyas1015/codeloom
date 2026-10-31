import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";
import type { CallResolver } from "../src/linker/resolve-calls.js";
import { callPathWithClient, chooseBackend, linkUi } from "../src/linker/link.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { EndpointsFile, HttpCall, HttpClient } from "../src/store/schemas.js";
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

function repo(id: string, ep: Partial<EndpointsFile>, opts?: { role?: "ui" | "api" | "worker" | "lib"; apiBase?: string[] }): RepoData {
  return { ref: { id, path: id, ...opts }, abs: `/ws/${id}`, graph: graphStub(), endpoints: endpoints(id, ep) };
}

function index(files: Record<string, string>): RepoCodeIndex {
  const idx: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) idx.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return idx;
}

function resolverFor(files: Record<string, string>, repoId: string): CallResolver {
  const idx = index(files);
  return createCallResolver({ repo: repoId, index: idx, files: new Set(idx.keys()), aliases: [] });
}

function ws(repos: RepoData[]): WorkspaceData {
  return { root: "/ws", name: "ws", repos, links: [] };
}

describe("callPathWithClient", () => {
  it("returns the call's own literal path when the client has no literal baseURL", () => {
    const call: HttpCall = { method: "POST", path: "/billing/invoices", raw: '"/billing/invoices"', resolved: true, client: "billingApi", at: { file: "lib/billing.ts", line: 3, symbol: "createInvoice" }, kind: "literal" };
    const clients: HttpClient[] = [{ name: "billingApi", file: "lib/billing-api.ts", line: 1, factory: "axios", baseExpr: "process.env.NEXT_PUBLIC_BILLING_URL" }];
    expect(callPathWithClient(call, clients)).toBe("/billing/invoices");
  });

  it("prepends a known client baseLiteral", () => {
    const call: HttpCall = { method: "GET", path: "/widgets", raw: '"/widgets"', resolved: true, client: "api", at: { file: "lib/x.ts", line: 1, symbol: "f" }, kind: "literal" };
    const clients: HttpClient[] = [{ name: "api", file: "lib/api.ts", line: 1, factory: "axios", baseLiteral: "/v2" }];
    expect(callPathWithClient(call, clients)).toBe("/v2/widgets");
  });

  it('returns "" for an unknown-kind call', () => {
    const call: HttpCall = { method: "GET", path: "", raw: "url", resolved: false, client: "api", at: { file: "a.ts", line: 1, symbol: "f" }, kind: "unknown" };
    expect(callPathWithClient(call, [])).toBe("");
  });
});

describe("chooseBackend", () => {
  it("returns the only candidate untouched when there is just one", () => {
    const backends = [repo("api", {})];
    const call: HttpCall = { method: "POST", path: "/x", raw: "x", resolved: true, client: "api", at: { file: "a.ts", line: 1, symbol: "f" }, kind: "literal" };
    expect(chooseBackend(call, [], backends)).toEqual({ repos: backends, hinted: false });
  });

  it("narrows to the repo whose apiBase matches the call's own base expression", () => {
    const api = repo("api", {}, { role: "api", apiBase: ["NEXT_PUBLIC_API_URL"] });
    const billing = repo("billing", {}, { role: "api", apiBase: ["NEXT_PUBLIC_BILLING_URL"] });
    const call: HttpCall = { method: "GET", path: "/x", raw: "x", resolved: true, client: "fetch", at: { file: "a.ts", line: 1, symbol: "f" }, kind: "template", base: "process.env.NEXT_PUBLIC_BILLING_URL" };
    expect(chooseBackend(call, [], [api, billing])).toEqual({ repos: [billing], hinted: true });
  });

  it("narrows via the client's baseExpr when the call itself carries no base", () => {
    const api = repo("api", {}, { role: "api", apiBase: ["NEXT_PUBLIC_API_URL"] });
    const billing = repo("billing", {}, { role: "api", apiBase: ["NEXT_PUBLIC_BILLING_URL"] });
    const call: HttpCall = { method: "POST", path: "/invoices", raw: '"/invoices"', resolved: true, client: "billingApi", at: { file: "a.ts", line: 1, symbol: "f" }, kind: "literal" };
    const clients: HttpClient[] = [{ name: "billingApi", file: "lib/billing-api.ts", line: 1, factory: "axios", baseExpr: "process.env.NEXT_PUBLIC_BILLING_URL" }];
    expect(chooseBackend(call, clients, [api, billing])).toEqual({ repos: [billing], hinted: true });
  });

  it("falls back to the unique repo with role \"api\" when no apiBase hint matches", () => {
    const worker = repo("notifier", {}, { role: "worker" });
    const api = repo("api", {}, { role: "api" });
    const call: HttpCall = { method: "GET", path: "/x", raw: "x", resolved: true, client: "fetch", at: { file: "a.ts", line: 1, symbol: "f" }, kind: "literal" };
    expect(chooseBackend(call, [], [worker, api])).toEqual({ repos: [api], hinted: true });
  });

  it("falls back to every candidate, unhinted, when nothing narrows it", () => {
    const backends = [repo("api", {}), repo("billing", {})];
    const call: HttpCall = { method: "GET", path: "/x", raw: "x", resolved: true, client: "fetch", at: { file: "a.ts", line: 1, symbol: "f" }, kind: "literal" };
    expect(chooseBackend(call, [], backends)).toEqual({ repos: backends, hinted: false });
  });
});

describe("linkUi", () => {
  const webFiles = {
    "lib/api.ts": `import axios from "axios";\nexport const api = axios.create({ baseURL: process.env.X });\n`,
    "lib/use-create-customer.ts": [
      'import { api } from "./api.js";',
      "export function useCreateCustomer() {",
      "  return async (input: unknown) => {",
      '    const res = await api.post("/api/customers", input);',
      "    return res.data;",
      "  };",
      "}",
      "",
    ].join("\n"),
    "app/customers/new/page.tsx": [
      'import { useCreateCustomer } from "../../../lib/use-create-customer.js";',
      "export default function NewCustomerPage() {",
      "  const createCustomer = useCreateCustomer();",
      "  return null;",
      "}",
      "",
    ].join("\n"),
  };

  function webAndApi(apiRoutes: EndpointsFile["routes"]) {
    const call: HttpCall = {
      method: "POST", path: "/api/customers", raw: '"/api/customers"', resolved: true, client: "api",
      at: { file: "lib/use-create-customer.ts", line: 4, symbol: "useCreateCustomer" }, kind: "literal",
    };
    const web = repo("web", {
      pages: [{ route: "/customers/new", file: "app/customers/new/page.tsx", line: 2, framework: "next-app" }],
      httpCalls: [call],
      httpClients: [{ name: "api", file: "lib/api.ts", line: 2, factory: "axios", baseExpr: "process.env.X" }],
    });
    const api = repo("api", { routes: apiRoutes });
    const resolvers = new Map([
      ["web", resolverFor(webFiles, "web")],
      ["api", resolverFor({}, "api")],
    ]);
    return { call, web, api, resolvers };
  }

  it("walks page -> hook -> call, and matches the call to the route", () => {
    const route: EndpointsFile["routes"][number] = {
      method: "POST", path: "/api/customers", handler: "CustomersController.store", inline: false,
      framework: "adonis", at: { file: "app/controllers/customers_controller.ts", line: 5, symbol: "CustomersController.store" },
    };
    const { call, web, api, resolvers } = webAndApi([route]);
    const links = linkUi({ ws: ws([web, api]), resolvers });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      repo: "web",
      call,
      pages: [{
        page: { route: "/customers/new" },
        path: [
          { repo: "web", file: "app/customers/new/page.tsx", symbol: "NewCustomerPage" },
          { repo: "web", file: "lib/use-create-customer.ts", symbol: "useCreateCustomer" },
        ],
      }],
      target: { kind: "route", confidence: "exact" },
    });
    expect(links[0]!.target.kind === "route" && links[0]!.target.route.effectivePath).toBe("/api/customers");
  });

  it("reports an unresolved call when no route matches", () => {
    const { web, api, resolvers } = webAndApi([]);
    const links = linkUi({ ws: ws([web, api]), resolvers });
    expect(links[0]!.target).toEqual({ kind: "unresolved", reason: "no matching route" });
  });

  it("reports unresolved with a clear reason for an unknown-kind URL", () => {
    const call: HttpCall = {
      method: "GET", path: "", raw: "someVar", resolved: false, client: "fetch",
      at: { file: "lib/x.ts", line: 1, symbol: "f" }, kind: "unknown",
    };
    const web = repo("web", { httpCalls: [call] });
    const links = linkUi({ ws: ws([web]), resolvers: new Map([["web", resolverFor({}, "web")]]) });
    expect(links[0]!.target).toEqual({ kind: "unresolved", reason: "url has no literal text" });
  });

  it("treats a hardcoded absolute foreign URL as external", () => {
    const call: HttpCall = {
      method: "POST", path: "/v1/charges", raw: '"https://api.stripe.com/v1/charges"', resolved: true,
      client: "axios", at: { file: "lib/pay.ts", line: 1, symbol: "pay" }, kind: "literal",
    };
    const web = repo("web", { httpCalls: [call] });
    const links = linkUi({ ws: ws([web]), resolvers: new Map([["web", resolverFor({}, "web")]]) });
    expect(links[0]!.target).toEqual({ kind: "external", base: "api.stripe.com" });
  });

  it("downgrades confidence to guess when several backends match and none is hinted", () => {
    const dupRoute: EndpointsFile["routes"][number] = {
      method: "POST", path: "/dup", handler: "f", inline: false, framework: "express",
      at: { file: "src/server.ts", line: 1, symbol: "f" },
    };
    const call: HttpCall = {
      method: "POST", path: "/dup", raw: '"/dup"', resolved: true, client: "fetch",
      at: { file: "lib/x.ts", line: 1, symbol: "f" }, kind: "literal",
    };
    const a = repo("a", { routes: [dupRoute] });
    const b = repo("b", { routes: [dupRoute] });
    const web = repo("web", { httpCalls: [call] });
    const resolvers = new Map([["web", resolverFor({}, "web")], ["a", resolverFor({}, "a")], ["b", resolverFor({}, "b")]]);
    const links = linkUi({ ws: ws([web, a, b]), resolvers });
    expect(links[0]!.target).toMatchObject({ kind: "route", confidence: "guess" });
  });
  describe("react-router pages", () => {
    const spaFiles = {
      "src/App.tsx": [
        'import { Customers } from "./customers";',
        'import { useMe } from "./hooks";',
        "export function App() {",
        "  const me = useMe();",
        "  return (",
        "    <Routes>",
        '      <Route path="/customers" element={<Customers />} />',
        '      <Route path="/lazy" element={<Missing />} />',
        "    </Routes>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "src/customers.tsx": [
        'import { useCustomers } from "./hooks";',
        "export function Customers() {",
        "  const list = useCustomers();",
        "  return null;",
        "}",
        "",
      ].join("\n"),
      "src/hooks.ts": [
        "export function useMe() {",
        '  return fetch("/api/me");',
        "}",
        "export function useCustomers() {",
        '  return fetch("/api/customers");',
        "}",
        "",
      ].join("\n"),
    };

    it("uses the routed component (through the router file's imports), never the router component", () => {
      const meCall: HttpCall = { method: "GET", path: "/api/me", raw: '"/api/me"', resolved: true, client: "fetch", at: { file: "src/hooks.ts", line: 2, symbol: "useMe" }, kind: "literal" };
      const custCall: HttpCall = { method: "GET", path: "/api/customers", raw: '"/api/customers"', resolved: true, client: "fetch", at: { file: "src/hooks.ts", line: 5, symbol: "useCustomers" }, kind: "literal" };
      const spa = repo("spa", {
        pages: [
          { route: "/customers", file: "src/App.tsx", line: 7, framework: "react-router", component: { name: "Customers", importSource: "./customers" } },
          { route: "/lazy", file: "src/App.tsx", line: 8, framework: "react-router", component: { name: "Missing" } },
        ],
        httpCalls: [meCall, custCall],
      });
      const links = linkUi({ ws: ws([spa]), resolvers: new Map([["spa", resolverFor(spaFiles, "spa")]]) });
      const byPath = new Map(links.map((l) => [l.call.path, l]));
      expect(byPath.get("/api/me")!.pages).toEqual([]);
      expect(byPath.get("/api/customers")!.pages.map((p) => p.page.route)).toEqual(["/customers"]);
      expect(byPath.get("/api/customers")!.pages[0]!.path.map((s) => s.symbol)).toEqual(["Customers", "useCustomers"]);
    });

    it("a react-router page with no component reaches nothing", () => {
      const meCall: HttpCall = { method: "GET", path: "/api/me", raw: '"/api/me"', resolved: true, client: "fetch", at: { file: "src/hooks.ts", line: 2, symbol: "useMe" }, kind: "literal" };
      const spa = repo("spa", {
        pages: [{ route: "/x", file: "src/App.tsx", line: 7, framework: "react-router" }],
        httpCalls: [meCall],
      });
      const links = linkUi({ ws: ws([spa]), resolvers: new Map([["spa", resolverFor(spaFiles, "spa")]]) });
      expect(links[0]!.pages).toEqual([]);
    });
  });
  it("a Next page starts from the file's default export even when a helper comes first", () => {
    const files = {
      "app/orders/page.tsx": [
        "function formatTotal(n: number) {",
        "  return String(n);",
        "}",
        "export default function OrdersPage() {",
        "  loadOrders();",
        "  return null;",
        "}",
        "function loadOrders() {",
        '  return fetch("/api/orders");',
        "}",
        "",
      ].join("\n"),
    };
    const call: HttpCall = { method: "GET", path: "/api/orders", raw: '"/api/orders"', resolved: true, client: "fetch", at: { file: "app/orders/page.tsx", line: 9, symbol: "loadOrders" }, kind: "literal" };
    const web = repo("web", { pages: [{ route: "/orders", file: "app/orders/page.tsx", line: 1, framework: "next-app" }], httpCalls: [call] });
    const links = linkUi({ ws: ws([web]), resolvers: new Map([["web", resolverFor(files, "web")]]) });
    expect(links[0]!.pages.map((p) => p.path.map((s) => s.symbol))).toEqual([["OrdersPage", "loadOrders"]]);
  });
});
