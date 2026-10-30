import { describe, expect, it } from "vitest";
import { finalizeEndpoints, loadContext, runAdapters } from "../src/adapters/run.js";
import { makeRepo } from "./helpers.js";

describe("loadContext", () => {
  it("unions dependencies from every package.json", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ dependencies: { express: "^4" } }),
      "apps/web/package.json": JSON.stringify({ devDependencies: { next: "^15" } }),
    });
    const ctx = loadContext(repo, ["package.json", "apps/web/package.json"]);
    expect([...ctx.deps].sort()).toEqual(["express", "next"]);
  });
});

describe("runAdapters + finalizeEndpoints", () => {
  it("resolves models to tables across files", () => {
    const ctx = { deps: new Set(["@adonisjs/core", "@adonisjs/lucid"]) };
    const parts = [
      runAdapters("app/models/customer.ts", `export default class Customer extends BaseModel {}`, ctx),
      runAdapters("app/services/s.ts", `import Customer from "#models/customer"; export const f = () => Customer.create({});`, ctx),
      runAdapters("README.md", "# hi", ctx),
      runAdapters("types.d.ts", "declare const x: number;", ctx),
    ];
    const ep = finalizeEndpoints("api", parts);
    expect(ep.version).toBe(1);
    expect(ep.repo).toBe("api");
    expect(ep.dbAccess).toMatchObject([{ model: "Customer", table: "customers", op: "insert" }]);
    expect(ep.tables).toMatchObject([{ name: "customers", source: "model" }]);
  });

  it("keeps unresolved models without a table", () => {
    const ctx = { deps: new Set(["@prisma/client"]) };
    const ep = finalizeEndpoints("x", [runAdapters("a.ts", `export const f = () => prisma.ghost.findMany();`, ctx)]);
    expect(ep.dbAccess[0]).toMatchObject({ model: "ghost" });
    expect(ep.dbAccess[0]!.table).toBeUndefined();
  });
});
