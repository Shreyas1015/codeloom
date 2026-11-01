#!/usr/bin/env node
import { CommanderError } from "commander";
import { buildProgram, exitCodeFor } from "./cli.js";
import { formatError } from "./errors.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // Commander has already printed its own usage message (or the help/version text).
  if (!(err instanceof CommanderError)) console.error(formatError(err, process.env.CODELOOM_DEBUG === "1"));
  process.exit(exitCodeFor(err));
}
