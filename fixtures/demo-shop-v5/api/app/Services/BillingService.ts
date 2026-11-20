import Env from '@ioc:Adonis/Core/Env'
import axios from 'axios'

export class BillingService {
  public static async createInvoice(customerId: number) {
    const res = await axios.post(`${Env.get('BILLING_API_URL')}/billing/invoices`, { customerId })
    return res.data
  }

  public async payInvoice(id: number) {
    const res = await axios.post(`${Env.get('BILLING_API_URL')}/billing/invoices/${id}/pay`)
    return res.data
  }
}
