#!/usr/bin/env node
// Release build (`pnpm release:build`): everything the published codeloom package needs, in packages/cli.
//   1. pnpm -r build              core, cli (tsc, used by tests) and the dashboard
//   2. esbuild                    src/bin.ts + @codeloom/core source → dist/bin.js (+ .map), see bundle.mjs
//   3. collect-grammars           every grammar .wasm + its licence → dist/grammars
//   4. dashboard                  packages/dashboard/dist → dist/dashboard
//   5. LICENSE, NOTICE            repo root → packages/cli (git-ignored copies)
// The tsc per-file output stays in dist/ for the tests; package.json "files" ships only the bundle.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { bundle, cliDir, externalPackages, repoRoot } from "./bundle.mjs";

function step(name) {
  process.stdout.write(`\n▸ ${name}\n`);
}

function fail(message) {
  process.stderr.write(`release build: ${message}\n`);
  process.exit(1);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const dist = join(cliDir, "dist");

step("pnpm -r build");
execFileSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "inherit" });

step("esbuild → packages/cli/dist/bin.js");
const result = await bundle();
process.stdout.write(`  external packages: ${(await externalPackages(result.metafile)).join(", ")}\n`);

step("grammars → packages/cli/dist/grammars");
const grammars = join(dist, "grammars");
rmSync(grammars, { recursive: true, force: true });
execFileSync(process.execPath, [join(repoRoot, "scripts/release/collect-grammars.mjs"), grammars], {
  cwd: repoRoot,
  stdio: "inherit",
});

step("dashboard → packages/cli/dist/dashboard");
const dashboardSrc = join(repoRoot, "packages/dashboard/dist");
if (!existsSync(join(dashboardSrc, "index.html"))) fail(`the dashboard build is missing (${dashboardSrc}/index.html)`);
const dashboard = join(dist, "dashboard");
rmSync(dashboard, { recursive: true, force: true });
cpSync(dashboardSrc, dashboard, { recursive: true });

step("LICENSE, NOTICE → packages/cli");
for (const f of ["LICENSE", "NOTICE"]) cpSync(join(repoRoot, f), join(cliDir, f));

process.stdout.write(
  `\nrelease build done:\n` +
    `  dist/bin.js      ${kb(statSync(join(dist, "bin.js")).size)}\n` +
    `  dist/bin.js.map  ${kb(statSync(join(dist, "bin.js.map")).size)}\n` +
    `  dist/grammars    ${kb(dirSize(grammars))}\n` +
    `  dist/dashboard   ${kb(dirSize(dashboard))}\n`,
);
