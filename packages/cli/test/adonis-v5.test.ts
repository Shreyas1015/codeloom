import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import type { Chain, EndpointsFile } from "../src/store/schemas.js";
import { commitAll, makeRepo } from "./helpers.js";

// An Adonis v5 api (fixtures/demo-shop-v5/api: string handlers, a namespaced group, a sub-folder controller,
// a `<Name>/index.ts` controller, a resource, Route.route, Route.any) indexed on its own, then with the
// demo-shop billing service it calls over HTTP (`Env.get("BILLING_API_URL")`) in one group.

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `codeloom-${prefix}-`));

function repo(src: string, parent: string, name: string, edit?: (dest: string) => void): string {
  const dest = join(parent, name);
  mkdirSync(parent, { recursive: true });
  cpSync(fileURLToPath(new URL(`../../../fixtures/${src}`, import.meta.url)), dest, { recursive: true });
  edit?.(dest);
  git(dest, "init", "-q", "-b", "main");
  commitAll(dest);
  git(dest, "remote", "add", "origin", `git@github.com:demo-shop/demo-${name}.git`);
  return dest;
}

const endpoints = (dir: string): EndpointsFile => JSON.parse(readFileSync(join(dir, ".codeloom", "endpoints.json"), "utf8"));
const chainsOf = (root: string): Chain[] => JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains;
const brief = (c: Chain) => c.stops.map((s) => `${s.repo}|${s.kind}|${s.kind === "route" || s.kind === "db" || s.kind === "call" ? s.label : s.symbol}`);
const chain = (chains: Chain[], key: string) => {
  const c = chains.find((x) => x.routeKey === key);
  if (!c) throw new Error(`no chain ${key}: ${chains.map((x) => x.routeKey).join(", ")}`);
  return brief(c);
};

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.CODELOOM_HOME;
  process.env.CODELOOM_HOME = tmp("home");
});
afterEach(() => {
  process.env.CODELOOM_HOME = savedHome;
});

describe("Adonis v5 string handlers (demo-shop-v5)", () => {
  it("finds every controller file by the namespace convention", async () => {
    const api = repo("demo-shop-v5/api", tmp("v5"), "legacy-api");
    await runIndex(api);
    const routes = endpoints(api).routes.filter((r) => !r.inline);
    expect(routes.map((r) => `${r.method} ${r.path} -> ${r.handlerFile}`)).toEqual(expect.arrayContaining([
      "GET /api/customers -> app/Controllers/Http/CustomersController.ts",
      "GET /api/orders/:id -> app/Controllers/Http/OrdersController/index.ts",
      "POST /api/invoices -> app/Controllers/Http/Billing/InvoicesController.ts",
      "PUT /api/invoices/:id/pay -> app/Controllers/Http/Billing/InvoicesController.ts",
      "GET /api/admin/customers -> app/Controllers/Http/Admin/CustomersController.ts",
      "ANY /api/admin/reports -> app/Controllers/Http/Admin/ReportsController.ts",
    ]));
    expect(routes.filter((r) => !r.handlerFile)).toEqual([]);
  });

  it("follows each controller method into its services (static, new, singleton) and their tables", async () => {
    const api = repo("demo-shop-v5/api", tmp("v5"), "legacy-api");
    const { root } = await runIndex(api);
    const chains = chainsOf(root);
    expect(chain(chains, "demo-legacy-api:GET /api/customers")).toEqual([
      "demo-legacy-api|route|GET /api/customers",
      "demo-legacy-api|handler|CustomersController.index",
      "demo-legacy-api|function|CustomerService.list",
      "demo-legacy-api|db|customers",
    ]);
    expect(chain(chains, "demo-legacy-api:POST /api/customers")).toEqual(expect.arrayContaining([
      "demo-legacy-api|function|CustomerService.create", "demo-legacy-api|db|customers",
    ]));
    expect(chain(chains, "demo-legacy-api:GET /api/customers/:id")).toEqual(expect.arrayContaining([
      "demo-legacy-api|function|CustomerLookup.find", "demo-legacy-api|db|customers",
    ]));
    // The file's default-exported class is the controller, whatever its own name.
    expect(chain(chains, "demo-legacy-api:GET /api/admin/customers")).toEqual([
      "demo-legacy-api|route|GET /api/admin/customers",
      "demo-legacy-api|handler|AdminCustomersController.index",
      "demo-legacy-api|db|customers",
    ]);
    expect(chain(chains, "demo-legacy-api:PATCH /api/orders/:id")).toEqual(expect.arrayContaining([
      "demo-legacy-api|handler|OrdersController.update", "demo-legacy-api|db|orders",
    ]));
  });

  it("continues over HTTP into the billing service's route and tables", async () => {
    const parent = tmp("v5-group");
    const api = repo("demo-shop-v5/api", parent, "legacy-api");
    const billing = repo("demo-shop/billing", parent, "billing");
    await runIndex(api);
    const { root } = await runIndex(billing);
    const chains = chainsOf(root);
    expect(chain(chains, "demo-legacy-api:POST /api/invoices")).toEqual([
      "demo-legacy-api|route|POST /api/invoices",
      "demo-legacy-api|handler|InvoicesController.create",
      "demo-legacy-api|function|BillingService.createInvoice",
      "demo-legacy-api|call|/billing/invoices",
      "demo-billing|route|POST /billing/invoices",
      ...chain(chains, "demo-billing:POST /billing/invoices").slice(1),
    ]);
    expect(chain(chains, "demo-billing:POST /billing/invoices")).toContain("demo-billing|db|invoices");
    // `new BillingService()` held in a local, then called.
    expect(chain(chains, "demo-legacy-api:PUT /api/invoices/:id/pay")).toEqual(expect.arrayContaining([
      "demo-legacy-api|handler|InvoicesController.pay",
      "demo-legacy-api|function|BillingService.payInvoice",
      "demo-legacy-api|call|/billing/invoices/:id/pay",
      "demo-billing|route|POST /billing/invoices/:id/pay",
    ]));
  });

  it("reads the controllers namespace and aliases from .adonisrc.json", async () => {
    const api = repo("demo-shop-v5/api", tmp("v5-rc"), "legacy-api", (dest) => {
      // No tsconfig paths: the `App` alias comes from .adonisrc.json alone; controllers live elsewhere.
      rmSync(join(dest, "tsconfig.json"));
      const rc = JSON.parse(readFileSync(join(dest, ".adonisrc.json"), "utf8"));
      writeFileSync(join(dest, ".adonisrc.json"), JSON.stringify({ ...rc, namespaces: { httpControllers: "App/Http" } }));
      const from = join(dest, "app", "Controllers", "Http", "CustomersController.ts");
      const to = join(dest, "app", "Http", "CustomersController.ts");
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from, "utf8"));
      rmSync(join(dest, "app", "Controllers"), { recursive: true });
    });
    await runIndex(api);
    const customers = endpoints(api).routes.find((r) => r.method === "GET" && r.path === "/api/customers")!;
    expect(customers.handlerFile).toBe("app/Http/CustomersController.ts");
    // The group's own .namespace() still wins, and names a folder that is gone: no file, nothing invented.
    const admin = endpoints(api).routes.find((r) => r.path === "/api/admin/customers")!;
    expect(admin.handlerFile).toBeUndefined();
  });

  it("keeps each app's .adonisrc.json aliases to its own folder (two Adonis apps in one repo)", async () => {
    const app = (name: string) => ({
      [`apps/${name}/package.json`]: JSON.stringify({ name: `demo-${name}`, dependencies: { "@adonisjs/core": "^5.9.0" } }),
      [`apps/${name}/.adonisrc.json`]: JSON.stringify({ typescript: true, aliases: { App: "app" } }),
      [`apps/${name}/start/routes.ts`]: `import Route from '@ioc:Adonis/Core/Route'\nRoute.get('/${name}', 'CustomersController.index')\n`,
    });
    const dir = makeRepo({
      "package.json": JSON.stringify({ name: "demo-shop-apps", private: true }),
      ...app("alpha"), ...app("beta"),
      "apps/alpha/app/Controllers/Http/CustomersController.ts": `export default class CustomersController {\n  public async index() { return []; }\n}\n`,
    });
    await runIndex(dir);
    const byPath = new Map(endpoints(dir).routes.map((r) => [r.path, r.handlerFile]));
    expect(byPath.get("/alpha")).toBe("apps/alpha/app/Controllers/Http/CustomersController.ts");
    expect(byPath.get("/beta")).toBeUndefined();
  });
});

describe("Adonis routes registered by a function from another file", () => {
  const files = (caller: string): Record<string, string> => ({
    "package.json": JSON.stringify({ name: "demo-legacy-api", dependencies: { "@adonisjs/core": "^5.9.0" } }),
    ".adonisrc.json": JSON.stringify({ typescript: true, aliases: { App: "app" } }),
    "app/Controllers/Http/CustomersController.ts": `export default class CustomersController {\n  public async index() { return 'top'; }\n}\n`,
    "app/Controllers/Http/Admin/CustomersController.ts": `export default class AdminCustomersController {\n  public async index() { return 'admin'; }\n}\n`,
    "start/routes/admin.ts": `import Route from '@ioc:Adonis/Core/Route'
export default () => {
  Route.get('/customers', 'CustomersController.index')
  Route.get('/own', 'CustomersController.index').namespace('App/Controllers/Http')
}
export function reports() {
  Route.group(() => {
    Route.get('/daily', 'CustomersController.index')
  }).prefix('/reports')
}
`,
    "start/routes.ts": caller,
  });
  const routes = (dir: string) => endpoints(dir).routes.map((r) => `${r.method} ${r.path} -> ${r.handlerFile ?? "-"}${r.handlerGuess ? " (guess)" : ""}`).sort();

  it("applies the caller's group prefix and namespace, one level or more", async () => {
    const dir = makeRepo(files(`import Route from '@ioc:Adonis/Core/Route'
import adminRoutes, { reports } from './routes/admin'
import nested from './routes/nested'

Route.group(() => {
  Route.group(() => {
    adminRoutes()
  }).prefix('/admin').namespace('App/Controllers/Http/Admin')
  reports()
}).prefix('/api')
nested()
`));
    writeFileSync(join(dir, "start/routes/nested.ts"), `import Route from '@ioc:Adonis/Core/Route'
import adminRoutes from './admin'
export default function nested() {
  Route.group(() => {
    adminRoutes()
  }).prefix('/v2')
}
`);
    commitAll(dir);
    await runIndex(dir);
    expect(routes(dir)).toEqual([
      "GET /api/admin/customers -> app/Controllers/Http/Admin/CustomersController.ts",
      "GET /api/admin/own -> app/Controllers/Http/CustomersController.ts",
      "GET /api/reports/daily -> app/Controllers/Http/CustomersController.ts",
      "GET /v2/customers -> app/Controllers/Http/CustomersController.ts",
      "GET /v2/own -> app/Controllers/Http/CustomersController.ts",
    ]);
    const prefixes = new Map(endpoints(dir).routes.map((r) => [r.path, r.registeredPrefix]));
    expect(prefixes.get("/api/admin/customers")).toBe("/api/admin");
    expect(prefixes.get("/api/reports/daily")).toBe("/api");
    expect(prefixes.get("/v2/own")).toBe("/v2");
    const { root } = await runIndex(dir);
    expect(chain(chainsOf(root), "demo-legacy-api:GET /api/admin/customers")).toEqual([
      "demo-legacy-api|route|GET /api/admin/customers", "demo-legacy-api|handler|AdminCustomersController.index",
    ]);
  });

  it("still links a call whose base carries the caller's prefix (`${API_URL}/reports/daily`, API_URL ending in /api)", async () => {
    const parent = tmp("v5-prefix");
    const api = makeRepo(files(`import Route from '@ioc:Adonis/Core/Route'
import { reports } from './routes/admin'
Route.group(() => {
  reports()
}).prefix('/api')
`), join(parent, "legacy-api"));
    git(api, "remote", "add", "origin", "git@github.com:demo-shop/demo-legacy-api.git");
    const web = makeRepo({
      "package.json": JSON.stringify({ name: "demo-web", private: true, dependencies: { next: "^15.0.0", react: "^19.0.0" } }),
      "lib/reports.ts": `export async function getDailyReport() {\n  const res = await fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/reports/daily\`);\n  return res.json();\n}\n`,
      "app/reports/page.tsx": `import { getDailyReport } from "../../lib/reports";\n\nexport default async function ReportsPage() {\n  const report = await getDailyReport();\n  return <h1>{report.total}</h1>;\n}\n`,
    }, join(parent, "web"));
    git(web, "remote", "add", "origin", "git@github.com:demo-shop/demo-web.git");
    await runIndex(api);
    const { root } = await runIndex(web);
    const page = chainsOf(root).find((c) => c.entry === "page:demo-web:/reports")!;
    expect(brief(page)).toEqual(expect.arrayContaining([
      "demo-web|call|/reports/daily", "demo-legacy-api|route|GET /api/reports/daily", "demo-legacy-api|handler|CustomersController.index",
    ]));
  });

  it("marks the handler a guess when nothing visible calls the exported function", async () => {
    const dir = makeRepo(files(`import Route from '@ioc:Adonis/Core/Route'
import * as all from './routes/admin'
Object.values(all).forEach((register) => register())
`));
    await runIndex(dir);
    expect(routes(dir)).toEqual([
      "GET /customers -> app/Controllers/Http/CustomersController.ts (guess)",
      "GET /own -> app/Controllers/Http/CustomersController.ts",
      "GET /reports/daily -> app/Controllers/Http/CustomersController.ts (guess)",
    ]);
  });
});

