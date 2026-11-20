import { BaseModel, column } from '@ioc:Adonis/Lucid/Orm'

export default class Customer extends BaseModel {
  public static table = 'customers'

  @column({ isPrimary: true })
  public id: number

  @column()
  public name: string
}
