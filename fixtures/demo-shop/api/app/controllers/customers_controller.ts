import type { HttpContext } from "@adonisjs/core/http";
import { inject } from "@adonisjs/core";
import CustomerService from "#services/customer_service";

@inject()
export default class CustomersController {
  constructor(private customers: CustomerService) {}

  async store({ request, response }: HttpContext) {
    const customer = await this.customers.create(request.body() as { name: string; email: string; city: string });
    return response.created(customer);
  }

  async show({ params }: HttpContext) {
    return new CustomerService().find(Number(params.id));
  }
}
