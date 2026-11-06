import type { JourneyProgressView, LevelCounts, ProgressResponse, TourFile, TourResponse } from "@/api/types";

/** demo-shop stop keys (JSON [lane, repo, file, line, symbol]). */
export const K_PAGE = JSON.stringify(["ui", "web", "app/invoices/new/page.tsx", 12, "NewInvoicePage"]);
export const K_STORE = JSON.stringify(["code", "api", "app/controllers/invoices_controller.ts", 41, "InvoicesController.store"]);
export const K_INSERT = JSON.stringify(["db", "api", "app/controllers/invoices_controller.ts", 44, "InvoicesController.store"]);

const check = (at: string, verdict: "pass" | "fail") => ({ at, questions: ["q1", "q2", "q3"], answers: ["a1", "a2", "a3"], verdict, notes: "", commit: { api: "abc1234" } });

function view(p: Partial<JourneyProgressView> & { journeyId: string; name: string }): JourneyProgressView {
  return { area: "", repos: [], level: "none", needsReWalk: [], lastCheck: null, ...p };
}

export const progressJourneys: JourneyProgressView[] = [
  view({
    journeyId: "j_edit",
    name: "Customer edits a profile",
    area: "Customers",
    repos: ["web"],
  }),
  view({
    journeyId: "j_email",
    name: "Invoice is emailed",
    area: "Invoices",
    repos: ["api"],
    level: "seen",
    seenAt: "2026-10-20T12:00:00.000Z",
  }),
  view({
    journeyId: "j_invoice",
    name: "Customer creates an invoice",
    area: "Invoices",
    repos: ["api", "web"],
    level: "understood",
    needsReWalk: [K_STORE],
    lastCheck: check("2026-10-21T12:00:00.000Z", "pass"),
    seenAt: "2026-10-19T12:00:00.000Z",
    touredAt: "2026-10-20T12:00:00.000Z",
    understoodAt: "2026-10-21T12:00:00.000Z",
  }),
  view({
    journeyId: "j_signup",
    name: "Customer signs up",
    area: "Customers",
    repos: ["api", "web"],
    level: "understood",
    lastCheck: check("2026-10-22T12:00:00.000Z", "pass"),
    seenAt: "2026-10-18T12:00:00.000Z",
    understoodAt: "2026-10-22T12:00:00.000Z",
  }),
  view({
    journeyId: "j_void",
    name: "Admin voids an invoice",
    area: "Invoices",
    repos: ["api"],
    level: "toured",
    lastCheck: check("2026-10-25T12:00:00.000Z", "fail"),
    seenAt: "2026-10-23T12:00:00.000Z",
    touredAt: "2026-10-24T12:00:00.000Z",
  }),
];

const counts = (p: Partial<LevelCounts>): LevelCounts => ({ total: 0, none: 0, seen: 0, toured: 0, understood: 0, needsReWalk: 0, ...p });

export const progress: ProgressResponse = {
  workspaceId: "0123456789abcdef",
  path: "/home/dev/.codeloom/progress/0123456789abcdef.json",
  journeys: progressJourneys,
  totals: {
    all: counts({ total: 5, none: 1, seen: 1, toured: 1, understood: 2, needsReWalk: 1 }),
    byRepo: {
      api: counts({ total: 4, seen: 1, toured: 1, understood: 2, needsReWalk: 1 }),
      docs: counts({}),
      web: counts({ total: 3, none: 1, understood: 2, needsReWalk: 1 }),
    },
    byArea: {
      Customers: counts({ total: 2, none: 1, understood: 1 }),
      Invoices: counts({ total: 3, seen: 1, toured: 1, understood: 1, needsReWalk: 1 }),
    },
  },
  olderJourneys: ["j_oldinvoice"],
};

export const emptyProgress: ProgressResponse = {
  ...progress,
  journeys: [],
  totals: { all: counts({}), byRepo: { api: counts({}) }, byArea: {} },
  olderJourneys: [],
};

function tourFile(journeyId: string): TourFile {
  return {
    version: 1,
    journeyId,
    writtenAt: "2026-10-19T12:00:00.000Z",
    writtenAtCommit: { api: "abc1234" },
    stops: [K_PAGE, K_STORE, K_INSERT].map((key, i) => ({ chainId: "ch_aaaa", stopIndex: i, key, fileHash: "h", explanation: "Explains the stop." })),
    dataJourney: { input: '{"customerId": 7}', steps: [], output: '{"id": 41}' },
    fileNotes: [],
    check: [
      { question: "Where is the invoice total computed?", expected: ["InvoiceService"] },
      { question: "Which table gets the lines?", expected: ["invoice_lines"] },
      { question: "What does the page send?", expected: ["customerId"] },
    ],
  };
}

export function tour(journeyId: string, stale: string[] = []): TourResponse {
  return { journeyId, journeyExists: true, tour: tourFile(journeyId), staleStops: stale, removedStops: [] };
}

export function noTour(journeyId: string): TourResponse {
  return { journeyId, journeyExists: true, tour: null, staleStops: [], removedStops: [] };
}
