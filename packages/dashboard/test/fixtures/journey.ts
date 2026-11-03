import type { ChainView, JourneyResult, Lane, StopView } from "@/api/types";

// TODO(from): drop this local widening once StopView carries `from` in codeloom's api-types.
export type StopWithFrom = StopView & { from?: number };

/** demo-shop: "Customer creates an invoice", two chains that share the new-invoice page.
 * `from` = index (in the same chain's stops) of the stop this one was reached from. */
export const page: StopWithFrom = {
  lane: "ui", kind: "page", repo: "web", file: "app/invoices/new/page.tsx", line: 12, symbol: "NewInvoicePage",
  label: "/invoices/new", confidence: "exact", ref: "web::function:app/invoices/new/page.tsx:NewInvoicePage",
};
export const postCall: StopWithFrom = {
  lane: "ui", kind: "call", repo: "web", file: "lib/api.ts", line: 30, symbol: "createInvoice", label: "POST /api/invoices",
  confidence: "exact", from: 0,
};
const postRoute: StopWithFrom = {
  lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 20, symbol: "routes", label: "POST /api/invoices",
  confidence: "param", from: 1,
};
export const store: StopWithFrom = {
  lane: "code", kind: "handler", repo: "api", file: "app/controllers/invoices_controller.ts", line: 41, symbol: "InvoicesController.store",
  confidence: "exact", ref: "api::function:app/controllers/invoices_controller.ts:InvoicesController.store", from: 2,
};
const insertInvoice: StopWithFrom = {
  lane: "db", kind: "db", repo: "api", file: "app/controllers/invoices_controller.ts", line: 44, symbol: "InvoicesController.store",
  label: "invoices", op: "insert", confidence: "exact", from: 3,
};
const insertLines: StopWithFrom = {
  lane: "db", kind: "db", repo: "api", file: "app/controllers/invoices_controller.ts", line: 47, symbol: "InvoicesController.store",
  label: "invoice_lines", op: "insert", confidence: "exact", from: 3,
};
const getCall: StopWithFrom = {
  lane: "ui", kind: "call", repo: "web", file: "lib/api.ts", line: 18, symbol: "listCustomers", label: "GET /api/customers",
  confidence: "guess", reason: "Called from a customer picker; matched by name", from: 0,
};
const getRoute: StopWithFrom = {
  lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 12, symbol: "routes", label: "GET /api/customers",
  confidence: "guess", reason: "URL built at runtime; matched by prefix", from: 1,
};
/** No `from`: the linker could not say where it was reached from, so no line leads to it. */
const indexHandler: StopWithFrom = {
  lane: "code", kind: "handler", repo: "api", file: "app/controllers/customers_controller.ts", line: 9, symbol: "CustomersController.index",
  confidence: "exact",
};

export const chainA: ChainView = {
  id: "ch_aaaa", name: "POST /api/invoices", entry: "web:/invoices/new", routeKey: "POST /api/invoices", confidence: "param",
  complete: true, journeys: ["j_invoice"], stops: [page, postCall, postRoute, store, insertInvoice, insertLines], unresolved: [],
};
export const chainB: ChainView = {
  id: "ch_bbbb", name: "GET /api/customers", entry: "web:/invoices/new", routeKey: "GET /api/customers", confidence: "guess",
  complete: false, journeys: ["j_invoice"], stops: [page, getCall, getRoute, indexHandler],
  unresolved: [{ at: { repo: "api", file: "start/routes.ts", line: 12, symbol: "routes" }, reason: "No handler found for GET /api/customers" }],
};

export function lanesOf(chains: ChainView[]): Record<Lane, StopView[]> {
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

/** Stops by number: 1 page, 2 POST call, 3 POST route, 4 store (code), 5 invoices, 6 invoice_lines,
 * 7 GET call, 8 GET route, 9 CustomersController.index (code, no `from`). */
export const journeyResult: JourneyResult = {
  journey: {
    id: "j_invoice", name: "Customer creates an invoice", area: "Invoices", note: "From the new-invoice form down to the invoices table.",
    chainIds: ["ch_aaaa", "ch_bbbb"], status: "ok",
  },
  chains: [chainA, chainB],
  lanes: lanesOf([chainA, chainB]),
  files: [
    "api:app/controllers/customers_controller.ts", "api:app/controllers/invoices_controller.ts", "api:start/routes.ts",
    "web:app/invoices/new/page.tsx", "web:lib/api.ts",
  ],
  tables: ["invoice_lines", "invoices"],
  queues: [],
  unresolved: chainB.unresolved.map((u) => ({ chainId: "ch_bbbb", ...u })),
  missingChainIds: [],
};

export const chainResult: JourneyResult = {
  journey: null,
  chains: [{ ...chainA, journeys: [] }],
  lanes: lanesOf([chainA]),
  files: ["api:app/controllers/invoices_controller.ts", "api:start/routes.ts", "web:app/invoices/new/page.tsx", "web:lib/api.ts"],
  tables: ["invoice_lines", "invoices"],
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
