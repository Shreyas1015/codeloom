"use client";

export default function LegacyInvoicePage() {
  return <button onClick={() => fetch("/api/legacy/billing/invoices", { method: "POST" })}>Create</button>;
}
