import { Command, CommanderError } from "commander";
import { runCheck } from "./commands/check.js";
import { CodeloomError } from "./errors.js";
import { formatDoctor, runDoctor } from "./commands/doctor.js";
import { formatInit, runInit } from "./commands/init.js";
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
      console.log(formatInit(runInit(dir)));
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
    .option("--traces", "compare the map with runtime traces from the workspace's trace source")
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
      const report = runDoctor(process.cwd(), { fix: opts.fix });
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      process.exitCode = report.summary.error > 0 ? 1 : 0;
    });

  program
    .command("serve")
    .description("Run the codeloom MCP server on stdio, for Claude or any MCP agent")
    .action(async () => {
      await runServeCommand(process.cwd());
    });

  return program;
}

/** The process exit code for an error thrown out of the program. Commander's own exits (help, version)
 * keep their 0; every other commander error is a usage error (unknown option or command, missing option
 * value): 2. A CodeloomError carries its own code; anything else is unexpected: 1. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
  return err instanceof CodeloomError ? err.exitCode : 1;
}
