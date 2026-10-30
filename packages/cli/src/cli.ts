import { Command } from "commander";
import { formatInit, runInit } from "./commands/init.js";
import { formatIndexSummary, runIndex } from "./commands/index-cmd.js";

export const VERSION = "0.0.0";

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

  return program;
}
