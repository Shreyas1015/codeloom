// The publish manifest (packages/cli/package.json) matches what the release bundle needs at runtime.
// The bundle is built in memory with the release esbuild settings (scripts/release/bundle.mjs); only
// its metafile is read, so this needs no prior build.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs release script, no type declarations
import { bundle, externalPackages, packageName } from "../../../scripts/release/bundle.mjs";

interface Manifest {
  name: string;
  version: string;
  type: string;
  license: string;
  author: string;
  description: string;
  keywords: string[];
  homepage: string;
  bugs: { url: string };
  repository: { type: string; url: string; directory: string };
  bin: Record<string, string>;
  files: string[];
  engines: Record<string, string>;
  publishConfig: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  private?: boolean;
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;

describe("packageName", () => {
  it("maps a bare import to its npm package", () => {
    expect(packageName("@modelcontextprotocol/sdk/server/mcp.js")).toBe("@modelcontextprotocol/sdk");
    expect(packageName("yaml")).toBe("yaml");
    expect(packageName("zod/v4")).toBe("zod");
    expect(packageName("node:fs")).toBeNull();
    expect(packageName("./x.js")).toBeNull();
  });
});

describe("publish manifest", () => {
  it("names, versions and describes the package", () => {
    expect(manifest.name).toBe("codeloom");
    expect(manifest.version).toBe("0.3.1");
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");
    expect(manifest.author).toBe("Shreyas1015");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.keywords).toEqual(
      expect.arrayContaining(["code map", "user journeys", "mcp", "claude", "codebase", "onboarding"]),
    );
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Shreyas1015/codeloom.git",
      directory: "packages/cli",
    });
    expect(manifest.homepage).toMatch(/^https:\/\/github\.com\/Shreyas1015\/codeloom/);
    expect(manifest.bugs.url).toBe("https://github.com/Shreyas1015/codeloom/issues");
    expect(manifest.bin).toEqual({ codeloom: "dist/bin.js" });
    expect(manifest.engines).toEqual({ node: ">=20" });
    expect(manifest.publishConfig).toEqual({ access: "public" });
  });

  it("ships only the bundle, grammars, dashboard and docs (no tsc per-file output)", () => {
    expect(manifest.files).toEqual([
      "dist/bin.js",
      "dist/bin.js.map",
      "dist/grammars",
      "dist/dashboard",
      "templates",
      "README.md",
      "LICENSE",
      "NOTICE",
      "CHANGELOG.md",
    ]);
  });

  it("refuses to pack before the release build ran", () => {
    expect(manifest.scripts.prepack).toContain("prepack-check.mjs");
  });

  it("has no workspace, @codeloom or grammar packages in dependencies", () => {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      expect(spec, name).not.toMatch(/^workspace:/);
      expect(name).not.toMatch(/^@codeloom\//);
      expect(name).not.toMatch(/(^|\/)tree-sitter-/);
    }
    expect(manifest.devDependencies["@codeloom/core"]).toBe("workspace:*");
  });

  it("lists exactly the npm packages the bundle imports at runtime", async () => {
    const result = await bundle({ write: false });
    const externals: string[] = await externalPackages(result.metafile);
    expect(externals).not.toContain("@codeloom/core");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(externals);
  }, 60_000);
});
