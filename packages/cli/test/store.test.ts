import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJsonAtomic } from "../src/store/json.js";
import { RepoConfigSchema, defaultRepoConfig } from "../src/store/schemas.js";
import { CodeloomError } from "../src/errors.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codeloom-store-"));

describe("store", () => {
  it("returns null for a missing file", () => {
    expect(readJson(join(tmp(), "nope.json"), RepoConfigSchema)).toBeNull();
  });

  it("round-trips a valid file and leaves no temp files", () => {
    const dir = tmp();
    const file = join(dir, "sub", "config.json");
    writeJsonAtomic(file, defaultRepoConfig());
    expect(readJson(file, RepoConfigSchema)).toEqual({ version: 1, autoUpdate: true, ignore: [] });
    expect(readdirSync(join(dir, "sub"))).toEqual(["config.json"]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("explains a file with the wrong shape", () => {
    const file = join(tmp(), "config.json");
    writeFileSync(file, JSON.stringify({ version: 1, autoUpdate: "yes", ignore: [] }));
    expect(() => readJson(file, RepoConfigSchema)).toThrow(CodeloomError);
    expect(() => readJson(file, RepoConfigSchema)).toThrow(/autoUpdate/);
  });

  it("explains a file that is not JSON", () => {
    const file = join(tmp(), "config.json");
    writeFileSync(file, "{ nope");
    expect(() => readJson(file, RepoConfigSchema)).toThrow(/not valid JSON/);
  });
});
