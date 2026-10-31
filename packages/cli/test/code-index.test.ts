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

const sym = (idx: ReturnType<typeof buildFileCodeIndex>) =>
  idx.symbols.map((s) => ({ name: s.name, kind: s.kind, exported: s.exported, exportedAs: s.exportedAs }));

describe("buildFileCodeIndex — review fixes", () => {
  it("1: arrow / function-expression consts become function symbols", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
const createInvoice = async (req, res) => {
  return res.json(req.body);
};
export const Page = () => null;
const f = function () { return 1; };
`));
    expect(idx.symbols).toEqual([
      { name: "createInvoice", kind: "function", lines: [2, 4], exported: false },
      { name: "Page", kind: "function", lines: [5, 5], exported: true },
      { name: "f", kind: "function", lines: [6, 6], exported: false },
    ]);
  });

  it("2: class property arrows become Class.prop methods", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
export class InvoiceController {
  create = async (req, res) => {
    return res.json({});
  };
}
`));
    expect(sym(idx)).toEqual([
      { name: "InvoiceController", kind: "class", exported: true, exportedAs: undefined },
      { name: "InvoiceController.create", kind: "method", exported: false, exportedAs: undefined },
    ]);
    expect(idx.symbols[1]!.lines).toEqual([3, 5]);
  });

  it("3: anonymous default-export class is <anonymous>, exported as default", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
export default class {
  run() { return 1; }
}
`));
    expect(sym(idx)).toEqual([
      { name: "<anonymous>", kind: "class", exported: true, exportedAs: "default" },
      { name: "<anonymous>.run", kind: "method", exported: false, exportedAs: undefined },
    ]);
  });

  it("4: local export lists and export default before the declaration", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
export default Late;
function a() {}
function hidden() {}
export { a, a as b };
const svc = { go() {} };
export { svc };
function Late() {}
`));
    expect(sym(idx)).toEqual([
      { name: "a", kind: "function", exported: true, exportedAs: "b" },
      { name: "hidden", kind: "function", exported: false, exportedAs: undefined },
      { name: "svc.go", kind: "object-method", exported: true, exportedAs: undefined },
      { name: "Late", kind: "function", exported: true, exportedAs: "default" },
    ]);
  });

  it("5a: module.exports = Ident / { a, b: c } / exports.x = y", () => {
    const one = buildFileCodeIndex(parsed("src/a.js", `
function handler() {}
module.exports = handler;
`));
    expect(sym(one)).toEqual([{ name: "handler", kind: "function", exported: true, exportedAs: "default" }]);

    const many = buildFileCodeIndex(parsed("src/b.js", `
function a() {}
const impl = () => 1;
function c() {}
function d() {}
function unused() {}
module.exports = { a, b: impl };
exports.c = c;
module.exports.e = d;
`));
    expect(sym(many)).toEqual([
      { name: "a", kind: "function", exported: true, exportedAs: undefined },
      { name: "impl", kind: "function", exported: true, exportedAs: "b" },
      { name: "c", kind: "function", exported: true, exportedAs: undefined },
      { name: "d", kind: "function", exported: true, exportedAs: "e" },
      { name: "unused", kind: "function", exported: false, exportedAs: undefined },
    ]);
  });

  it("5b: object literals in module.exports / export default name methods exports.* / default.*", () => {
    const cjs = buildFileCodeIndex(parsed("src/a.js", `
module.exports = {
  async list() { return 1; },
  find: async (id) => id,
};
`));
    expect(sym(cjs)).toEqual([
      { name: "exports.list", kind: "object-method", exported: true, exportedAs: undefined },
      { name: "exports.find", kind: "object-method", exported: true, exportedAs: undefined },
    ]);
    const esm = buildFileCodeIndex(parsed("src/b.ts", `
export default {
  list() { return 1; },
  find: function (id) { return id; },
};
`));
    expect(sym(esm)).toEqual([
      { name: "default.list", kind: "object-method", exported: true, exportedAs: undefined },
      { name: "default.find", kind: "object-method", exported: true, exportedAs: undefined },
    ]);
  });

  it("7: this.x = new Svc() in a constructor is a class field", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
export class InvoiceController {
  svc: InvoiceService;
  constructor() {
    this.svc = new InvoiceService();
    this.audit = new AuditLogger();
  }
}
`));
    expect(idx.classFields).toEqual([
      { className: "InvoiceController", field: "svc", typeName: "InvoiceService" },
      { className: "InvoiceController", field: "audit", typeName: "AuditLogger" },
    ]);
  });

  it("8: symbolAt prefers the deeper symbol on equal span", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
class A { m() { return 1; } }
`));
    expect(symbolAt(idx, 2)?.name).toBe("A.m");
  });
});

describe("contract: every call site's caller is a symbol in the same file", () => {
  const snippets: Record<string, string> = {
    "arrows.ts": `
const createInvoice = async (req, res) => { await save(req); };
export const Page = () => render();
const f = function () { go(); };
const g = function named() { go(); };
foo(function cb() { go(); });
function outer() { const inner = () => go(); inner(); }`,
    "classes.ts": `
export default class { run() { go(); } }
class B { create = async () => { go(); }; get x() { return go(); } m() { [1].map(() => go()); } }
const C = class { k() { go(); } };`,
    "objects.ts": `
export const svc = { a() { go(); }, b: () => go(), c: function () { go(); } };
export default { list() { go(); }, find: (id) => go(id) };`,
    "cjs.js": `
module.exports = { list() { go(); }, find: async (id) => go(id) };
exports.helper = function helper() { go(); };`,
  };
  for (const [file, code] of Object.entries(snippets)) {
    it(file, () => {
      const idx = buildFileCodeIndex(parsed(file, code));
      const names = new Set(idx.symbols.map((s) => s.name));
      const callers = idx.calls.map((c) => c.caller).filter((c) => c !== "<module>");
      expect(callers.length).toBeGreaterThan(0);
      for (const c of callers) expect(names, `caller ${c}`).toContain(c);
    });
  }
});
