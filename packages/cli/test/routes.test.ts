import { describe, expect, it } from "vitest";
import { adonisStringHandler, detectRoutes } from "../src/adapters/routes.js";
import { ctxIn, ctxWith, parsed } from "./adapter-helpers.js";

const show = (rel: string, code: string, ...deps: string[]) =>
  detectRoutes(parsed(rel, code), ctxWith(...deps)).map((r) => `${r.method} ${r.path} -> ${r.handler}${r.inline ? " (inline)" : ""} [${r.framework}]`);

describe("detectRoutes", () => {
  it("reads AdonisJS routes with group prefixes and lazy controllers", () => {
    expect(show("start/routes.ts", `
      import router from "@adonisjs/core/services/router";
      const CustomersController = () => import("#controllers/customers_controller");
      router.get("/", async () => "hi");
      router.group(() => {
        router.post("/customers", [CustomersController, "store"]);
        router.group(() => { router.get("/:id", "#controllers/customers_controller.show"); }).prefix("/customers");
      }).prefix("/api").middleware([]);
    `, "@adonisjs/core")).toEqual([
      "GET / -> GET / (inline) [adonis]",
      "POST /api/customers -> CustomersController.store [adonis]",
      "GET /api/customers/:id -> CustomersController.show [adonis]",
    ]);
  });

  it("reads Express routers created in the file", () => {
    expect(show("src/server.ts", `
      import express from "express";
      const app = express();
      const billing = express.Router();
      billing.post("/invoices", auth, createInvoice);
      billing.route("/invoices/:id").get(invoices.show);
      app.get("/health", (_req, res) => res.json({ ok: true }));
      app.get("env");
    `, "express")).toEqual([
      "POST /invoices -> createInvoice [express]",
      "GET /invoices/:id -> invoices.show [express]",
      "GET /health -> GET /health (inline) [express]",
    ]);
  });

  it("reads Fastify route objects", () => {
    expect(show("src/app.ts", `import Fastify from "fastify";\nfastify.route({ method: "PATCH", url: "/orders/:id", handler: updateOrder });`, "fastify"))
      .toEqual(["PATCH /orders/:id -> updateOrder [fastify]"]);
  });

  it("reads NestJS controllers", () => {
    expect(show("src/customers.controller.ts", `
      @Controller("customers")
      export class CustomersController {
        @Get(":id") findOne() {}
        @Post() create() {}
      }
    `, "@nestjs/core")).toEqual([
      "GET /customers/:id -> CustomersController.findOne [nest]",
      "POST /customers -> CustomersController.create [nest]",
    ]);
  });

  it("reads Next.js API routes", () => {
    expect(show("app/api/customers/[id]/route.ts", `export async function GET() {} export const DELETE = async () => {};`, "next"))
      .toEqual(["GET /api/customers/:id -> GET [next-api]", "DELETE /api/customers/:id -> DELETE [next-api]"]);
    expect(show("pages/api/health.ts", `export default function handler() {}`, "next"))
      .toEqual(["ANY /api/health -> default [next-api]"]);
  });

  it("reads Next.js API routes only directly under the package root", () => {
    const at = (rel: string, ctx = ctxIn("apps/web", "next")) => detectRoutes(parsed(rel, "export async function GET() {}"), ctx).map((r) => r.path);
    expect(at("apps/web/src/app/api/orders/route.ts")).toEqual(["/api/orders"]);
    expect(at("apps/web/lib/app/api/route.ts")).toEqual([]);
  });

  it("records where handlers live: inline lines, same-file functions, and import specifiers", () => {
    const routes = detectRoutes(parsed("src/server.ts", `import express from "express";
import { createInvoice } from "./invoices";
import * as orders from "./orders";
const app = express();
function listInvoices(req, res) {}
app.post("/invoices", createInvoice);
app.get("/invoices", listInvoices);
app.get("/orders/:id", orders.show);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/wrapped", wrap(createInvoice));`), ctxWith("express"));
    expect(routes.map((r) => [r.path, r.handlerFile, r.handlerLines, r.handlerImport])).toEqual([
      ["/invoices", undefined, undefined, "./invoices"],
      ["/invoices", "src/server.ts", undefined, undefined],
      ["/orders/:id", undefined, undefined, "./orders"],
      ["/health", "src/server.ts", [9, 11], undefined],
      ["/wrapped", undefined, undefined, "./invoices"],
    ]);
  });

  it("records Adonis controller import specifiers (lazy, static and string handlers)", () => {
    const routes = detectRoutes(parsed("start/routes.ts", `import router from "@adonisjs/core/services/router";
import UsersController from "#controllers/users_controller";
const CustomersController = () => import("#controllers/customers_controller");
router.post("/customers", [CustomersController, "store"]);
router.get("/users", [UsersController, "index"]);
router.get("/health", "#controllers/health_checks_controller.index");
router.get("/legacy", "LegacyController.index");`), ctxWith("@adonisjs/core"));
    expect(routes.map((r) => [r.path, r.handlerImport])).toEqual([
      ["/customers", "#controllers/customers_controller"],
      ["/users", "#controllers/users_controller"],
      ["/health", "#controllers/health_checks_controller"],
      ["/legacy", undefined],
    ]);
  });

  it("judges a router name by its nearest declaration, not a same-named variable elsewhere", () => {
    expect(show("src/server.ts", `
      import express from "express";
      function mount() { const billing = express.Router(); billing.get("/a", h); }
      function call(billing) { billing.get("/b", h2); }
    `, "express")).toEqual(["GET /a -> h [express]"]);
  });

  it("does not treat a koa import as proof of a router (koa-router is not supported)", () => {
    expect(show("src/server.ts", `import Koa from "koa";\nrouter.get("/x", h);`, "express")).toEqual([]);
  });

  it("records the line of each route call", () => {
    const routes = detectRoutes(parsed("src/server.ts", `import express from "express";
const app = express();

app.get("/a", h);
app.post(
  "/b",
  h,
);`), ctxWith("express"));
    expect(routes.map((r) => [r.path, r.at.line])).toEqual([["/a", 4], ["/b", 5]]);
  });

  it("finds nothing in repos without a backend framework", () => {
    expect(show("src/x.ts", `router.get("/a", h);`, "react")).toEqual([]);
  });

  it("ignores generic router names in a frontend file with no backend import, even in a repo with express elsewhere", () => {
    expect(show("src/components/nav.ts", `
      const r = useRouter();
      r.get("/settings", go);
      app.post("/x", y);
    `, "express")).toEqual([]);
  });

  it("treats generic router names as routers in a file that imports express", () => {
    expect(show("src/routes/users.ts", `
      import { Router } from "express";
      export default function mount(router: Router) { router.get("/users", list); }
    `, "express")).toEqual(["GET /users -> list [express]"]);
  });

  it("treats Route as a router in an Adonis v5 file importing @ioc:Adonis/Core/Route", () => {
    expect(show("start/routes.ts", `
      import Route from "@ioc:Adonis/Core/Route";
      Route.get("/health", "HealthController.index");
    `, "@adonisjs/core")).toEqual(["GET /health -> HealthController.index [adonis]"]);
  });

  it("turns Adonis string handlers into Class.method", () => {
    expect(adonisStringHandler("CustomersController.store")).toBe("CustomersController.store");
    expect(adonisStringHandler("#controllers/customers_controller.store")).toBe("CustomersController.store");
    expect(adonisStringHandler("#controllers/health_checks_controller")).toBe("HealthChecksController.handle");
  });
});
