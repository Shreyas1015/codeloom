import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { locateDashboardAssets } from "../src/web/assets.js";

/** A fake monorepo: <root>/packages/cli (the cli package) and maybe <root>/packages/dashboard/dist. */
function fakeMonorepo(opts: { bundled?: boolean; dashboard?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-assets-"));
  const cli = join(root, "packages", "cli");
  mkdirSync(join(cli, "dist", "web"), { recursive: true });
  // The compiled server code also lives in dist/web; without index.html it is not the bundled dashboard.
  writeFileSync(join(cli, "dist", "web", "server.js"), "");
  if (opts.bundled) writeFileSync(join(cli, "dist", "web", "index.html"), "<html></html>");
  if (opts.dashboard) {
    mkdirSync(join(root, "packages", "dashboard", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "dashboard", "dist", "index.html"), "<html></html>");
  }
  return cli;
}

describe("locateDashboardAssets", () => {
  it("prefers the bundled dist/web when it has index.html", () => {
    const cli = fakeMonorepo({ bundled: true, dashboard: true });
    expect(locateDashboardAssets(cli)).toBe(join(cli, "dist", "web"));
  });

  it("falls back to packages/dashboard/dist in the monorepo", () => {
    const cli = fakeMonorepo({ dashboard: true });
    expect(locateDashboardAssets(cli)).toBe(join(cli, "..", "dashboard", "dist"));
  });

  it("throws a CodeloomError naming the build command when neither exists", () => {
    const cli = fakeMonorepo({});
    expect(() => locateDashboardAssets(cli)).toThrow(CodeloomError);
    expect(() => locateDashboardAssets(cli)).toThrow(
      'The dashboard is not built. Run "pnpm --filter @codeloom/dashboard build".',
    );
  });

  it("with no argument, resolves from this package (absent here → the same error, or a folder with index.html)", () => {
    try {
      const dir = locateDashboardAssets();
      expect(dir).toMatch(/(dist[\\/]web|dashboard[\\/]dist)$/);
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
    }
  });
});
