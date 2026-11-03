// esbuild settings for the published codeloom bin: packages/cli/src/bin.ts → packages/cli/dist/bin.js.
// One ESM file for Node 20. @codeloom/core is bundled from its TypeScript source; every other bare
// import stays external and must be listed in packages/cli/package.json "dependencies"
// (packages/cli/test/release-manifest.test.ts checks this with the metafile).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const cliDir = join(repoRoot, "packages/cli");
const coreSrc = join(repoRoot, "packages/core/src");

const cliVersion = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;

/** The release bundle's marker: the first line after the shebang. A tsc build also writes dist/bin.js;
 * scripts/release/prepack-check.mjs refuses to pack unless dist/bin.js carries this exact line. */
export const RELEASE_MARKER = `// codeloom-release-bundle ${cliVersion}`;

// ESM output has no `require`; CJS dependencies (yaml, ...) and core's grammar-path need one.
const BANNER = [
  RELEASE_MARKER,
  'import { createRequire as __codeloomCreateRequire } from "node:module";',
  "const require = __codeloomCreateRequire(import.meta.url);",
].join("\n");

/** Resolve `@codeloom/core` (and `@codeloom/core/<sub>`) to core's source instead of its dist. */
const coreFromSource = {
  name: "codeloom-core-from-source",
  setup(b) {
    b.onResolve({ filter: /^@codeloom\/core(\/.*)?$/ }, (args) => {
      const sub = args.path.slice("@codeloom/core".length).replace(/^\//, "");
      const file = sub === "" ? "index.ts" : sub === "languages" ? "languages/index.ts" : `${sub}.ts`;
      return { path: join(coreSrc, file) };
    });
  },
};

/** Run esbuild. `write: false` keeps the output in memory (tests read only the metafile). */
export function bundle({ outfile = join(cliDir, "dist/bin.js"), write = true } = {}) {
  return build({
    entryPoints: [join(cliDir, "src/bin.ts")],
    outfile,
    write,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    plugins: [coreFromSource],
    banner: { js: BANNER },
    sourcemap: "linked",
    metafile: true,
    logLevel: "warning",
  });
}

/** npm package name of a bare import: "a/b/c" → "a", "@s/a/b" → "@s/a". Node built-ins → null. */
export function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Sorted npm package names the bundle imports at runtime (externals minus Node built-ins). */
export async function externalPackages(metafile) {
  const { builtinModules } = await import("node:module");
  const builtins = new Set(builtinModules);
  const names = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (!imp.external) continue;
      const name = packageName(imp.path);
      if (name && !builtins.has(name)) names.add(name);
    }
  }
  return [...names].sort();
}
