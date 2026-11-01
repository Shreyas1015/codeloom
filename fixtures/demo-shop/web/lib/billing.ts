import { billingApi } from "./billing-api";

export async function createInvoice(customerId: number) {
  const res = await billingApi.post("/billing/invoices", { customerId });
  return res.data;
}
