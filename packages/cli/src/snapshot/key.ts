// Names one API answer's data file inside a hosted PR snapshot (spec §3). Byte-for-byte mirrored in
// packages/dashboard/src/api/static.ts (a later task), so the dashboard can read the same files back
// with no server: `apiGet(path, params)` there computes this same key and fetches `data/<key>.json`.

import { createHash } from "node:crypto";
import { compare } from "../util.js";

/** Keys longer than this (including the hash suffix) are shortened; see below. */
const MAX_KEY_LENGTH = 120;
/** How many characters of the over-long key are kept before the "-<hash>" suffix. */
const KEPT_PREFIX_LENGTH = 80;
/** Hex characters of the sha256 digest kept in a shortened key. */
const HASH_LENGTH = 16;

/** One data file's name for `path` + `params` (no leading "data/", no ".json"):
 * - the leading "/api" (and the "/" after it) is dropped, then every remaining "/" becomes "~"
 *   (so "/api/journeys/j_1" -> "journeys~j_1", and a path segment that itself holds a "/" — a node
 *   ref embedding a file path — gets the same treatment);
 * - `params` entries are sorted by name, `undefined` dropped, and each value run through
 *   `encodeURIComponent` (param names are not encoded: they are always plain identifiers), joined
 *   with "&" and appended after "@" (e.g. `("/api/graph", {repo:"api", dir:"app/services"})` ->
 *   "graph@dir=app%2Fservices&repo=api");
 * - a key over 120 characters is shortened to its first 80 characters, "-", and the first 16 hex
 *   characters of its own sha256 — still unique enough, and short enough for every filesystem. */
export function snapshotKey(path: string, params?: Record<string, string | number | undefined>): string {
  const base = path.replace(/^\/api\/?/, "").replace(/\//g, "~");
  const query = params === undefined
    ? ""
    : Object.entries(params)
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .sort(([a], [b]) => compare(a, b))
        .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
        .join("&");
  const full = query === "" ? base : `${base}@${query}`;
  if (full.length <= MAX_KEY_LENGTH) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, HASH_LENGTH);
  return `${full.slice(0, KEPT_PREFIX_LENGTH)}-${hash}`;
}
