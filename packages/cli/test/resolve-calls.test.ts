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
