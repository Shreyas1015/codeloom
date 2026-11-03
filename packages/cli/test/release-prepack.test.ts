// The `prepack` guard (scripts/release/prepack-check.mjs) refuses to pack anything but the release bundle.
// A tsc build (`pnpm --filter codeloom build`, or the cli tests outside CI) rewrites dist/bin.js; that file
// must never be packed. Each case lays out a fake package folder and runs the guard against it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs release script, no type declarations
import { bundle, RELEASE_MARKER } from "../../../scripts/release/bundle.mjs";

const guard = fileURLToPath(new URL("../../../scripts/release/prepack-check.mjs", import.meta.url));
const version = (RELEASE_MARKER as string).split(" ").pop();

function fakePackage(binJs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-prepack-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "codeloom", version }));
  mkdirSync(join(dir, "dist/grammars"), { recursive: true });
  mkdirSync(join(dir, "dist/dashboard"), { recursive: true });
  writeFileSync(join(dir, "dist/bin.js"), binJs);
  writeFileSync(join(dir, "dist/bin.js.map"), "{}");
  writeFileSync(join(dir, "dist/grammars/tree-sitter-go.wasm"), "");
  writeFileSync(join(dir, "dist/dashboard/index.html"), "");
  writeFileSync(join(dir, "LICENSE"), "");
  writeFileSync(join(dir, "NOTICE"), "");
  return dir;
}

function runGuard(dir: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [guard, dir], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

describe("release bundle marker", () => {
  it("is the line right after the shebang, with the package version", async () => {
    const result = await bundle({ write: false });
    const lines = new TextDecoder().decode(result.outputFiles.find((f: { path: string }) => f.path.endsWith("bin.js")).contents).split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]).toBe(RELEASE_MARKER);
    expect(RELEASE_MARKER).toMatch(/^\/\/ codeloom-release-bundle \d+\.\d+\.\d+/);
  });
});

describe("prepack guard", () => {
  it("passes for the release bundle", () => {
    const r = runGuard(fakePackage(`#!/usr/bin/env node\n${RELEASE_MARKER}\nconsole.log(1);\n`));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("fails for tsc output (no marker)", () => {
    const r = runGuard(fakePackage(`#!/usr/bin/env node\nimport { run } from "./cli.js";\nrun();\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not the release bundle");
    expect(r.stderr).toContain('Run "pnpm release:build"');
  });

  it("fails for a bundle built for another version", () => {
    const r = runGuard(fakePackage(`#!/usr/bin/env node\n// codeloom-release-bundle 0.0.1\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not the release bundle");
  });

  it("fails when the marker is not right after the shebang", () => {
    const r = runGuard(fakePackage(`#!/usr/bin/env node\nconsole.log(1);\n${RELEASE_MARKER}\n`));
    expect(r.status).toBe(1);
  });
});
