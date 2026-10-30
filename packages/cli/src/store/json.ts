import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { CodeloomError } from "../errors.js";

/** Read and validate a JSON file. Missing file → null. Bad JSON or bad shape → CodeloomError. */
export function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CodeloomError(
      `${path} is not valid JSON. Delete it and run "codeloom index" again to rebuild it.`,
    );
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new CodeloomError(
      `${path} has an unexpected shape:\n${lines.join("\n")}\nFix the file by hand, or delete it and run "codeloom index" again.`,
    );
  }
  return result.data;
}

/** Write JSON so readers never see a half-written file: write a temp file, then rename. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}
