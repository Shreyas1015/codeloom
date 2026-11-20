import Customer from 'App/Models/Customer'

export default class CustomerService {
  public static async list() {
    return Customer.query().orderBy('id')
  }

  public async create(payload: { name: string }) {
    return Customer.create(payload)
  }
}
