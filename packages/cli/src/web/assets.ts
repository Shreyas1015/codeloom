import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeloomError } from "../errors.js";

/** The nearest folder at or above `moduleDir` that holds a package.json (`moduleDir` itself if none). This
 * module runs from src/web (tests), dist/web (tsc output) or dist (the release bundle, dist/bin.js), so a
 * fixed number of ".." would be wrong for one of them. */
export function cliRootFrom(moduleDir: string): string {
  for (let dir = resolve(moduleDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return resolve(moduleDir);
  }
}

/** The cli package folder (the published package root when bundled). */
const CLI_ROOT = cliRootFrom(dirname(fileURLToPath(import.meta.url)));

/** The built dashboard folder: packages/cli/dist/dashboard (bundled into the published package) if it has
 * index.html, else <monorepo>/packages/dashboard/dist. (dist/web holds the compiled server code, never the
 * dashboard.) Neither → CodeloomError naming both places and the build command.
 * `cliRoot` is the cli package folder (tests pass a fake one). */
export function locateDashboardAssets(cliRoot: string = CLI_ROOT): string {
  const candidates = [join(cliRoot, "dist", "dashboard"), join(cliRoot, "..", "dashboard", "dist")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  throw new CodeloomError(
    `The dashboard is not built (no index.html in ${candidates.join(" or ")}). Run "pnpm --filter @codeloom/dashboard build".`,
  );
}
