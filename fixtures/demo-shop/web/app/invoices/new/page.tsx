"use client";
import { createInvoice } from "../../../lib/billing";

export default function NewInvoicePage() {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void createInvoice(1);
      }}
    >
      <button type="submit">Save</button>
    </form>
  );
}
