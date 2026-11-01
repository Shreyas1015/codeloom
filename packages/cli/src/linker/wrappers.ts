import { absoluteHost, normalizePath } from "../adapters/ast.js";
import type { Confidence, HttpCall } from "../store/schemas.js";
import { compare } from "../util.js";
import type { HttpWrapper } from "./code-index.js";
import { joinPaths, worse } from "./paths.js";
import type { CallResolver } from "./resolve-calls.js";

/**
 * An HTTP call as the UI linker sees it: an adapter call, or one derived from a call to an HTTP wrapper
 * function (H2). Derived calls carry `via: "wrapper"`, the wrapper they went through, the host of the
 * wrapper's literal base (if absolute), and a confidence that is never better than "param".
 */
export type LinkedCall = HttpCall & {
  via?: "wrapper";
  /** `file#symbol` of the wrapper, for diagnostics. */
  wrapper?: string;
  /** Host of the wrapper's absolute literal base, e.g. "conduit.productionready.io". */
  host?: string;
  /** Confidence of the call itself (wrapper-derived calls only). */
  confidence?: Confidence;
};

function derived(
  wrapper: HttpWrapper, wrapperKey: string, file: string, line: number, caller: string,
  arg: NonNullable<import("./code-index.js").CallSite["urlArgs"]>[number] | undefined, confidence: Confidence,
): LinkedCall {
  const at = { file, line, symbol: caller };
  const common = { method: wrapper.method, client: wrapper.client, at, via: "wrapper" as const, wrapper: wrapperKey, confidence };
  if (!arg) return { ...common, path: "", raw: "", resolved: false, kind: "unknown" };
  // The caller's own base (`requests.get(`${X}/a`)`) wins over the wrapper's.
  const ownBase = arg.base;
  const literal = ownBase === undefined ? wrapper.baseLiteral : undefined;
  const host = literal !== undefined ? absoluteHost(literal) : undefined;
  const base = ownBase ?? (literal === undefined ? wrapper.base : undefined);
  return {
    ...common,
    path: literal !== undefined ? joinPaths(normalizePath(literal), arg.path) : arg.path,
    raw: arg.raw,
    resolved: arg.resolved,
    kind: arg.kind,
    ...(base !== undefined ? { base } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

/**
 * Every resolved call to an HTTP wrapper becomes an HTTP call at the caller: with a literal/template URL
 * argument it carries that path (after the wrapper's literal base); with anything else it is an
 * unknown-kind call, which the linker reports unresolved. Confidence: the call resolution's, capped at
 * "param". Calls from inside a wrapper to itself are skipped. Sorted by file, line, symbol.
 */
export function wrapperCalls(resolver: CallResolver): LinkedCall[] {
  const out: LinkedCall[] = [];
  for (const file of resolver.indexedFiles()) {
    for (const site of resolver.fileIndex(file)?.calls ?? []) {
      const rc = resolver.resolve(file, site);
      if (!rc) continue;
      const wrapper = resolver.fileIndex(rc.target.file)?.wrappers?.find((w) => w.symbol === rc.target.symbol);
      if (!wrapper) continue;
      if (rc.target.file === file && rc.target.symbol === site.caller) continue;
      const arg = site.urlArgs?.find((a) => a.index === wrapper.param);
      out.push(derived(wrapper, `${rc.target.file}#${rc.target.symbol}`, file, site.line, site.caller, arg, worse(rc.confidence, "param")));
    }
  }
  return out.sort((a, b) => compare(a.at.file, b.at.file) || a.at.line - b.at.line || compare(a.at.symbol, b.at.symbol));
}
