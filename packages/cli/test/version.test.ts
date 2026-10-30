import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION as CLI_VERSION } from "../src/cli.js";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("is read from package.json, and the CLI uses the same value", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(CLI_VERSION).toBe(VERSION);
  });
});
