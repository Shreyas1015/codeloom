#!/usr/bin/env node
// Copy every tree-sitter grammar .wasm that codeloom loads, plus each grammar package's licence,
// into <outDir> (grammars) and <outDir>/LICENSES/<package>.txt. The published package loads them
// from dist/grammars/ (see packages/core/src/plugins/grammar-path.ts), so it needs no native
// tree-sitter-* npm packages at install time.
//
// Usage: node scripts/release/collect-grammars.mjs <outDir> [<package>/<file.wasm> ...]
// Reads the language configs from core's built dist: run `pnpm --filter @codeloom/core build` first.
// Checks every file before copying anything; exits 1 naming each missing grammar or licence.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const coreDir = join(repoRoot, "packages/core");
// Grammar packages are core's dependencies, so resolve them as core would.
const requireFromCore = createRequire(join(coreDir, "package.json"));
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

const [outArg, ...extra] = process.argv.slice(2);
if (!outArg) {
  process.stderr.write("usage: collect-grammars.mjs <outDir> [<package>/<file.wasm> ...]\n");
  process.exit(1);
}
const outDir = resolve(outArg);

/** "<package>/<file>" → { pkg, file }; scoped packages keep their "@scope/name". */
function splitSpec(spec) {
  const i = spec.lastIndexOf("/");
  return { pkg: spec.slice(0, i), file: spec.slice(i + 1) };
}

async function configuredGrammars() {
  const languagesUrl = pathToFileURL(join(coreDir, "dist/languages/index.js")).href;
  const { builtinLanguageConfigs } = await import(languagesUrl);
  const list = [];
  for (const config of builtinLanguageConfigs) {
    if (!config.treeSitter) continue;
    const { wasmPackage, wasmFile } = config.treeSitter;
    list.push({ pkg: wasmPackage, file: wasmFile });
    // tree-sitter-plugin.ts also loads the TSX grammar from the TypeScript package.
    if (config.id === "typescript") list.push({ pkg: wasmPackage, file: "tree-sitter-tsx.wasm" });
  }
  return list;
}

/** Directory of the installed package that owns `filePath` (nearest package.json named `pkg`). */
function packageDir(pkg, filePath) {
  for (let dir = dirname(filePath); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === pkg) return dir;
  }
  return null;
}

const grammars = [...(await configuredGrammars()), ...extra.map(splitSpec)];
const missing = [];
const wasmCopies = new Map(); // file name → source path
const licenseCopies = new Map(); // package → source path

for (const { pkg, file } of grammars) {
  let src;
  try {
    src = requireFromCore.resolve(`${pkg}/${file}`);
  } catch {
    missing.push(`grammar ${pkg}/${file}`);
    continue;
  }
  const previous = wasmCopies.get(file);
  if (previous && previous !== src) {
    missing.push(`grammar ${pkg}/${file} (file name clashes with ${previous})`);
    continue;
  }
  wasmCopies.set(file, src);

  if (licenseCopies.has(pkg)) continue;
  const dir = packageDir(pkg, src);
  const license = dir && LICENSE_NAMES.map((n) => join(dir, n)).find((p) => existsSync(p));
  if (license) licenseCopies.set(pkg, license);
  else missing.push(`licence for ${pkg} (looked for ${LICENSE_NAMES.join(", ")})`);
}

if (missing.length > 0) {
  process.stderr.write(`collect-grammars: missing:\n${missing.map((m) => `  - ${m}\n`).join("")}`);
  process.exit(1);
}

mkdirSync(join(outDir, "LICENSES"), { recursive: true });
for (const [file, src] of wasmCopies) copyFileSync(src, join(outDir, file));
for (const [pkg, src] of licenseCopies) {
  const name = pkg.replace(/^@/, "").replace("/", "__");
  copyFileSync(src, join(outDir, "LICENSES", `${name}.txt`));
}
process.stdout.write(
  `collect-grammars: ${wasmCopies.size} grammars, ${licenseCopies.size} licences → ${outDir}\n`,
);
