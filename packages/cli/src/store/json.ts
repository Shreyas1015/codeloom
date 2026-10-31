import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { dataError } from "../errors.js";

/** Read and validate a JSON file. Missing file → null. Bad JSON or bad shape → CodeloomError (exit 2). */
export function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw dataError(
      `${path} is not valid JSON. Delete it and run "codeloom index" again to rebuild it.`,
    );
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw dataError(
      `${path} has an unexpected shape:\n${lines.join("\n")}\nFix the file by hand, or delete it and run "codeloom index" again.`,
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
