import { describe, expect, it } from "vitest";
import { adonisStringHandler, detectMounts, detectRoutes } from "../src/adapters/routes.js";
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

  it("detects pages-router API methods from req.method checks", () => {
    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        if (req.method === "DELETE") return handleDelete(req, res);
      }
    `, "next")).toEqual(["DELETE /api/post/:id -> default [next-api]"]);

    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        switch (req.method) {
          case "GET":
            return handleGet(req, res);
          case "DELETE":
            return handleDelete(req, res);
          default:
            res.status(405).end();
        }
      }
    `, "next")).toEqual([
      "DELETE /api/post/:id -> default [next-api]",
      "GET /api/post/:id -> default [next-api]",
    ]);

    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        if (req.method !== "POST") {
          return res.status(405).end();
        }
        return create(req, res);
      }
    `, "next")).toEqual(["POST /api/post/:id -> default [next-api]"]);

    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        const { method } = req;
        if (method === "PUT") return update(req, res);
      }
    `, "next")).toEqual(["PUT /api/post/:id -> default [next-api]"]);

    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        return res.json({});
      }
    `, "next")).toEqual(["ANY /api/post/:id -> default [next-api]"]);
  });

  it("does not let a nested function/arrow that rebinds the request name leak its own method checks", () => {
    // A nested function with its own `req` param shadows the outer request — its checks don't count.
    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        function helper(req) {
          if (req.method === "POST") return true;
        }
        return res.json({});
      }
    `, "next")).toEqual(["ANY /api/post/:id -> default [next-api]"]);

    // Same shadowing through a callback parameter, not just a named nested function.
    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        items.map((req) => {
          if (req.method === "PUT") return true;
        });
        return res.json({});
      }
    `, "next")).toEqual(["ANY /api/post/:id -> default [next-api]"]);

    // A nested closure that does NOT shadow `req` should still be scanned.
    expect(show("pages/api/post/[id].ts", `
      export default async function handle(req, res) {
        const f = () => req.method === "PATCH";
        return f() ? res.json({}) : res.end();
      }
    `, "next")).toEqual(["PATCH /api/post/:id -> default [next-api]"]);
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

describe("detectRoutes router field", () => {
  it("records the router receiver on express routes (including chained .route().method())", () => {
    const routes = detectRoutes(parsed("src/server.ts", `
      import express from "express";
      const app = express();
      const billing = express.Router();
      billing.post("/invoices", createInvoice);
      billing.route("/invoices/:id").get(showInvoice);
      app.get("/health", h);
    `), ctxWith("express"));
    expect(routes.map((r) => r.router)).toEqual(["billing", "billing", "app"]);
  });

  it("records the router receiver on a fastify route object", () => {
    const routes = detectRoutes(
      parsed("src/app.ts", `import Fastify from "fastify";\nfastify.route({ method: "PATCH", url: "/orders/:id", handler: updateOrder });`, ),
      ctxWith("fastify"),
    );
    expect(routes[0]!.router).toBe("fastify");
  });

  it("leaves router undefined for Adonis, Nest and Next routes", () => {
    const adonis = detectRoutes(parsed("start/routes.ts", `
      import router from "@adonisjs/core/services/router";
      router.get("/health", "HealthController.index");
    `), ctxWith("@adonisjs/core"));
    expect(adonis[0]!.router).toBeUndefined();

    const nest = detectRoutes(parsed("src/customers.controller.ts", `
      @Controller("customers") export class CustomersController { @Get() list() {} }
    `), ctxWith("@nestjs/core"));
    expect(nest[0]!.router).toBeUndefined();

    const next = detectRoutes(parsed("pages/api/health.ts", `export default function handler() {}`), ctxWith("next"));
    expect(next[0]!.router).toBeUndefined();
  });
});

describe("detectMounts", () => {
  const mounts = (rel: string, code: string, ...deps: string[]) =>
    detectMounts(parsed(rel, code), ctxWith(...deps)).map(
      (m) => `${m.kind} ${m.prefix} on=${m.on || "<none>"} target=${m.target.name ?? "<none>"}${m.targetImport ? ` import=${m.targetImport}` : ""}`,
    );

  it("finds an express app.use mount of a same-file router", () => {
    expect(mounts("src/server.ts", `
      import express from "express";
      const app = express();
      const billing = express.Router();
      app.use("/billing", billing);
    `, "express")).toEqual(["express-use /billing on=app target=billing"]);
  });

  it("finds an express app.use mount of an imported router, keeping the import specifier", () => {
    expect(mounts("src/server.ts", `
      import express from "express";
      import billingRouter from "./billing-router";
      const app = express();
      app.use("/billing", billingRouter);
    `, "express")).toEqual(["express-use /billing on=app target=billingRouter import=./billing-router"]);
  });

  it("takes the last argument when middleware precedes the router", () => {
    expect(mounts("src/server.ts", `
      import express from "express";
      const app = express();
      const billing = express.Router();
      app.use("/billing", auth(), logger, billing);
    `, "express")).toEqual(["express-use /billing on=app target=billing"]);
  });

  it("skips a mount whose prefix is not a literal", () => {
    expect(mounts("src/server.ts", `
      import express from "express";
      const app = express();
      const billing = express.Router();
      app.use(prefixVar, billing);
    `, "express")).toEqual([]);
  });

  it("finds a fastify register with a prefix", () => {
    expect(mounts("src/app.ts", `
      import Fastify from "fastify";
      fastify.register(billingPlugin, { prefix: "/billing" });
    `, "fastify")).toEqual(["fastify-register /billing on=fastify target=billingPlugin"]);
  });

  it("finds a Nest setGlobalPrefix, with no receiver and no target", () => {
    expect(mounts("src/main.ts", `
      async function bootstrap() {
        const app = await NestFactory.create(AppModule);
        app.setGlobalPrefix("api");
      }
    `, "@nestjs/core")).toEqual(["nest-global /api on=<none> target=<none>"]);
  });

  it("finds nothing in a repo without a backend framework", () => {
    expect(mounts("src/x.ts", `app.use("/billing", billing);`, "react")).toEqual([]);
  });

  it("reads a prefix-less use(router) as a mount with an empty prefix (H1)", () => {
    expect(mounts("src/server.ts", `
      import express from "express";
      const app = express();
      const billing = express.Router();
      app.use(billing);
    `, "express")).toEqual(["express-use  on=app target=billing"]);
  });
});
