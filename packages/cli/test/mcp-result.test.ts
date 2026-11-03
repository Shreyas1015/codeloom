import { describe, expect, it } from "vitest";
import { fitResponse, ok, responseBytes, withErrors } from "../src/mcp/result.js";

const row = (i: number) => ({ id: `row-${String(i).padStart(5, "0")}`, text: "x".repeat(200) });

describe("fitResponse (H5)", () => {
  it("leaves a response under the cap untouched", () => {
    const r = { total: 3, rows: [row(1), row(2), row(3)], truncated: false };
    expect(fitResponse(r, "Use limit.", 10_000)).toBe(r);
  });

  it("cuts the biggest list so the whole tool response fits, and says how to narrow it", () => {
    const r = { total: 1000, rows: Array.from({ length: 1000 }, (_, i) => row(i)), tags: ["a", "b"], truncated: false };
    const out = fitResponse(r, "Pass limit/offset to page.", 50_000);
    expect(responseBytes(out)).toBeLessThanOrEqual(50_000);
    const rows = out.rows as unknown[];
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.length).toBeLessThan(1000);
    expect(rows).toEqual(r.rows.slice(0, rows.length)); // keeps the head, in order
    expect(out.tags).toEqual(["a", "b"]);
    expect(out.total).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.truncatedNote).toMatch(/1 MB|cut/);
    expect(out.truncatedNote).toContain(`rows: kept ${rows.length} of 1000`);
    expect(out.truncatedNote).toContain("Pass limit/offset to page.");
    expect(r.rows).toHaveLength(1000); // the input is not mutated
  });

  it("reaches lists nested in objects and moves on to the next list when one is not enough", () => {
    const r = {
      lanes: { api: Array.from({ length: 300 }, (_, i) => row(i)), db: Array.from({ length: 300 }, (_, i) => row(i)) },
      chains: Array.from({ length: 100 }, (_, i) => ({ id: i, stops: [row(i)] })),
    };
    const out = fitResponse(r, "Narrow it.", 30_000);
    expect(responseBytes(out)).toBeLessThanOrEqual(30_000);
    expect(out.truncated).toBe(true);
  });

  it("cuts a single huge string when no list is left to cut", () => {
    const r = { code: { text: "y".repeat(100_000) } };
    const out = fitResponse(r, "Use maxChars.", 20_000);
    expect(responseBytes(out)).toBeLessThanOrEqual(20_000);
    expect((out.code as { text: string }).text.length).toBeGreaterThan(1000);
    expect(out.truncated).toBe(true);
  });

  it("withErrors applies the 1 MB cap with the tool's narrowing hint", async () => {
    const big = { rows: Array.from({ length: 10_000 }, (_, i) => row(i)) };
    const r = await withErrors(() => big, "Filter by repo.")({});
    const text = (r.content[0] as { text: string }).text;
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(1_000_000);
    expect(JSON.parse(text).truncated).toBe(true);
    expect(JSON.parse(text).truncatedNote).toContain("Filter by repo.");
    expect(r.structuredContent).toEqual(JSON.parse(text));
    expect(responseBytes({ a: 1 })).toBe(Buffer.byteLength(JSON.stringify(ok({ a: 1 }))));
  });
});
