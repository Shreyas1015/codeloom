// Writes a hosted PR snapshot's data/*.json (design spec §3): the dashboard's API answers, computed once
// at the PR head by the same route handlers the live server uses (API_ROUTES + matchRoute), plus
// review.json (buildReview) and manifest.json. No server runs afterwards: the dashboard's static mode
// reads these files back by the same snapshotKey.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeloomError } from "../errors.js";
import { parseNodeRef } from "../mcp/state.js";
import { buildReview } from "../review/build.js";
import { readSpecs } from "../store/specs.js";
import { compare } from "../util.js";
import { API_ROUTES, CODE_MAX_BYTES, HttpError, matchRoute, repoFile } from "../web/api.js";
import { loadWorkspace } from "../workspace/repos.js";
import { VERSION } from "../version.js";
import { snapshotKey } from "./key.js";

/** Default `--max-size` (PR review maps constraints). */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface WriteSnapshotOptions {
  /** `impact_of_diff`'s base ref: the snapshot covers `merge-base(baseRef, HEAD)..HEAD`. */
  baseRef: string;
  /** The snapshot's root; data files land in `<outDir>/data/*.json`. */
  outDir: string;
  /** Default 25 MB. */
  maxBytes?: number;
  /** Default `() => new Date()`; override for deterministic `builtAt` in tests. */
  now?: () => Date;
}

/** `data/manifest.json`'s shape (design spec §3). `pr`/`repoSlug` are filled in later by `snapshot-site`. */
export interface SnapshotManifest {
  version: 1;
  codeloom: string;
  head: string;
  /** The merge-base SHA the diff was taken against. */
  base: string;
  /** The `--base` the user passed (e.g. "main"), for the dashboard banner's "vs main" (final review m1). */
  baseRef?: string;
  builtAt: string;
  pr?: number;
  repoSlug?: string;
  /** Set when even the always-included part alone would pass `maxBytes`: then only manifest.json and
   * review.json are written (and `files`/`omitted`/`bytes` describe that reduced set). */
  tooLarge?: { bytes: number; max: number };
  /** Data-relative paths (e.g. "overview.json"), sorted. */
  files: string[];
  omitted: { mapFolders: string[]; codeFiles: string[] };
  bytes: number;
}

interface Entry {
  key: string;
  body: unknown;
  json: string;
  bytes: number;
}

/** One API answer, exactly as a real request would get it: builds the URL (`path` + `params`), matches it
 * against `API_ROUTES` and awaits the handler. `path` is also what `snapshotKey` names the file from, so a
 * dynamic path segment (a node ref) must already be `encodeURIComponent`-escaped by the caller — the same
 * string then becomes both the request path and the file's key. Throws HttpError exactly as the live
 * server would (callers that can legitimately get a 404/400, like a doc link, catch it themselves). */
async function get(start: string, path: string, params?: Record<string, string | number | undefined>): Promise<Entry> {
  const key = snapshotKey(path, params);
  const url = new URL(`http://snapshot${path}`);
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  }
  const found = matchRoute(API_ROUTES, url.pathname);
  if (!found) throw new Error(`codeloom snapshot: no API route matches ${path}`);
  const body = await found.route.handler({ start, url, params: found.params });
  const json = JSON.stringify(body);
  return { key, body, json, bytes: Buffer.byteLength(json, "utf8") };
}

/** /api/node/:ref for a node ref that must exist (a changed node, or a journey stop's own ref): null on a
 * 404/400 (never expected, but the snapshot is best-effort — a stale ref is skipped, not fatal). */
async function nodeEntry(start: string, ref: string): Promise<Entry | null> {
  try {
    return await get(start, `/api/node/${encodeURIComponent(ref)}`);
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/** /api/docs for a spec doc linked to an affected journey: null when the link is stale, points outside the
 * repo, at git/.env/.codeloom internals, or over the 512 KB doc cap (same checks /api/docs always makes). */
async function docEntry(start: string, repoId: string, file: string): Promise<Entry | null> {
  try {
    return await get(start, "/api/docs", { repo: repoId, file });
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/** The whole text of one repo file, for the dashboard's offline diff/code views (never line-capped, unlike
 * live /api/code: design spec §3 "the dashboard loads the whole-file JSON and slices itself"). Keyed by a
 * dedicated path ("/api/files/<repo>/<file>", not a real route) so it never collides with /api/code's own
 * key. Path safety: `repoFile` (api.ts), the same check /api/code and /api/docs make — never git
 * internals, .env files, codeloom's own folder, or a symlink leading outside the repo; null on any of
 * that (HttpError). Also null over `CODE_MAX_BYTES` — "≤ the dashboard's code size cap" (design spec §3) —
 * the same cap /api/code itself enforces. Neither case counts against the `--max-size` budget
 * (`manifest.omitted`): this file is simply never a candidate for it. Any other error (e.g. the file
 * vanished between indexing and snapshotting) is not swallowed here. */
function fileEntry(start: string, repoId: string, file: string): Entry | null {
  try {
    const url = new URL(`http://snapshot/api/code?repo=${encodeURIComponent(repoId)}&file=${encodeURIComponent(file)}`);
    const { real, size } = repoFile(start, url);
    if (size > CODE_MAX_BYTES) return null;
    const text = readFileSync(real, "utf8");
    const key = snapshotKey(`/api/files/${repoId}/${file}`);
    const body = { file, text };
    const json = JSON.stringify(body);
    return { key, body, json, bytes: Buffer.byteLength(json, "utf8") };
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/** "a/b/c.ts" -> ["a", "a/b"] (every folder strictly above the file, root "" excluded: the repo's
 * top-level graph is always included separately). */
function ancestorDirs(file: string): string[] {
  const parts = file.split("/");
  parts.pop();
  const dirs: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc === "" ? part : `${acc}/${part}`;
    dirs.push(acc);
  }
  return dirs;
}

/** Writes `<opts.outDir>/data/*.json`: the dashboard's full API surface at the PR head (always: overview,
 * journeys, chains, layers, tours, specs, views, each repo's top-level graph; node/doc/code data for
 * whatever the diff touches), plus review.json (buildReview) and manifest.json. Never progress or search.
 *
 * Size (design spec §3): the "always" group above is never cut — if it alone would pass `maxBytes`, only
 * review.json and manifest.json (with `tooLarge`) are written and the function returns normally (exit 0
 * is the caller's job). Otherwise every always file is written, then Map folders (graph/<dir> for every
 * folder on the path to a changed file) and then code files (the whole text of a file holding a changed
 * node or a stop of an affected journey) are added one at a time while the running total stays under
 * `maxBytes`; the first one that would not fit, and everything after it in that bucket, is recorded in
 * `omitted` instead of being written. */
export async function writeSnapshotData(start: string, opts: WriteSnapshotOptions): Promise<SnapshotManifest> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const builtAt = (opts.now ? opts.now() : new Date()).toISOString();

  const review = buildReview(start, opts.baseRef);
  const ws = loadWorkspace(start);
  const repoIds = [...ws.repos.map((r) => r.id)].sort(compare);

  const always = new Map<string, Entry>();
  const add = (e: Entry) => always.set(e.key, e);

  add(await get(start, "/api/overview"));
  const journeysResp = await get(start, "/api/journeys");
  add(journeysResp);
  const journeyIds = (journeysResp.body as { journeys: Array<{ id: string }> }).journeys.map((j) => j.id).sort(compare);

  const journeyBodies = new Map<string, unknown>();
  for (const id of journeyIds) {
    const e = await get(start, `/api/journeys/${id}`);
    add(e);
    journeyBodies.set(id, e.body);
  }

  add(await get(start, "/api/chains"));
  for (const repoId of repoIds) add(await get(start, "/api/layers", { repo: repoId }));
  for (const id of journeyIds) add(await get(start, `/api/tours/${id}`));
  add(await get(start, "/api/specs"));
  for (const id of journeyIds) add(await get(start, `/api/specs/${id}`));

  const viewsResp = await get(start, "/api/views");
  add(viewsResp);
  const viewIds = (viewsResp.body as { views: Array<{ id: string }> }).views.map((v) => v.id).sort(compare);
  for (const id of viewIds) add(await get(start, `/api/views/${id}`));

  for (const repoId of repoIds) add(await get(start, "/api/graph", { repo: repoId }));

  // Node refs + the files holding a stop: the changed nodes themselves, and every ref'd stop of the
  // journeys the diff touches (review.journeys[].id). With no journey named for any of them (final review
  // I4), each affected chain (review.chains) stands in for a journey: /api/journeys/<chainId> answers for
  // a chain id too, so its own journeys~<chainId> is written (the Review screen links to it) and its
  // stops' nodes and files are written exactly as a journey's would be.
  const affectedJourneyIds = new Set(review.journeys.map((j) => j.id));
  if (review.journeys.length === 0) {
    for (const chainId of [...review.chains].sort(compare)) {
      try {
        const e = await get(start, `/api/journeys/${encodeURIComponent(chainId)}`);
        add(e);
        journeyBodies.set(chainId, e.body);
        affectedJourneyIds.add(chainId);
      } catch (err) {
        // A chain id that no longer resolves (getJourney's own dataError, or an HttpError): skipped, never fatal.
        if (!(err instanceof HttpError) && !(err instanceof CodeloomError)) throw err;
      }
    }
  }
  const nodeRefs = new Set<string>(review.nodes.map((n) => n.ref));
  const fileKeys = new Set<string>(); // "<repo>\0<file>"
  for (const id of affectedJourneyIds) {
    const body = journeyBodies.get(id) as { lanes?: Record<string, Array<{ repo: string; file: string; ref?: string }>> } | undefined;
    for (const stops of Object.values(body?.lanes ?? {})) {
      for (const s of stops) {
        fileKeys.add(`${s.repo}\0${s.file}`);
        if (s.ref) nodeRefs.add(s.ref);
      }
    }
  }
  for (const ref of [...nodeRefs].sort(compare)) {
    const e = await nodeEntry(start, ref);
    if (!e) continue;
    add(e);
    const body = e.body as { node?: { filePath?: string } };
    if (body.node?.filePath) fileKeys.add(`${parseNodeRef(ref).repo}\0${body.node.filePath}`);
  }

  // Spec docs linked to an affected journey.
  const docRefs = new Set<string>(); // "<repo>:<path>"
  for (const id of affectedJourneyIds) {
    for (const link of readSpecs(ws.root).journeys[id]?.links ?? []) {
      if (link.kind === "doc") docRefs.add(link.ref);
    }
  }
  for (const ref of [...docRefs].sort(compare)) {
    const at = ref.indexOf(":");
    if (at <= 0) continue;
    const e = await docEntry(start, ref.slice(0, at), ref.slice(at + 1));
    if (e) add(e);
  }

  const alwaysEntries = [...always.values()];
  const alwaysBytes = alwaysEntries.reduce((n, e) => n + e.bytes, 0);
  const reviewJson = JSON.stringify(review);
  const reviewBytes = Buffer.byteLength(reviewJson, "utf8");

  const dataDir = join(opts.outDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const put = (key: string, json: string) => writeFileSync(join(dataDir, `${key}.json`), json);

  if (alwaysBytes > maxBytes) {
    put("review", reviewJson);
    const manifest: SnapshotManifest = {
      version: 1,
      codeloom: VERSION,
      head: review.head,
      base: review.base,
      baseRef: opts.baseRef,
      builtAt,
      tooLarge: { bytes: alwaysBytes, max: maxBytes },
      files: ["manifest.json", "review.json"],
      omitted: { mapFolders: [], codeFiles: [] },
      bytes: reviewBytes,
    };
    put("manifest", JSON.stringify(manifest));
    return manifest;
  }

  for (const e of alwaysEntries) put(e.key, e.json);
  put("review", reviewJson);
  const written = new Set<string>(alwaysEntries.map((e) => e.key));
  written.add("review");
  const total0 = alwaysBytes + reviewBytes;

  // Map folders: every folder on the path to a changed file (review.files[], the whitelisted field).
  const folderCandidates = new Map<string, { repo: string; dir: string }>();
  for (const f of review.files) {
    for (const dir of ancestorDirs(f.file)) folderCandidates.set(`${f.repo}\0${dir}`, { repo: f.repo, dir });
  }
  const sortedFolders = [...folderCandidates.values()].sort((a, b) => compare(a.repo, b.repo) || compare(a.dir, b.dir));
  const folderEntries: Entry[] = [];
  for (const { repo, dir } of sortedFolders) {
    try {
      folderEntries.push(await get(start, "/api/graph", { repo, dir }));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err; // an impossible folder: never happens for a real ancestor dir
    }
  }

  // Code files: the whole text of each file holding a changed node or a stop of an affected journey.
  const fileCandidates = [...fileKeys]
    .map((k) => {
      const i = k.indexOf("\0");
      return { repo: k.slice(0, i), file: k.slice(i + 1) };
    })
    .sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file));
  const fileEntries: Entry[] = [];
  for (const { repo, file } of fileCandidates) {
    const e = fileEntry(start, repo, file);
    if (e) fileEntries.push(e); // unsafe path or over CODE_MAX_BYTES: never written, never counted as "cut for size"
  }

  // Cut order (constraints: "Map folders, then code files"): code files are protected first — they are
  // only cut once every Map folder has already been dropped and there is still not enough room.
  const allFileBytes = fileEntries.reduce((n, e) => n + e.bytes, 0);
  const foldersBudget = maxBytes - total0 - allFileBytes;
  const filesFitWhole = foldersBudget >= 0;

  // Stops adding at the first one that would not fit; everything after it in that bucket is omitted too
  // (not a bin-packing search for smaller ones that might still fit).
  const omittedMapFolders: string[] = [];
  let total = total0;
  if (filesFitWhole) {
    let spent = 0;
    let full = false;
    for (const e of folderEntries) {
      if (!full && spent + e.bytes <= foldersBudget) {
        put(e.key, e.json);
        written.add(e.key);
        spent += e.bytes;
      } else {
        full = true;
        omittedMapFolders.push(e.key);
      }
    }
    total += spent;
  } else {
    for (const e of folderEntries) omittedMapFolders.push(e.key);
  }

  const omittedCodeFiles: string[] = [];
  if (filesFitWhole) {
    for (const e of fileEntries) {
      put(e.key, e.json);
      written.add(e.key);
    }
    total += allFileBytes;
  } else {
    const filesBudget = maxBytes - total0;
    let spent = 0;
    let full = false;
    for (const e of fileEntries) {
      if (!full && spent + e.bytes <= filesBudget) {
        put(e.key, e.json);
        written.add(e.key);
        spent += e.bytes;
      } else {
        full = true;
        omittedCodeFiles.push(e.key);
      }
    }
    total += spent;
  }

  const files = [...written, "manifest"].map((k) => `${k}.json`).sort(compare);
  const manifest: SnapshotManifest = {
    version: 1,
    codeloom: VERSION,
    head: review.head,
    base: review.base,
    baseRef: opts.baseRef,
    builtAt,
    files,
    omitted: { mapFolders: omittedMapFolders, codeFiles: omittedCodeFiles },
    bytes: total,
  };
  put("manifest", JSON.stringify(manifest));
  return manifest;
}
