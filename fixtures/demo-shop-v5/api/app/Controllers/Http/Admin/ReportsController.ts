import Database from '@ioc:Adonis/Lucid/Database'

export default class ReportsController {
  public async handle() {
    return Database.from('orders').count('* as total')
  }
}
