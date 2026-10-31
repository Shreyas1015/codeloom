import { describe, expect, it } from "vitest";
import { buildFileCodeIndex, symbolAt } from "../src/linker/code-index.js";
import { parsed } from "./adapter-helpers.js";

describe("buildFileCodeIndex — symbols", () => {
  it("finds functions, classes, methods and object-literal methods, with export info", () => {
    const idx = buildFileCodeIndex(parsed("src/customer-service.ts", `
export function helper() {
  return 1;
}

export default class CustomerService {
  async create(payload: unknown) {
    return payload;
  }
  async find(id: number) {
    return id;
  }
}

export const invoiceService = {
  async create(data: unknown) {
    return data;
  },
  async markPaid(id: number) {
    return id;
  },
};
`));
    expect(idx.symbols.map((s) => ({ name: s.name, kind: s.kind, exported: s.exported, exportedAs: s.exportedAs })))
      .toEqual([
        { name: "helper", kind: "function", exported: true, exportedAs: undefined },
        { name: "CustomerService", kind: "class", exported: true, exportedAs: "default" },
        { name: "CustomerService.create", kind: "method", exported: false, exportedAs: undefined },
        { name: "CustomerService.find", kind: "method", exported: false, exportedAs: undefined },
        { name: "invoiceService.create", kind: "object-method", exported: true, exportedAs: undefined },
        { name: "invoiceService.markPaid", kind: "object-method", exported: true, exportedAs: undefined },
      ]);
  });

  it("marks a separately exported identifier as the default export", () => {
    const idx = buildFileCodeIndex(parsed("src/new-invoice-page.tsx", `
function NewInvoicePage() {
  return null;
}
export default NewInvoicePage;
`));
    expect(idx.symbols).toEqual([
      { name: "NewInvoicePage", kind: "function", lines: [2, 4], exported: true, exportedAs: "default" },
    ]);
  });
});

describe("symbolAt", () => {
  it("finds the innermost symbol containing a line", () => {
    const idx = buildFileCodeIndex(parsed("src/customer-service.ts", `
export default class CustomerService {
  async create(payload: unknown) {
    return payload;
  }
}
`));
    expect(symbolAt(idx, 3)?.name).toBe("CustomerService.create");
    expect(symbolAt(idx, 2)?.name).toBe("CustomerService");
    expect(symbolAt(idx, 100)).toBeUndefined();
  });
});

describe("buildFileCodeIndex — imports and re-exports", () => {
  it("records import bindings: default, named, renamed and namespace, plus CJS require", () => {
    const idx = buildFileCodeIndex(parsed("src/invoices.ts", `
import CustomerService from "./customer-service.js";
import { CustomerService as CS, findCustomer } from "./customer-service.js";
import * as events from "./events.js";
const legacyEvents = require("./legacy-events.js");
const { publish, bind: bindQueue } = require("./amqp.js");
`));
    expect(idx.imports).toEqual([
      { local: "CustomerService", kind: "default", from: "./customer-service.js" },
      { local: "CS", kind: "named", imported: "CustomerService", from: "./customer-service.js" },
      { local: "findCustomer", kind: "named", imported: "findCustomer", from: "./customer-service.js" },
      { local: "events", kind: "namespace", from: "./events.js" },
      { local: "legacyEvents", kind: "namespace", from: "./legacy-events.js" },
      { local: "publish", kind: "named", imported: "publish", from: "./amqp.js" },
      { local: "bindQueue", kind: "named", imported: "bind", from: "./amqp.js" },
    ]);
  });

  it("records re-exports (barrels)", () => {
    const idx = buildFileCodeIndex(parsed("src/index.ts", `
export * from "./customer-service.js";
export { CustomerService as CS, findCustomer } from "./customer-service.js";
`));
    expect(idx.reExports).toEqual([
      { kind: "all", from: "./customer-service.js" },
      { kind: "named", exported: "CS", imported: "CustomerService", from: "./customer-service.js" },
      { kind: "named", exported: "findCustomer", imported: "findCustomer", from: "./customer-service.js" },
    ]);
  });
});

describe("buildFileCodeIndex — class fields", () => {
  it("records constructor parameter properties and new-initialized fields", () => {
    const idx = buildFileCodeIndex(parsed("src/customers-controller.ts", `
export default class CustomersController {
  private audit = new AuditLogger();
  constructor(private customers: CustomerService) {}
  async store() {
    return this.customers.create({});
  }
}
`));
    expect(idx.classFields).toEqual([
      { className: "CustomersController", field: "audit", typeName: "AuditLogger" },
      { className: "CustomersController", field: "customers", typeName: "CustomerService" },
    ]);
  });
});

describe("buildFileCodeIndex — call sites", () => {
  it("classifies this, this-field, new-member, member, other and ident calls; tracks local `new` bindings", () => {
    const code = `
import { CustomerService } from "./customer-service.js";
import { invoiceService } from "./invoice-service.js";

export default class CustomersController {
  constructor(private customers: CustomerService) {}

  async store(body: unknown) {
    const created = await this.customers.create(body);
    this.notify();
    return created;
  }

  async show(id: number) {
    return new CustomerService().find(id);
  }

  notify() {
    invoiceService.markPaid(1);
  }
}

export function createViaLocal() {
  const svc = new CustomerService();
  return svc.create({});
}

export function dispatch(handlers: Record<string, () => void>) {
  handlers["create"]();
}

export function bootstrap() {
  createViaLocal();
}
`;
    const idx = buildFileCodeIndex(parsed("src/customers-controller.ts", code));
    expect(idx.calls).toEqual([
      { caller: "CustomersController.store", line: 9, callee: { kind: "this-field", field: "customers", prop: "create" } },
      { caller: "CustomersController.store", line: 10, callee: { kind: "this", prop: "notify" } },
      { caller: "CustomersController.show", line: 15, callee: { kind: "new-member", className: "CustomerService", prop: "find" } },
      { caller: "CustomersController.notify", line: 19, callee: { kind: "member", object: "invoiceService", prop: "markPaid" } },
      { caller: "createViaLocal", line: 25, callee: { kind: "member", object: "svc", prop: "create" } },
      { caller: "dispatch", line: 29, callee: { kind: "other", prop: "create" } },
      { caller: "bootstrap", line: 33, callee: { kind: "ident", name: "createViaLocal" } },
    ]);
    expect(idx.localNews).toEqual([{ caller: "createViaLocal", local: "svc", className: "CustomerService" }]);
  });
});

describe("buildFileCodeIndex — non-JS/TS files", () => {
  it("returns all-empty arrays", () => {
    const idx = buildFileCodeIndex(parsed("prisma/schema.prisma", `model Invoice { id Int @id }`));
    expect(idx).toEqual({ symbols: [], imports: [], reExports: [], classFields: [], localNews: [], calls: [] });
  });
});
