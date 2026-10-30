#!/usr/bin/env node
import { buildProgram } from "./cli.js";
import { CodeloomError } from "./errors.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  if (err instanceof CodeloomError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
