/** No-network check for the built dashboard: finds http(s) URLs in dist outside license comments.
 * Loopback URLs and XML namespace identifiers (never fetched) are allowed. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ALLOWED = [/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/, /^http:\/\/www\.w3\.org\//];
const TEXT = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".map"]);

/** Strip block comments that carry a license marker (/*! … or @license / @preserve). */
function stripLicenseComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => (c.startsWith("/*!") || /@license|@preserve/.test(c) ? "" : c));
}

export function findExternalUrls(text: string): string[] {
  const urls = stripLicenseComments(text).match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? [];
  return urls.filter((u) => !ALLOWED.some((re) => re.test(u)));
}

export function scanDir(dir: string): Array<{ file: string; url: string }> {
  const hits: Array<{ file: string; url: string }> = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT.has(extname(p))) for (const url of findExternalUrls(readFileSync(p, "utf8"))) hits.push({ file: relative(dir, p), url });
    }
  };
  walk(dir);
  return hits;
}
