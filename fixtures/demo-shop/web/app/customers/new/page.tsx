"use client";
import { useCreateCustomer } from "../../../lib/use-create-customer";

export default function NewCustomerPage() {
  const createCustomer = useCreateCustomer();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void createCustomer({ name: "Ada Lovelace", email: "ada@example.com", city: "London" });
      }}
    >
      <button type="submit">Save</button>
    </form>
  );
}
