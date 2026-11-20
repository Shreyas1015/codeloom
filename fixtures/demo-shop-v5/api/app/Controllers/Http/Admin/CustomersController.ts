import Database from '@ioc:Adonis/Lucid/Database'

export default class AdminCustomersController {
  public async index() {
    return Database.from('customers').select('*')
  }
}
