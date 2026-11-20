import type { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Order from 'App/Models/Order'

export default class OrdersController {
  public async index() {
    return Order.all()
  }

  public async store({ request }: HttpContextContract) {
    return Order.create(request.only(['customerId']))
  }

  public async show({ params }: HttpContextContract) {
    return Order.findOrFail(params.id)
  }

  public async update({ params, request }: HttpContextContract) {
    const order = await Order.findOrFail(params.id)
    order.merge(request.only(['customerId']))
    return order.save()
  }
}
