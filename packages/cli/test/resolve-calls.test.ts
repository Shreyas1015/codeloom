import { describe, expect, it } from "vitest";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { createCallResolver, MAX_DEPTH, walkCalls, walkCallers } from "../src/linker/resolve-calls.js";
import type { CallResolver, SymbolRef } from "../src/linker/resolve-calls.js";
import { parsed } from "./adapter-helpers.js";

function repoOf(files: Record<string, string>): { index: RepoCodeIndex; files: Set<string> } {
  const index: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) index.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return { index, files: new Set(Object.keys(files)) };
}

function resolverOf(files: Record<string, string>): CallResolver {
  const { index, files: fileSet } = repoOf(files);
  return createCallResolver({ repo: "api", index, files: fileSet, aliases: [] });
}

function ref(file: string, symbol: string): SymbolRef {
  return { repo: "api", file, symbol };
}

function siteAt(resolver: CallResolver, file: string, symbol: string) {
  // helper for tests that only check the first/only call site of a symbol
  const calls = resolver.callsFrom({ repo: "api", file, symbol });
  return calls[0] ?? null;
}

const CUSTOMER_SERVICE = `
  export class CustomerService {
    create(data: unknown) { return data; }
    find(id: number) { return { id }; }
  }
`;
const AUDIT_SERVICE = `
  export class AuditService {
    log(action: string) { return action; }
  }
`;

describe("createCallResolver", () => {
  it("resolves a plain call to a local top-level function", () => {
    const resolver = resolverOf({
      "a.ts": `
        function helper() { return 1; }
        export function run() { return helper(); }
      `,
    });
    const rc = siteAt(resolver, "a.ts", "run");
    expect(rc).toMatchObject({ target: { file: "a.ts", symbol: "helper" }, confidence: "exact", via: "local" });
  });

  it("resolves a direct named import", () => {
    const resolver = resolverOf({
      "lib/greet.ts": `export function greet(name: string) { return "hi " + name; }`,
      "controllers/run.ts": `
        import { greet } from "../lib/greet.js";
        export function run() { return greet("Ada"); }
      `,
    });
    const rc = siteAt(resolver, "controllers/run.ts", "run");
    expect(rc).toMatchObject({ target: { file: "lib/greet.ts", symbol: "greet" }, confidence: "exact", via: "import" });
  });
});

describe("barrels (export * / export {x} from, <=3 hops)", () => {
  const files = {
    "services/customer-service.ts": CUSTOMER_SERVICE,
    "services/grouped.ts": `export * from "./customer-service.js";`,
    "services/index.ts": `export * from "./grouped.js";`,
    "controllers/customers-controller.ts": `
      import { CustomerService } from "../services/index.js";
      export class CustomersController {
        store() { return new CustomerService().create({}); }
      }
    `,
  };

  it("chases export * through two re-export hops to the declaring class method", () => {
    const resolver = resolverOf(files);
    const rc = siteAt(resolver, "controllers/customers-controller.ts", "CustomersController.store");
    expect(rc).toMatchObject({
      target: { file: "services/customer-service.ts", symbol: "CustomerService.create" },
      confidence: "exact",
      via: "new",
    });
  });

  it("resolveExport follows the same chain directly", () => {
    const resolver = resolverOf(files);
    expect(resolver.resolveExport("services/index.ts", "CustomerService.create")).toEqual({
      repo: "api",
      file: "services/customer-service.ts",
      symbol: "CustomerService.create",
    });
  });

  it("resolves a renamed named re-export (export { x as y } from)", () => {
    const resolver = resolverOf({
      "services/audit-service.ts": AUDIT_SERVICE,
      "services/audit.ts": `export { AuditService as Audit } from "./audit-service.js";`,
      "controllers/notify.ts": `
        import { Audit } from "../services/audit.js";
        export class NotifyController {
          run() { return new Audit().log("hi"); }
        }
      `,
    });
    const rc = siteAt(resolver, "controllers/notify.ts", "NotifyController.run");
    expect(rc).toMatchObject({
      target: { file: "services/audit-service.ts", symbol: "AuditService.log" },
      confidence: "exact",
      via: "new",
    });
  });
});

describe("renamed / namespace / require imports", () => {
  it("resolves new X().m() through a renamed named import", () => {
    const resolver = resolverOf({
      "services/audit-service.ts": AUDIT_SERVICE,
      "controllers/notify.ts": `
        import { AuditService as Audit } from "../services/audit-service.js";
        export class NotifyController {
          run() { return new Audit().log("hi"); }
        }
      `,
    });
    const rc = siteAt(resolver, "controllers/notify.ts", "NotifyController.run");
    expect(rc).toMatchObject({
      target: { file: "services/audit-service.ts", symbol: "AuditService.log" },
      confidence: "exact",
      via: "new",
    });
  });

  it("resolves a namespace import's member call (ns.f())", () => {
    const resolver = resolverOf({
      "lib/format.ts": `export function formatName(name: string) { return name.trim(); }`,
      "controllers/fmt.ts": `
        import * as Format from "../lib/format.js";
        export class FmtController {
          run(name: string) { return Format.formatName(name); }
        }
      `,
    });
    const rc = siteAt(resolver, "controllers/fmt.ts", "FmtController.run");
    expect(rc).toMatchObject({ target: { file: "lib/format.ts", symbol: "formatName" }, confidence: "exact", via: "import" });
  });

  it("resolves new X().m() through a destructured require() rename", () => {
    const resolver = resolverOf({
      "services/customer-service.ts": CUSTOMER_SERVICE,
      "controllers/legacy.ts": `
        const { CustomerService: CS } = require("../services/customer-service.js");
        export class LegacyController {
          run(id: number) { return new CS().find(id); }
        }
      `,
    });
    const rc = siteAt(resolver, "controllers/legacy.ts", "LegacyController.run");
    expect(rc).toMatchObject({
      target: { file: "services/customer-service.ts", symbol: "CustomerService.find" },
      confidence: "exact",
      via: "new",
    });
  });
});

describe("this.svc DI (property initializer and constructor parameter property)", () => {
  it("resolves this.svc.m() where svc is a class-field initializer (new AuditService())", () => {
    const resolver = resolverOf({
      "services/audit-service.ts": AUDIT_SERVICE,
      "services/notification-service.ts": `
        import { AuditService } from "./audit-service.js";
        export class NotificationService {
          private audit = new AuditService();
          notify() { return this.audit.log("notified"); }
        }
      `,
    });
    const rc = siteAt(resolver, "services/notification-service.ts", "NotificationService.notify");
    expect(rc).toMatchObject({
      target: { file: "services/audit-service.ts", symbol: "AuditService.log" },
      confidence: "exact",
      via: "di",
    });
  });

  it("resolves this.svc.m() where svc is a constructor parameter property (Nest/Adonis DI)", () => {
    const resolver = resolverOf({
      "services/customer-service.ts": CUSTOMER_SERVICE,
      "controllers/orders.ts": `
        import { CustomerService } from "../services/customer-service.js";
        export class OrdersController {
          constructor(private customers: CustomerService) {}
          audit() { return true; }
          store() {
            this.audit();
            return this.customers.create({ name: "Ada" });
          }
        }
      `,
    });
    const storeCalls = resolver.callsFrom({ repo: "api", file: "controllers/orders.ts", symbol: "OrdersController.store" });
    expect(storeCalls).toEqual([
      expect.objectContaining({
        target: { repo: "api", file: "controllers/orders.ts", symbol: "OrdersController.audit" },
        confidence: "exact",
        via: "this",
      }),
      expect.objectContaining({
        target: { repo: "api", file: "services/customer-service.ts", symbol: "CustomerService.create" },
        confidence: "exact",
        via: "di",
      }),
    ]);
  });
});

describe("unique-method guess fallback and object-literal services", () => {
  it("guesses a method call on an unresolvable receiver when the method name is unique repo-wide", () => {
    const resolver = resolverOf({
      "services/weird-service.ts": `export class WeirdService { uniqueOp() { return 1; } }`,
      "controllers/unknown.ts": `
        export class UnknownController {
          run(svc: any) { return svc.uniqueOp(); }
        }
      `,
    });
    const rc = siteAt(resolver, "controllers/unknown.ts", "UnknownController.run");
    expect(rc).toMatchObject({
      target: { file: "services/weird-service.ts", symbol: "WeirdService.uniqueOp" },
      confidence: "guess",
      via: "unique-method",
    });
  });

  it("does not guess for a chained receiver (a.b.c()), only for a simple identifier receiver", () => {
    const resolver = resolverOf({
      "services/invoice-service.ts": `export const invoiceService = { create(data: unknown) { return data; } };`,
      "workers/notify.ts": `
        export async function handleEmail(prisma: any) { return prisma.emailLog.create({}); }
        export async function viaCall(make: any) { return make().create({}); }
        export async function viaElement(o: any) { return o["x"].create({}); }
        export async function simple(svc: any) { return svc.create({}); }
      `,
    });
    expect(siteAt(resolver, "workers/notify.ts", "handleEmail")).toBeNull();
    expect(resolver.callsFrom({ repo: "api", file: "workers/notify.ts", symbol: "viaCall" }).map((c) => c.target.symbol)).toEqual([]);
    expect(resolver.callsFrom({ repo: "api", file: "workers/notify.ts", symbol: "viaElement" }).map((c) => c.target.symbol)).toEqual([]);
    expect(siteAt(resolver, "workers/notify.ts", "simple")).toMatchObject({
      target: { file: "services/invoice-service.ts", symbol: "invoiceService.create" }, confidence: "guess", via: "unique-method",
    });
  });

  it("does not guess when the method name is ambiguous repo-wide", () => {
    const resolver = resolverOf({
      "services/a.ts": `export class A { run() { return 1; } }`,
      "services/b.ts": `export class B { run() { return 2; } }`,
      "controllers/c.ts": `
        export class C { call(svc: any) { return svc.run(); } }
      `,
    });
    const rc = siteAt(resolver, "controllers/c.ts", "C.call");
    expect(rc).toBeNull();
  });

  it("resolves svc.m() where svc is an imported object-literal service", () => {
    const resolver = resolverOf({
      "services/invoice-service.ts": `
        export const invoiceService = {
          create(data: unknown) { return data; },
          markPaid(id: number) { return id; },
        };
      `,
      "controllers/invoices.ts": `
        import { invoiceService } from "../services/invoice-service.js";
        export class InvoicesController {
          store() { return invoiceService.create({}); }
        }
      `,
    });
    const rc = siteAt(resolver, "controllers/invoices.ts", "InvoicesController.store");
    expect(rc).toMatchObject({
      target: { file: "services/invoice-service.ts", symbol: "invoiceService.create" },
      confidence: "exact",
      via: "object",
    });
  });
});

describe("walkCalls: depth-6 limit and cycle guard", () => {
  it("stops expanding at MAX_DEPTH (6 hops from the start)", () => {
    const resolver = resolverOf({
      "chain/steps.ts": `
        export function step0() { return step1(); }
        export function step1() { return step2(); }
        export function step2() { return step3(); }
        export function step3() { return step4(); }
        export function step4() { return step5(); }
        export function step5() { return step6(); }
        export function step6() { return step7(); }
        export function step7() { return 0; }
      `,
    });
    const steps = walkCalls(resolver, ref("chain/steps.ts", "step0"));
    expect(MAX_DEPTH).toBe(6);
    expect(steps).toHaveLength(7); // step0..step6 (depth 0..6); step7 is never reached
    expect(steps.map((s) => s.ref.symbol)).not.toContain("step7");
    expect(steps[steps.length - 1]).toMatchObject({ ref: { symbol: "step6" }, depth: 6 });
  });

  it("does not loop forever on a call cycle", () => {
    const resolver = resolverOf({
      "chain/cycle.ts": `
        export function ping() { return pong(); }
        export function pong() { return ping(); }
      `,
    });
    const steps = walkCalls(resolver, ref("chain/cycle.ts", "ping"));
    expect(steps.map((s) => s.ref.symbol)).toEqual(["ping", "pong"]);
  });
});

describe("callersOf / walkCallers", () => {
  it("finds the resolved caller of a method (reverse edge)", () => {
    const resolver = resolverOf({
      "services/customer-service.ts": CUSTOMER_SERVICE,
      "controllers/customers.ts": `
        import { CustomerService } from "../services/customer-service.js";
        export class CustomersController {
          store() { return new CustomerService().create({}); }
        }
      `,
    });
    const target = ref("services/customer-service.ts", "CustomerService.create");
    const callers = resolver.callersOf(target);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.from).toEqual(ref("controllers/customers.ts", "CustomersController.store"));

    const steps = walkCallers(resolver, target);
    expect(steps.map((s) => s.ref.symbol)).toEqual(["CustomerService.create", "CustomersController.store"]);
  });
});

describe("fileIndex", () => {
  it("returns the cached per-file index, or undefined for an unknown file", () => {
    const resolver = resolverOf({ "services/customer-service.ts": CUSTOMER_SERVICE });
    expect(resolver.fileIndex("services/customer-service.ts")?.symbols.map((s) => s.name)).toContain("CustomerService.create");
    expect(resolver.fileIndex("nope.ts")).toBeUndefined();
  });
});

describe("createCallResolver — module-level singletons", () => {
  it("resolves svc.method() inside a function to a module-level `const svc = new Svc()`", () => {
    const resolver = resolverOf({
      "services/customer-service.ts": CUSTOMER_SERVICE,
      "controllers/customers.ts": `
        import { CustomerService } from "../services/customer-service.js";
        const svc = new CustomerService();
        export function show(id: number) { return svc.find(id); }
      `,
    });
    const rc = siteAt(resolver, "controllers/customers.ts", "show");
    expect(rc).toMatchObject({
      target: { file: "services/customer-service.ts", symbol: "CustomerService.find" }, confidence: "exact", via: "new",
    });
  });
});

describe("review fixes", () => {
  it("1: export * never forwards default", () => {
    const resolver = resolverOf({
      "lib/star.ts": `export default function starDefault() { return 1; }`,
      "lib/barrel.ts": `export * from "./star.js";`,
      "controllers/d.ts": `
        import D from "../lib/barrel.js";
        export function run() { return D(); }
      `,
    });
    expect(siteAt(resolver, "controllers/d.ts", "run")).toBeNull();
    expect(resolver.resolveExport("lib/barrel.ts", "default")).toBeNull();
  });

  it("1b: export * never forwards a default class (new D().m() through the barrel)", () => {
    const resolver = resolverOf({
      "lib/star.ts": `export default class Star { m() { return 1; } }`,
      "lib/other.ts": `export class Other { m() { return 2; } }`,
      "lib/barrel.ts": `export * from "./star.js";`,
      "controllers/d.ts": `
        import D from "../lib/barrel.js";
        export function run() { return new D().m(); }
      `,
    });
    expect(siteAt(resolver, "controllers/d.ts", "run")).toBeNull();
  });

  it("2: renamed default re-export of a class resolves to the default class's method", () => {
    const resolver = resolverOf({
      "ui/button.ts": `export default class Button { click() { return 1; } }`,
      "ui/index.ts": `export { default as Button } from "./button.js";`,
      "pages/home.ts": `
        import { Button } from "../ui/index.js";
        export function run() { return new Button().click(); }
      `,
    });
    expect(siteAt(resolver, "pages/home.ts", "run")).toMatchObject({
      target: { file: "ui/button.ts", symbol: "Button.click" }, confidence: "exact", via: "new",
    });
  });

  it("2b: renamed default re-export of an anonymous default class", () => {
    const resolver = resolverOf({
      "ui/button.ts": `export default class { click() { return 1; } }`,
      "ui/index.ts": `export { default as Button } from "./button.js";`,
      "pages/home.ts": `
        import { Button } from "../ui/index.js";
        export function run() { return new Button().click(); }
      `,
    });
    expect(siteAt(resolver, "pages/home.ts", "run")).toMatchObject({
      target: { file: "ui/button.ts", symbol: "<anonymous>.click" }, confidence: "exact", via: "new",
    });
  });

  it("3: export { a as b } resolves import { b } to a", () => {
    const resolver = resolverOf({
      "lib/x.ts": `function a() { return 1; } export { a as b };`,
      "c.ts": `import { b } from "./lib/x.js"; export function run() { return b(); }`,
    });
    expect(siteAt(resolver, "c.ts", "run")).toMatchObject({
      target: { file: "lib/x.ts", symbol: "a" }, confidence: "exact", via: "import",
    });
  });

  it("3b: module.exports = { b: impl } resolves import { b } to impl", () => {
    const resolver = resolverOf({
      "lib/x.js": `function impl() { return 1; } module.exports = { b: impl };`,
      "c.ts": `import { b } from "./lib/x.js"; export function run() { return b(); }`,
    });
    expect(siteAt(resolver, "c.ts", "run")).toMatchObject({
      target: { file: "lib/x.js", symbol: "impl" }, confidence: "exact", via: "import",
    });
  });

  it("3c: export { Svc as Service } resolves new Service().m() to Svc.m", () => {
    const resolver = resolverOf({
      "lib/svc.ts": `class Svc { m() { return 1; } } export { Svc as Service };`,
      "c.ts": `import { Service } from "./lib/svc.js"; export function run() { return new Service().m(); }`,
    });
    expect(siteAt(resolver, "c.ts", "run")).toMatchObject({
      target: { file: "lib/svc.ts", symbol: "Svc.m" }, confidence: "exact", via: "new",
    });
  });

  it("3d: export { a, a as b } still resolves import { a } (and { b }) to a", () => {
    const resolver = resolverOf({
      "lib/x.ts": `function a() { return 1; } export { a, a as b };`,
      "c.ts": `import { a } from "./lib/x.js"; export function run() { return a(); }`,
      "d.ts": `import { b } from "./lib/x.js"; export function run() { return b(); }`,
    });
    expect(siteAt(resolver, "c.ts", "run")).toMatchObject({ target: { file: "lib/x.ts", symbol: "a" }, confidence: "exact" });
    expect(siteAt(resolver, "d.ts", "run")).toMatchObject({ target: { file: "lib/x.ts", symbol: "a" }, confidence: "exact" });
  });

  describe("6: a symbol is reachable only under the names it is exported as", () => {
    const exactTarget = (resolver: CallResolver, file: string, symbol: string) =>
      resolver.callsFrom(ref(file, symbol)).find((c) => c.confidence === "exact") ?? null;

    it("export { a as b } + import { a } does not resolve", () => {
      const resolver = resolverOf({
        "lib/x.ts": `function a() { return 1; } export { a as b };`,
        "c.ts": `import { a } from "./lib/x.js"; export function run() { return a(); }`,
      });
      expect(exactTarget(resolver, "c.ts", "run")).toBeNull();
    });

    it("export default function foo + import { foo } does not resolve", () => {
      const resolver = resolverOf({
        "lib/x.ts": `export default function foo() { return 1; }`,
        "c.ts": `import { foo } from "./lib/x.js"; export function run() { return foo(); }`,
      });
      expect(exactTarget(resolver, "c.ts", "run")).toBeNull();
    });

    it("module.exports = { b: impl } + import { impl } does not resolve", () => {
      const resolver = resolverOf({
        "lib/x.js": `function impl() { return 1; } module.exports = { b: impl };`,
        "c.ts": `import { impl } from "./lib/x.js"; export function run() { return impl(); }`,
      });
      expect(exactTarget(resolver, "c.ts", "run")).toBeNull();
    });

    it("export { Svc as Service } + import { Svc } does not resolve new Svc().m() exactly", () => {
      const resolver = resolverOf({
        "lib/svc.ts": `class Svc { m() { return 1; } } export { Svc as Service };`,
        "c.ts": `import { Svc } from "./lib/svc.js"; export function run() { return new Svc().m(); }`,
      });
      expect(exactTarget(resolver, "c.ts", "run")).toBeNull();
    });

    it("import * as ns + ns.foo() where foo is only the default export does not resolve", () => {
      const resolver = resolverOf({
        "lib/x.ts": `export default function foo() { return 1; }`,
        "c.ts": `import * as ns from "./lib/x.js"; export function run() { return ns.foo(); }`,
      });
      expect(exactTarget(resolver, "c.ts", "run")).toBeNull();
    });
  });

  it("4: const svc = require('./x'); svc.list() resolves to exports.list", () => {
    const resolver = resolverOf({
      "services/x.js": `module.exports = { list() { return []; } };`,
      "controllers/c.js": `
        const svc = require("../services/x.js");
        function run() { return svc.list(); }
      `,
      "services/y.js": `class Other { list() { return 1; } }`,
    });
    expect(siteAt(resolver, "controllers/c.js", "run")).toMatchObject({
      target: { file: "services/x.js", symbol: "exports.list" }, confidence: "exact",
    });
  });

  it("4b: const CS = require('./x'); new CS().m() resolves to the class exported via module.exports = CS", () => {
    const resolver = resolverOf({
      "services/cs.js": `class CS { m() { return 1; } } module.exports = CS;`,
      "services/other.js": `class Other { m() { return 2; } }`,
      "controllers/c.js": `
        const CS = require("../services/cs.js");
        function run() { return new CS().m(); }
      `,
    });
    expect(siteAt(resolver, "controllers/c.js", "run")).toMatchObject({
      target: { file: "services/cs.js", symbol: "CS.m" }, confidence: "exact", via: "new",
    });
  });

  it("4d: module.exports = obj (declared separately) resolves require().list() and default import x.list() to obj.list", () => {
    const resolver = resolverOf({
      "services/x.js": `const obj = { list() { return []; } };\nmodule.exports = obj;`,
      "services/y.js": `const other = { list() { return 1; } };`,
      "controllers/c.js": `
        const svc = require("../services/x.js");
        function run() { return svc.list(); }
      `,
      "controllers/d.ts": `import x from "../services/x.js"; export function go() { return x.list(); }`,
    });
    expect(siteAt(resolver, "controllers/c.js", "run")).toMatchObject({
      target: { file: "services/x.js", symbol: "obj.list" }, confidence: "exact",
    });
    expect(siteAt(resolver, "controllers/d.ts", "go")).toMatchObject({
      target: { file: "services/x.js", symbol: "obj.list" }, confidence: "exact",
    });
  });

  it("4e: inline CommonJS exports and module.exports = class resolve exactly", () => {
    const resolver = resolverOf({
      "services/x.js": `exports.list = function () { return []; };`,
      "services/r.js": `module.exports = class Repo { find() { return 1; } };`,
      "services/o.js": `class Other { find() { return 2; } list() { return 3; } }`,
      "controllers/c.js": `
        const svc = require("../services/x.js");
        const Repo = require("../services/r.js");
        function run() { return svc.list(); }
        function get() { return new Repo().find(); }
      `,
    });
    expect(siteAt(resolver, "controllers/c.js", "run")).toMatchObject({
      target: { file: "services/x.js", symbol: "list" }, confidence: "exact",
    });
    expect(siteAt(resolver, "controllers/c.js", "get")).toMatchObject({
      target: { file: "services/r.js", symbol: "Repo.find" }, confidence: "exact",
    });
  });

  it("4c: default import of an `export default {}` object resolves svc.m() to default.m", () => {
    const resolver = resolverOf({
      "services/x.ts": `export default { list() { return []; } };`,
      "services/y.ts": `export class Y { list() { return 1; } }`,
      "controllers/c.ts": `import svc from "../services/x.js"; export function run() { return svc.list(); }`,
    });
    expect(siteAt(resolver, "controllers/c.ts", "run")).toMatchObject({
      target: { file: "services/x.ts", symbol: "default.list" }, confidence: "exact",
    });
  });

  it("5: callersOf / walkCallers are independent of index insertion order", () => {
    const filesA: Record<string, string> = {
      "lib/t.ts": `export function target() { return 1; }`,
      "b/caller.ts": `import { target } from "../lib/t.js"; export function zeta() { return target(); } export function alpha() { return target(); }`,
      "a/caller.ts": `import { target } from "../lib/t.js"; export function beta() { target(); return target(); }`,
    };
    const filesB: Record<string, string> = Object.fromEntries(Object.entries(filesA).reverse());
    const r1 = resolverOf(filesA);
    const r2 = resolverOf(filesB);
    const t = ref("lib/t.ts", "target");
    const c1 = r1.callersOf(t);
    expect(c1.map((c) => `${c.from.file}#${c.from.symbol}:${c.call.site.line}`)).toEqual([
      "a/caller.ts#beta:1", "a/caller.ts#beta:1", "b/caller.ts#alpha:1", "b/caller.ts#zeta:1",
    ]);
    expect(r2.callersOf(t)).toEqual(c1);
    expect(walkCallers(r2, t)).toEqual(walkCallers(r1, t));
  });

  it("6: no unique-method guess for bare identifier calls", () => {
    const resolver = resolverOf({
      "services/s.ts": `export class S { next() { return 1; } }`,
      "c.ts": `export function run() { return next(); }`,
    });
    expect(siteAt(resolver, "c.ts", "run")).toBeNull();
  });

  it("8: this.m() inside an object-literal method resolves to the sibling object-method", () => {
    const resolver = resolverOf({
      "services/inv.ts": `
        export const invoiceService = {
          create(d: unknown) { return this.validate(d); },
          validate(d: unknown) { return d; },
        };
      `,
      "services/other.ts": `export class Other { validate() { return 1; } }`,
    });
    expect(siteAt(resolver, "services/inv.ts", "invoiceService.create")).toMatchObject({
      target: { file: "services/inv.ts", symbol: "invoiceService.validate" }, confidence: "exact", via: "this",
    });
  });

  it("9: static call on an imported class is via import (barrel when re-exported)", () => {
    const resolver = resolverOf({
      "lib/util.ts": `export class Util { static make() { return 1; } }`,
      "lib/index.ts": `export * from "./util.js";`,
      "c.ts": `import { Util } from "./lib/util.js"; export function run() { return Util.make(); }`,
      "d.ts": `import { Util } from "./lib/index.js"; export function run() { return Util.make(); }`,
    });
    expect(siteAt(resolver, "c.ts", "run")).toMatchObject({
      target: { file: "lib/util.ts", symbol: "Util.make" }, confidence: "exact", via: "import",
    });
    expect(siteAt(resolver, "d.ts", "run")).toMatchObject({
      target: { file: "lib/util.ts", symbol: "Util.make" }, confidence: "exact", via: "barrel",
    });
  });
});

describe("createCallResolver — only real bindings resolve bare identifiers", () => {
  it("A: exports.fetch = function wrapping the global fetch does not link to itself", () => {
    const resolver = resolverOf({ "a.js": `exports.fetch = function (u) { return fetch(u); };` });
    expect(resolver.callsFrom(ref("a.js", "fetch"))).toEqual([]);
  });

  it("B: exports.find wrapping an imported find resolves to the import", () => {
    const resolver = resolverOf({
      "db.ts": `export function find(id) { return id; }`,
      "b.ts": `
        import { find } from "./db.js";
        exports.find = function (id) { return find(id); };
      `,
    });
    expect(siteAt(resolver, "b.ts", "find")).toMatchObject({
      target: { file: "db.ts", symbol: "find" }, confidence: "exact", via: "import",
    });
  });

  it("C: the own name of module.exports = function main is not in module scope", () => {
    const resolver = resolverOf({ "c.js": `module.exports = function main() {};\nfunction run() { main(); }` });
    expect(resolver.callsFrom(ref("c.js", "run"))).toEqual([]);
  });

  it("D: the own name of a function expression passed as a value is not in module scope", () => {
    const resolver = resolverOf({ "d.js": `foo({ cb: function named() {} });\nfunction run() { named(); }` });
    expect(resolver.callsFrom(ref("d.js", "run"))).toEqual([]);
  });

  it("a declared function and a same-named CJS export: the bare call resolves to the declaration", () => {
    const resolver = resolverOf({ "f.js": `function list() { return 1; }\nexports.list = function () { return list(); };` });
    const idx = resolver.fileIndex("f.js")!;
    expect(idx.symbols.filter((s) => s.name === "list").map((s) => s.binding)).toEqual([true, false]);
    const calls = resolver.callsFrom(ref("f.js", "list"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: { file: "f.js", symbol: "list" }, confidence: "exact", via: "local" });
    expect(calls[0]!.target).toEqual(ref("f.js", "list"));
    // the target is the declaration (line 1), not the CJS export (line 2)
    expect(idx.symbols.find((s) => s.name === "list" && s.binding)!.lines).toEqual([1, 1]);
  });
});
