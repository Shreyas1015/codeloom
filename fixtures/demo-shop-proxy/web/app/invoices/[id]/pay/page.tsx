"use client";

export default function PayInvoicePage({ params }: { params: { id: string } }) {
  return <button onClick={() => fetch(`/api/billing/invoices/${params.id}/pay`, { method: "POST" })}>Pay</button>;
}
