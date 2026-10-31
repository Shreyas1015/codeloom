import type { Alias } from "../indexer/resolve-imports.js";
import { resolveImport } from "../indexer/resolve-imports.js";
import type { Confidence } from "../store/schemas.js";
import { compare } from "../util.js";
import type { Callee, CallSite, CodeSymbol, FileCodeIndex, ImportBinding, RepoCodeIndex } from "./code-index.js";

type NamedOrDefault = Extract<ImportBinding, { kind: "named" | "default" }>;
type NamedImport = Extract<ImportBinding, { kind: "named" }>;

export interface SymbolRef {
  repo: string;
  file: string;
  symbol: string;
}

export interface ResolvedCall {
  site: CallSite;
  target: SymbolRef;
  /** "exact" for import/new/this/DI/object; "guess" for the unique-method fallback. */
  confidence: Confidence;
  via: "local" | "import" | "barrel" | "new" | "this" | "di" | "object" | "unique-method";
}

export interface RepoResolveInput {
  repo: string;
  index: RepoCodeIndex;
  files: Set<string>;
  aliases: Alias[];
}

export interface CallResolver {
  resolve(file: string, site: CallSite): ResolvedCall | null;
  callsFrom(ref: SymbolRef): ResolvedCall[];
  callersOf(ref: SymbolRef): Array<{ from: SymbolRef; call: ResolvedCall }>;
  resolveExport(file: string, exportedName: string): SymbolRef | null;
  /** The cached per-file index this resolver was built over (used by linkUi / findHandler with symbolAt). */
  fileIndex(file: string): FileCodeIndex | undefined;
}

export const MAX_DEPTH = 6;
const BARREL_MAX_HOPS = 3;

export interface WalkStep {
  ref: SymbolRef;
  depth: number;
  via?: ResolvedCall;
  parent?: SymbolRef;
}

interface ExportHit {
  file: string;
  symbol: string;
  /** Number of export-* / export{}-from hops crossed to find this symbol (0 = declared in the start file). */
  hops: number;
}

function splitDotted(name: string): { base: string; rest: string } {
  const dot = name.indexOf(".");
  return dot < 0 ? { base: name, rest: "" } : { base: name.slice(0, dot), rest: name.slice(dot) };
}

/** A dotted member ("Class.method" / "obj.method") declared in `fi` and reachable via an export.
 * The code index marks class methods `exported: false` (exported-ness lives on the class symbol),
 * while object-literal methods carry their variable statement's export flag directly. */
function exportedMember(fi: FileCodeIndex, base: string, name: string): CodeSymbol | undefined {
  const member = fi.symbols.find((s) => s.name === name && (s.kind === "method" || s.kind === "object-method"));
  if (!member) return undefined;
  if (member.kind === "object-method") return member.exported ? member : undefined;
  return fi.symbols.some((s) => s.name === base && s.kind === "class" && s.exported) ? member : undefined;
}

/** Follow `exportedName` (possibly dotted, e.g. "CustomerService.create") through `export *` / named
 * re-exports starting at `file`, up to BARREL_MAX_HOPS files beyond the start. Direct declarations
 * (symbols[].exported) always win before any re-export is followed. */
function resolveExportIn(
  index: RepoCodeIndex,
  files: Set<string>,
  aliases: Alias[],
  file: string,
  exportedName: string,
  hops: number,
): ExportHit | null {
  const fi = index.get(file);
  if (!fi) return null;
  const { base, rest } = splitDotted(exportedName);
  const direct = rest ? exportedMember(fi, base, exportedName) : fi.symbols.find(
    (s) => s.exported && (s.name === exportedName || (exportedName === "default" && s.exportedAs === "default")),
  );
  if (direct) return { file, symbol: direct.name, hops };
  if (hops >= BARREL_MAX_HOPS) return null;
  for (const re of fi.reExports) {
    if (re.kind === "all") {
      const target = resolveImport(file, re.from, files, aliases);
      if (!target) continue;
      const hit = resolveExportIn(index, files, aliases, target, exportedName, hops + 1);
      if (hit) return hit;
    } else if (re.exported === base) {
      const target = resolveImport(file, re.from, files, aliases);
      if (!target) continue;
      const hit = resolveExportIn(index, files, aliases, target, re.imported + rest, hops + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Class name of a caller symbol ("Class.method" -> "Class"); undefined for top-level functions. */
function classOfCaller(caller: string): string | undefined {
  const dot = caller.indexOf(".");
  return dot < 0 ? undefined : caller.slice(0, dot);
}

/** Resolve `<localClassName>.<method>` starting at `file`: a method declared directly in `file` wins;
 * otherwise `localClassName` must be an import binding, chased (default export's real class name is
 * read off the target file's own symbols) through barrels via resolveExportIn. */
function resolveClassMethod(
  index: RepoCodeIndex,
  files: Set<string>,
  aliases: Alias[],
  file: string,
  localClassName: string,
  method: string,
): ExportHit | null {
  const fi = index.get(file);
  if (!fi) return null;
  const name = `${localClassName}.${method}`;
  const direct = fi.symbols.find((s) => s.name === name && s.kind === "method");
  if (direct) return { file, symbol: direct.name, hops: 0 };
  const imp = fi.imports.find((i): i is NamedOrDefault => i.local === localClassName && (i.kind === "named" || i.kind === "default"));
  if (!imp) return null;
  const target = resolveImport(file, imp.from, files, aliases);
  if (!target) return null;
  if (imp.kind === "default") {
    const tf = index.get(target);
    const cls = tf?.symbols.find((s) => s.kind === "class" && s.exportedAs === "default");
    return cls ? resolveExportIn(index, files, aliases, target, `${cls.name}.${method}`, 0) : null;
  }
  return resolveExportIn(index, files, aliases, target, `${imp.imported}.${method}`, 0);
}

/** Resolve `<objectLocal>.<prop>` as an object-literal service method: declared locally as an
 * `object-method` symbol, or imported (named/default) from a file that declares it. Default-export
 * object literals are not supported (no name to key the method lookup on). */
function resolveObjectLiteral(
  index: RepoCodeIndex,
  files: Set<string>,
  aliases: Alias[],
  file: string,
  objectLocal: string,
  prop: string,
): ExportHit | null {
  const fi = index.get(file);
  if (!fi) return null;
  const name = `${objectLocal}.${prop}`;
  const local = fi.symbols.find((s) => s.kind === "object-method" && s.name === name);
  if (local) return { file, symbol: local.name, hops: 0 };
  const imp = fi.imports.find((i): i is NamedImport => i.local === objectLocal && i.kind === "named");
  if (!imp) return null;
  const target = resolveImport(file, imp.from, files, aliases);
  return target ? resolveExportIn(index, files, aliases, target, `${imp.imported}.${prop}`, 0) : null;
}

/** Repo-wide fallback: a method/object-method named exactly `method` on exactly one class/object
 * anywhere in the repo. More than one candidate (or zero) means no guess is made. */
function guessUniqueMethod(repo: string, index: RepoCodeIndex, site: CallSite, method: string): ResolvedCall | null {
  const suffix = `.${method}`;
  let hit: { file: string; symbol: string } | null = null;
  for (const [file, fi] of index) {
    for (const s of fi.symbols) {
      if ((s.kind === "method" || s.kind === "object-method") && s.name.endsWith(suffix)) {
        if (hit) return null;
        hit = { file, symbol: s.name };
      }
    }
  }
  if (!hit) return null;
  return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "guess", via: "unique-method" };
}

function resolveIdent(input: RepoResolveInput, file: string, site: CallSite, callee: Extract<Callee, { kind: "ident" }>): ResolvedCall | null {
  const { repo, index, files, aliases } = input;
  const fi = index.get(file);
  if (!fi) return null;
  const local = fi.symbols.find((s) => s.name === callee.name && s.kind === "function");
  if (local) return { site, target: { repo, file, symbol: local.name }, confidence: "exact", via: "local" };
  const imp = fi.imports.find((i): i is NamedOrDefault => i.local === callee.name && (i.kind === "named" || i.kind === "default"));
  if (imp) {
    const target = resolveImport(file, imp.from, files, aliases);
    const exportedName = imp.kind === "default" ? "default" : imp.imported;
    const hit = target ? resolveExportIn(index, files, aliases, target, exportedName, 0) : null;
    if (hit) {
      return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via: hit.hops > 0 ? "barrel" : "import" };
    }
  }
  return guessUniqueMethod(repo, index, site, callee.name);
}

function resolveMember(input: RepoResolveInput, file: string, site: CallSite, callee: Extract<Callee, { kind: "member" }>): ResolvedCall | null {
  const { repo, index, files, aliases } = input;
  const fi = index.get(file);
  if (!fi) return null;

  const ns = fi.imports.find((i) => i.local === callee.object && i.kind === "namespace");
  if (ns) {
    const target = resolveImport(file, ns.from, files, aliases);
    const hit = target ? resolveExportIn(index, files, aliases, target, callee.prop, 0) : null;
    if (hit) return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via: "import" };
  }

  // The caller's own `const x = new C()` first; else a module-level singleton used inside a function.
  const localNew =
    fi.localNews.find((n) => n.caller === site.caller && n.local === callee.object) ??
    fi.localNews.find((n) => n.caller === "<module>" && n.local === callee.object);
  if (localNew) {
    const hit = resolveClassMethod(index, files, aliases, file, localNew.className, callee.prop);
    if (hit) return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via: "new" };
  }

  const obj = resolveObjectLiteral(index, files, aliases, file, callee.object, callee.prop);
  if (obj) return { site, target: { repo, file: obj.file, symbol: obj.symbol }, confidence: "exact", via: "object" };

  return guessUniqueMethod(repo, index, site, callee.prop);
}

function resolveNewMember(input: RepoResolveInput, file: string, site: CallSite, callee: Extract<Callee, { kind: "new-member" }>): ResolvedCall | null {
  const { repo, index, files, aliases } = input;
  const hit = resolveClassMethod(index, files, aliases, file, callee.className, callee.prop);
  if (hit) return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via: "new" };
  return guessUniqueMethod(repo, index, site, callee.prop);
}

function resolveThis(input: RepoResolveInput, file: string, site: CallSite, callee: Extract<Callee, { kind: "this" }>): ResolvedCall | null {
  const { repo, index, files, aliases } = input;
  const cls = classOfCaller(site.caller);
  if (cls) {
    const hit = resolveClassMethod(index, files, aliases, file, cls, callee.prop);
    if (hit) return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via: "this" };
  }
  return guessUniqueMethod(repo, index, site, callee.prop);
}

function resolveThisField(input: RepoResolveInput, file: string, site: CallSite, callee: Extract<Callee, { kind: "this-field" }>): ResolvedCall | null {
  const { repo, index, files, aliases } = input;
  const fi = index.get(file);
  const cls = classOfCaller(site.caller);
  if (fi && cls) {
    const field = fi.classFields.find((f) => f.className === cls && f.field === callee.field);
    if (field) {
      const hit = resolveClassMethod(index, files, aliases, file, field.typeName, callee.prop);
      if (hit) return { site, target: { repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via: "di" };
    }
  }
  return guessUniqueMethod(repo, index, site, callee.prop);
}

function resolveOther(input: RepoResolveInput, site: CallSite, callee: Extract<Callee, { kind: "other" }>): ResolvedCall | null {
  return callee.prop ? guessUniqueMethod(input.repo, input.index, site, callee.prop) : null;
}

function resolveOne(input: RepoResolveInput, file: string, site: CallSite): ResolvedCall | null {
  const callee = site.callee;
  switch (callee.kind) {
    case "ident": return resolveIdent(input, file, site, callee);
    case "member": return resolveMember(input, file, site, callee);
    case "new-member": return resolveNewMember(input, file, site, callee);
    case "this": return resolveThis(input, file, site, callee);
    case "this-field": return resolveThisField(input, file, site, callee);
    case "other": return resolveOther(input, site, callee);
  }
}

export function createCallResolver(input: RepoResolveInput): CallResolver {
  let reverse: Map<string, Array<{ from: SymbolRef; call: ResolvedCall }>> | null = null;

  function buildReverse(): Map<string, Array<{ from: SymbolRef; call: ResolvedCall }>> {
    const map = new Map<string, Array<{ from: SymbolRef; call: ResolvedCall }>>();
    for (const [file, fi] of input.index) {
      for (const site of fi.calls) {
        const rc = resolveOne(input, file, site);
        if (!rc) continue;
        const key = `${rc.target.file}#${rc.target.symbol}`;
        const from: SymbolRef = { repo: input.repo, file, symbol: site.caller };
        const arr = map.get(key) ?? [];
        arr.push({ from, call: rc });
        map.set(key, arr);
      }
    }
    return map;
  }

  return {
    resolve: (file, site) => resolveOne(input, file, site),
    callsFrom(ref) {
      const fi = input.index.get(ref.file);
      if (!fi) return [];
      const out: ResolvedCall[] = [];
      for (const site of fi.calls) {
        if (site.caller !== ref.symbol) continue;
        const rc = resolveOne(input, ref.file, site);
        if (rc) out.push(rc);
      }
      return out.sort((a, b) => a.site.line - b.site.line);
    },
    callersOf(ref) {
      reverse ??= buildReverse();
      return reverse.get(`${ref.file}#${ref.symbol}`) ?? [];
    },
    resolveExport(file, exportedName) {
      const hit = resolveExportIn(input.index, input.files, input.aliases, file, exportedName, 0);
      return hit ? { repo: input.repo, file: hit.file, symbol: hit.symbol } : null;
    },
    fileIndex: (file) => input.index.get(file),
  };
}

function stepKey(ref: SymbolRef): string {
  return `${ref.file}#${ref.symbol}`;
}

function walk(
  neighbors: (ref: SymbolRef) => Array<{ target: SymbolRef; call: ResolvedCall }>,
  start: SymbolRef,
  maxDepth: number,
): WalkStep[] {
  const seen = new Set<string>([stepKey(start)]);
  const first: WalkStep = { ref: start, depth: 0 };
  const steps: WalkStep[] = [first];
  const queue: WalkStep[] = [first];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    for (const { target, call } of neighbors(cur.ref)) {
      const k = stepKey(target);
      if (seen.has(k)) continue;
      seen.add(k);
      const step: WalkStep = { ref: target, depth: cur.depth + 1, via: call, parent: cur.ref };
      steps.push(step);
      queue.push(step);
    }
  }
  return steps.sort((a, b) => a.depth - b.depth || compare(a.ref.file, b.ref.file) || compare(a.ref.symbol, b.ref.symbol));
}

export function walkCalls(resolver: CallResolver, start: SymbolRef, maxDepth = MAX_DEPTH): WalkStep[] {
  return walk((ref) => resolver.callsFrom(ref).map((call) => ({ target: call.target, call })), start, maxDepth);
}

export function walkCallers(resolver: CallResolver, start: SymbolRef, maxDepth = MAX_DEPTH): WalkStep[] {
  return walk((ref) => resolver.callersOf(ref).map(({ from, call }) => ({ target: from, call })), start, maxDepth);
}
