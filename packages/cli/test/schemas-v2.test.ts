import { describe, expect, it } from "vitest";
import {
  EndpointsFileSchema, HttpCallSchema, MountSchema, QueueOpSchema, RepoRefSchema, RouteSchema,
  TracesConfigSchema, WorkspaceFileSchema,
} from "../src/store/schemas.js";

const customerEndpointsV2 = {
  version: 2,
  repo: "api",
  pages: [],
  httpCalls: [
    {
      method: "POST", path: "/api/customers", raw: "/api/customers", resolved: true, client: "api",
      at: { file: "lib/use-create-customer.ts", line: 4, symbol: "useCreateCustomer" },
      kind: "literal",
    },
    {
      method: "GET", path: "/api/customers/:id", raw: "`${base}/api/customers/${id}`", resolved: true,
      client: "api", at: { file: "lib/get-customer.ts", line: 6, symbol: "getCustomer" },
      kind: "template", base: "process.env.NEXT_PUBLIC_API_URL",
    },
  ],
  httpClients: [
    {
      name: "api", file: "lib/http.ts", line: 3, factory: "axios",
      baseExpr: "process.env.NEXT_PUBLIC_API_URL",
    },
  ],
  routes: [
    {
      method: "POST", path: "/customers", handler: "CustomersController.store", inline: false,
      framework: "express", at: { file: "src/server.ts", line: 10, symbol: "<module>" }, router: "router",
    },
  ],
  mounts: [
    {
      prefix: "/api", kind: "express-use", on: "app",
      target: { name: "router" }, at: { file: "src/server.ts", line: 8, symbol: "<module>" },
    },
  ],
  dbAccess: [
    { table: "customers", op: "insert", via: "lucid", at: { file: "app/services/customer_service.ts", line: 5, symbol: "CustomerService.create" } },
  ],
  tables: [{ name: "customers", file: "app/models/customer.ts", line: 1, source: "model" }],
  models: [{ model: "Customer", table: "customers", file: "app/models/customer.ts", source: "lucid" }],
  queues: [
    { queue: "invoice.created", op: "publish", at: { file: "src/invoices.ts", line: 12, symbol: "createInvoice" } },
    {
      queue: "emails", op: "bind", exchange: "billing", routingKey: "invoice.*",
      at: { file: "src/notify-consumer.ts", line: 3, symbol: "startNotifier" },
    },
  ],
};

describe("EndpointsFileSchema v2", () => {
  it("parses a full v2 endpoints file (customer + invoice vocabulary)", () => {
    expect(EndpointsFileSchema.parse(customerEndpointsV2).version).toBe(2);
  });

  it("rejects a v1 file (version literal no longer matches)", () => {
    const v1 = { ...customerEndpointsV2, version: 1 };
    expect(EndpointsFileSchema.safeParse(v1).success).toBe(false);
  });

  it("requires httpCalls[].kind and rejects a call missing it", () => {
    const bad = {
      method: "GET", path: "/api/customers", raw: "/api/customers", resolved: true, client: "api",
      at: { file: "lib/get-customer.ts", line: 1, symbol: "getCustomer" },
    };
    expect(HttpCallSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts an httpCall with kind 'unknown' and no base", () => {
    const call = {
      method: "GET", path: "", raw: "url", resolved: false, client: "api",
      at: { file: "lib/get-customer.ts", line: 1, symbol: "getCustomer" }, kind: "unknown",
    };
    expect(HttpCallSchema.parse(call).path).toBe("");
  });

  it("accepts a route with no router (unaffected frameworks) and one with router set", () => {
    const nextRoute = {
      method: "GET", path: "/api/customers", handler: "GET", inline: false, framework: "next-api",
      at: { file: "app/api/customers/route.ts", line: 1, symbol: "GET" },
    };
    expect(RouteSchema.parse(nextRoute).router).toBeUndefined();
    const expressRoute = { ...nextRoute, framework: "express" as const, router: "router" };
    expect(RouteSchema.parse(expressRoute).router).toBe("router");
  });

  it("accepts a nest-global mount with no target name/file", () => {
    const mount = {
      prefix: "/api", kind: "nest-global", on: "",
      target: {}, at: { file: "src/main.ts", line: 4, symbol: "<module>" },
    };
    expect(MountSchema.parse(mount).target).toEqual({});
  });

  it("accepts a bind queue op and a plain publish without exchange/routingKey", () => {
    const bind = {
      queue: "emails", op: "bind", exchange: "billing", routingKey: "invoice.*",
      at: { file: "src/notify-consumer.ts", line: 3, symbol: "startNotifier" },
    };
    expect(QueueOpSchema.parse(bind).op).toBe("bind");
    const publish = {
      queue: "invoice.created", op: "publish", at: { file: "src/invoices.ts", line: 12, symbol: "createInvoice" },
    };
    expect(QueueOpSchema.parse(publish).exchange).toBeUndefined();
  });
});

describe("workspace optional fields", () => {
  it("accepts a RepoRef with role and apiBase hints", () => {
    const ref = { id: "api", path: "api", role: "api", apiBase: ["NEXT_PUBLIC_API_URL", "api.example.com"] };
    expect(RepoRefSchema.parse(ref).apiBase).toEqual(["NEXT_PUBLIC_API_URL", "api.example.com"]);
  });

  it("accepts a RepoRef with neither role nor apiBase (both optional)", () => {
    expect(RepoRefSchema.parse({ id: "api", path: "api" }).role).toBeUndefined();
  });

  it("validates a tempo traces config and an otlp-file traces config", () => {
    const tempo = { kind: "tempo", url: "http://tempo.local:3200", services: { api: "customers-api" } };
    expect(TracesConfigSchema.parse(tempo).kind).toBe("tempo");
    const file = { kind: "otlp-file", path: ".codeloom/traces.json" };
    expect(TracesConfigSchema.parse(file).kind).toBe("otlp-file");
  });

  it("rejects a traces config with an unknown kind", () => {
    expect(TracesConfigSchema.safeParse({ kind: "jaeger", url: "x" }).success).toBe(false);
  });

  it("accepts an otlp-file traces config with a services map, like tempo's", () => {
    const file = { kind: "otlp-file", path: ".codeloom/traces.json", services: { "billing-svc": "billing" } };
    const parsed = TracesConfigSchema.parse(file);
    expect(parsed.kind).toBe("otlp-file");
    expect(parsed).toMatchObject({ services: { "billing-svc": "billing" } });
  });

  it("keeps workspace version 1 and traces optional", () => {
    const ws = { version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }], links: [] };
    expect(WorkspaceFileSchema.parse(ws).traces).toBeUndefined();
    const withTraces = { ...ws, traces: { kind: "otlp-file", path: ".codeloom/traces.json" } };
    expect(WorkspaceFileSchema.parse(withTraces).traces?.kind).toBe("otlp-file");
  });
});
