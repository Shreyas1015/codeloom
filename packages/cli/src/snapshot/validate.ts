// The publish step's trust boundary (design spec §5): an untrusted build artifact's data/ folder is
// validated before anything else about it is believed. Every rejection throws a CodeloomError whose
// message is safe to show on the PR ("codeloom review map refused: <reason>") — it never repeats
// attacker-controlled bytes, only the offending file NAME, which GitHub Actions already lets through to
// its own run logs regardless.

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CodeloomError } from "../errors.js";
import type { SnapshotManifest } from "./write.js";

/** Per-file cap (design spec §5): "a file over 5 MB" is refused outright, independent of `maxBytes`. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ValidateOptions {
  /** Total cap across every file in `dataDir` (the same `--max-size` the writer used). */
  maxBytes: number;
  /** The event's own head SHA (never the artifact's own say-so): must equal `manifest.head`. */
  expectedHead: string;
}

function refuse(reason: string): never {
  throw new CodeloomError(reason);
}

/** Validates an untrusted `data/` folder (the publish step's only trusted read of the build artifact):
 * every entry must be a plain, non-symlinked, flat "*.json" file, each at most 5 MB and the whole folder
 * at most `maxBytes`, each file valid JSON, `manifest.json` must have version 1 and `head` equal to
 * `expectedHead`, and every file present must be named in `manifest.files`. Returns the parsed, now-
 * trusted manifest on success; throws CodeloomError (never writes anything) on the first problem found. */
export function validateSnapshotData(dataDir: string, opts: ValidateOptions): SnapshotManifest {
  let entries;
  try {
    entries = readdirSync(dataDir, { withFileTypes: true });
  } catch {
    refuse(`${dataDir} does not exist or is not a folder.`);
  }

  const names: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const full = join(dataDir, entry.name);
    // isSymbolicLink() on a readdir dirent reflects the entry itself, not what it resolves to — a
    // symlink is refused before anything follows it, whatever it (or a chain of them) points at.
    if (entry.isSymbolicLink()) refuse(`${entry.name} is a symlink, which is never trusted in a snapshot artifact.`);
    if (!entry.isFile()) refuse(`${entry.name} is not a plain file (the snapshot data folder must be flat).`);
    if (!entry.name.endsWith(".json")) refuse(`${entry.name} is not a .json file.`);

    const size = statSync(full).size;
    if (size > MAX_FILE_BYTES) refuse(`${entry.name} is ${size} bytes, over the 5 MB per-file cap.`);
    total += size;
    names.push(entry.name);
  }

  if (total > opts.maxBytes) refuse(`the snapshot data is ${total} bytes, over the ${opts.maxBytes} byte cap.`);

  const parsed = new Map<string, unknown>();
  for (const name of names) {
    const text = readFileSync(join(dataDir, name), "utf8");
    try {
      parsed.set(name, JSON.parse(text));
    } catch {
      refuse(`${name} is not valid JSON.`);
    }
  }

  if (!parsed.has("manifest.json")) refuse("manifest.json is missing.");
  const manifest = parsed.get("manifest.json") as Partial<SnapshotManifest> | null;
  if (manifest === null || typeof manifest !== "object") refuse("manifest.json is not a JSON object.");
  if (manifest.version !== 1) refuse(`manifest.json has version ${JSON.stringify(manifest.version)}, expected 1.`);
  if (manifest.head !== opts.expectedHead) refuse(`manifest.json's head (${String(manifest.head)}) does not match the expected head (${opts.expectedHead}).`);
  if (!Array.isArray(manifest.files)) refuse("manifest.json's files is not an array.");

  const listed = new Set(manifest.files as string[]);
  for (const name of names) {
    if (!listed.has(name)) refuse(`${name} is present but not listed in manifest.files.`);
  }

  return manifest as SnapshotManifest;
}
