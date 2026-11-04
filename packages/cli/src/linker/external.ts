import type { ExternalCallFact } from "../store/schemas.js";
import { compare } from "../util.js";
import type { UiLink } from "./link.js";

/** The display name of an other-service call: the workspace file's `external` name, else its base. */
export function externalLabel(f: Pick<ExternalCallFact, "base" | "name">): string {
  return f.name ?? f.base;
}

/** One fact per UI call that goes to another service (linkUi's `external` targets), with the pages that
 * reach it. A call site linked more than once (same repo, file, line, method, path, base) is one fact. */
export function externalCallFacts(ui: UiLink[]): ExternalCallFact[] {
  const byKey = new Map<string, ExternalCallFact>();
  for (const link of ui) {
    if (link.target.kind !== "external") continue;
    const { call, target } = link;
    const key = [link.repo, call.at.file, String(call.at.line), call.method, call.path, target.base].join("\0");
    const prev = byKey.get(key);
    const pages = new Set([...(prev?.pages ?? []), ...link.pages.map((p) => p.page.route)]);
    byKey.set(key, {
      repo: link.repo, file: call.at.file, line: call.at.line, symbol: call.at.symbol,
      method: call.method, path: call.path, base: target.base,
      ...(target.name !== undefined ? { name: target.name } : {}),
      pages: [...pages].sort(compare),
    });
  }
  return [...byKey.values()].sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file) || a.line - b.line
    || compare(a.method, b.method) || compare(a.path, b.path) || compare(a.base, b.base));
}
