import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  it("prefers the bundled dist/dashboard when it has index.html", () => {
    const cli = fakeMonorepo({ bundled: true, dashboard: true });
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
