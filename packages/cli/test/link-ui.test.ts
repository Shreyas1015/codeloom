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

    it("resolves a page component reached through a barrel re-export", () => {
      const barrelFiles = {
        "src/App.tsx": [
          'import { Customers } from "./customers-index";',
          "export function App() {",
          "  return (",
          "    <Routes>",
          '      <Route path="/customers" element={<Customers />} />',
          "    </Routes>",
          "  );",
          "}",
          "",
        ].join("\n"),
        "src/customers-index.ts": 'export { default as Customers } from "./customers";\n',
        "src/customers.tsx": [
          'import { useCustomers } from "./hooks";',
          "export default function Customers() {",
          "  const list = useCustomers();",
          "  return null;",
          "}",
          "",
        ].join("\n"),
        "src/hooks.ts": [
          "export function useCustomers() {",
          '  return fetch("/api/customers");',
          "}",
          "",
        ].join("\n"),
      };
      const custCall: HttpCall = { method: "GET", path: "/api/customers", raw: '"/api/customers"', resolved: true, client: "fetch", at: { file: "src/hooks.ts", line: 2, symbol: "useCustomers" }, kind: "literal" };
      const spa = repo("spa", {
        pages: [{ route: "/customers", file: "src/App.tsx", line: 5, framework: "react-router", component: { name: "Customers", importSource: "./customers-index" } }],
        httpCalls: [custCall],
      });
      const links = linkUi({ ws: ws([spa]), resolvers: new Map([["spa", resolverFor(barrelFiles, "spa")]]) });
      expect(links[0]!.pages.map((p) => p.page.route)).toEqual(["/customers"]);
      expect(links[0]!.pages[0]!.path.map((s) => s.symbol)).toEqual(["Customers", "useCustomers"]);
    });

    it("resolves a page component reached through a default import", () => {
      const defaultImportFiles = {
        "src/App.tsx": [
          'import Orders from "./orders";',
          "export function App() {",
          "  return (",
          "    <Routes>",
          '      <Route path="/orders" element={<Orders />} />',
          "    </Routes>",
          "  );",
          "}",
          "",
        ].join("\n"),
        "src/orders.tsx": [
          'import { useOrders } from "./hooks";',
          "export default function Orders() {",
          "  const list = useOrders();",
          "  return null;",
          "}",
          "",
        ].join("\n"),
        "src/hooks.ts": [
          "export function useOrders() {",
          '  return fetch("/api/orders");',
          "}",
          "",
        ].join("\n"),
      };
      const ordersCall: HttpCall = { method: "GET", path: "/api/orders", raw: '"/api/orders"', resolved: true, client: "fetch", at: { file: "src/hooks.ts", line: 2, symbol: "useOrders" }, kind: "literal" };
      const spa = repo("spa", {
        pages: [{ route: "/orders", file: "src/App.tsx", line: 5, framework: "react-router", component: { name: "Orders", importSource: "./orders" } }],
        httpCalls: [ordersCall],
      });
      const links = linkUi({ ws: ws([spa]), resolvers: new Map([["spa", resolverFor(defaultImportFiles, "spa")]]) });
      expect(links[0]!.pages.map((p) => p.page.route)).toEqual(["/orders"]);
      expect(links[0]!.pages[0]!.path.map((s) => s.symbol)).toEqual(["Orders", "useOrders"]);
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
  it("retries over every backend as a guess when the hinted backends have no matching route", () => {
    const call: HttpCall = { method: "POST", path: "/billing/x", raw: '"/billing/x"', resolved: true, client: "fetch", at: { file: "lib/x.ts", line: 1, symbol: "f" }, kind: "literal" };
    const api = repo("api", { routes: [{ method: "GET", path: "/other", handler: "h", inline: false, framework: "express", at: { file: "s.ts", line: 1, symbol: "h" } }] }, { role: "api" });
    const worker = repo("worker", { routes: [{ method: "POST", path: "/billing/x", handler: "b", inline: false, framework: "express", at: { file: "w.ts", line: 1, symbol: "b" } }] }, { role: "worker" });
    const web = repo("web", { httpCalls: [call] });
    const resolvers = new Map([["web", resolverFor({}, "web")], ["api", resolverFor({}, "api")], ["worker", resolverFor({}, "worker")]]);
    const links = linkUi({ ws: ws([web, api, worker]), resolvers });
    expect(links[0]!.target).toMatchObject({ kind: "route", confidence: "guess", reason: "matched outside the hinted backends" });
    expect(links[0]!.target.kind === "route" && links[0]!.target.route.repo).toBe("worker");
  });
  it("carries the worst walk-hop confidence onto the page reach", () => {
    const files = {
      "app/orders/page.tsx": [
        "export default function OrdersPage({ svc }: any) {",
        "  svc.loadAllOrders();",
        "  return null;",
        "}",
        "",
      ].join("\n"),
      "lib/order-service.ts": [
        "export class OrderService {",
        "  loadAllOrders() {",
        '    return fetch("/api/orders");',
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    const call: HttpCall = { method: "GET", path: "/api/orders", raw: '"/api/orders"', resolved: true, client: "fetch", at: { file: "lib/order-service.ts", line: 3, symbol: "OrderService.loadAllOrders" }, kind: "literal" };
    const web = repo("web", { pages: [{ route: "/orders", file: "app/orders/page.tsx", line: 1, framework: "next-app" }], httpCalls: [call] });
    const links = linkUi({ ws: ws([web]), resolvers: new Map([["web", resolverFor(files, "web")]]) });
    expect(links[0]!.pages).toHaveLength(1);
    expect(links[0]!.pages[0]!.confidence).toBe("guess");
    expect(links[0]!.pages[0]!.path.map((s) => [s.symbol, s.confidence])).toEqual([
      ["OrdersPage", "guess"],
      ["OrderService.loadAllOrders", "exact"],
    ]);
  });
  describe("internal vs external hosts", () => {
    const route: EndpointsFile["routes"][number] = { method: "GET", path: "/api/x", handler: "h", inline: false, framework: "express", at: { file: "s.ts", line: 1, symbol: "h" } };
    const run = (call: HttpCall, clients: HttpClient[] = [], apiBase?: string[]) => {
      const web = repo("web", { httpCalls: [call], httpClients: clients });
      const api = repo("api", { routes: [route, { ...route, path: "/v1/charges" }] }, apiBase ? { apiBase } : undefined);
      const resolvers = new Map([["web", resolverFor({}, "web")], ["api", resolverFor({}, "api")]]);
      return linkUi({ ws: ws([web, api]), resolvers })[0]!.target;
    };
    const at = { file: "lib/x.ts", line: 1, symbol: "f" };

    it("treats a localhost absolute URL as the workspace backend", () => {
      expect(run({ method: "GET", path: "/api/x", raw: '"http://localhost:3333/api/x"', resolved: true, client: "fetch", at, kind: "literal" }))
        .toMatchObject({ kind: "route", confidence: "exact" });
      expect(run({ method: "GET", path: "/api/x", raw: "`http://127.0.0.1:3333/api/x`", resolved: true, client: "fetch", at, kind: "literal" }))
        .toMatchObject({ kind: "route" });
    });

    it("treats a host listed in a repo's apiBase as internal", () => {
      expect(run({ method: "GET", path: "/api/x", raw: '"https://api.myco.com/api/x"', resolved: true, client: "fetch", at, kind: "literal" }, [], ["api.myco.com"]))
        .toMatchObject({ kind: "route" });
      expect(run({ method: "GET", path: "/api/x", raw: '"https://api.myco.com/api/x"', resolved: true, client: "fetch", at, kind: "literal" }))
        .toEqual({ kind: "external", base: "api.myco.com" });
    });

    it("treats calls through a client whose literal baseURL is a foreign host as external", () => {
      const clients: HttpClient[] = [{ name: "stripe", file: "lib/stripe.ts", line: 1, factory: "axios", baseLiteral: "/v1", baseHost: "api.stripe.com" }];
      expect(run({ method: "GET", path: "/charges", raw: '"/charges"', resolved: true, client: "stripe", at, kind: "literal" }, clients))
        .toEqual({ kind: "external", base: "api.stripe.com" });
    });

    it("matches calls through a localhost client against the workspace", () => {
      const clients: HttpClient[] = [{ name: "api", file: "lib/api.ts", line: 1, factory: "axios", baseLiteral: "/api", baseHost: "localhost:3333" }];
      expect(run({ method: "GET", path: "/x", raw: '"/x"', resolved: true, client: "api", at, kind: "literal" }, clients))
        .toMatchObject({ kind: "route" });
    });
  });
  it("orders calls on the same line by method, then path", () => {
    const at = { file: "lib/x.ts", line: 1, symbol: "f" };
    const mk = (method: HttpCall["method"], path: string): HttpCall => ({ method, path, raw: `"${path}"`, resolved: true, client: "fetch", at, kind: "literal" });
    const web = repo("web", { httpCalls: [mk("POST", "/b"), mk("GET", "/z"), mk("GET", "/a")] });
    const links = linkUi({ ws: ws([web]), resolvers: new Map([["web", resolverFor({}, "web")]]) });
    expect(links.map((l) => `${l.call.method} ${l.call.path}`)).toEqual(["GET /a", "GET /z", "POST /b"]);
  });
});

describe("linkUi — HTTP wrapper calls (H2)", () => {
  const route = (method: HttpCall["method"], path: string): EndpointsFile["routes"][number] => ({
    method, path, handler: `${method} ${path}`, inline: true, framework: "express",
    at: { file: "src/routes.ts", line: 1, symbol: `${method} ${path}` },
  });
  const apiRoutes = [
    route("GET", "/api/user"), route("GET", "/api/articles"), route("GET", "/api/articles/:slug"),
    route("DELETE", "/api/articles/:slug/comments/:id"), route("GET", "/users"),
  ];

  const agentJs = `import superagentPromise from 'superagent-promise';
import _superagent from 'superagent';
const superagent = superagentPromise(_superagent, global.Promise);
const API_ROOT = 'https://conduit.productionready.io/api';
const encode = encodeURIComponent;
const responseBody = res => res.body;
const requests = {
  del: url =>
    superagent.del(\`\${API_ROOT}\${url}\`).then(responseBody),
  get: url =>
    superagent.get(\`\${API_ROOT}\${url}\`).then(responseBody),
};
const limit = (count, p) => \`limit=\${count}&offset=\${p ? p * count : 0}\`;
const Auth = {
  current: () =>
    requests.get('/user'),
};
const Articles = {
  all: page =>
    requests.get(\`/articles?\${limit(10, page)}\`),
  get: slug =>
    requests.get(\`/articles/\${slug}\`),
};
const Comments = {
  delete: (slug, commentId) =>
    requests.del(\`/articles/\${slug}/comments/\${commentId}\`),
};
export default { Articles, Auth, Comments };
`;

  function link(files: Record<string, string>, apiBase?: string[]) {
    const ui = repo("ui", {}, { role: "ui" });
    const api = repo("api", { routes: apiRoutes }, { role: "api", ...(apiBase ? { apiBase } : {}) });
    const resolvers = new Map([["ui", resolverFor(files, "ui")], ["api", resolverFor({}, "api")]]);
    return linkUi({ ws: ws([ui, api]), resolvers });
  }

  it("turns calls to the realworld `requests` wrapper into HTTP calls at the caller, at best param", () => {
    const links = link({ "src/agent.js": agentJs }, ["conduit.productionready.io"]);
    expect(links.map((l) => ({
      at: `${l.call.at.file}#${l.call.at.symbol}`, method: l.call.method, path: l.call.path, via: l.call.via,
      confidence: l.call.confidence,
      target: l.target.kind === "route" ? `${l.target.route.route.method} ${l.target.route.effectivePath}` : l.target.kind,
    }))).toEqual([
      { at: "src/agent.js#Auth.current", method: "GET", path: "/api/user", via: "wrapper", confidence: "param", target: "GET /api/user" },
      { at: "src/agent.js#Articles.all", method: "GET", path: "/api/articles", via: "wrapper", confidence: "param", target: "GET /api/articles" },
      { at: "src/agent.js#Articles.get", method: "GET", path: "/api/articles/:slug", via: "wrapper", confidence: "param", target: "GET /api/articles/:slug" },
      { at: "src/agent.js#Comments.delete", method: "DELETE", path: "/api/articles/:slug/comments/:commentId", via: "wrapper", confidence: "param", target: "DELETE /api/articles/:slug/comments/:id" },
    ]);
  });

  it("treats a wrapper whose literal base names a foreign host as external", () => {
    const links = link({ "src/agent.js": agentJs });
    expect(links.map((l) => l.target)).toEqual(Array(4).fill({ kind: "external", base: "conduit.productionready.io" }));
  });

  it("follows a plain fetch wrapper imported from another file: apiGet(\"/users\")", () => {
    const links = link({
      "src/api.ts": "const API = process.env.NEXT_PUBLIC_API_URL;\nexport function apiGet(path: string) { return fetch(`${API}${path}`); }\n",
      "src/users.ts": 'import { apiGet } from "./api";\nexport function loadUsers() { return apiGet("/users"); }\n',
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      call: { method: "GET", path: "/users", base: "API", via: "wrapper", confidence: "param", at: { file: "src/users.ts", line: 2, symbol: "loadUsers" } },
      target: { kind: "route" },
    });
  });

  it("leaves a wrapper called with a non-literal argument unresolved", () => {
    const links = link({
      "src/api.ts": "export function apiGet(path: string) { return fetch(`${process.env.API}${path}`); }\n",
      "src/users.ts": 'import { apiGet } from "./api";\nexport function load(p: string) { return apiGet(p); }\n',
    });
    // The wrapper's own fetch (adapter-style) is not in endpoints here; only the derived call is linked.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ call: { kind: "unknown", via: "wrapper", at: { symbol: "load" } }, target: { kind: "unresolved" } });
  });

  it("does not add a wrapper call where the adapter already found a call on the same line", () => {
    const files = {
      "src/api.ts": "const api = { get: (url: string) => fetch(`${process.env.API}${url}`) };\nexport function load() { return api.get(\"/users\"); }\n",
    };
    const adapterCall: HttpCall = {
      method: "GET", path: "/users", raw: '"/users"', resolved: true, client: "api", kind: "literal",
      at: { file: "src/api.ts", line: 2, symbol: "load" },
    };
    const ui = repo("ui", { httpCalls: [adapterCall] }, { role: "ui" });
    const api = repo("api", { routes: apiRoutes }, { role: "api" });
    const links = linkUi({ ws: ws([ui, api]), resolvers: new Map([["ui", resolverFor(files, "ui")], ["api", resolverFor({}, "api")]]) });
    expect(links.map((l) => l.call)).toEqual([adapterCall]);
  });

  it("keeps a wrapper call that shares its line with a different adapter call", () => {
    const files = {
      "src/api.ts": "export function apiGet(path: string) { return fetch(`${process.env.API}${path}`); }\n",
      "src/load.ts": 'import { apiGet } from "./api";\nexport function load() { return Promise.all([fetch("/users"), apiGet("/api/user")]); }\n',
    };
    const adapterCall: HttpCall = {
      method: "GET", path: "/users", raw: '"/users"', resolved: true, client: "fetch", kind: "literal",
      at: { file: "src/load.ts", line: 2, symbol: "load" },
    };
    const ui = repo("ui", { httpCalls: [adapterCall] }, { role: "ui" });
    const api = repo("api", { routes: apiRoutes }, { role: "api" });
    const links = linkUi({ ws: ws([ui, api]), resolvers: new Map([["ui", resolverFor(files, "ui")], ["api", resolverFor({}, "api")]]) });
    expect(links.map((l) => `${l.call.method} ${l.call.path} ${l.call.via ?? "adapter"}`).sort()).toEqual(["GET /api/user wrapper", "GET /users adapter"]);
  });

  it("never links a forwarded-init fetch wrapper as GET: apiFetch(path, { method: \"POST\" })", () => {
    const links = link({
      "src/api.ts": "export function apiFetch(path: string, init: RequestInit) { return fetch(path, init); }\nexport function apiSend(path: string, o: RequestInit) { return fetch(path, { ...o }); }\n",
      "src/users.ts": 'import { apiFetch, apiSend } from "./api";\nexport function save() { apiFetch("/users", { method: "POST" }); return apiSend("/users", { method: "POST" }); }\n',
    });
    expect(links.filter((l) => l.call.method === "GET")).toEqual([]);
  });

  it("does not treat a function that hard-codes its URL as a wrapper", () => {
    const links = link({
      "src/api.ts": 'export function listUsers(page: number) { return fetch(`/users?page=${page}`); }\n',
      "src/users.ts": 'import { listUsers } from "./api";\nexport function load() { return listUsers(1); }\n',
    });
    expect(links).toEqual([]);
  });
});
