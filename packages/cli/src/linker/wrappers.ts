import { absoluteHost, normalizePath } from "../adapters/ast.js";
import type { Confidence, HttpCall } from "../store/schemas.js";
import { compare } from "../util.js";
import type { HttpWrapper } from "./code-index.js";
import type { ConfigArg } from "./config-wrappers.js";
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
 * A call to a config-object wrapper (`httpClient({ method, url })`): method from the caller's config
 * (unless the wrapper fixes it; default GET), url from its `url`. A config whose method or url cannot be
 * read gives an unknown-kind call. The wrapper's inner call names the real client instance.
 */
function derivedFromConfig(
  wrapper: HttpWrapper, wrapperKey: string, client: string, file: string, line: number, caller: string,
  arg: ConfigArg | undefined, confidence: Confidence,
): LinkedCall {
  const at = { file, line, symbol: caller };
  const method = wrapper.methodFixed ? wrapper.method : arg?.method ?? "GET";
  const common = { method, client, at, via: "wrapper" as const, wrapper: wrapperKey, confidence };
  if (!arg?.url || (arg.methodUnknown && !wrapper.methodFixed)) {
    return { ...common, path: "", raw: arg?.url?.raw ?? "", resolved: false, kind: "unknown" };
  }
  const base = arg.url.base ?? wrapper.base;
  return {
    ...common, path: arg.url.path, raw: arg.url.raw, resolved: arg.url.resolved, kind: arg.url.kind,
    ...(base !== undefined ? { base } : {}),
  };
}

/**
 * Every resolved call to an HTTP wrapper becomes an HTTP call at the caller: with a literal/template URL
 * argument it carries that path (after the wrapper's literal base); with anything else it is an
 * unknown-kind call, which the linker reports unresolved. Confidence: the call resolution's, capped at
 * "param". Calls from inside a wrapper to itself are skipped. Sorted by file, line, symbol.
 *
 * A config-object wrapper counts only when `adapterCalls` holds an HTTP call at its inner call (the
 * adapter has checked that the callee is an HTTP client); without `adapterCalls` none count.
 */
export function wrapperCalls(resolver: CallResolver, adapterCalls: HttpCall[] = []): LinkedCall[] {
  const out: LinkedCall[] = [];
  const adapterAt = new Map(adapterCalls.map((c) => [`${c.at.file}:${c.at.line}`, c]));
  for (const file of resolver.indexedFiles()) {
    for (const site of resolver.fileIndex(file)?.calls ?? []) {
      // A wrapper handed to JSX (`onClick={apiGet}`) is not called here, with no URL argument.
      if (site.kind !== undefined) continue;
      const rc = resolver.resolve(file, site);
      if (!rc) continue;
      const wrapper = resolver.fileIndex(rc.target.file)?.wrappers?.find((w) => w.symbol === rc.target.symbol);
      if (!wrapper) continue;
      if (rc.target.file === file && rc.target.symbol === site.caller) continue;
      const key = `${rc.target.file}#${rc.target.symbol}`;
      const confidence = worse(rc.confidence, "param");
      if (wrapper.config) {
        const inner = adapterAt.get(`${rc.target.file}:${wrapper.line}`);
        if (!inner) continue;
        const arg = site.configArgs?.find((a) => a.index === wrapper.param);
        out.push(derivedFromConfig(wrapper, key, inner.client, file, site.line, site.caller, arg, confidence));
        continue;
      }
      const arg = site.urlArgs?.find((a) => a.index === wrapper.param);
      out.push(derived(wrapper, key, file, site.line, site.caller, arg, confidence));
    }
  }
  return out.sort((a, b) => compare(a.at.file, b.at.file) || a.at.line - b.at.line || compare(a.at.symbol, b.at.symbol));
}
