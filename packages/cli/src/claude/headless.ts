import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { codeloomBin } from "../commands/init.js";

/** No AI inside codeloom: this module only ever runs `claude` when runClaudeHeadless is called, and the
 * caller (the init wizard, later the `check-pr` headless run) is the one that must have already asked the
 * user. Nothing here starts a process on import or by itself. */

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
}

/** The absolute path of the `claude` CLI on PATH, or null when it is not there. Read-only: never spawns
 * anything. `pathEnv` defaults to this process's PATH; tests pass their own to avoid depending on the
 * machine that runs them. */
export function findClaude(pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "claude");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface HeadlessRun {
  /** The full prompt text, passed as `-p <prompt>`. */
  prompt: string;
  /** MCP tool names Claude may call (e.g. "mcp__codeloom__save_journeys"), passed as `--allowedTools`. */
  allowedTools: string[];
  /** Working directory to run `claude` in, so it picks up that folder's .mcp.json. */
  cwd: string;
  /** Absolute path of the `claude` binary (normally findClaude()'s result). Defaults to "claude" on PATH. */
  claudeBin?: string;
  /** The codeloom MCP server Claude may use — the only one (`--strict-mcp-config`). Defaults to this very
   * codeloom's own `serve` (codeloomServeCommand), never whatever a checkout's .mcp.json pins. */
  mcpServer?: McpServerCommand;
}

export interface McpServerCommand {
  command: string;
  args: string[];
}

/** How to start this running codeloom's own MCP server: its bin when it is executable, else node + the script
 * it was started from, else `codeloom` on PATH. Always ends in "serve"; the server reads its cwd. */
export function codeloomServeCommand(argv1: string | undefined = process.argv[1]): McpServerCommand {
  const bin = codeloomBin(argv1);
  if (bin !== undefined) return { command: bin, args: ["serve"] };
  if (argv1) return { command: process.execPath, args: [resolve(argv1), "serve"] };
  return { command: "codeloom", args: ["serve"] };
}

/** The isolation every headless run gets: no built-in tools (Read, Bash, …), no permission prompts (anything
 * not pre-approved is denied), only codeloom's own MCP server, only the user's settings (never the checkout's
 * project/local settings, which a pull request controls), no slash commands; then the pre-approved tools. */
export function headlessArgs(run: HeadlessRun): string[] {
  const mcp = { mcpServers: { codeloom: run.mcpServer ?? codeloomServeCommand() } };
  return [
    "-p",
    run.prompt,
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcp),
    "--setting-sources",
    "user",
    "--disable-slash-commands",
    "--allowedTools",
    ...run.allowedTools,
  ];
}

/** A `child_process.spawn`-shaped function, so tests can fake the process instead of starting a real one. */
export type SpawnLike = typeof nodeSpawn;

/** Runs `claude -p <prompt>` isolated (headlessArgs: no built-in tools, only codeloom's own MCP server, user
 * settings only, only `allowedTools` pre-approved) in `run.cwd` with stdin closed (claude never waits on input it
 * will not get), and resolves with its exit code and stdout text. This function only executes the process: the
 * caller must already have the user's yes (or --yes/--check). */
export function runClaudeHeadless(run: HeadlessRun, spawnImpl: SpawnLike = nodeSpawn): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const bin = run.claudeBin ?? "claude";
    const args = headlessArgs(run);
    const child: ChildProcess = spawnImpl(bin, args, { cwd: run.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (err) => reject(err));
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 0, output }));
  });
}
