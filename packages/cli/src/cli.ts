import { Command } from "commander";

export const VERSION = "0.0.0";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("codeloom")
    .description("Map a codebase into user journeys, for you and your AI agent.")
    .version(VERSION);
  return program;
}
