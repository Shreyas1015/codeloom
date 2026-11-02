import type { ChainView, JourneyResult, Lane, StopView } from "@/api/types";

/** demo-shop: "Customer creates an invoice", two chains that share the new-invoice page. */
export const page: StopView = {
  lane: "ui", kind: "page", repo: "web", file: "app/invoices/new/page.tsx", line: 12, symbol: "NewInvoicePage",
  label: "/invoices/new", confidence: "exact", ref: "web::fn:app/invoices/new/page.tsx:NewInvoicePage",
};
const postCall: StopView = {
  lane: "ui", kind: "call", repo: "web", file: "lib/api.ts", line: 30, symbol: "createInvoice", label: "POST /api/invoices", confidence: "exact",
};
const postRoute: StopView = {
  lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 20, symbol: "routes", label: "POST /api/invoices", confidence: "param",
};
export const store: StopView = {
  lane: "api", kind: "handler", repo: "api", file: "app/controllers/invoices_controller.ts", line: 41, symbol: "InvoicesController.store",
  confidence: "exact", ref: "api::fn:app/controllers/invoices_controller.ts:InvoicesController.store",
};
const insert: StopView = {
  lane: "db", kind: "db", repo: "api", file: "app/controllers/invoices_controller.ts", line: 44, symbol: "InvoicesController.store",
  label: "invoices", op: "insert", confidence: "exact",
};
const getCall: StopView = {
  lane: "ui", kind: "call", repo: "web", file: "lib/api.ts", line: 18, symbol: "listCustomers", label: "GET /api/customers", confidence: "exact",
};
const getRoute: StopView = {
  lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 12, symbol: "routes", label: "GET /api/customers",
  confidence: "guess", reason: "URL built at runtime; matched by prefix",
};

export const chainA: ChainView = {
  id: "ch_aaaa", name: "POST /api/invoices", entry: "web:/invoices/new", routeKey: "POST /api/invoices", confidence: "param",
  complete: true, journeys: ["j_invoice"], stops: [page, postCall, postRoute, store, insert], unresolved: [],
};
export const chainB: ChainView = {
  id: "ch_bbbb", name: "GET /api/customers", entry: "web:/invoices/new", routeKey: "GET /api/customers", confidence: "guess",
  complete: false, journeys: ["j_invoice"], stops: [page, getCall, getRoute],
  unresolved: [{ at: { repo: "api", file: "start/routes.ts", line: 12, symbol: "routes" }, reason: "No handler found for GET /api/customers" }],
};

function lanesOf(chains: ChainView[]): Record<Lane, StopView[]> {
  const lanes: Record<Lane, StopView[]> = { ui: [], api: [], code: [], db: [], queue: [] };
  const seen = new Set<string>();
  for (const c of chains)
    for (const s of c.stops) {
      const k = JSON.stringify([s.lane, s.repo, s.file, s.line, s.symbol]);
      if (seen.has(k)) continue;
      seen.add(k);
      lanes[s.lane].push(s);
    }
  return lanes;
}

/** Stops in number order: 1 page, 2 POST call, 3 POST route, 4 store, 5 insert, 6 GET call, 7 GET route. */
export const journeyResult: JourneyResult = {
  journey: {
    id: "j_invoice", name: "Customer creates an invoice", area: "Invoices", note: "From the new-invoice form down to the invoices table.",
    chainIds: ["ch_aaaa", "ch_bbbb"], status: "ok",
  },
  chains: [chainA, chainB],
  lanes: lanesOf([chainA, chainB]),
  files: ["api:app/controllers/invoices_controller.ts", "api:start/routes.ts", "web:app/invoices/new/page.tsx", "web:lib/api.ts"],
  tables: ["invoices"],
  queues: [],
  unresolved: chainB.unresolved.map((u) => ({ chainId: "ch_bbbb", ...u })),
  missingChainIds: [],
};

export const chainResult: JourneyResult = {
  journey: null,
  chains: [{ ...chainA, journeys: [] }],
  lanes: lanesOf([chainA]),
  files: ["api:app/controllers/invoices_controller.ts", "api:start/routes.ts", "web:app/invoices/new/page.tsx", "web:lib/api.ts"],
  tables: ["invoices"],
  queues: [],
  unresolved: [],
  missingChainIds: [],
};

export const orphanedResult: JourneyResult = {
  journey: { ...journeyResult.journey!, status: "orphaned" },
  chains: [],
  lanes: { ui: [], api: [], code: [], db: [], queue: [] },
  files: [],
  tables: [],
  queues: [],
  unresolved: [],
  missingChainIds: ["ch_aaaa", "ch_bbbb"],
};
