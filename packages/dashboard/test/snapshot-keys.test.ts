import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotKey } from "@/api/static";

// The same golden cases packages/cli/test/snapshot-key.test.ts checks: the snapshot writer and this
// reader must name every data file identically. `null` stands for a param that is undefined at the call site.
interface KeyCase {
  path: string;
  params?: Record<string, string | number | null>;
  key: string;
}
// Vitest runs from packages/dashboard (jsdom: import.meta.url is not a file URL here).
const cases = JSON.parse(readFileSync(join(process.cwd(), "../../fixtures/snapshot-keys.json"), "utf8")) as KeyCase[];

describe("snapshotKey matches the cli's snapshot writer", () => {
  it.each(cases.map((c) => [c.key, c] as const))("%s", (_key, c) => {
    const params = c.params ? Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, v === null ? undefined : v])) : undefined;
    expect(snapshotKey(c.path, params)).toBe(c.key);
  });
});
