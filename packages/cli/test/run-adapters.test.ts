import { describe, expect, it } from "vitest";
import { finalizeEndpoints, loadContext, runAdapters } from "../src/adapters/run.js";
import { emptyPart } from "../src/adapters/types.js";
import { ctxWith } from "./adapter-helpers.js";
import { makeRepo } from "./helpers.js";

describe("loadContext", () => {
  it("gives each file the deps of its nearest package.json, plus the repo root's", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15" } }),
      "apps/api/package.json": JSON.stringify({ dependencies: { express: "^4" } }),
    });
    const ctx = loadContext(repo, ["package.json", "apps/web/package.json", "apps/api/package.json"]);
    const web = ctx.contextFor("apps/web/app/page.tsx");
    expect([...web.deps].sort()).toEqual(["next", "typescript"]);
    expect(web.packageRoot).toBe("apps/web");
    const api = ctx.contextFor("apps/api/src/server.ts");
    expect([...api.deps].sort()).toEqual(["express", "typescript"]);
    expect(api.packageRoot).toBe("apps/api");
    const root = ctx.contextFor("scripts/x.ts");
    expect([...root.deps]).toEqual(["typescript"]);
    expect(root.packageRoot).toBe("");
  });

  it("uses an empty set when no package.json is above a file", () => {
    const repo = makeRepo({ "lib/package.json": JSON.stringify({ dependencies: { pg: "^8" } }) });
    const ctx = loadContext(repo, ["lib/package.json"]);
    expect([...ctx.contextFor("tools/x.ts").deps]).toEqual([]);
    expect([...ctx.contextFor("lib/db.ts").deps]).toEqual(["pg"]);
  });

  it("has a key that changes when any package's deps change", () => {
    const a = makeRepo({ "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15" } }) });
    const b = makeRepo({ "apps/web/package.json": JSON.stringify({ dependencies: { next: "^15", axios: "^1" } }) });
    const c = makeRepo({ "apps/other/package.json": JSON.stringify({ dependencies: { next: "^15" } }) });
    const key = (repo: string, f: string) => loadContext(repo, [f]).key;
    expect(key(a, "apps/web/package.json")).not.toBe(key(b, "apps/web/package.json"));
    expect(key(a, "apps/web/package.json")).not.toBe(key(c, "apps/other/package.json"));
  });
});

describe("runAdapters + finalizeEndpoints", () => {
  it("resolves models to tables across files", () => {
    const ctx = ctxWith("@adonisjs/core", "@adonisjs/lucid");
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
    const ctx = ctxWith("@prisma/client");
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
