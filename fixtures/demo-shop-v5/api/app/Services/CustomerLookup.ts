import Database from '@ioc:Adonis/Lucid/Database'

class CustomerLookup {
  public async find(id: number) {
    return Database.from('customers').where('id', id).first()
  }
}

export default new CustomerLookup()
