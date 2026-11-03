#!/usr/bin/env node
// `prepack` guard for packages/cli: refuse to pack unless `pnpm release:build` produced the bundle.
// A plain `tsc` build also writes dist/bin.js, but that file imports @codeloom/core, which is not published.
// The release bundle carries a marker as its second line (see RELEASE_MARKER in bundle.mjs):
//   #!/usr/bin/env node
//   // codeloom-release-bundle <version>
// Usage: node prepack-check.mjs [packageDir]   (default: packages/cli; tests pass a fake package folder)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/cli");
const version = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
const marker = `// codeloom-release-bundle ${version}`;
const problems = [];
const bin = join(cliDir, "dist/bin.js");

if (!existsSync(bin)) problems.push("dist/bin.js is missing");
else if (readFileSync(bin, "utf8").split("\n", 2)[1] !== marker) {
  problems.push(`dist/bin.js is not the release bundle for ${version} (its second line is not "${marker}"); a tsc build overwrites it`);
}
if (!existsSync(join(cliDir, "dist/bin.js.map"))) problems.push("dist/bin.js.map is missing");
const grammars = join(cliDir, "dist/grammars");
if (!existsSync(grammars) || !readdirSync(grammars).some((f) => f.endsWith(".wasm"))) {
  problems.push("dist/grammars has no .wasm files");
}
if (!existsSync(join(cliDir, "dist/dashboard/index.html"))) problems.push("dist/dashboard/index.html is missing");
for (const f of ["LICENSE", "NOTICE"]) if (!existsSync(join(cliDir, f))) problems.push(`${f} is missing`);

if (problems.length > 0) {
  process.stderr.write(
    `codeloom prepack: the release build has not run (or was overwritten):\n` +
      problems.map((p) => `  - ${p}\n`).join("") +
      `Run "pnpm release:build" at the repo root, then pack again.\n`,
  );
  process.exit(1);
}
