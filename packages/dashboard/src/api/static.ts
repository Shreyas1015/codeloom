/** Static snapshot mode: a read-only copy of the dashboard hosted on GitHub Pages for one pull request,
 * with no server behind it — `data/<key>.json` files sit beside `index.html` instead of `/api`. Detected
 * once at boot (`main.tsx`) from `data/manifest.json`; `apiGet` (client.ts) routes through `staticGet`
 * once `isSnapshot()` is true. `apiPost`, live events (`events.ts`) and search are off in this mode (the
 * snapshot never contains progress, events or search — review-maps-constraints.md). */

import { ApiError } from "./client";
import type { CodeResponse } from "./types";
import type { QueryParams } from "./client";

export interface SnapshotInfo {
  pr?: number;
  repoSlug?: string;
  head: string;
  base: string;
  builtAt: string;
  omitted: { mapFolders: string[]; codeFiles: string[] };
}

/** The subset of `data/manifest.json` (spec §3) this module reads. The writer (packages/cli) owns the
 * rest (codeloom, files, bytes); the dashboard never needs them. */
interface ManifestFile {
  version: number;
  head: string;
  base: string;
  builtAt: string;
  pr?: number;
  repoSlug?: string;
  omitted?: { mapFolders: string[]; codeFiles: string[] };
}

/** Thrown by `staticGet` when the requested data was never written to this snapshot (not on the PR's
 * affected journeys, or cut by the size cap). Not a `MapStateError`/`SessionError`: it never blocks the
 * whole page, only the one screen that asked for it, so `ScreenError` renders its message as a plain
 * notice ("Not in this snapshot: …"). */
export class NotInSnapshotError extends Error {
  constructor(path: string) {
    super(`Not in this snapshot: ${path}`);
    this.name = "NotInSnapshotError";
  }
}

let snapshot: SnapshotInfo | null = null;

/** GET `./data/manifest.json`. A 200 with `version: 1` is a snapshot: its info is cached (for
 * `isSnapshot`/`getSnapshot`) and returned. Anything else (missing file, a future manifest version, a
 * network error) means this is an ordinary live dashboard: cached state is cleared and `null` comes back.
 * Call once, before the first render (`main.tsx`); `isSnapshot()` reads what it found from then on. */
export async function detectSnapshot(fetchImpl: typeof fetch = fetch): Promise<SnapshotInfo | null> {
  snapshot = null;
  let res: Response;
  try {
    res = await fetchImpl("./data/manifest.json", { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let manifest: ManifestFile;
  try {
    manifest = (await res.json()) as ManifestFile;
  } catch {
    return null;
  }
  if (manifest.version !== 1) return null;
  snapshot = {
    head: manifest.head,
    base: manifest.base,
    builtAt: manifest.builtAt,
    omitted: manifest.omitted ?? { mapFolders: [], codeFiles: [] },
    ...(manifest.pr !== undefined ? { pr: manifest.pr } : {}),
    ...(manifest.repoSlug !== undefined ? { repoSlug: manifest.repoSlug } : {}),
  };
  return snapshot;
}

/** True once `detectSnapshot` has found a snapshot manifest. Read by `client.ts`, `events.ts`, the Rail
 * and the Map's search box to switch off what a snapshot never has. */
export function isSnapshot(): boolean {
  return snapshot !== null;
}

/** The detected snapshot's info (pr, head, base, …), for the banner. `null` outside a snapshot. */
export function getSnapshot(): SnapshotInfo | null {
  return snapshot;
}

// ---- snapshotKey: identical to the writer's packages/cli/src/snapshot/key.ts (fixtures/snapshot-keys.json
// is the shared golden file; both sides are tested against it) -----------------------------------------

/** SHA-256 of `bytes`, as lowercase hex. A small, dependency-free implementation (FIPS 180-4): the browser
 * has no synchronous hash (Web Crypto's `subtle.digest` is async only), and `snapshotKey` must stay sync
 * so it can be called from render code and plain query-key builders alike. */
function sha256Hex(bytes: Uint8Array): string {
  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;

  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((bytes.length + 9 + 63) & ~63);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + k[i]! + w[i]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(hex).join("");
}

const MAX_KEY_LENGTH = 120;
const SAFE_KEY_RE = /^[A-Za-z0-9._~@=&-]*$/;
const UNSAFE_CHAR_RE = /[^A-Za-z0-9._~@=&-]/g;

/** The `data/<key>.json` file name a snapshot stores `path` + `params` at (shared with the writer,
 * packages/cli/src/snapshot/key.ts — the two must stay identical; fixtures/snapshot-keys.json is their
 * shared golden file). `/api/x/y` → the `/api/` prefix is dropped and every other `/` becomes `~`. Params
 * (if any): drop the ones that are `undefined`, sort by name, `encodeURIComponent` each value, join as
 * `name=value` with `&`, and append after `@`. That full key is kept as-is only when it is entirely
 * [A-Za-z0-9._~@=&-] and at most 120 characters; otherwise every other character becomes `_`, it is cut to
 * 80 characters, and `-` plus the first 16 hex characters of the FULL key's SHA-256 is appended — always a
 * plain name a static host serves byte-for-byte (no `%` it would decode into a different file). */
export function snapshotKey(path: string, params?: Record<string, string | number | undefined>): string {
  const base = path.replace(/^\/api\/?/, "").replace(/\//g, "~");
  const qs = params
    ? Object.entries(params)
        .filter((e): e is [string, string | number] => e[1] !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const key = qs ? `${base}@${qs}` : base;
  if (SAFE_KEY_RE.test(key) && key.length <= MAX_KEY_LENGTH) return key;
  const hash = sha256Hex(new TextEncoder().encode(key)).slice(0, 16);
  return `${key.replace(UNSAFE_CHAR_RE, "_").slice(0, 80)}-${hash}`;
}

// ---- staticGet: apiGet's static-mode path -------------------------------------------------------------

function toKeyParams(params?: QueryParams): Record<string, string | number | undefined> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? undefined : typeof v === "boolean" ? String(v) : v;
  return out;
}

async function loadData<T>(path: string, key: string): Promise<T> {
  let res: Response;
  try {
    // The key is already in the safe charset (snapshotKey); encoding it is a safety net so no character
    // could ever reach the static host as something it would decode into a different file name.
    res = await fetch(`./data/${encodeURIComponent(key)}.json`, { headers: { accept: "application/json" } });
  } catch {
    throw new NotInSnapshotError(path);
  }
  if (!res.ok) throw new NotInSnapshotError(path);
  return (await res.json()) as T;
}

export const CODE_MAX_LINES = 400;
export const CODE_MAX_CHARS = 60_000;

/** Lines `start..end` (1-based, inclusive; no `end` = to the end of the file) of `source`, capped at 400
 * lines and 60 000 chars (cut on a line boundary; a single longer line is cut mid-line). `truncated` when
 * less than the asked range came back. Mirrors the server's `sliceCode` (packages/cli/src/web/api.ts)
 * exactly, since a snapshot has no server to slice for it — the dashboard loads the whole file and slices
 * it here instead. */
export function sliceCode(file: string, source: string, start: number, end: number | undefined): CodeResponse {
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  if (start > lines.length) throw new ApiError(`Bad range: ${file} has ${lines.length} lines; start ${start} is past the end.`, 400);
  if (end !== undefined && end < start) throw new ApiError(`Bad range: end ${end} is before start ${start}.`, 400);
  const wantEnd = Math.min(end ?? lines.length, lines.length);
  const capEnd = Math.min(wantEnd, start + CODE_MAX_LINES - 1);
  let text = lines[start - 1]!;
  let endLine = start;
  let cut = false;
  if (text.length > CODE_MAX_CHARS) {
    text = text.slice(0, CODE_MAX_CHARS);
    cut = true;
  } else {
    for (let n = start + 1; n <= capEnd; n++) {
      const next = lines[n - 1]!;
      if (text.length + 1 + next.length > CODE_MAX_CHARS) break;
      text += `\n${next}`;
      endLine = n;
    }
  }
  return { file, startLine: start, endLine, text, truncated: cut || endLine < wantEnd };
}

/** `/api/code?repo=&file=&start=&end=`: the stored whole file (`snapshotKey("/api/files/<repo>/<file>")`,
 * exactly the key the writer's fileEntry uses; written as `{ file, text }`) sliced locally with `sliceCode`,
 * to the same `CodeResponse` the server returns. */
async function staticCode(params: QueryParams | undefined): Promise<CodeResponse> {
  const repo = String(params?.repo ?? "");
  const file = String(params?.file ?? "");
  const start = params?.start !== undefined ? Number(params.start) : 1;
  const end = params?.end !== undefined ? Number(params.end) : undefined;
  const key = snapshotKey(`/api/files/${repo}/${file}`);
  const whole = await loadData<{ file: string; text: string }>("/api/code", key);
  return sliceCode(file, whole.text, start, end);
}

/** `apiGet`'s static-mode path (client.ts calls this once `isSnapshot()` is true): `/api/code` loads the
 * stored whole file and slices it; everything else reads `data/<snapshotKey(path, params)>.json` straight.
 * A file the snapshot never wrote (not on the PR's affected journeys, or cut by the size cap) throws
 * `NotInSnapshotError`. */
export async function staticGet<T>(path: string, params?: QueryParams): Promise<T> {
  if (path === "/api/code") return (await staticCode(params)) as T;
  const key = snapshotKey(path, toKeyParams(params));
  return loadData<T>(path, key);
}
