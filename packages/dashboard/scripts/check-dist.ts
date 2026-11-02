/** No-network check for the built dashboard: finds live load targets in dist that point at an
 * external host — src=, href=, url(, CSS @import, fetch(, import(, new URL(, EventSource( and
 * WebSocket( with an http(s)/ws(s) literal. Plain-text doc links inside strings (e.g. React's error
 * decoder "https://react.dev/errors/") are never loaded and are allowed; so are loopback targets.
 * License comments are ignored. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const TEXT = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt"]);
const LOOPBACK = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost)(?:[:/]|$)/;

const URL_BODY = String.raw`[^\s"'\`)<>\\]+`;
const Q = String.raw`["'\`]`;
/** Each pattern captures the URL in group 1. */
const LOAD_TARGETS: RegExp[] = [
  // HTML attributes and DOM property writes: <script src=…>, <link href=…>, el.src = "…"
  new RegExp(String.raw`\b(?:src|href)\s*=\s*["']?(https?:\/\/${URL_BODY})`, "g"),
  // CSS url(…) and @import "…"
  new RegExp(String.raw`\burl\(\s*["']?(https?:\/\/${URL_BODY})`, "g"),
  new RegExp(String.raw`@import\s+["'](https?:\/\/${URL_BODY})`, "g"),
  // JS loaders
  new RegExp(String.raw`\b(?:fetch|import)\(\s*${Q}(https?:\/\/${URL_BODY})`, "g"),
  new RegExp(String.raw`\bnew\s+URL\(\s*${Q}(https?:\/\/${URL_BODY})`, "g"),
  new RegExp(String.raw`\b(?:EventSource|WebSocket)\(\s*${Q}((?:https?|wss?):\/\/${URL_BODY})`, "g"),
];

/** Strip block comments that carry a license marker (/*! … or @license / @preserve). */
function stripLicenseComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => (c.startsWith("/*!") || /@license|@preserve/.test(c) ? "" : c));
}

export function findExternalUrls(text: string): string[] {
  const body = stripLicenseComments(text);
  const hits: Array<{ at: number; url: string }> = [];
  for (const re of LOAD_TARGETS) for (const m of body.matchAll(re)) hits.push({ at: m.index ?? 0, url: m[1]! });
  return hits
    .sort((a, b) => a.at - b.at)
    .map((h) => h.url)
    .filter((u) => !LOOPBACK.test(u));
}

export function scanDir(dir: string): Array<{ file: string; url: string }> {
  const hits: Array<{ file: string; url: string }> = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT.has(extname(p))) for (const url of findExternalUrls(readFileSync(p, "utf8"))) hits.push({ file: relative(dir, p), url });
    }
  };
  walk(dir);
  return hits;
}

/** CLI: `pnpm check:dist` (Node ≥ 22.6, type stripping) scans dist; exit 1 on any hit. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? "dist";
  const found = scanDir(dir);
  for (const h of found) console.error(`${h.file}: loads ${h.url}`);
  console.log(found.length ? `check-dist: ${found.length} external load target(s) in ${dir}` : `check-dist: no external load targets in ${dir}`);
  process.exitCode = found.length ? 1 : 0;
}
