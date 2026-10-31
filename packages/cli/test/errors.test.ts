import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runInit } from "../src/commands/init.js";
import { CodeloomError, dataError, formatError } from "../src/errors.js";
import { indexRepo } from "../src/indexer/index-repo.js";
import { makeRepo } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codeloom-err-"));

describe("clear errors", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("runInit on a missing folder", () => {
    const missing = join(tmp(), "nope");
    expect(() => runInit(missing)).toThrow(CodeloomError);
    expect(() => runInit(missing)).toThrow(`Folder not found: ${missing}`);
  });

  it("indexRepo on a missing repo folder names the repo, the path and codeloom init", async () => {
    const missing = join(tmp(), "api");
    const err = await indexRepo(missing, "api").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeloomError);
    expect((err as Error).message).toMatch(/"api"/);
    expect((err as Error).message).toContain(missing);
    expect((err as Error).message).toContain("codeloom init");
  });

  it("indexRepo on a folder that is not a git repo", async () => {
    const dir = tmp();
    const err = await indexRepo(dir, "web").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeloomError);
    expect((err as Error).message).toMatch(/"web".*not a git repo/);
    expect((err as Error).message).toContain("codeloom init");
  });

  it("runIndex with a workspace entry whose folder is gone", async () => {
    const root = tmp();
    makeRepo({ "a.ts": "" }, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "ws", repos: [{ id: "api", path: "api" }, { id: "gone", path: "gone" }], links: [],
    }));
    await expect(runIndex(root)).rejects.toThrow(/"gone"/);
    await expect(runIndex(root)).rejects.toBeInstanceOf(CodeloomError);
  });

  it("git missing from PATH", async () => {
    const repo = makeRepo({ "a.ts": "" });
    process.env.PATH = tmp();
    await expect(indexRepo(repo, "svc")).rejects.toThrow(/git was not found on PATH/);
    await expect(indexRepo(repo, "svc")).rejects.toBeInstanceOf(CodeloomError);
  });
});

describe("formatError", () => {
  it("prints a CodeloomError message as is", () => {
    expect(formatError(new CodeloomError("Folder not found: /x"), false)).toBe("Folder not found: /x");
  });

  it("wraps unexpected errors without a stack trace", () => {
    const text = formatError(new TypeError("boom"), false);
    expect(text).toBe("codeloom hit an unexpected error: boom\nPlease report it with the command you ran.");
  });

  it("keeps the stack when debugging", () => {
    const err = new TypeError("boom");
    expect(formatError(err, true)).toContain(err.stack!);
  });
});

describe("CodeloomError", () => {
  it("defaults to exit code 1", () => {
    const err = new CodeloomError("boom");
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("CodeloomError");
  });

  it("accepts an explicit exit code", () => {
    expect(new CodeloomError("boom", { exitCode: 2 }).exitCode).toBe(2);
  });
});

describe("dataError", () => {
  it("builds a CodeloomError with exit code 2", () => {
    const err = dataError("bad data");
    expect(err).toBeInstanceOf(CodeloomError);
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe("bad data");
  });
});

describe("formatError", () => {
  it("prints a CodeloomError's message as is", () => {
    expect(formatError(new CodeloomError("nice message"), false)).toBe("nice message");
  });

  it("prints a CodeloomError's message as is even with debug on", () => {
    expect(formatError(new CodeloomError("nice message"), true)).toBe("nice message");
  });

  it("wraps an unexpected error without a stack by default", () => {
    const text = formatError(new Error("oops"), false);
    expect(text).toBe("codeloom hit an unexpected error: oops\nPlease report it with the command you ran.");
  });

  it("includes the stack when debugging", () => {
    const err = new Error("oops");
    const text = formatError(err, true);
    expect(text.startsWith("codeloom hit an unexpected error: oops\nPlease report it with the command you ran.\n\n")).toBe(true);
    expect(text).toContain(err.stack);
  });

  it("stringifies a non-Error throw", () => {
    expect(formatError("plain string", false)).toBe(
      "codeloom hit an unexpected error: plain string\nPlease report it with the command you ran.",
    );
  });
});
