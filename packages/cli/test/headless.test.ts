import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeloomServeCommand, findClaude, type HeadlessRun, runClaudeHeadless, type SpawnLike } from "../src/claude/headless.js";

/** A fake `child_process.spawn`: records the call and emits stdout chunks then a close event, without
 * starting any real process. */
function fakeSpawn(exitCode: number, stdoutChunks: string[]): { spawnImpl: SpawnLike; calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnImpl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as unknown as ReturnType<SpawnLike>;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    queueMicrotask(() => {
      for (const chunk of stdoutChunks) (child as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(chunk));
      child.emit("close", exitCode);
    });
    return child;
  }) as SpawnLike;
  return { spawnImpl, calls };
}

describe("runClaudeHeadless", () => {
  it("runs claude -p <prompt> --allowedTools ...tools in the given cwd, with stdin closed", async () => {
    const { spawnImpl, calls } = fakeSpawn(0, []);
    const run: HeadlessRun = { prompt: "do the thing", allowedTools: ["mcp__codeloom__save_journeys", "mcp__codeloom__list_chains"], cwd: "/tmp/my-ws" };

    await runClaudeHeadless(run, spawnImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.args).toEqual([
      "-p",
      "do the thing",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { codeloom: codeloomServeCommand() } }),
      "--setting-sources",
      "user",
      "--disable-slash-commands",
      "--allowedTools",
      "mcp__codeloom__save_journeys",
      "mcp__codeloom__list_chains",
    ]);
    expect(calls[0]!.options.cwd).toBe("/tmp/my-ws");
    expect((calls[0]!.options.stdio as string[])[0]).toBe("ignore");
  });

  it("pins codeloom's MCP server to the given command (default: this codeloom's own serve)", async () => {
    const { spawnImpl, calls } = fakeSpawn(0, []);
    await runClaudeHeadless({ prompt: "x", allowedTools: ["mcp__codeloom__a"], cwd: "/tmp", mcpServer: { command: "/opt/codeloom/bin.js", args: ["serve"] } }, spawnImpl);
    const at = calls[0]!.args.indexOf("--mcp-config");
    expect(JSON.parse(calls[0]!.args[at + 1]!)).toEqual({ mcpServers: { codeloom: { command: "/opt/codeloom/bin.js", args: ["serve"] } } });
    const def = codeloomServeCommand();
    expect(def.args.at(-1)).toBe("serve");
  });

  it("runs the given claudeBin instead of plain 'claude' when set", async () => {
    const { spawnImpl, calls } = fakeSpawn(0, []);
    await runClaudeHeadless({ prompt: "x", allowedTools: [], cwd: "/tmp", claudeBin: "/opt/claude/claude" }, spawnImpl);
    expect(calls[0]!.command).toBe("/opt/claude/claude");
  });

  it("resolves with stdout joined into output and the process's exit code", async () => {
    const { spawnImpl } = fakeSpawn(0, ["hello ", "world\n"]);
    const result = await runClaudeHeadless({ prompt: "x", allowedTools: [], cwd: "/tmp" }, spawnImpl);
    expect(result).toEqual({ exitCode: 0, output: "hello world\n" });
  });

  it("resolves with a non-zero exit code when claude fails", async () => {
    const { spawnImpl } = fakeSpawn(1, ["oops"]);
    const result = await runClaudeHeadless({ prompt: "x", allowedTools: [], cwd: "/tmp" }, spawnImpl);
    expect(result).toEqual({ exitCode: 1, output: "oops" });
  });
});

describe("findClaude", () => {
  it("returns null when claude is not on any PATH folder", () => {
    const empty = mkdtempSync(join(tmpdir(), "codeloom-noclaude-"));
    expect(findClaude(empty)).toBeNull();
  });

  it("returns the absolute path of an executable claude on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-claude-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(findClaude(dir)).toBe(bin);
  });

  it("skips a non-executable file named claude", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeloom-claude-notexec-"));
    writeFileSync(join(dir, "claude"), "not executable");
    expect(findClaude(dir)).toBeNull();
  });

  it("finds claude in the second PATH entry when the first doesn't have it", () => {
    const empty = mkdtempSync(join(tmpdir(), "codeloom-claude-empty-"));
    const dir = mkdtempSync(join(tmpdir(), "codeloom-claude-second-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(findClaude(`${empty}:${dir}`)).toBe(bin);
  });
});
