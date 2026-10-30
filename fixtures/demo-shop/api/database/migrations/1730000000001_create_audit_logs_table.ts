import { BaseSchema } from "@adonisjs/lucid/schema";

export default class extends BaseSchema {
  async up() {
    this.schema.createTable("audit_logs", (table) => {
      table.increments("id");
      table.string("action");
    });
  }
}
