import { getCustomer } from "../../../lib/get-customer";

export default async function CustomerPage({ params }: { params: { id: string } }) {
  const customer = await getCustomer(params.id);
  return <h1>{customer.name}</h1>;
}
