export async function getCustomer(id: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/customers/${id}`);
  return res.json();
}
