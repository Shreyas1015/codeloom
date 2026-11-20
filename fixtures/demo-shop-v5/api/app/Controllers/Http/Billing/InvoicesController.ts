import type { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import { BillingService } from 'App/Services/BillingService'

export default class InvoicesController {
  public async create({ request }: HttpContextContract) {
    return BillingService.createInvoice(Number(request.input('customerId')))
  }

  public async pay({ params }: HttpContextContract) {
    const billing = new BillingService()
    return billing.payInvoice(Number(params.id))
  }
}
