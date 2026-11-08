import type { DocResponse, JourneySpecRow, JourneySpecsResponse, SpecCoverage, SpecsResponse } from "@/api/types";

/** demo-shop spec links: ticket keys are generic `SHOP-n`, docs live under `docs/`. */

export function specRow(p: Partial<JourneySpecRow> & { journeyId: string; name: string }): JourneySpecRow {
  return { area: "", repos: [], state: "none", checked: false, links: [], candidates: { docs: 0, tickets: 0 }, ...p };
}

export function coverage(p: Partial<SpecCoverage> = {}): SpecCoverage {
  return { total: 0, linked: 0, candidates: 0, none: 0, checked: 0, ...p };
}

export const LINKED_AT = "2026-11-03T10:00:00.000Z";

/** One journey per state: linked, candidates waiting, checked with no spec, not checked. */
export const specsList: SpecsResponse = {
  journeys: [
    specRow({
      journeyId: "j_void", name: "Admin voids an invoice", area: "Invoices", repos: ["api", "web"], state: "linked", checked: true,
      checkedAt: LINKED_AT,
      links: [{ kind: "ticket", ref: "SHOP-12", reason: "The ticket that added voiding.", savedAt: LINKED_AT }],
    }),
    specRow({
      journeyId: "j_signup", name: "Customer signs up", area: "Customers", repos: ["api", "web"], state: "candidates",
      candidates: { docs: 2, tickets: 1 },
    }),
    specRow({ journeyId: "j_email", name: "Invoice is emailed", area: "Invoices", repos: ["api"], state: "none", checked: true, checkedAt: LINKED_AT }),
  ],
  totals: {
    all: coverage({ total: 3, linked: 1, candidates: 1, none: 1, checked: 2 }),
    byRepo: {
      api: coverage({ total: 3, linked: 1, candidates: 1, none: 1, checked: 2 }),
      web: coverage({ total: 2, linked: 1, candidates: 1, none: 0, checked: 1 }),
    },
    byArea: {
      Customers: coverage({ total: 1, candidates: 1 }),
      Invoices: coverage({ total: 2, linked: 1, none: 1, checked: 2 }),
    },
  },
  olderJourneys: [],
  candidatesIndexed: true,
};

/** "Customer creates an invoice": a linked doc and a linked ticket. */
export const invoiceLinked: JourneySpecsResponse = {
  journeyId: "j_invoice",
  journeyExists: true,
  journey: { id: "j_invoice", name: "Customer creates an invoice", area: "Invoices" },
  state: "linked",
  checked: true,
  checkedAt: LINKED_AT,
  links: [
    { kind: "doc", ref: "api:docs/invoices.md", reason: "Describes POST /api/invoices and the invoices table.", savedAt: LINKED_AT },
    { kind: "ticket", ref: "SHOP-12", reason: "Added invoice creation for customers.", savedAt: LINKED_AT },
  ],
  candidates: { docs: [], tickets: [] },
  candidatesIndexed: true,
};

/** The same journey, not checked yet: one candidate doc and one candidate ticket with evidence. */
export const invoiceCandidates: JourneySpecsResponse = {
  ...invoiceLinked,
  state: "candidates",
  checked: false,
  checkedAt: null,
  links: [],
  candidates: {
    docs: [
      {
        ref: "api:docs/invoices.md", repo: "api", file: "docs/invoices.md", score: 5, count: 2,
        evidence: [
          { kind: "route", term: "POST /api/invoices", file: "docs/invoices.md", line: 3 },
          { kind: "table", term: "invoices", file: "docs/invoices.md", line: 5 },
        ],
      },
    ],
    tickets: [
      {
        ref: "SHOP-12", score: 2, count: 2,
        evidence: [
          { repo: "api", commit: "a1b2c3d", file: "app/controllers/invoices_controller.ts", subject: "SHOP-12 create invoices for a customer" },
        ],
      },
    ],
  },
};

export const invoicesDoc: DocResponse = {
  repo: "api",
  file: "docs/invoices.md",
  text: "# Invoices\n\nPOST /api/invoices creates an invoice.\n\nRows go to the invoices table.",
  lines: 5,
  bytes: 80,
};
