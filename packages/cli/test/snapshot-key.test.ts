import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snapshotKey } from "../src/snapshot/key.js";

/** Golden cases shared with the dashboard's own snapshotKey (byte-for-byte mirrored in
 * packages/dashboard/src/api/static.ts, a later task). `null` in a case's params stands for a param
 * that is `undefined` at the call site (plain JSON cannot hold `undefined`) — it must be dropped, not
 * stringified as "null". */
interface GoldenCase {
  path: string;
  params?: Record<string, string | number | null>;
  key: string;
}

const FIXTURE = fileURLToPath(new URL("../../../fixtures/snapshot-keys.json", import.meta.url));
const cases: GoldenCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("snapshotKey", () => {
  it(`matches every golden case in ${FIXTURE}`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const c of cases) {
      const params = c.params
        ? (Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, v === null ? undefined : v])) as Record<
            string,
            string | number | undefined
          >)
        : undefined;
      expect(snapshotKey(c.path, params), `${c.path} ${JSON.stringify(c.params)}`).toBe(c.key);
    }
  });
});
