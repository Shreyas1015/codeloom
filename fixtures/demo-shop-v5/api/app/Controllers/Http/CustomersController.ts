import type { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import CustomerService from 'App/Services/CustomerService'
import customerLookup from 'App/Services/CustomerLookup'

export default class CustomersController {
  public async index() {
    return CustomerService.list()
  }

  public async store({ request }: HttpContextContract) {
    return new CustomerService().create(request.only(['name']))
  }

  public async show({ params }: HttpContextContract) {
    return customerLookup.find(Number(params.id))
  }
}
