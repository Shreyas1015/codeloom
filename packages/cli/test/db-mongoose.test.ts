import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { detectDb, mongooseCollection } from "../src/adapters/db.js";
import { finalizeEndpoints, type ImportResolver, runAdapters } from "../src/adapters/run.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

const ctx = ctxWith("mongoose", "express");

function resolverFor(files: string[]): ImportResolver {
  return (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const cand of [`${base}.ts`, `${base}/index.ts`]) if (files.includes(cand)) return cand;
    return null;
  };
}

/** Index files as one repo; "op table|model:<m> via <via> @symbol" per access, and "model -> table" per model. */
function index(files: Record<string, string>): { access: string[]; models: string[]; tables: string[] } {
  const rels = Object.keys(files);
  const ep = finalizeEndpoints("api", rels.map((rel) => runAdapters(rel, files[rel]!, ctx)), resolverFor(rels));
  return {
    access: ep.dbAccess.map((a) => `${a.op} ${a.table ?? `model:${a.model}`} via ${a.via} @${a.at.symbol}`),
    models: ep.models.map((m) => `${m.model} -> ${m.table}`),
    tables: ep.tables.map((t) => t.name),
  };
}

describe("H9: mongoose models name their collection, never the model's own name", () => {
  it("uses mongoose's rule (lowercase + plural) when nothing names the collection", () => {
    expect(index({
      "src/models/customer.ts": `
        import mongoose from "mongoose";
        const customerSchema = new mongoose.Schema({ name: String });
        export const Customer = mongoose.model("Customer", customerSchema);
        export const listCustomers = () => Customer.find({});
      `,
    })).toEqual({
      access: ["read customers via mongoose @listCustomers"],
      models: ["Customer -> customers"],
      tables: ["customers"],
    });
  });

  it("takes the 3rd argument of model(), else the schema's collection option", () => {
    expect(index({
      "src/models/invoice.ts": `
        import { model, Schema } from "mongoose";
        const invoiceSchema = new Schema({ total: Number });
        const lineSchema = new Schema({ qty: Number }, { collection: "invoice_lines", timestamps: true });
        export const Invoice = model("Invoice", invoiceSchema, "billing_invoices");
        export const InvoiceLine = model("InvoiceLine", lineSchema);
        export async function pay(id: string) {
          await Invoice.findByIdAndUpdate(id, { paid: true });
          await InvoiceLine.deleteMany({ invoice: id });
          return Invoice.create({ total: 1 });
        }
      `,
    })).toEqual({
      access: [
        "update billing_invoices via mongoose @pay",
        "delete invoice_lines via mongoose @pay",
        "insert billing_invoices via mongoose @pay",
      ],
      models: ["Invoice -> billing_invoices", "InvoiceLine -> invoice_lines"],
      tables: ["billing_invoices", "invoice_lines"],
    });
  });

  it("resolves a model imported from its own file (default export, any local name)", () => {
    expect(index({
      "src/models/customer.ts": `
        import mongoose from "mongoose";
        const schema = new mongoose.Schema({ name: String });
        const CustomerModel = mongoose.models.Customer || mongoose.model("Customer", schema);
        export default CustomerModel;
      `,
      "src/services/customer-service.ts": `
        import Clients from "../models/customer";
        export const find = (id: string) => Clients.findById(id);
        export const count = () => Clients.countDocuments();
      `,
    })).toEqual({
      access: ["read customers via mongoose @find", "read customers via mongoose @count"],
      models: ["CustomerModel -> customers"],
      tables: ["customers"],
    });
  });

  it("a default import takes the table of the file it comes from, even when every model file names its variable Model", () => {
    const r = index({
      "src/models/customer.ts": `
        import mongoose from "mongoose";
        const schema = new mongoose.Schema({ name: String });
        const Model = mongoose.model("Customer", schema);
        export default Model;
      `,
      "src/models/invoice.ts": `
        import mongoose from "mongoose";
        const schema = new mongoose.Schema({ total: Number });
        const Model = mongoose.model("Invoice", schema);
        export default Model;
      `,
      "src/services/invoice-service.ts": `
        import Invoice from "../models/invoice";
        import Customer from "../models/customer";
        export const list = () => Invoice.find();
        export const one = (id: string) => Customer.findById(id);
      `,
    });
    expect(r.access).toEqual(["read invoices via mongoose @list", "read customers via mongoose @one"]);
  });

  it("a model name that maps to more than one table resolves to no table, never the first one", () => {
    const r = index({
      "src/models/customer.ts": `
        import mongoose from "mongoose";
        const Model = mongoose.model("Customer", new mongoose.Schema({}));
        export default Model;
      `,
      "src/models/invoice.ts": `
        import mongoose from "mongoose";
        const Model = mongoose.model("Invoice", new mongoose.Schema({}));
        export default Model;
      `,
      "src/services/guess.ts": `
        import { Model } from "../models/model";
        export const list = () => Model.find();
      `,
    });
    expect(r.access).toEqual(["read model:Model via mongoose @list"]);
  });

  it("reports no table when the collection cannot be read (the access keeps its model, table unknown)", () => {
    const r = index({
      "src/models/dynamic.ts": `
        import mongoose from "mongoose";
        const schema = new mongoose.Schema({});
        export const Customer = mongoose.model("Customer", schema, process.env.CUSTOMER_COLLECTION);
        export const Invoice = mongoose.model(modelName(), schema);
        export const a = () => Customer.find();
        export const b = () => Invoice.findOne();
      `,
    });
    expect(r).toEqual({
      access: ["read model:Customer via mongoose @a", "read model:Invoice via mongoose @b"],
      models: [],
      tables: [],
    });
  });

  it("does not treat a model-looking call as mongoose without the mongoose dependency", () => {
    expect(detectDb(parsed("src/models/c.ts", `
      const Customer = model("Customer", schema);
      export const a = () => Customer.find();
    `), ctxWith("express"))).toEqual({ dbAccess: [], tables: [], models: [] });
  });
});

describe("v0.2a §4: more mongoose shapes", () => {
  it("new Model(data).save() inserts into the model's collection (imported or local model)", () => {
    expect(index({
      "src/models/customer.ts": `
        import mongoose from "mongoose";
        const Customer = mongoose.model("Customer", new mongoose.Schema({ name: String }));
        export default Customer;
      `,
      "src/services/customer-service.ts": `
        import Customer from "../models/customer";
        import { Invoice } from "../models/invoice";
        export async function register(data: unknown) { return new Customer(data).save(); }
        export async function bill(data: unknown) {
          const invoice = new Invoice(data);
          await invoice.save();
        }
      `,
      "src/models/invoice.ts": `
        import { model, Schema } from "mongoose";
        export const Invoice = model("Invoice", new Schema({ total: Number }));
      `,
    }).access).toEqual(["insert customers via mongoose @register", "insert invoices via mongoose @bill"]);
  });

  it("save() on anything that is not a new model document is not an access", () => {
    expect(index({
      "src/models/customer.ts": `
        import mongoose from "mongoose";
        export const Customer = mongoose.model("Customer", new mongoose.Schema({}));
        export async function a(form: any) { await new Draft(form).save(); }
        export async function b(doc: any) { await doc.save(); }
        export async function c(d: unknown) {
          let x = new Customer(d);
          x = load();
          await x.save();
        }
      `,
    }).access).toEqual([]);
  });

  it("connection.model(Name, schema) on a mongoose connection or with a schema of this file is a model", () => {
    const r = index({
      "src/db/models.ts": `
        import mongoose from "mongoose";
        const conn = mongoose.createConnection(process.env.MONGO_URL);
        const invoiceSchema = new mongoose.Schema({ total: Number });
        export const Invoice = conn.model("Invoice", invoiceSchema);
        export const Customer = connection.model("Customer", new mongoose.Schema({}), "clients");
        export const Other = registry.model("Other", { strict: true });
        export const list = () => Invoice.find();
        export const one = () => Customer.findOne();
        export const other = () => Other.find();
      `,
    });
    expect(r.models).toEqual(["Customer -> clients", "Invoice -> invoices"]);
    expect(r.access).toEqual(["read invoices via mongoose @list", "read clients via mongoose @one"]);
  });

  it("CommonJS: module.exports = mongoose.model(...) and exports.X = mongoose.model(...), required elsewhere", () => {
    const r = index({
      "src/models/customer.ts": `
        const mongoose = require("mongoose");
        const CustomerSchema = new mongoose.Schema({ name: String });
        module.exports = mongoose.model("Customer", CustomerSchema);
      `,
      "src/models/invoice.ts": `
        const { model, Schema } = require("mongoose");
        exports.Invoice = model("Invoice", new Schema({ total: Number }), "billing_invoices");
      `,
      "src/services/billing.ts": `
        const Customer = require("../models/customer");
        const { Invoice } = require("../models/invoice");
        exports.list = () => Customer.find();
        module.exports.pay = async (id) => Invoice.updateOne({ _id: id }, { paid: true });
        exports.open = (d) => new Invoice(d).save();
      `,
    });
    expect(r.models).toEqual(["Customer -> customers", "Invoice -> billing_invoices"]);
    expect(r.access).toEqual([
      "read customers via mongoose @list",
      "update billing_invoices via mongoose @pay",
      "insert billing_invoices via mongoose @open",
    ]);
  });
});

describe("mongooseCollection (mongoose's pluralise rule)", () => {
  it("lowercases and pluralises like mongoose", () => {
    expect(["Customer", "Invoice", "InvoiceLine", "Person", "Category", "Address", "Box", "Alias", "News", "Child", "Shelf", "Quiz", "Mouse", "Datum", "Bus"]
      .map(mongooseCollection)).toEqual([
      "customers", "invoices", "invoicelines", "people", "categories", "addresses", "boxes", "aliases", "news", "children",
      "shelves", "quizzes", "mice", "data", "buses",
    ]);
  });
});
