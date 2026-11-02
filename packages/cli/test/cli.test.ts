import { describe, expect, it } from "vitest";
import { buildProgram, exitCodeFor, VERSION } from "../src/cli.js";

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

describe("codeloom cli exit codes (final review item 2)", () => {
  async function codeFor(args: string[]): Promise<number> {
    const program = buildProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    try {
      await program.parseAsync(["node", "codeloom", ...args]);
      return 0;
    } catch (err) {
      return exitCodeFor(err);
    }
  }

  it("exits 2 on an unknown option", async () => {
    expect(await codeFor(["check", "--nope"])).toBe(2);
  });

  it("exits 2 when an option is missing its value", async () => {
    expect(await codeFor(["check", "--fail-under"])).toBe(2);
  });

  it("exits 2 on an unknown command", async () => {
    expect(await codeFor(["frobnicate"])).toBe(2);
  });

  it("exits 2 on a bad --fail-under value", async () => {
    expect(await codeFor(["check", "--fail-under", "abc"])).toBe(2);
  });

  it("keeps --help and --version at exit 0", async () => {
    expect(await codeFor(["--help"])).toBe(0);
    expect(await codeFor(["--version"])).toBe(0);
    expect(await codeFor(["check", "--help"])).toBe(0);
  });

  it("exits 1 on an unexpected (non-codeloom) error", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(1);
  });
});

describe("codeloom serve", () => {
  it("registers the serve command", () => {
    const serve = buildProgram().commands.find((c) => c.name() === "serve");
    expect(serve).toBeDefined();
  });
});
