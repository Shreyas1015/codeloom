import { Command, CommanderError } from "commander";
import { runCheck } from "./commands/check.js";
import { runDashboard } from "./commands/dashboard.js";
import { CodeloomError, dataError } from "./errors.js";
import { formatDoctor, runDoctor } from "./commands/doctor.js";
import { codeloomBin, formatInit, runInit } from "./commands/init.js";
import { formatIndexSummary, runIndex } from "./commands/index-cmd.js";
import { runServeCommand } from "./commands/serve.js";
import { VERSION } from "./version.js";

export { VERSION };

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("codeloom")
    .description("Map a codebase into user journeys, for you and your AI agent.")
    .version(VERSION)
    // Throw instead of exiting, so bin.ts maps usage errors to exit 2 (subcommands inherit this).
    .exitOverride();

  program
    .command("init")
    .description("Set up codeloom in a repo, or in a folder of repos (a workspace)")
    .argument("[dir]", "folder to set up", ".")
    .action((dir: string) => {
      console.log(formatInit(runInit(dir, { bin: codeloomBin() })));
    });

  program
    .command("index")
    .description("Index every repo in this workspace (only changed files are re-parsed)")
    .option("--quiet", "print nothing on success")
    .action(async (opts: { quiet?: boolean }) => {
      const result = await runIndex(process.cwd());
      if (!opts.quiet) console.log(formatIndexSummary(result));
    });

  program
    .command("check")
    .description("Report how complete the journey map is")
    .option("--json", "print the report as JSON")
    .option("--fail-under <percent>", "exit 1 when the complete percentage is below this")
    .option(
      "--traces",
      'compare the map with runtime traces from "traces" in codeloom.workspace.json (an otlp-file path or a Tempo url)',
    )
    .action(async (opts: { json?: boolean; failUnder?: string; traces?: boolean }) => {
      const { output, exitCode } = await runCheck(process.cwd(), opts);
      console.log(output);
      process.exitCode = exitCode;
    });

  program
    .command("doctor")
    .description("Check and repair data files, hooks, the .gitignore line and the MCP entry")
    .option("--fix", "repair what is safe to repair (never hand-written or committed map files)")
    .option("--json", "print the report as JSON")
    .action((opts: { fix?: boolean; json?: boolean }) => {
      const report = runDoctor(process.cwd(), { fix: opts.fix, bin: codeloomBin() });
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      process.exitCode = report.summary.error > 0 ? 1 : 0;
    });

  program
    .command("serve")
    .description("Run the codeloom MCP server on stdio, for Claude or any MCP agent")
    .action(async () => {
      await runServeCommand(process.cwd());
    });

  program
    .command("dashboard")
    .description("Open the codeloom dashboard (Home, Journey, Map) in your browser, served from 127.0.0.1")
    .option("--port <port>", "port to listen on (default: the first free one from 4747)")
    .option("--no-open", "print the URL but do not open a browser")
    .action(async (opts: { port?: string; open: boolean }) => {
      await runDashboard(process.cwd(), { port: parsePort(opts.port), open: opts.open });
    });

  return program;
}

/** --port: a whole number 0–65535 (0 = any free port), else a usage error (exit 2). */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n > 65535) throw dataError(`--port must be a whole number between 0 and 65535, got "${raw}".`);
  return n;
}

/** The process exit code for an error thrown out of the program. Commander's own exits (help, version)
 * keep their 0; every other commander error is a usage error (unknown option or command, missing option
 * value): 2. A CodeloomError carries its own code; anything else is unexpected: 1. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
  return err instanceof CodeloomError ? err.exitCode : 1;
}
