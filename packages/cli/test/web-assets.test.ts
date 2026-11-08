import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { cliRootFrom, locateDashboardAssets } from "../src/web/assets.js";

/** A fake monorepo: <root>/packages/cli (the cli package) and maybe <root>/packages/dashboard/dist. */
function fakeMonorepo(opts: { bundled?: boolean; dashboard?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-assets-"));
  const cli = join(root, "packages", "cli");
  mkdirSync(join(cli, "dist", "web"), { recursive: true });
  // The compiled server code lives in dist/web; even with an index.html there it is never the dashboard.
  writeFileSync(join(cli, "dist", "web", "server.js"), "");
  writeFileSync(join(cli, "dist", "web", "index.html"), "<html></html>");
  if (opts.bundled) {
    mkdirSync(join(cli, "dist", "dashboard"), { recursive: true });
    writeFileSync(join(cli, "dist", "dashboard", "index.html"), "<html></html>");
  }
  if (opts.dashboard) {
    mkdirSync(join(root, "packages", "dashboard", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "dashboard", "dist", "index.html"), "<html></html>");
  }
  return cli;
}

describe("locateDashboardAssets", () => {
  it("prefers the bundled dist/dashboard when it has index.html (and is not older)", () => {
    const cli = fakeMonorepo({ bundled: true, dashboard: true });
    const same = new Date("2026-11-08T00:00:00Z");
    utimesSync(join(cli, "dist", "dashboard", "index.html"), same, same);
    utimesSync(join(cli, "..", "dashboard", "dist", "index.html"), same, same);
    expect(locateDashboardAssets(cli)).toBe(join(cli, "dist", "dashboard"));
  });

  it("when both are built, takes the one with the newer index.html (a fresh dashboard build beats a stale bundled copy)", () => {
    const cli = fakeMonorepo({ bundled: true, dashboard: true });
    const bundled = join(cli, "dist", "dashboard", "index.html");
    const dev = join(cli, "..", "dashboard", "dist", "index.html");
    utimesSync(bundled, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
    utimesSync(dev, new Date("2026-11-08T00:00:00Z"), new Date("2026-11-08T00:00:00Z"));
    expect(locateDashboardAssets(cli)).toBe(join(cli, "..", "dashboard", "dist"));
    utimesSync(bundled, new Date("2026-11-09T00:00:00Z"), new Date("2026-11-09T00:00:00Z"));
    expect(locateDashboardAssets(cli)).toBe(join(cli, "dist", "dashboard"));
  });

  it("falls back to packages/dashboard/dist in the monorepo, never dist/web (compiled server code)", () => {
    const cli = fakeMonorepo({ dashboard: true });
    expect(locateDashboardAssets(cli)).toBe(join(cli, "..", "dashboard", "dist"));
  });

  it("throws a CodeloomError naming both places and the build command when neither exists", () => {
    const cli = fakeMonorepo({});
    expect(() => locateDashboardAssets(cli)).toThrow(CodeloomError);
    expect(() => locateDashboardAssets(cli)).toThrow(
      `The dashboard is not built (no index.html in ${join(cli, "dist", "dashboard")} or ${join(cli, "..", "dashboard", "dist")}). Run "pnpm --filter @codeloom/dashboard build".`,
    );
  });

  it("with no argument, resolves from this package (absent here → the same error, or a folder with index.html)", () => {
    try {
      const dir = locateDashboardAssets();
      expect(dir).toMatch(/(dist[\\/]dashboard|dashboard[\\/]dist)$/);
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
    }
  });
});

describe("cliRootFrom", () => {
  /** <pkg>/package.json plus the given empty sub-folders. */
  function fakePackage(...dirs: string[]): string {
    const pkg = mkdtempSync(join(tmpdir(), "codeloom-root-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    for (const d of dirs) mkdirSync(join(pkg, d), { recursive: true });
    return pkg;
  }

  it("finds the package from src/web (tests) and dist/web (tsc output)", () => {
    const pkg = fakePackage("src/web", "dist/web");
    expect(cliRootFrom(join(pkg, "src", "web"))).toBe(pkg);
    expect(cliRootFrom(join(pkg, "dist", "web"))).toBe(pkg);
  });

  it("finds the package from dist (the release bundle, all code in dist/bin.js)", () => {
    const pkg = fakePackage("dist");
    expect(cliRootFrom(join(pkg, "dist"))).toBe(pkg);
  });
});
