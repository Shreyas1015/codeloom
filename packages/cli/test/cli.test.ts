import { describe, expect, it } from "vitest";
import { buildProgram, VERSION } from "../src/cli.js";

describe("codeloom cli", () => {
  it("prints the version", async () => {
    let out = "";
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => { out += s; } });
    await expect(program.parseAsync(["node", "codeloom", "--version"])).rejects.toThrow();
    expect(out.trim()).toBe(VERSION);
  });

  it("registers the check command with --json and --fail-under options", () => {
    const program = buildProgram();
    const check = program.commands.find((c) => c.name() === "check")!;
    expect(check).toBeDefined();
    expect(check.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--json", "--fail-under"]));
  });
});
