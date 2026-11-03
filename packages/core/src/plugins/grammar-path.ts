import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Directory of the module that defines this function: `dist/` when bundled into `dist/bin.js`. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface GrammarPathOptions {
  /** Directory that holds the `grammars/` folder. Defaults to this module's own directory. */
  baseDir?: string;
}

/**
 * Absolute path of a tree-sitter grammar `.wasm` file.
 *
 * The published package ships grammars at `dist/grammars/<file>` next to the bundled entry
 * (`dist/bin.js`), so a bundled copy wins. Otherwise (dev / monorepo) the file is resolved from
 * the grammar's npm package. Throws when neither exists.
 */
export function grammarPath(pkg: string, file: string, options: GrammarPathOptions = {}): string {
  const bundled = join(options.baseDir ?? moduleDir, "grammars", file);
  if (existsSync(bundled)) return bundled;
  return require.resolve(`${pkg}/${file}`);
}
