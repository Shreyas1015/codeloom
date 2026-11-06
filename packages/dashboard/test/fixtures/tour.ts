import type { JourneyProgressView, ProgressResponse, TourFile, TourResponse } from "@/api/types";
import { stopKey } from "@/lib/journey-stops";
import { page, postCall, store } from "./journey";

export const insertInvoiceKey = stopKey({ lane: "db", repo: "api", file: "app/controllers/invoices_controller.ts", line: 44, symbol: "InvoicesController.store" });
/** A stop the tour was written for that is no longer in the journey. */
export const removedKey = stopKey({ lane: "code", repo: "api", file: "app/services/legacy_invoice.ts", line: 3, symbol: "LegacyInvoice.save" });
export const storeKey = stopKey(store);

/** demo-shop "Customer creates an invoice": stored in file order (chainId, stopIndex), not stop number. */
export const tourFile: TourFile = {
  version: 1,
  journeyId: "j_invoice",
  writtenAt: "2026-11-01T10:00:00.000Z",
  writtenAtCommit: { api: "abc1234", web: "def5678" },
  stops: [
    { chainId: "ch_aaaa", stopIndex: 3, key: storeKey, fileHash: "h3", explanation: "Validates the invoice with `createInvoiceValidator`.\n\nThen **saves** it for the customer." },
    { chainId: "ch_aaaa", stopIndex: 0, key: stopKey(page), fileHash: "h0", explanation: "The new-invoice form." },
    { chainId: "ch_aaaa", stopIndex: 1, key: stopKey(postCall), fileHash: "h1", explanation: "Sends the form as JSON." },
    { chainId: "ch_aaaa", stopIndex: 4, key: insertInvoiceKey, fileHash: "h4", explanation: "Writes the invoice row." },
    { chainId: "ch_zzzz", stopIndex: 2, key: removedKey, fileHash: "h9", explanation: "The old save path." },
  ],
  dataJourney: {
    input: '{ "customerId": 3812, "lines": [{ "sku": "PANEL-400", "qty": 2 }] }',
    steps: [
      { stopKey: stopKey(postCall), note: "The form becomes a POST body." },
      { stopKey: insertInvoiceKey, note: "One row per invoice.", sql: "INSERT INTO invoices (customer_id, total) VALUES ($1, $2)" },
    ],
    output: '{ "id": 501, "customerId": 3812 }',
  },
  fileNotes: [
    {
      repo: "api",
      file: "app/controllers/invoices_controller.ts",
      notes: [
        { kind: "trap", text: "The total is computed here, not in the model." },
        { kind: "note", text: "Uses the customer's default currency." },
      ],
    },
  ],
  check: [
    { question: "Where is the invoice total computed?", expected: ["In InvoicesController.store", "Not in the model"] },
    { question: "Which tables get a row?", expected: ["invoices", "invoice_lines"] },
    { question: "What does the form send?", expected: ["customerId and lines as JSON"] },
  ],
};

export const tourResponse: TourResponse = { journeyId: "j_invoice", journeyExists: true, tour: tourFile, staleStops: [storeKey], removedStops: [removedKey] };
export const noTourResponse: TourResponse = { journeyId: "j_invoice", journeyExists: true, tour: null, staleStops: [], removedStops: [] };

export const invoiceProgress: JourneyProgressView = {
  journeyId: "j_invoice",
  name: "Customer creates an invoice",
  area: "Invoices",
  repos: ["api", "web"],
  level: "seen",
  needsReWalk: [],
  lastCheck: {
    at: "2026-11-02T09:30:00.000Z",
    questions: ["Where is the invoice total computed?"],
    answers: ["In the model"],
    verdict: "fail",
    notes: "The total is computed in the controller.",
    commit: { api: "abc1234" },
  },
  seenAt: "2026-10-30T08:00:00.000Z",
};

const counts = { total: 1, none: 0, seen: 1, toured: 0, understood: 0, needsReWalk: 0 };
export function progressWith(row: JourneyProgressView = invoiceProgress): ProgressResponse {
  return {
    workspaceId: "0123456789abcdef",
    path: "/home/u/.codeloom/progress/0123456789abcdef.json",
    journeys: [row],
    totals: { all: counts, byRepo: { api: counts, web: counts }, byArea: { Invoices: counts } },
    olderJourneys: [],
  };
}
