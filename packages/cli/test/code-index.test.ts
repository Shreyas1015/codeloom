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
      { name: "NewInvoicePage", kind: "function", lines: [2, 4], exported: true, binding: true, exportedAs: "default", exportNames: ["default"] },
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
      { name: "createInvoice", kind: "function", lines: [2, 4], exported: false, binding: true },
      { name: "Page", kind: "function", lines: [5, 5], exported: true, binding: true, exportNames: ["Page"] },
      { name: "f", kind: "function", lines: [6, 6], exported: false, binding: true },
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
    "cjs-inline.js": `
exports.list = function () { go(); };
module.exports.x = () => go();
foo({ cb: function named() { go(); } });`,
    "cjs-main.js": `module.exports = function main() { go(); };`,
    "cjs-anon.js": `module.exports = async () => { go(); };`,
    "default-fn.ts": `export default function () { go(); }`,
    "default-arrow.ts": `export default () => go();`,
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

describe("buildFileCodeIndex — follow-up fixes", () => {
  it("1: inline CommonJS function exports are function symbols named by the property", () => {
    const idx = buildFileCodeIndex(parsed("src/a.js", `
exports.helper = function helper() { go(); };
exports.list = function () { go(); };
module.exports.x = () => go();
exports.renamed = function inner() { go(); };
`));
    expect(sym(idx)).toEqual([
      { name: "helper", kind: "function", exported: true, exportedAs: undefined },
      { name: "list", kind: "function", exported: true, exportedAs: undefined },
      { name: "x", kind: "function", exported: true, exportedAs: undefined },
      { name: "renamed", kind: "function", exported: true, exportedAs: undefined },
    ]);
    expect(idx.calls.map((c) => c.caller)).toEqual(["helper", "list", "x", "renamed"]);
  });

  it("1b: module.exports = function main / class Repo are default exports", () => {
    const fn = buildFileCodeIndex(parsed("src/a.js", `module.exports = function main() { go(); };`));
    expect(sym(fn)).toEqual([{ name: "main", kind: "function", exported: true, exportedAs: "default" }]);
    expect(fn.calls[0]!.caller).toBe("main");
    const cls = buildFileCodeIndex(parsed("src/b.js", `module.exports = class Repo { find() { go(); } };`));
    expect(sym(cls)).toEqual([
      { name: "Repo", kind: "class", exported: true, exportedAs: "default" },
      { name: "Repo.find", kind: "method", exported: false, exportedAs: undefined },
    ]);
    const anon = buildFileCodeIndex(parsed("src/c.js", `module.exports = () => go();`));
    expect(sym(anon)).toEqual([{ name: "default", kind: "function", exported: true, exportedAs: "default" }]);
    expect(anon.calls[0]!.caller).toBe("default");
  });

  it("2: anonymous default functions are named default; named ones keep their name", () => {
    const decl = buildFileCodeIndex(parsed("src/a.ts", `export default function () { go(); }`));
    expect(sym(decl)).toEqual([{ name: "default", kind: "function", exported: true, exportedAs: "default" }]);
    expect(decl.calls[0]!.caller).toBe("default");
    const arrow = buildFileCodeIndex(parsed("src/b.ts", `export default () => { go(); };`));
    expect(sym(arrow)).toEqual([{ name: "default", kind: "function", exported: true, exportedAs: "default" }]);
    expect(arrow.calls[0]!.caller).toBe("default");
    const named = buildFileCodeIndex(parsed("src/c.ts", `export default function handler() { go(); }`));
    expect(sym(named)).toEqual([{ name: "handler", kind: "function", exported: true, exportedAs: "default" }]);
  });

  it("3: constructor this.x = new X() scan skips nested classes and non-arrow functions", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
class A {
  constructor() {
    this.svc = new Svc();
    const f = () => { this.arrow = new Arrow(); };
    const g = function () { this.notMine = new Wrong(); };
    const C = class { m() { this.inner = new Inner(); } };
  }
}
`));
    expect(idx.classFields).toEqual([
      { className: "A", field: "svc", typeName: "Svc" },
      { className: "A", field: "arrow", typeName: "Arrow" },
    ]);
  });

  it("4: a named function expression in an unnamed object is a function", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `foo({ cb: function named() { go(); } });`));
    expect(sym(idx)).toEqual([{ name: "named", kind: "function", exported: false, exportedAs: undefined }]);
  });

  it("6: exportNames lists every name a function/class is exported under", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
function a() {}
function onlyRenamed() {}
export { a, a as b };
export { onlyRenamed as r };
export default function foo() {}
export class K {}
function hidden() {}
`));
    expect(idx.symbols.map((s) => [s.name, s.exportNames])).toEqual([
      ["a", ["a", "b"]],
      ["onlyRenamed", ["r"]],
      ["foo", ["default"]],
      ["K", ["K"]],
      ["hidden", undefined],
    ]);
    const cjs = buildFileCodeIndex(parsed("src/y.js", `
function impl() {}
function c() {}
module.exports = { b: impl, c };
exports.list = function () {};
`));
    expect(cjs.symbols.map((s) => [s.name, s.exportNames])).toEqual([
      ["impl", ["b"]],
      ["c", ["c"]],
      ["list", ["list"]],
    ]);
  });

  it("5: module.exports = obj records the default object", () => {
    const idx = buildFileCodeIndex(parsed("src/x.js", `
const obj = { list() { return 1; } };
module.exports = obj;
`));
    expect(idx.defaultObject).toBe("obj");
    expect(sym(idx)).toEqual([{ name: "obj.list", kind: "object-method", exported: true, exportedAs: undefined }]);
    const none = buildFileCodeIndex(parsed("src/y.js", `function f() {} module.exports = f;`));
    expect(none.defaultObject).toBeUndefined();
  });
});

describe("buildFileCodeIndex — binding", () => {
  it("marks only names that bind in the file scope", () => {
    const idx = buildFileCodeIndex(parsed("src/x.js", `
function decl() {}
const arrow = () => {};
var fexpr = function inner() {};
class Repo { m() {} }
const svc = { a() {} };
exports.cjs = function () {};
module.exports = function main() {};
foo({ cb: function named() {} });
module.exports.Klass = class {};
`));
    expect(idx.symbols.map((s) => [s.name, s.binding])).toEqual([
      ["decl", true], ["arrow", true], ["fexpr", true], ["Repo", true], ["Repo.m", true],
      ["svc.a", true], ["cjs", false], ["main", false], ["named", false], ["<anonymous>", false],
    ]);
    const def = buildFileCodeIndex(parsed("src/y.ts", `export default () => {};`));
    expect(def.symbols.map((s) => [s.name, s.binding])).toEqual([["default", false]]);
    const defFn = buildFileCodeIndex(parsed("src/z.ts", `export default function () {}`));
    expect(defFn.symbols.map((s) => [s.name, s.binding])).toEqual([["default", false]]);
  });
});

describe("buildFileCodeIndex — identifier arguments", () => {
  it("records plain identifiers passed by reference, with their position, only when present", () => {
    const code = ['export async function start(channel) {', '  await channel.consume("emails", handleEmail);', "  channel.ack(1);", "}", "function handleEmail(msg) { return msg; }", ""].join("\n");
    const idx = buildFileCodeIndex(parsed("src/c.ts", code));
    expect(idx.calls).toEqual([
      { caller: "start", line: 2, callee: { kind: "member", object: "channel", prop: "consume" }, refArgs: [{ index: 1, name: "handleEmail" }] },
      { caller: "start", line: 3, callee: { kind: "member", object: "channel", prop: "ack" } },
    ]);
  });
});

describe("buildFileCodeIndex — identifier arguments that are not functions", () => {
  it("drops parameters and other plain values", () => {
    const code = ['import { handler } from "./h.js";', "export function f(id) {", "  run(id, handler);", "}", ""].join("\n");
    const idx = buildFileCodeIndex(parsed("src/f.ts", code));
    expect(idx.calls).toEqual([{ caller: "f", line: 3, callee: { kind: "ident", name: "run" }, refArgs: [{ index: 1, name: "handler" }] }]);
  });
});

describe("buildFileCodeIndex — HTTP wrappers (H2)", () => {
  it("finds the realworld `requests` object: superagent methods on `${API_ROOT}${url}`", () => {
    const idx = buildFileCodeIndex(parsed("src/agent.js", `
import superagentPromise from 'superagent-promise';
import _superagent from 'superagent';
const superagent = superagentPromise(_superagent, global.Promise);
const API_ROOT = 'https://conduit.productionready.io/api';
const responseBody = res => res.body;
const tokenPlugin = req => {};
const requests = {
  del: url =>
    superagent.del(\`\${API_ROOT}\${url}\`).use(tokenPlugin).then(responseBody),
  get: url =>
    superagent.get(\`\${API_ROOT}\${url}\`).use(tokenPlugin).then(responseBody),
  put: (url, body) =>
    superagent.put(\`\${API_ROOT}\${url}\`, body).use(tokenPlugin).then(responseBody),
  post: (url, body) =>
    superagent.post(\`\${API_ROOT}\${url}\`, body).use(tokenPlugin).then(responseBody)
};
const Auth = { current: () => requests.get('/user') };
`));
    expect(idx.wrappers).toEqual([
      { symbol: "requests.del", param: 0, method: "DELETE", client: "superagent", baseLiteral: "https://conduit.productionready.io/api" },
      { symbol: "requests.get", param: 0, method: "GET", client: "superagent", baseLiteral: "https://conduit.productionready.io/api" },
      { symbol: "requests.put", param: 0, method: "PUT", client: "superagent", baseLiteral: "https://conduit.productionready.io/api" },
      { symbol: "requests.post", param: 0, method: "POST", client: "superagent", baseLiteral: "https://conduit.productionready.io/api" },
    ]);
    const site = idx.calls.find((c) => c.caller === "Auth.current" && c.callee.kind === "member");
    expect(site?.urlArgs).toEqual([{ index: 0, path: "/user", kind: "literal", resolved: true, raw: "'/user'" }]);
  });

  it("finds a plain fetch wrapper with a non-literal base, and `BASE + path` / bare-param forms", () => {
    const idx = buildFileCodeIndex(parsed("src/api.ts", `
const API = process.env.NEXT_PUBLIC_API_URL;
export function apiGet(path: string) { return fetch(\`\${API}\${path}\`); }
export function apiPost(path: string, body: unknown) { return fetch(API + path, { method: "POST", body: JSON.stringify(body) }); }
export const raw = (u: string) => fetch(u);
`));
    expect(idx.wrappers).toEqual([
      { symbol: "apiGet", param: 0, method: "GET", client: "fetch", base: "API" },
      { symbol: "apiPost", param: 0, method: "POST", client: "fetch", base: "API" },
      { symbol: "raw", param: 0, method: "GET", client: "fetch" },
    ]);
  });

  it("takes the method from the wrapper's own name when the inner call's method is a variable", () => {
    const idx = buildFileCodeIndex(parsed("src/http.ts", `
const BASE = "/api";
export const http = {
  patch: (url: string, m: string) => fetch(\`\${BASE}\${url}\`, { method: m }),
  send: (url: string, m: string) => fetch(\`\${BASE}\${url}\`, { method: m }),
};
`));
    expect(idx.wrappers).toEqual([{ symbol: "http.patch", param: 0, method: "PATCH", client: "fetch", baseLiteral: "/api" }]);
  });

  it("does not treat a function that hard-codes its URL as a wrapper", () => {
    const idx = buildFileCodeIndex(parsed("src/users.ts", `
const API = "/api";
export function listUsers(page: number) { return fetch(\`\${API}/users?page=\${page}\`); }
export function getUser(id: string) { return fetch("/api/users/" + id); }
export function ping() { return fetch(\`\${API}\${"/ping"}\`); }
`));
    expect(idx.wrappers ?? []).toEqual([]);
  });

  it("does not record non-literal call arguments as url arguments", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
function load(path: string) { return apiGet(path); }
`));
    expect(idx.calls[0]?.urlArgs).toBeUndefined();
  });
});

describe("buildFileCodeIndex — H2 fix", () => {
  it("does not infer GET for a wrapper that forwards a non-literal or spread-only fetch init", () => {
    const idx = buildFileCodeIndex(parsed("src/api.ts", `
export function apiFetch(path: string, init: RequestInit) { return fetch(path, init); }
export function apiSend(path: string, opts: RequestInit) { return fetch(path, { ...opts }); }
export const http = { post: (url: string, init: RequestInit) => fetch(url, init) };
export function apiPost(path: string, opts: RequestInit) { return fetch(path, { ...opts, method: "POST" }); }
`));
    expect(idx.wrappers).toEqual([
      { symbol: "http.post", param: 0, method: "POST", client: "fetch" },
      { symbol: "apiPost", param: 0, method: "POST", client: "fetch" },
    ]);
  });

  it("does not treat a function whose URL is a shadowing inner parameter as a wrapper", () => {
    const idx = buildFileCodeIndex(parsed("src/x.ts", `
export function loadAll(path: string) { return ["/a"].map((path) => fetch(path)); }
export function loadOne(path: string) { return ["/a"].map(function (p) { return fetch(path); }); }
`));
    expect(idx.wrappers ?? []).toEqual([]);
  });

  it("records only path-like url arguments, never require/import specifiers", () => {
    const idx = buildFileCodeIndex(parsed("src/x.js", `
const a = require("./lib/a");
const b = () => import("./lib/b");
log("a/b");
apiGet("/ok");
apiGet(\`/t/\${id}\`);
apiGet(\`x\${id}\`);
`));
    expect(idx.calls.flatMap((c) => c.urlArgs ?? []).map((u) => u.raw)).toEqual(["\"/ok\"", "`/t/${id}`"]);
  });
});

describe("buildFileCodeIndex — JSX references (H3)", () => {
  const jsx = (code: string) => buildFileCodeIndex(parsed("src/app/create/page.tsx", code)).calls.filter((c) => c.kind === "jsx-ref");

  it("records an identifier handed to a JSX attribute as a jsx-ref from the enclosing component", () => {
    // Shape of prisma-rest-nextjs src/app/create/page.tsx.
    const refs = jsx(`
export default function Draft() {
  const submitData = async (e: unknown) => {
    await fetch("/api/post", { method: "POST" })
  }
  return (
    <form onSubmit={submitData}>
      <input onChange={(e) => setTitle(e.target.value)} value={title} />
    </form>
  )
}
`);
    expect(refs).toEqual([{ caller: "Draft", line: 7, kind: "jsx-ref", callee: { kind: "ident", name: "submitData" } }]);
  });

  it("records this.x and obj.x attribute values, and component tags", () => {
    const refs = jsx(`import PostDetails from "../components/PostDetails";
class Editor extends React.Component {
  save() {}
  render() {
    return <div>
      <button onClick={this.save}>s</button>
      <button onClick={actions.reset}>r</button>
      <PostDetails {...post} />
      <Layout.Footer />
      <span />
    </div>;
  }
}
`);
    expect(refs).toEqual([
      { caller: "Editor.render", line: 6, kind: "jsx-ref", callee: { kind: "this", prop: "save" } },
      { caller: "Editor.render", line: 7, kind: "jsx-ref", callee: { kind: "member", object: "actions", prop: "reset" } },
      { caller: "Editor.render", line: 8, kind: "jsx-ref", callee: { kind: "ident", name: "PostDetails" } },
      { caller: "Editor.render", line: 9, kind: "jsx-ref", callee: { kind: "member", object: "Layout", prop: "Footer" } },
    ]);
  });

  it("does not record plain {handler} children, string attributes, or non-JSX references", () => {
    const refs = jsx(`
export default function Page() {
  const handle = () => fetch("/api/x");
  const alias = handle;
  items.forEach(handle);
  return <div className="x" title={"t"}>{handle}</div>;
}
`);
    expect(refs).toEqual([]);
  });

  it("an inline arrow attribute that calls a handler stays an ordinary call from the component", () => {
    const calls = buildFileCodeIndex(parsed("src/components/PostDetails.tsx", `
export default function PostDetails({ id }: { id: number }) {
  async function destroy(id: number) { await fetch(\`/api/post/\${id}\`, { method: "DELETE" }) }
  return <button onClick={() => destroy(id)}>Delete</button>
}
`)).calls;
    expect(calls.find((c) => c.callee.kind === "ident" && c.callee.name === "destroy")).toMatchObject({ caller: "PostDetails", line: 4 });
    expect(calls.some((c) => c.kind === "jsx-ref")).toBe(false);
  });
});
