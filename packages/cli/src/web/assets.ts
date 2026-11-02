import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeloomError } from "../errors.js";

/** The cli package folder: this file is src/web/assets.ts (tests) or dist/web/assets.js (built). */
const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The built dashboard folder: packages/cli/dist/web (bundled into the published package) if it has
 * index.html, else <monorepo>/packages/dashboard/dist. dist/web also holds the compiled server code, so
 * only index.html marks it as the dashboard. Neither → CodeloomError naming the build command.
 * `cliRoot` is the cli package folder (tests pass a fake one). */
export function locateDashboardAssets(cliRoot: string = CLI_ROOT): string {
  const candidates = [join(cliRoot, "dist", "web"), join(cliRoot, "..", "dashboard", "dist")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  throw new CodeloomError('The dashboard is not built. Run "pnpm --filter @codeloom/dashboard build".');
}
