import type { HttpContext } from "@adonisjs/core/http";
import CustomerService from "#services/customer_service";

export default class CustomersController {
  async store({ request, response }: HttpContext) {
    const customer = await new CustomerService().create(request.body() as { name: string; email: string; city: string });
    return response.created(customer);
  }

  async show({ params }: HttpContext) {
    return new CustomerService().find(Number(params.id));
  }
}
