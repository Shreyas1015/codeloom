import { Command } from "commander";
import { runCheck } from "./commands/check.js";
import { formatInit, runInit } from "./commands/init.js";
import { formatIndexSummary, runIndex } from "./commands/index-cmd.js";
import { VERSION } from "./version.js";

export { VERSION };

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("codeloom")
    .description("Map a codebase into user journeys, for you and your AI agent.")
    .version(VERSION);

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
    .action((opts: { json?: boolean; failUnder?: string }) => {
      const { output, exitCode } = runCheck(process.cwd(), opts);
      console.log(output);
      process.exitCode = exitCode;
    });

  return program;
}
