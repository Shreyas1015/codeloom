import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { dataError } from "../errors.js";

export interface ReadJsonOptions {
  /** The file is written by a person or an agent, never rebuilt by codeloom (journeys.json): a bad file
   * must be fixed by hand, so the error never suggests deleting it and re-indexing. */
  handWritten?: boolean;
}

/** The last line of every readJson error: where to look for a full health check. */
export const DOCTOR_HINT = `Run "codeloom doctor" for a full check.`;

/** Read and validate a JSON file. Missing file → null. Bad JSON or bad shape → CodeloomError (exit 2),
 * whose message ends with DOCTOR_HINT on its own line. */
export function readJson<T>(path: string, schema: z.ZodType<T>, opts: ReadJsonOptions = {}): T | null {
  if (!existsSync(path)) return null;
  const handFix = `Fix it by hand: codeloom never rebuilds this file, and it holds work that cannot be regenerated.`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw dataError((opts.handWritten
      ? `${path} is not valid JSON. ${handFix}`
      : `${path} is not valid JSON. Delete it and run "codeloom index" again to rebuild it.`) + `\n${DOCTOR_HINT}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw dataError(
      `${path} has an unexpected shape:\n${lines.join("\n")}\n` + (opts.handWritten
        ? handFix
        : `Fix the file by hand, or delete it and run "codeloom index" again.`) + `\n${DOCTOR_HINT}`,
    );
  }
  return result.data;
}

function serialize(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

/** Write JSON so readers never see a half-written file: write a temp file, then rename. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, serialize(data));
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Like writeJsonAtomic, but leaves the file untouched when its content would not change. Returns whether it wrote. */
export function writeJsonIfChanged(path: string, data: unknown): boolean {
  const text = serialize(data);
  try {
    if (readFileSync(path, "utf8") === text) return false;
  } catch {
    // Missing or unreadable: write it.
  }
  writeJsonAtomic(path, data);
  return true;
}
