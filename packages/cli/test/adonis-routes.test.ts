import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectRoutes } from "../src/adapters/routes.js";
import type { AdapterContext } from "../src/adapters/types.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

// Adonis v5 string handlers ("CustomersController.index") name a controller by the IoC convention: the
// namespace (`.adonisrc.json` namespaces.httpControllers, default App/Controllers/Http, or a group's/route's
// `.namespace()`) + the handler's path. The adapter records that as the handler's import specifier; the
// indexer resolves it like any import (tsconfig paths / .adonisrc.json aliases).

const V5 = "@adonisjs/core";
const show = (code: string, ctx: AdapterContext = ctxWith(V5)) =>
  detectRoutes(parsed("start/routes.ts", code), ctx).map(
    (r) => `${r.method} ${r.path} -> ${r.handler}${r.inline ? " (inline)" : ""} @ ${r.handlerImport ?? "-"}`,
  );

describe("Adonis v5 string handlers", () => {
  it("reads the demo-shop v5 routes file: namespaces, sub-folders, resources, Route.route and Route.any", () => {
    const code = readFileSync(new URL("../../../fixtures/demo-shop-v5/api/start/routes.ts", import.meta.url), "utf8");
    expect(show(code)).toEqual([
      "GET /health -> GET /health (inline) @ -",
      "GET /api/customers -> CustomersController.index @ App/Controllers/Http/CustomersController",
      "POST /api/customers -> CustomersController.store @ App/Controllers/Http/CustomersController",
      "GET /api/customers/:id -> CustomersController.show @ App/Controllers/Http/CustomersController",
      "GET /api/orders -> OrdersController.index @ App/Controllers/Http/OrdersController",
      "POST /api/orders -> OrdersController.store @ App/Controllers/Http/OrdersController",
      "GET /api/orders/:id -> OrdersController.show @ App/Controllers/Http/OrdersController",
      "PUT /api/orders/:id -> OrdersController.update @ App/Controllers/Http/OrdersController",
      "PATCH /api/orders/:id -> OrdersController.update @ App/Controllers/Http/OrdersController",
      "POST /api/invoices -> InvoicesController.create @ App/Controllers/Http/Billing/InvoicesController",
      "POST /api/invoices/:id/pay -> InvoicesController.pay @ App/Controllers/Http/Billing/InvoicesController",
      "PUT /api/invoices/:id/pay -> InvoicesController.pay @ App/Controllers/Http/Billing/InvoicesController",
      "GET /api/admin/customers -> CustomersController.index @ App/Controllers/Http/Admin/CustomersController",
      "ANY /api/admin/reports -> ReportsController.handle @ App/Controllers/Http/Admin/ReportsController",
    ]);
  });

  it("honours a route's own .namespace(), the innermost group namespace, and an absolute handler", () => {
    expect(show(`
      import Route from "@ioc:Adonis/Core/Route";
      Route.group(() => {
        Route.group(() => {
          Route.get("/a", "OrdersController.index");
        }).namespace("App/Controllers/Http/V2");
        Route.get("/b", "OrdersController.index").namespace("App/Legacy");
        Route.get("/c", "/App/Other/OrdersController.index");
        Route.get("/d", "OrdersController.index");
      }).namespace("App/Controllers/Http/Shop");
    `)).toEqual([
      "GET /a -> OrdersController.index @ App/Controllers/Http/V2/OrdersController",
      "GET /b -> OrdersController.index @ App/Legacy/OrdersController",
      "GET /c -> OrdersController.index @ App/Other/OrdersController",
      "GET /d -> OrdersController.index @ App/Controllers/Http/Shop/OrdersController",
    ]);
  });

  it("uses the package's .adonisrc.json controllers namespace when there is no group namespace", () => {
    const ctx: AdapterContext = { ...ctxWith(V5), adonisControllers: "App/Http/Controllers" };
    expect(show(`import Route from "@ioc:Adonis/Core/Route";\nRoute.get("/x", "Shop/OrdersController.index");`, ctx))
      .toEqual(["GET /x -> OrdersController.index @ App/Http/Controllers/Shop/OrdersController"]);
  });

  it("maps resources to their standard actions, with only/except/apiOnly and nested names", () => {
    expect(show(`
      import Route from "@ioc:Adonis/Core/Route";
      Route.resource("customers", "CustomersController");
      Route.resource("invoices", "InvoicesController").only(["index", "show"]);
      Route.resource("customers.orders", "OrdersController").except(["create", "edit", "update"]).as("orders");
    `)).toEqual([
      "GET /customers -> CustomersController.index @ App/Controllers/Http/CustomersController",
      "GET /customers/create -> CustomersController.create @ App/Controllers/Http/CustomersController",
      "POST /customers -> CustomersController.store @ App/Controllers/Http/CustomersController",
      "GET /customers/:id -> CustomersController.show @ App/Controllers/Http/CustomersController",
      "GET /customers/:id/edit -> CustomersController.edit @ App/Controllers/Http/CustomersController",
      "PUT /customers/:id -> CustomersController.update @ App/Controllers/Http/CustomersController",
      "PATCH /customers/:id -> CustomersController.update @ App/Controllers/Http/CustomersController",
      "DELETE /customers/:id -> CustomersController.destroy @ App/Controllers/Http/CustomersController",
      "GET /invoices -> InvoicesController.index @ App/Controllers/Http/InvoicesController",
      "GET /invoices/:id -> InvoicesController.show @ App/Controllers/Http/InvoicesController",
      "GET /customers/:customer_id/orders -> OrdersController.index @ App/Controllers/Http/OrdersController",
      "POST /customers/:customer_id/orders -> OrdersController.store @ App/Controllers/Http/OrdersController",
      "GET /customers/:customer_id/orders/:id -> OrdersController.show @ App/Controllers/Http/OrdersController",
      "DELETE /customers/:customer_id/orders/:id -> OrdersController.destroy @ App/Controllers/Http/OrdersController",
    ]);
  });

  it("gives a shallow resource's member routes the short path", () => {
    expect(show(`
      import Route from "@ioc:Adonis/Core/Route";
      Route.shallowResource("customers.orders", "OrdersController").apiOnly();
    `)).toEqual([
      "GET /customers/:customer_id/orders -> OrdersController.index @ App/Controllers/Http/OrdersController",
      "POST /customers/:customer_id/orders -> OrdersController.store @ App/Controllers/Http/OrdersController",
      "GET /orders/:id -> OrdersController.show @ App/Controllers/Http/OrdersController",
      "PUT /orders/:id -> OrdersController.update @ App/Controllers/Http/OrdersController",
      "PATCH /orders/:id -> OrdersController.update @ App/Controllers/Http/OrdersController",
      "DELETE /orders/:id -> OrdersController.destroy @ App/Controllers/Http/OrdersController",
    ]);
  });

  it("does not read a resource or Route.route call on something that is not a router", () => {
    expect(show(`
      import Route from "@ioc:Adonis/Core/Route";
      store.resource("customers", "CustomersController");
      cache.route("/x", ["GET"], "XController.y");
      Route.resource(name, "CustomersController");
    `)).toEqual([]);
  });
});

describe("Adonis v6 resources", () => {
  it("maps router.resource with a lazily imported controller class to the standard actions", () => {
    expect(show(`
      import router from "@adonisjs/core/services/router";
      const CustomersController = () => import("#controllers/customers_controller");
      router.group(() => {
        router.resource("customers", CustomersController).apiOnly().only(["index", "store"]);
      }).prefix("/api");
      router.get("/x", "#controllers/orders_controller.show");
    `)).toEqual([
      "GET /api/customers -> CustomersController.index @ #controllers/customers_controller",
      "POST /api/customers -> CustomersController.store @ #controllers/customers_controller",
      "GET /x -> OrdersController.show @ #controllers/orders_controller",
    ]);
  });
});
