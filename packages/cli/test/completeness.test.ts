import { describe, expect, it } from "vitest";
import { chainReach, hasUiStop, isComplete, reachesStore } from "../src/linker/completeness.js";
import type { ChainStop } from "../src/store/schemas.js";

const exact = { confidence: "exact" as const };
const page: ChainStop = { lane: "ui", kind: "page", repo: "web", file: "src/pages/Customers.tsx", line: 1, symbol: "CustomersPage", hop: exact };
const call: ChainStop = { lane: "ui", kind: "call", repo: "web", file: "src/api/customers.ts", line: 3, symbol: "createCustomer", op: "POST", hop: exact, from: 0 };
const route: ChainStop = { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 4, symbol: "CustomersController.store", op: "POST", label: "POST /api/customers", hop: exact };
const handler: ChainStop = { lane: "code", kind: "handler", repo: "api", file: "app/customers.ts", line: 8, symbol: "CustomersController.store", hop: exact };
const db: ChainStop = { lane: "db", kind: "db", repo: "api", file: "app/customers.ts", line: 9, symbol: "CustomersController.store", op: "insert", label: "customers", hop: exact };
const publish: ChainStop = { lane: "queue", kind: "publish", repo: "api", file: "app/invoices.ts", line: 9, symbol: "InvoicesController.store", op: "publish", label: "invoice.created", hop: exact };
const consume: ChainStop = { lane: "queue", kind: "consume", repo: "api", file: "app/worker.ts", line: 2, symbol: "onInvoice", op: "consume", label: "invoice.created", hop: exact };

describe("completeness (H3): complete only with a UI stop and a store", () => {
  it("a page → call → route → handler → db chain is complete", () => {
    const stops = [page, call, route, handler, db];
    expect(hasUiStop(stops)).toBe(true);
    expect(reachesStore(stops)).toBe(true);
    expect(isComplete(stops)).toBe(true);
    expect(chainReach(stops)).toBe("complete");
  });

  it("a call-entry chain (call stop, no page) that reaches a queue is complete", () => {
    expect(chainReach([call, route, handler, publish])).toBe("complete");
  });

  it("a route-only chain that reaches a table is API → DB only, not complete", () => {
    const stops = [route, handler, db];
    expect(isComplete(stops)).toBe(false);
    expect(chainReach(stops)).toBe("api-only");
  });

  it("a consumer chain that reaches a table has no UI stop: API → DB only", () => {
    expect(chainReach([consume, handler, db])).toBe("api-only");
  });

  it("a chain that reaches no store is incomplete, with or without a UI stop", () => {
    expect(chainReach([page, call, route, handler])).toBe("incomplete");
    expect(chainReach([route, handler])).toBe("incomplete");
    expect(chainReach([])).toBe("incomplete");
  });
});
