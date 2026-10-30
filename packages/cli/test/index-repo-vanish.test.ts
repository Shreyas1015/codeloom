import { describe, expect, it, vi } from "vitest";
import { indexRepo } from "../src/indexer/index-repo.js";
import { makeRepo } from "./helpers.js";

// Simulate a file that git listed but that is deleted before codeloom reads it.
vi.mock("../src/workspace/files.js", async (orig) => {
  const actual = await orig<typeof import("../src/workspace/files.js")>();
  return { listFiles: (...args: Parameters<typeof actual.listFiles>) => [...actual.listFiles(...args), "src/ghost.ts"].sort() };
});

describe("indexRepo with a file deleted mid-run", () => {
  it("skips the vanished file instead of failing", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;" });
    const res = await indexRepo(repo, "svc");
    expect(res.stats.parsed).toBe(1);
    expect(res.stats.skipped).toEqual([{ file: "src/ghost.ts", reason: expect.stringMatching(/ENOENT|no such file/) }]);
  });
});
