import { describe, expect, it } from "vitest";
import { finalizeEndpoints, loadContext, runAdapters } from "../src/adapters/run.js";
import { emptyPart } from "../src/adapters/types.js";
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

  it("resolves model collisions with first-wins rule (matching tables dedup)", () => {
    const part1 = emptyPart();
    part1.models.push({ model: "User", table: "users", file: "a/models/user.ts", line: 1, source: "lucid" });
    part1.dbAccess.push({ model: "User", op: "read", via: "lucid", at: { file: "x.ts", line: 1, symbol: "f" } });

    const part2 = emptyPart();
    part2.models.push({ model: "User", table: "accounts", file: "b/models/user.ts", line: 1, source: "lucid" });

    const ep = finalizeEndpoints("test", [part1, part2]);
    // First User definition (users) should win for collision resolution
    expect(ep.dbAccess[0]).toMatchObject({ model: "User", table: "users", op: "read" });
  });
});
