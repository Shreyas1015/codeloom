// Walking one chain's stops along their real predecessor links (`from`), shared by build.ts (what the
// changed code writes / only reads) and mermaid.ts (the 0.5 draft's changed-path diagram). Works on both
// ChainStop (store/schemas.ts) and ReviewStop (types.ts): only lane/kind/op/from are read.

import { compare } from "../util.js";
import type { Review, ReviewNodeChange } from "./types.js";

export interface WalkStop {
  lane: string;
  kind?: string;
  op?: string;
  from?: number;
}

const DB_WRITE_OPS = new Set(["insert", "update", "delete", "upsert"]);

/** A db stop that changes a table (insert/update/delete/upsert) or a queue stop that publishes. */
export function isWrite(s: WalkStop): boolean {
  if (s.lane === "db") return s.op !== undefined && DB_WRITE_OPS.has(s.op);
  if (s.lane === "queue") return s.op === "publish" || s.kind === "publish";
  return false;
}

/** A db stop that only reads its table. */
export function isRead(s: WalkStop): boolean {
  return s.lane === "db" && s.op === "read";
}

/** A queue consumer: the start of a separate flow on the far side of a queue. */
export function isConsume(s: WalkStop): boolean {
  return s.lane === "queue" && (s.op === "consume" || s.kind === "consume");
}

/** Indices of the stops reached (directly or not) from stop `i` of this chain, in chain order — never past
 * a queue consumer (what a consumer then does is another flow's work, not this stop's). */
export function downstream(stops: readonly WalkStop[], i: number): number[] {
  const reached = new Set<number>([i]);
  const out: number[] = [];
  for (let j = i + 1; j < stops.length; j++) {
    const s = stops[j]!;
    if (s.from === undefined || !reached.has(s.from) || isConsume(s)) continue;
    reached.add(j);
    out.push(j);
  }
  return out;
}

/** Indices of the stops on the way from the chain's first stop to stop `i` (not `i` itself), first first. */
export function ancestors(stops: readonly WalkStop[], i: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([i]);
  let at = stops[i]?.from;
  while (at !== undefined && at >= 0 && at < stops.length && !seen.has(at)) {
    seen.add(at);
    out.push(at);
    at = stops[at]!.from;
  }
  return out.reverse();
}

export const FILE_KINDS = ["code", "tests", "docs", "config", "migrations", "other"] as const;

/** A rough kind for a changed file (repo- or root-relative, "/"-separated): the draft's "Also changed" line,
 * and build.ts skipping tests and docs before looking for deploy risks. Tests and docs win over a folder
 * name, so `docs/migrations/upgrade.md` is docs and `test/fixtures/seed.sql` is tests, never a migration. */
export function fileKind(path: string): (typeof FILE_KINDS)[number] {
  const segs = path.split("/");
  const name = segs.at(-1)!;
  const dirs = segs.slice(0, -1);
  if (dirs.some((d) => d === "test" || d === "tests" || d === "__tests__" || d === "spec" || d === "__mocks__") || /\.(test|spec)\.[^.]+$/.test(name)) return "tests";
  if (/\.(md|mdx|rst|txt|adoc)$/i.test(name) || dirs.includes("docs") || dirs.includes("doc")) return "docs";
  if (dirs.includes("migrations")) return "migrations";
  if (name.startsWith(".") || /\.(json|ya?ml|toml|ini|lock|env)$/i.test(name) || /config/i.test(name) || /^Dockerfile/i.test(name)) return "config";
  if (/\.(?:[cm]?[jt]sx?|py|rb|go|vue|svelte|php|java|kt|cs|rs|css|scss|html|sql|prisma)$/.test(name)) return "code";
  return "other";
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0);

/** Code to check's order (the draft and the check packet alike): changed functions a touched chain stops at
 * first (its own stop, or its own call — a call changed through its function carries that function's name),
 * then the other changed ones, then new, then deleted; bigger changes first within each. So a big new file's
 * functions never push the changed callers out of the first 8. */
export function codeToCheckOrder(review: Review): ReviewNodeChange[] {
  const stopRefs = new Set<string>();
  const callers = new Set<string>();
  for (const id of review.chains) {
    const stops = Object.hasOwn(review.chainStops, id) ? review.chainStops[id]! : [];
    if (!Array.isArray(stops)) continue;
    for (const s of stops) {
      stopRefs.add(s.ref);
      if (s.kind === "call" && s.changed) callers.add(`${s.repo}\0${s.file ?? ""}\0${s.label}`);
    }
  }
  const rank = (n: ReviewNodeChange): number => {
    if (n.before === null) return 2;
    if (n.after === null) return 3;
    const onChain = stopRefs.has(n.ref) || callers.has(`${n.repo}\0${n.file}\0${n.symbol}`) || (Array.isArray(n.journeys) && n.journeys.length > 0);
    return onChain ? 0 : 1;
  };
  return [...review.nodes].sort(
    (a, b) => rank(a) - rank(b) || count(b.added) + count(b.removed) - (count(a.added) + count(a.removed)) || compare(String(a.ref), String(b.ref)),
  );
}
