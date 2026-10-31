import type { Alias } from "../indexer/resolve-imports.js";
import { resolveImport } from "../indexer/resolve-imports.js";
import type { Confidence } from "../store/schemas.js";
import { compare } from "../util.js";
import type { Callee, CallSite, CodeSymbol, FileCodeIndex, ImportBinding, RepoCodeIndex } from "./code-index.js";

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

/** Per-resolver state: the repo input plus caches built once (method-name map) or filled lazily
 * (resolveExportIn memo). */
interface Ctx extends RepoResolveInput {
  /** Method-name suffix -> the single method/object-method carrying it, or null when ambiguous. */
  methods: Map<string, { file: string; symbol: string } | null>;
  exportMemo: Map<string, ExportHit | null>;
}

function splitDotted(name: string): { base: string; rest: string } {
  const dot = name.indexOf(".");
  return dot < 0 ? { base: name, rest: "" } : { base: name.slice(0, dot), rest: name.slice(dot) };
}

/** Is `s` a function/class importable under `exportedName` (one of its recorded export names)? */
function exportedUnder(s: CodeSymbol, exportedName: string): boolean {
  return (s.kind === "function" || s.kind === "class") && !!s.exportNames?.includes(exportedName);
}

/** The class importable under `exportedName` (its own name, an alias, or "default"). */
function exportedClass(fi: FileCodeIndex, exportedName: string): CodeSymbol | undefined {
  return fi.symbols.find((s) => s.kind === "class" && exportedUnder(s, exportedName));
}

/** Object-literal names an export `base` can stand for: `export default {…}` methods are keyed
 * `default.*`, `module.exports = {…}` ones `exports.*` (which is also the CommonJS default export), and
 * `module.exports = obj` ones `obj.*` (recorded as the file's defaultObject). */
function objectBases(fi: FileCodeIndex, base: string): string[] {
  if (base !== "default") return [base];
  return fi.defaultObject !== undefined ? ["default", "exports", fi.defaultObject] : ["default", "exports"];
}

/** A dotted member ("Class.method" / "obj.method") declared in `fi` and reachable via an export.
 * The code index marks class methods `exported: false` (exported-ness lives on the class symbol),
 * while object-literal methods carry their own export flag. */
function exportedMember(fi: FileCodeIndex, base: string, rest: string): CodeSymbol | undefined {
  const cls = exportedClass(fi, base);
  if (cls) {
    const m = fi.symbols.find((s) => s.kind === "method" && s.name === cls.name + rest);
    if (m) return m;
  }
  for (const ob of objectBases(fi, base)) {
    const m = fi.symbols.find((s) => s.kind === "object-method" && s.exported && s.name === ob + rest);
    if (m) return m;
  }
  return undefined;
}

/** A non-dotted export: a function/class exported under exactly that name (`export { a as b }` /
 * `module.exports = { b: impl }` map `b` to `a` / `impl`, never `a` / `impl` themselves), else a
 * CommonJS default-object member: `module.exports = { name() {} }` (`exports.name`) or
 * `module.exports = obj` (`obj.name`). */
function exportedPlain(fi: FileCodeIndex, exportedName: string): CodeSymbol | undefined {
  const plain = fi.symbols.find((s) => exportedUnder(s, exportedName));
  if (plain || exportedName === "default") return plain;
  const bases = fi.defaultObject !== undefined ? ["exports", fi.defaultObject] : ["exports"];
  for (const b of bases) {
    const m = fi.symbols.find((s) => s.kind === "object-method" && s.exported && s.name === `${b}.${exportedName}`);
    if (m) return m;
  }
  return undefined;
}

/** Follow `exportedName` (possibly dotted, e.g. "CustomerService.create") through `export *` / named
 * re-exports starting at `file`, up to BARREL_MAX_HOPS files beyond the start. Direct declarations
 * always win before any re-export is followed. `export *` never forwards `default`. Memoized per
 * (file, name, hops). */
function resolveExportIn(ctx: Ctx, file: string, exportedName: string, hops: number): ExportHit | null {
  const key = `${hops}\0${file}\0${exportedName}`;
  const memo = ctx.exportMemo.get(key);
  if (memo !== undefined) return memo;
  ctx.exportMemo.set(key, null); // cycle guard while computing
  const hit = resolveExportUncached(ctx, file, exportedName, hops);
  ctx.exportMemo.set(key, hit);
  return hit;
}

function resolveExportUncached(ctx: Ctx, file: string, exportedName: string, hops: number): ExportHit | null {
  const { index, files, aliases } = ctx;
  const fi = index.get(file);
  if (!fi) return null;
  const { base, rest } = splitDotted(exportedName);
  const direct = rest ? exportedMember(fi, base, rest) : exportedPlain(fi, exportedName);
  if (direct) return { file, symbol: direct.name, hops };
  if (hops >= BARREL_MAX_HOPS) return null;
  for (const re of fi.reExports) {
    if (re.kind === "all") {
      if (base === "default") continue;
      const target = resolveImport(file, re.from, files, aliases);
      if (!target) continue;
      const hit = resolveExportIn(ctx, target, exportedName, hops + 1);
      if (hit) return hit;
    } else if (re.exported === base) {
      const target = resolveImport(file, re.from, files, aliases);
      if (!target) continue;
      const hit = resolveExportIn(ctx, target, re.imported + rest, hops + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function symbolKind(ctx: Ctx, hit: ExportHit): CodeSymbol["kind"] | undefined {
  return ctx.index.get(hit.file)?.symbols.find((s) => s.name === hit.symbol)?.kind;
}

/** Class name of a caller symbol ("Class.method" -> "Class"); undefined for top-level functions. */
function classOfCaller(caller: string): string | undefined {
  const dot = caller.indexOf(".");
  return dot < 0 ? undefined : caller.slice(0, dot);
}

/** The export name an import binding stands for: named -> its imported name; default and
 * namespace (`const X = require("./x")`, i.e. `module.exports = X`) -> "default". */
function importedName(imp: ImportBinding): string {
  return imp.kind === "named" ? imp.imported : "default";
}

/** Resolve `<localClassName>.<method>` starting at `file`: a method declared directly in `file` wins;
 * otherwise `localClassName` must be an import binding (named, default, or a require() namespace),
 * chased through barrels via resolveExportIn. Only class methods are accepted. */
function resolveClassMethod(ctx: Ctx, file: string, localClassName: string, method: string): ExportHit | null {
  const fi = ctx.index.get(file);
  if (!fi) return null;
  const name = `${localClassName}.${method}`;
  const direct = fi.symbols.find((s) => s.name === name && s.kind === "method");
  if (direct) return { file, symbol: direct.name, hops: 0 };
  const imp = fi.imports.find((i) => i.local === localClassName);
  if (!imp) return null;
  const target = resolveImport(file, imp.from, ctx.files, ctx.aliases);
  if (!target) return null;
  const hit = resolveExportIn(ctx, target, `${importedName(imp)}.${method}`, 0);
  return hit && symbolKind(ctx, hit) === "method" ? hit : null;
}

/** Resolve `<objectLocal>.<prop>` as an object-literal service method or a static class method:
 * declared locally, or imported (named / default / require namespace) from a file that declares it. */
function resolveObjectLiteral(ctx: Ctx, file: string, objectLocal: string, prop: string): ExportHit | null {
  const fi = ctx.index.get(file);
  if (!fi) return null;
  const name = `${objectLocal}.${prop}`;
  const local = fi.symbols.find((s) => (s.kind === "object-method" || s.kind === "method") && s.name === name);
  if (local) return { file, symbol: local.name, hops: 0 };
  const imp = fi.imports.find((i) => i.local === objectLocal && i.kind !== "namespace");
  if (!imp) return null;
  const target = resolveImport(file, imp.from, ctx.files, ctx.aliases);
  return target ? resolveExportIn(ctx, target, `${importedName(imp)}.${prop}`, 0) : null;
}

/** Every method / object-method, keyed on each dot-suffix of its name ("A.b" -> "b"); a key seen
 * twice maps to null (ambiguous). Built once per resolver. */
function buildMethodMap(index: RepoCodeIndex): Map<string, { file: string; symbol: string } | null> {
  const map = new Map<string, { file: string; symbol: string } | null>();
  for (const [file, fi] of index) {
    for (const s of fi.symbols) {
      if (s.kind !== "method" && s.kind !== "object-method") continue;
      for (let i = s.name.indexOf("."); i >= 0; i = s.name.indexOf(".", i + 1)) {
        const key = s.name.slice(i + 1);
        map.set(key, map.has(key) ? null : { file, symbol: s.name });
      }
    }
  }
  return map;
}

/** Repo-wide fallback for member calls: a method/object-method named exactly `method` on exactly one
 * class/object anywhere in the repo. More than one candidate (or zero) means no guess is made. */
function guessUniqueMethod(ctx: Ctx, site: CallSite, method: string): ResolvedCall | null {
  const hit = ctx.methods.get(method);
  if (!hit) return null;
  return { site, target: { repo: ctx.repo, file: hit.file, symbol: hit.symbol }, confidence: "guess", via: "unique-method" };
}

function exact(ctx: Ctx, site: CallSite, hit: ExportHit, via: ResolvedCall["via"]): ResolvedCall {
  return { site, target: { repo: ctx.repo, file: hit.file, symbol: hit.symbol }, confidence: "exact", via };
}

/** Bare identifier calls (`helper()`, `fetch()`) resolve to a local function or an import, or not at
 * all: a global like `fetch` / a callback param like `next` must never be guessed onto a method. */
function resolveIdent(ctx: Ctx, file: string, site: CallSite, callee: Extract<Callee, { kind: "ident" }>): ResolvedCall | null {
  const fi = ctx.index.get(file);
  if (!fi) return null;
  const local = fi.symbols.find((s) => s.name === callee.name && s.kind === "function");
  if (local) return exact(ctx, site, { file, symbol: local.name, hops: 0 }, "local");
  const imp = fi.imports.find((i) => i.local === callee.name && i.kind !== "namespace");
  if (imp) {
    const target = resolveImport(file, imp.from, ctx.files, ctx.aliases);
    const hit = target ? resolveExportIn(ctx, target, importedName(imp), 0) : null;
    if (hit) return exact(ctx, site, hit, hit.hops > 0 ? "barrel" : "import");
  }
  return null;
}

function resolveMember(ctx: Ctx, file: string, site: CallSite, callee: Extract<Callee, { kind: "member" }>): ResolvedCall | null {
  const fi = ctx.index.get(file);
  if (!fi) return null;

  const ns = fi.imports.find((i) => i.local === callee.object && i.kind === "namespace");
  if (ns) {
    const target = resolveImport(file, ns.from, ctx.files, ctx.aliases);
    const hit = target ? resolveExportIn(ctx, target, callee.prop, 0) : null;
    if (hit) return exact(ctx, site, hit, "import");
  }

  // The caller's own `const x = new C()` first; else a module-level singleton used inside a function.
  const localNew =
    fi.localNews.find((n) => n.caller === site.caller && n.local === callee.object) ??
    fi.localNews.find((n) => n.caller === "<module>" && n.local === callee.object);
  if (localNew) {
    const hit = resolveClassMethod(ctx, file, localNew.className, callee.prop);
    if (hit) return exact(ctx, site, hit, "new");
  }

  const obj = resolveObjectLiteral(ctx, file, callee.object, callee.prop);
  if (obj) {
    // A static call on a class (`Util.make()`) is labelled like any other import ("barrel" when a
    // re-export was crossed; "local" when declared in this file); "object" stays for object literals.
    if (symbolKind(ctx, obj) === "method") {
      const via = obj.file === file && obj.hops === 0 && !fi.imports.some((i) => i.local === callee.object)
        ? "local" : obj.hops > 0 ? "barrel" : "import";
      return exact(ctx, site, obj, via);
    }
    return exact(ctx, site, obj, "object");
  }

  return guessUniqueMethod(ctx, site, callee.prop);
}

function resolveNewMember(ctx: Ctx, file: string, site: CallSite, callee: Extract<Callee, { kind: "new-member" }>): ResolvedCall | null {
  const hit = resolveClassMethod(ctx, file, callee.className, callee.prop);
  if (hit) return exact(ctx, site, hit, "new");
  return guessUniqueMethod(ctx, site, callee.prop);
}

function resolveThis(ctx: Ctx, file: string, site: CallSite, callee: Extract<Callee, { kind: "this" }>): ResolvedCall | null {
  const fi = ctx.index.get(file);
  const owner = classOfCaller(site.caller);
  if (fi && owner) {
    // `this.m()` inside an object-literal method: the sibling method of the same object.
    if (fi.symbols.some((s) => s.name === site.caller && s.kind === "object-method")) {
      const sib = fi.symbols.find((s) => s.kind === "object-method" && s.name === `${owner}.${callee.prop}`);
      if (sib) return exact(ctx, site, { file, symbol: sib.name, hops: 0 }, "this");
    } else {
      const hit = resolveClassMethod(ctx, file, owner, callee.prop);
      if (hit) return exact(ctx, site, hit, "this");
    }
  }
  return guessUniqueMethod(ctx, site, callee.prop);
}

function resolveThisField(ctx: Ctx, file: string, site: CallSite, callee: Extract<Callee, { kind: "this-field" }>): ResolvedCall | null {
  const fi = ctx.index.get(file);
  const cls = classOfCaller(site.caller);
  if (fi && cls) {
    const field = fi.classFields.find((f) => f.className === cls && f.field === callee.field);
    if (field) {
      const hit = resolveClassMethod(ctx, file, field.typeName, callee.prop);
      if (hit) return exact(ctx, site, hit, "di");
    }
  }
  return guessUniqueMethod(ctx, site, callee.prop);
}

function resolveOther(ctx: Ctx, site: CallSite, callee: Extract<Callee, { kind: "other" }>): ResolvedCall | null {
  return callee.prop ? guessUniqueMethod(ctx, site, callee.prop) : null;
}

function resolveOne(ctx: Ctx, file: string, site: CallSite): ResolvedCall | null {
  const callee = site.callee;
  switch (callee.kind) {
    case "ident": return resolveIdent(ctx, file, site, callee);
    case "member": return resolveMember(ctx, file, site, callee);
    case "new-member": return resolveNewMember(ctx, file, site, callee);
    case "this": return resolveThis(ctx, file, site, callee);
    case "this-field": return resolveThisField(ctx, file, site, callee);
    case "other": return resolveOther(ctx, site, callee);
  }
}

type Caller = { from: SymbolRef; call: ResolvedCall };

/** callersOf order: caller file, caller symbol, call line (code-point compare), so walkCallers'
 * parents/vias never depend on index insertion order. */
function compareCallers(a: Caller, b: Caller): number {
  return compare(a.from.file, b.from.file) || compare(a.from.symbol, b.from.symbol) || a.call.site.line - b.call.site.line;
}

export function createCallResolver(input: RepoResolveInput): CallResolver {
  const ctx: Ctx = { ...input, methods: buildMethodMap(input.index), exportMemo: new Map() };
  let reverse: Map<string, Caller[]> | null = null;

  function buildReverse(): Map<string, Caller[]> {
    const map = new Map<string, Caller[]>();
    for (const [file, fi] of input.index) {
      for (const site of fi.calls) {
        const rc = resolveOne(ctx, file, site);
        if (!rc) continue;
        const key = `${rc.target.file}#${rc.target.symbol}`;
        const from: SymbolRef = { repo: input.repo, file, symbol: site.caller };
        const arr = map.get(key) ?? [];
        arr.push({ from, call: rc });
        map.set(key, arr);
      }
    }
    for (const arr of map.values()) arr.sort(compareCallers);
    return map;
  }

  return {
    resolve: (file, site) => resolveOne(ctx, file, site),
    callsFrom(ref) {
      const fi = input.index.get(ref.file);
      if (!fi) return [];
      const out: ResolvedCall[] = [];
      for (const site of fi.calls) {
        if (site.caller !== ref.symbol) continue;
        const rc = resolveOne(ctx, ref.file, site);
        if (rc) out.push(rc);
      }
      return out.sort((a, b) => a.site.line - b.site.line);
    },
    callersOf(ref) {
      reverse ??= buildReverse();
      return reverse.get(`${ref.file}#${ref.symbol}`) ?? [];
    },
    resolveExport(file, exportedName) {
      const hit = resolveExportIn(ctx, file, exportedName, 0);
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
