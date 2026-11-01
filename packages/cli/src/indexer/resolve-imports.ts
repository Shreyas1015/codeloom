import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export interface Alias {
  prefix: string;
  targets: string[];
  /** Set only for aliases derived from a tsconfig/jsconfig's `paths` or `baseUrl`. */
  kind?: "paths" | "baseUrl";
  /** The tsconfig/jsconfig's own directory (posix, "" at repo root); used to pick the nearest config. */
  dir?: string;
}

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];

function readJsonLoose(path: string): Record<string, unknown> | null {
  try {
    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
    return (parsed.config as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["import", "node", "default", "require"]) {
      const v = (value as Record<string, unknown>)[key];
      const s = firstString(v);
      if (s) return s;
    }
  }
  return undefined;
}

type CompilerOpts = { baseUrl?: string; paths?: Record<string, string[]> };

interface TsConfigLevel {
  dir: string;
  opts: CompilerOpts;
}

const MAX_EXTENDS_DEPTH = 5;

/**
 * Walks a tsconfig/jsconfig's `extends` chain, child first, following only a relative-path
 * `extends` ("./..." or "../..."). A package-name extends (e.g. `"@tsconfig/node20"`) is left
 * unresolved here — following it would require node_modules resolution, which is out of scope —
 * so it is treated as if there were no `extends` and the chain stops at the config itself.
 * Stops on a cycle, or once MAX_EXTENDS_DEPTH configs have been collected, matching tsc's own
 * circularity/depth guard.
 */
function loadConfigChain(repoAbs: string, startRel: string, fileSet: Set<string>): TsConfigLevel[] {
  const chain: TsConfigLevel[] = [];
  const visited = new Set<string>();
  let currentRel: string | undefined = startRel;
  while (currentRel !== undefined && chain.length < MAX_EXTENDS_DEPTH && !visited.has(currentRel)) {
    visited.add(currentRel);
    const config = readJsonLoose(join(repoAbs, currentRel));
    if (!config) break;
    const dir: string = posix.dirname(currentRel) === "." ? "" : posix.dirname(currentRel);
    chain.push({ dir, opts: (config.compilerOptions ?? {}) as CompilerOpts });
    const extendsValue = config.extends;
    currentRel =
      typeof extendsValue === "string" && (extendsValue.startsWith("./") || extendsValue.startsWith("../"))
        ? resolveExtendsTarget(dir, extendsValue, fileSet)
        : undefined;
  }
  return chain;
}

function resolveExtendsTarget(dir: string, extendsValue: string, fileSet: Set<string>): string | undefined {
  const joined = posix.normalize(posix.join(dir, extendsValue));
  if (fileSet.has(joined)) return joined;
  if (fileSet.has(`${joined}.json`)) return `${joined}.json`;
  return undefined;
}

export function loadAliases(repoAbs: string, files: string[]): Alias[] {
  const aliases: Alias[] = [];
  const fileSet = new Set(files);
  for (const rel of files) {
    const base = posix.basename(rel);
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    if (base === "package.json") {
      const imports = (readJsonLoose(join(repoAbs, rel))?.imports ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(imports)) {
        const target = firstString(value);
        if (!target || !key.endsWith("*") || !target.includes("*")) continue;
        aliases.push({ prefix: key.slice(0, -1), targets: [posix.normalize(posix.join(dir, target.slice(0, target.indexOf("*"))))] });
      }
    }
    if (base === "tsconfig.json" || base === "jsconfig.json") {
      // Resolve `baseUrl`/`paths` across the `extends` chain: the nearest (most child-ward) config
      // in the chain that declares a given key wins, and it is resolved relative to the directory
      // of the config file that declared it — matching TypeScript's own `extends` + baseUrl
      // resolution. `paths` targets (wherever declared) are always joined against the single
      // effective `baseUrl`, since `paths` entries are plain paths relative to `baseUrl`.
      const chain = loadConfigChain(repoAbs, rel, fileSet);
      let baseUrlDecl: { value: string; dir: string } | undefined;
      let pathsDecl: { value: Record<string, string[]>; dir: string } | undefined;
      for (const level of chain) {
        if (baseUrlDecl === undefined && level.opts.baseUrl !== undefined) baseUrlDecl = { value: level.opts.baseUrl, dir: level.dir };
        if (pathsDecl === undefined && level.opts.paths !== undefined) pathsDecl = { value: level.opts.paths, dir: level.dir };
      }
      const baseUrlDir = baseUrlDecl?.dir ?? pathsDecl?.dir ?? dir;
      const baseUrl = posix.normalize(posix.join(baseUrlDir, baseUrlDecl?.value ?? "."));
      for (const [key, targets] of Object.entries(pathsDecl?.value ?? {})) {
        if (!key.endsWith("*")) continue;
        aliases.push({
          prefix: key.slice(0, -1),
          targets: targets.filter((t) => t.includes("*")).map((t) => posix.normalize(posix.join(baseUrl, t.slice(0, t.indexOf("*"))))),
          kind: "paths",
          dir,
        });
      }
      // A plain `baseUrl` (no matching `paths` entry) is also a resolution root for bare specifiers:
      // TypeScript falls back to it for non-relative imports. Packages with no matching file under it
      // simply stay unresolved. `paths` is tried first (pushed above), so it wins on overlap.
      //
      // Deliberate: when the effective `baseUrl` is "." (repo/package root), this makes ANY local
      // folder whose name matches a real package specifier shadow that package — e.g. a local
      // `express/` folder makes `import "express"` resolve to `express/index.ts` instead of staying
      // unresolved as the npm package. This matches tsc's own module resolution (baseUrl is tried
      // before node_modules resolution), so codeloom keeps it rather than special-casing real
      // package names.
      if (baseUrlDecl !== undefined) {
        aliases.push({ prefix: "", targets: [baseUrl], kind: "baseUrl", dir });
      }
    }
  }
  return aliases;
}

function tryFile(base: string, files: Set<string>): string | null {
  const clean = base.replace(/^\.\//, "");
  const stem = clean.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [clean, ...EXTS.map((e) => stem + e), ...EXTS.map((e) => `${stem}/index${e}`)];
  return candidates.find((c) => files.has(c)) ?? null;
}

/**
 * The tsconfig/jsconfig directory that is the nearest ancestor of `fromRel`, among those that
 * contributed `paths` or `baseUrl` aliases. Matches TypeScript's "nearest config wins" behaviour
 * for monorepos with several tsconfig files.
 */
function nearestConfigDir(fromRel: string, aliases: Alias[]): string | undefined {
  const fromDir = posix.dirname(fromRel);
  let best: string | undefined;
  for (const a of aliases) {
    if (a.kind !== "paths" && a.kind !== "baseUrl") continue;
    const dir = a.dir ?? "";
    const isAncestor = dir === "" || fromDir === dir || fromDir.startsWith(`${dir}/`);
    if (!isAncestor) continue;
    if (best === undefined || dir.length > best.length) best = dir;
  }
  return best;
}

export function resolveImport(fromRel: string, source: string, files: Set<string>, aliases: Alias[]): string | null {
  const bases: string[] = [];
  if (source.startsWith("./") || source.startsWith("../")) {
    bases.push(posix.normalize(posix.join(posix.dirname(fromRel), source)));
  } else {
    const configDir = nearestConfigDir(fromRel, aliases);
    for (const a of aliases) {
      if (a.kind === "baseUrl") continue;
      if (a.kind === "paths" && a.dir !== configDir) continue;
      if (source.startsWith(a.prefix)) bases.push(...a.targets.map((t) => posix.normalize(t + source.slice(a.prefix.length))));
    }
    const baseUrlAlias = aliases.find((a) => a.kind === "baseUrl" && a.dir === configDir);
    if (baseUrlAlias) bases.push(...baseUrlAlias.targets.map((t) => posix.normalize(posix.join(t, source))));
  }
  for (const b of bases) {
    const hit = tryFile(b, files);
    if (hit) return hit;
  }
  return null;
}
