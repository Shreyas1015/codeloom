import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export interface Alias {
  prefix: string;
  targets: string[];
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

export function loadAliases(repoAbs: string, files: string[]): Alias[] {
  const aliases: Alias[] = [];
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
      const opts = (readJsonLoose(join(repoAbs, rel))?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
      const baseUrl = posix.join(dir, opts.baseUrl ?? ".");
      for (const [key, targets] of Object.entries(opts.paths ?? {})) {
        if (!key.endsWith("*")) continue;
        aliases.push({
          prefix: key.slice(0, -1),
          targets: targets.filter((t) => t.includes("*")).map((t) => posix.normalize(posix.join(baseUrl, t.slice(0, t.indexOf("*"))))),
        });
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

export function resolveImport(fromRel: string, source: string, files: Set<string>, aliases: Alias[]): string | null {
  const bases: string[] = [];
  if (source.startsWith("./") || source.startsWith("../")) {
    bases.push(posix.normalize(posix.join(posix.dirname(fromRel), source)));
  } else {
    for (const a of aliases) {
      if (source.startsWith(a.prefix)) bases.push(...a.targets.map((t) => posix.normalize(t + source.slice(a.prefix.length))));
    }
  }
  for (const b of bases) {
    const hit = tryFile(b, files);
    if (hit) return hit;
  }
  return null;
}
