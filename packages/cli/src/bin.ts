#!/usr/bin/env node
import { buildProgram } from "./cli.js";
import { formatError } from "./errors.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  console.error(formatError(err, process.env.CODELOOM_DEBUG === "1"));
  process.exit(1);
}
