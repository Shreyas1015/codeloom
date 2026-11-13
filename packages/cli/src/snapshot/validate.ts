// The publish step's trust boundary (design spec §5): an untrusted build artifact's data/ folder is
// validated before anything else about it is believed. Every rejection throws a CodeloomError whose
// message is a FIXED string literal, never built from anything read out of the artifact (a file name,
// manifest.head, manifest.version, review.json's own fields, ...) — all of that is attacker-controlled
// text that would otherwise land, unescaped, in the PR description or comment the reason is rendered
// into (security review I1a). CI's own run log still gets the full exception detail some other way
// (e.g. GitHub Actions' own step failure output) — just never the text handed back to the caller here.

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CodeloomError } from "../errors.js";
import { manifestFieldsSchema, reviewSchema } from "../review/schema.js";
import type { SnapshotManifest } from "./write.js";

/** Per-file cap (design spec §5): "a file over 5 MB" is refused outright, independent of `maxBytes`. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** manifest.json's `files` entries: the snapshotKey charset (letters, digits, `.`, `_`, `~`, `-`, `@`,
 * `%`, `=`, `&`), always ending in literal ".json". This alone rules out "..", "." and anything
 * containing "/" or "\" (none of those characters are in the charset, and both "." and ".." are too
 * short to also end in the required ".json" suffix) — security review C1 (path traversal via a listed
 * ".." or "../evil.html" entry, which `join(dataDir, entry)` would otherwise resolve outside `dataDir`). */
const FILE_NAME_RE = /^[A-Za-z0-9._~@%=&-]+\.json$/;

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
 * `dataDir` itself must not be a symlink; every entry inside it must be a plain, non-symlinked, flat
 * "*.json" file, each at most 5 MB and the whole folder at most `maxBytes`, each file valid JSON;
 * `manifest.json` must have version 1 and `head` equal to `expectedHead`; `manifest.files` must be an
 * array of safely-named strings (FILE_NAME_RE) with no duplicates that is EXACTLY the set of files on
 * disk (every on-disk file listed, and every listed file on disk — never a listed-but-missing entry, C1);
 * `review.json` must be present and match review/schema.ts's shape (I1b — a malformed review.json is
 * refused here, before anything is ever written, rather than crashing after data/assets have already
 * been copied). Returns the parsed, now-trusted manifest on success; throws CodeloomError (never writes
 * anything) on the first problem found. */
export function validateSnapshotData(dataDir: string, opts: ValidateOptions): SnapshotManifest {
  let dirStat;
  try {
    dirStat = lstatSync(dataDir);
  } catch {
    refuse("the snapshot data folder does not exist.");
  }
  // lstat (never followed) — m1: a symlinked data/ dir itself must be refused, not just the symlinks
  // inside it (the readdirSync below only ever sees what's really inside dataDir's own real location,
  // but dataDir itself pointing somewhere else entirely is the same kind of trust problem).
  if (dirStat.isSymbolicLink()) refuse("the snapshot data folder must not be a symlink.");
  if (!dirStat.isDirectory()) refuse("the snapshot data folder does not exist.");

  let entries;
  try {
    entries = readdirSync(dataDir, { withFileTypes: true });
  } catch {
    refuse("the snapshot data folder could not be read.");
  }

  const names: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const full = join(dataDir, entry.name);
    // isSymbolicLink() on a readdir dirent reflects the entry itself, not what it resolves to — a
    // symlink is refused before anything follows it, whatever it (or a chain of them) points at.
    if (entry.isSymbolicLink()) refuse("a symlink is never trusted inside a snapshot artifact.");
    if (!entry.isFile()) refuse("the snapshot data folder must be flat (every entry must be a plain file).");
    if (!entry.name.endsWith(".json")) refuse("every entry in the snapshot data must be a .json file.");

    const size = statSync(full).size;
    if (size > MAX_FILE_BYTES) refuse("a file in the snapshot data is over the 5 MB per-file cap.");
    total += size;
    names.push(entry.name);
  }

  if (total > opts.maxBytes) refuse("the snapshot data is over the size cap.");

  const parsed = new Map<string, unknown>();
  for (const name of names) {
    const text = readFileSync(join(dataDir, name), "utf8");
    try {
      parsed.set(name, JSON.parse(text));
    } catch {
      refuse("a file in the snapshot data is not valid JSON.");
    }
  }

  if (!parsed.has("manifest.json")) refuse("manifest.json is missing.");
  const manifest = parsed.get("manifest.json") as Partial<SnapshotManifest> | null;
  if (manifest === null || typeof manifest !== "object") refuse("manifest.json is not a JSON object.");
  if (manifest.version !== 1) refuse("manifest.json has an unsupported version.");
  // Never echo manifest.head (or anything else read from the artifact) back in the refusal — I1a.
  if (typeof manifest.head !== "string" || manifest.head !== opts.expectedHead) refuse("manifest.json's head does not match this PR's commit.");
  if (!Array.isArray(manifest.files)) refuse("manifest.json's files is not an array.");

  // C1: every listed entry must be a safely-named, flat, unique string, and the listed set must be
  // EXACTLY the on-disk set (not just disk ⊆ listed) — a listed-but-missing entry (review.json deleted
  // from disk but left in the list) or a non-string entry must refuse here, not crash downstream.
  const rawFiles = manifest.files as unknown[];
  const listedFiles: string[] = [];
  const seen = new Set<string>();
  for (const f of rawFiles) {
    if (typeof f !== "string") refuse("manifest.json's files contains a non-string entry.");
    if (!FILE_NAME_RE.test(f)) refuse("manifest.json's files contains a badly-named entry.");
    if (seen.has(f)) refuse("manifest.json's files contains a duplicate entry.");
    seen.add(f);
    listedFiles.push(f);
  }

  const onDisk = new Set(names);
  for (const name of names) if (!seen.has(name)) refuse("a file is present but not listed in manifest.json's files.");
  for (const f of listedFiles) if (!onDisk.has(f)) refuse("manifest.json lists a file that is not present in the snapshot data.");

  if (!onDisk.has("review.json")) refuse("review.json is missing.");
  const reviewResult = reviewSchema.safeParse(parsed.get("review.json"));
  if (!reviewResult.success) refuse("review.json does not match the expected shape.");

  // I1'b: manifest.json's own other fields (never checked before) — a malformed `omitted` (not an
  // array of strings; stands in for the unbounded-depth attack that stack-overflowed JSON.stringify
  // downstream), a non-finite `bytes`, or a malformed `tooLarge` (null, a non-numeric bytes/max, ...)
  // is refused here, before anything downstream ever trusts that shape.
  const extra = manifestFieldsSchema.safeParse(manifest);
  if (!extra.success) refuse("manifest.json does not match the expected shape.");

  // Built field by field from validated pieces only — never a raw spread of the parsed artifact value
  // (I1'b): an unknown/extra key in the artifact's manifest.json can never survive into the trusted
  // return value this way, whatever it is.
  const result: SnapshotManifest = {
    version: 1,
    codeloom: extra.data.codeloom,
    head: manifest.head,
    base: extra.data.base,
    builtAt: extra.data.builtAt,
    files: listedFiles,
    omitted: extra.data.omitted,
    bytes: extra.data.bytes,
    ...(extra.data.tooLarge !== undefined ? { tooLarge: extra.data.tooLarge } : {}),
  };
  return result;
}
