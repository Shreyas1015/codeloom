import { api } from "./api";

export function useCreateCustomer() {
  return async (input: { name: string; gstNo: string; city: string }) => {
    const res = await api.post("/api/customers", input);
    return res.data;
  };
}
