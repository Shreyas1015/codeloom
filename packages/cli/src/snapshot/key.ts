// Names one API answer's data file inside a hosted PR snapshot (spec §3). Byte-for-byte mirrored in
// packages/dashboard/src/api/static.ts (a later task), so the dashboard can read the same files back
// with no server: `apiGet(path, params)` there computes this same key and fetches `data/<key>.json`.

import { createHash } from "node:crypto";
import { compare } from "../util.js";

/** Keys longer than this are shortened; see below. */
const MAX_KEY_LENGTH = 120;
/** How many characters of the (made-safe) key are kept before the "-<hash>" suffix. */
const KEPT_PREFIX_LENGTH = 80;
/** Hex characters of the sha256 digest kept in a shortened key. */
const HASH_LENGTH = 16;
/** The only characters a data file name may hold: every static host (GitHub Pages, `python3 -m
 * http.server`, ...) serves these as-is, never percent-decoding them into some other name. Shared with
 * snapshot/validate.ts's FILE_NAME_RE (final review C1/I1). */
const SAFE_KEY_RE = /^[A-Za-z0-9._~@=&-]*$/;
const UNSAFE_CHAR_RE = /[^A-Za-z0-9._~@=&-]/g;

/** One data file's name for `path` + `params` (no leading "data/", no ".json"):
 * - the leading "/api" (and the "/" after it) is dropped, then every remaining "/" becomes "~"
 *   (so "/api/journeys/j_1" -> "journeys~j_1", and a path segment that itself holds a "/" — a node
 *   ref embedding a file path — gets the same treatment);
 * - `params` entries are sorted by name, `undefined` dropped, and each value run through
 *   `encodeURIComponent` (param names are not encoded: they are always plain identifiers), joined
 *   with "&" and appended after "@" (e.g. `("/api/graph", {repo:"api", dir:"app"})` -> "graph@dir=app&repo=api");
 * - that full key is kept as-is only when it is entirely [A-Za-z0-9._~@=&-] and at most 120 characters.
 *   Otherwise (a "%" escape, a ":" of a node ref, a "[id]"/"(group)"/"+page"/"$id" path, a space,
 *   non-ASCII, or just too long) it becomes: every other character replaced by "_", cut to 80 characters,
 *   "-", and the first 16 hex characters of the FULL key's own sha256 — always a plain, short, unique
 *   name a static host serves byte-for-byte (final review C1/I1/I2). */
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
  if (SAFE_KEY_RE.test(full) && full.length <= MAX_KEY_LENGTH) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, HASH_LENGTH);
  return `${full.replace(UNSAFE_CHAR_RE, "_").slice(0, KEPT_PREFIX_LENGTH)}-${hash}`;
}
