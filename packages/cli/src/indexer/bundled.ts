/**
 * Bundled or minified JavaScript: build output checked into a repo (e.g. tool hooks bundled by esbuild).
 * Such a file packs many modules — often many nameless classes — into one file, so method and call
 * analysis on it only makes wrong edges. index-repo keeps it in graph.json as a file node (the
 * tree-sitter structure) but gives it no code index, no call edges and no adapter endpoints.
 *
 * Conservative: a normal app file is never skipped for one long line (a long string or regex); a long
 * line only counts when it is most of the file (minified) or comes with a source map comment.
 */

const MAX_LINE = 1_000;

/** `*.min.js`, `*.bundle.js`, `*-bundle.js` (by the file's base name), with `.js`, `.cjs` or `.mjs` only:
 * a source file such as `product-bundle.ts` is a normal module. */
const BUNDLE_NAME_RE = /(?:\.min|[.-]bundle)\.[cm]?js$/;

/** Markers only bundler output carries. */
const BUNDLER_MARKER_RE = /__webpack_require__|\/\*! For license information|\b__commonJS\(|\b__toESM\(/;

const SOURCE_MAP_RE = /^\/\/# sourceMappingURL=/m;

export function isBundledFile(rel: string, content: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (BUNDLE_NAME_RE.test(base)) return true;
  if (BUNDLER_MARKER_RE.test(content)) return true;
  let longChars = 0;
  for (const line of content.split("\n")) if (line.length > MAX_LINE) longChars += line.length;
  if (longChars === 0) return false;
  // Minified: the over-long lines are most of the file. Or: a long line plus a source map comment.
  return longChars * 2 >= content.length || SOURCE_MAP_RE.test(content);
}
