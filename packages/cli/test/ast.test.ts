import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  enclosingSymbol, fileRoute, normalizePath, parseSource, pathPattern, rootName, snakePlural, walk,
} from "../src/adapters/ast.js";

function firstCall(code: string, file = "x.ts"): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  walk(parseSource(file, code), (n) => { if (!found && ts.isCallExpression(n)) found = n; });
  if (!found) throw new Error("no call");
  return found;
}

describe("pathPattern", () => {
  const p = (expr: string) => pathPattern(firstCall(`f(${expr})`).arguments[0]);
  it("keeps literals", () => expect(p(`"/api/customers"`)).toEqual({ path: "/api/customers", resolved: true }));
  it("drops a base-url prefix and names params", () =>
    expect(p("`${process.env.NEXT_PUBLIC_API_URL}/api/customers/${customer.id}`")).toEqual({ path: "/api/customers/:id", resolved: true }));
  it("handles concatenation", () => expect(p(`API_BASE + "/customers/" + id`)).toEqual({ path: "/customers/:id", resolved: true }));
  it("strips origin and query", () => expect(p(`"https://pay.example.com/v1/charges?x=1"`)).toEqual({ path: "/v1/charges", resolved: true }));
  it("unwraps encodeURIComponent", () => expect(p("`/customers/${encodeURIComponent(id)}`")).toEqual({ path: "/customers/:id", resolved: true }));
  it("gives up on a bare variable", () => expect(p("url")).toBeUndefined());
});

describe("enclosingSymbol", () => {
  it("names functions, methods and arrow consts", () => {
    const sf = parseSource("x.ts", `
      function useThing() { return async () => fetch("/a"); }
      class CustomerService { async create() { db.from("customers"); } }
      const getCustomer = async () => fetch("/b");
      fetch("/c");`);
    const symbols: string[] = [];
    walk(sf, (n) => { if (ts.isCallExpression(n) && /fetch|from/.test(n.expression.getText())) symbols.push(enclosingSymbol(n)); });
    expect(symbols).toEqual(["useThing", "CustomerService.create", "getCustomer", "<module>"]);
  });
});

describe("helpers", () => {
  it("normalizes paths", () => {
    expect(normalizePath("customers//x/")).toBe("/customers/x");
    expect(normalizePath("")).toBe("/");
  });
  it("builds file routes", () => {
    expect(fileRoute(["(shop)", "customers", "[id]", "edit"])).toBe("/customers/:id/edit");
    expect(fileRoute(["docs", "[...slug]"])).toBe("/docs/:slug*");
    expect(fileRoute([])).toBe("/");
  });
  it("finds the root name, skipping this", () => {
    expect(rootName(firstCall("this.prisma.invoice.create()").expression)).toBe("prisma");
    expect(rootName(firstCall("db.from('x')").expression)).toBe("db");
  });
  it("pluralises table names like Lucid", () => {
    expect(snakePlural("Customer")).toBe("customers");
    expect(snakePlural("CustomerContact")).toBe("customer_contacts");
    expect(snakePlural("Category")).toBe("categories");
    expect(snakePlural("Address")).toBe("addresses");
  });
});
