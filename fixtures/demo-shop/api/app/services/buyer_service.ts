import db from "@adonisjs/lucid/services/db";
import Customer from "#models/customer";

export default class CustomerService {
  async create(payload: { name: string; gstNo: string; city: string }) {
    const customer = await Customer.create(payload);
    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });
    return customer;
  }

  async find(id: number) {
    return Customer.findOrFail(id);
  }
}
