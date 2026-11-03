#!/usr/bin/env node
// Walk an installed node_modules and fail if any package needs a native build step on install:
// a preinstall / install / postinstall script, `"gypfile": true`, or a binding.gyp (npm runs
// `node-gyp rebuild` for that one even without a script). codeloom must install with `npm i` / `npx`
// on a machine with no compiler.
// Usage: node no-native-deps.mjs <path/to/node_modules>
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root || !existsSync(root)) {
  process.stderr.write(`usage: node no-native-deps.mjs <node_modules dir> (got ${root ?? "nothing"})\n`);
  process.exit(2);
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
const problems = [];
let checked = 0;
const seen = new Set();

function checkPackage(dir) {
  const real = realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return; // not a package manifest (some packages ship fixture package.json files)
  }
  checked++;
  const name = `${pkg.name ?? relative(root, dir)}@${pkg.version ?? "?"}`;
  for (const s of INSTALL_SCRIPTS) {
    if (pkg.scripts?.[s]) problems.push(`${name}: "${s}" script: ${pkg.scripts[s]}`);
  }
  if (pkg.gypfile) problems.push(`${name}: "gypfile": true`);
  if (existsSync(join(dir, "binding.gyp"))) problems.push(`${name}: has binding.gyp`);
  const nested = join(dir, "node_modules");
  if (existsSync(nested)) walk(nested);
}

/** A directory, following symlinks (pnpm and `file:` installs link packages). */
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function walk(nodeModules) {
  for (const name of readdirSync(nodeModules)) {
    const p = join(nodeModules, name);
    if (name.startsWith(".") || !isDir(p)) continue;
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(p)) if (isDir(join(p, scoped))) checkPackage(join(p, scoped));
    } else {
      checkPackage(p);
    }
  }
}

walk(root);

if (problems.length > 0) {
  process.stderr.write(`no-native-deps: ${problems.length} package(s) need an install step:\n${problems.map((p) => `  - ${p}\n`).join("")}`);
  process.exit(1);
}
if (checked === 0) {
  process.stderr.write(`no-native-deps: no packages found in ${root}\n`);
  process.exit(1);
}
process.stdout.write(`no-native-deps: ${checked} packages, none with an install script or binding.gyp\n`);
