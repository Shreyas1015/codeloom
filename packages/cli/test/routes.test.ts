import { describe, expect, it } from "vitest";
import { adonisStringHandler, detectRoutes } from "../src/adapters/routes.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

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
    expect(show("src/app.ts", `fastify.route({ method: "PATCH", url: "/orders/:id", handler: updateOrder });`, "fastify"))
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

  it("finds nothing in repos without a backend framework", () => {
    expect(show("src/x.ts", `router.get("/a", h);`, "react")).toEqual([]);
  });

  it("turns Adonis string handlers into Class.method", () => {
    expect(adonisStringHandler("CustomersController.store")).toBe("CustomersController.store");
    expect(adonisStringHandler("#controllers/customers_controller.store")).toBe("CustomersController.store");
    expect(adonisStringHandler("#controllers/health_checks_controller")).toBe("HealthChecksController.handle");
  });
});
