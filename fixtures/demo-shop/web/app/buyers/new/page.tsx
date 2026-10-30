"use client";
import { useCreateCustomer } from "../../../lib/use-create-customer";

export default function NewCustomerPage() {
  const createCustomer = useCreateCustomer();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void createCustomer({ name: "Asha Solar", gstNo: "27AABCA1234F1Z5", city: "Lisbon" });
      }}
    >
      <button type="submit">Save</button>
    </form>
  );
}
