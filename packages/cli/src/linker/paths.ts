import type { Confidence, HttpMethod } from "../store/schemas.js";
import { compare } from "../util.js";

export type Segment = { kind: "literal"; value: string } | { kind: "param"; name: string } | { kind: "splat"; name: string };

export function parsePath(path: string): Segment[] {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const parts = trimmed.split("/").filter((p) => p.length > 0);
  return parts.map((p): Segment => {
    const namedSplat = p.match(/^:(.+)\*$/);
    if (namedSplat) return { kind: "splat", name: namedSplat[1]! };
    if (p === "*" || p === "(.*)") return { kind: "splat", name: "*" };
    const param = p.match(/^:(.+)$/);
    if (param) return { kind: "param", name: param[1]! };
    return { kind: "literal", value: p };
  });
}

export function joinPaths(...parts: string[]): string {
  const segs = parts
    .flatMap((p) => p.split("/"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segs.length === 0 ? "/" : `/${segs.join("/")}`;
}

export interface PathMatch {
  confidence: Confidence;
  literals: number;
  reason?: string;
}

function rank(c: Confidence): number {
  return c === "exact" ? 0 : c === "param" ? 1 : 2;
}
/** The less certain of two confidences (exact < param < guess). */
export function worse(a: Confidence, b: Confidence): Confidence {
  return rank(a) >= rank(b) ? a : b;
}

interface SegMatch {
  confidence: Confidence;
  literals: number;
}

/** Recursive segment matcher: `route` must consume `call` exactly (a splat may consume zero or more
 * of the remaining call segments). literal=literal -> exact + 1 literal; call literal vs route
 * param/splat -> param; call param vs route literal -> guess; two dynamic segments -> exact, no
 * literal credit. Returns null when the shapes cannot line up (lengths mismatch with no splat to
 * absorb the difference, or a literal mismatch). */
function matchSegments(call: Segment[], route: Segment[]): SegMatch | null {
  if (route.length === 0) return call.length === 0 ? { confidence: "exact", literals: 0 } : null;
  const [rHead, ...rTail] = route as [Segment, ...Segment[]];
  if (rHead.kind === "splat") {
    let best: SegMatch | null = null;
    for (let consumed = 0; consumed <= call.length; consumed++) {
      const rest = matchSegments(call.slice(consumed), rTail);
      if (!rest) continue;
      const confidence = consumed > 0 ? worse(rest.confidence, "param") : rest.confidence;
      const combined: SegMatch = { confidence, literals: rest.literals };
      if (!best || combined.literals > best.literals || (combined.literals === best.literals && rank(combined.confidence) < rank(best.confidence))) {
        best = combined;
      }
    }
    return best;
  }
  if (call.length === 0) return null;
  const [cHead, ...cTail] = call as [Segment, ...Segment[]];
  const tail = matchSegments(cTail, rTail);
  if (!tail) return null;
  if (rHead.kind === "literal") {
    if (cHead.kind === "literal") {
      return cHead.value === rHead.value ? { confidence: tail.confidence, literals: tail.literals + 1 } : null;
    }
    return { confidence: worse(tail.confidence, "guess"), literals: tail.literals };
  }
  // rHead.kind === "param"
  if (cHead.kind === "literal") return { confidence: worse(tail.confidence, "param"), literals: tail.literals };
  return { confidence: tail.confidence, literals: tail.literals };
}

export function matchPath(callPath: string, routePath: string): PathMatch | null {
  const m = matchSegments(parsePath(callPath), parsePath(routePath));
  if (!m) return null;
  return m.confidence === "guess" ? { ...m, reason: "call segment is a variable" } : m;
}

/** Match `routePath` against the *tail* of `callPath` only (the call's leading segments are an
 * unknown mount prefix). Not supported when the route itself contains a splat (its own length
 * against the tail would be ambiguous). */
function matchSuffix(callPath: string, routePath: string): SegMatch | null {
  const call = parsePath(callPath);
  const route = parsePath(routePath);
  if (route.length === 0 || route.length > call.length) return null;
  if (route.some((s) => s.kind === "splat")) return null;
  return matchSegments(call.slice(call.length - route.length), route);
}

export function methodMatches(call: HttpMethod, route: HttpMethod): boolean {
  return call === "ANY" || route === "ANY" || call === route;
}

export interface RouteCandidate<T> {
  item: T;
  method: HttpMethod;
  path: string;
  mountsKnown: boolean;
}

/** Equal-rank tie-break (radix-router style, left to right): the route whose literal segment equals the
 * call's literal at the first position where the tied routes differ wins. Returns the winner's index, or
 * undefined when no single route wins (same literal positions) or a route has a splat (positions are
 * then ambiguous). */
function leftmostLiteralWinner(callPath: string, routePaths: string[]): number | undefined {
  const call = parsePath(callPath);
  const routes = routePaths.map(parsePath);
  if (routes.some((r) => r.length !== call.length || r.some((s) => s.kind === "splat"))) return undefined;
  let alive = routes.map((_, i) => i);
  for (let pos = 0; pos < call.length && alive.length > 1; pos++) {
    const c = call[pos]!;
    const lit = alive.filter((i) => {
      const s = routes[i]![pos]!;
      return c.kind === "literal" && s.kind === "literal" && s.value === c.value;
    });
    if (lit.length > 0 && lit.length < alive.length) alive = lit;
  }
  return alive.length === 1 ? alive[0] : undefined;
}

export function pickRoute<T>(
  method: HttpMethod,
  callPath: string,
  candidates: RouteCandidate<T>[],
): { item: T; match: PathMatch } | null {
  type Scored = { candidate: RouteCandidate<T>; match: PathMatch };
  const known: Scored[] = [];
  const suffixOnly: Scored[] = [];
  for (const c of candidates) {
    if (!methodMatches(method, c.method)) continue;
    if (c.mountsKnown) {
      const m = matchPath(callPath, c.path);
      if (m) known.push({ candidate: c, match: m });
    } else {
      const m = matchSuffix(callPath, c.path);
      if (m) suffixOnly.push({ candidate: c, match: { confidence: m.confidence, literals: m.literals } });
    }
  }
  if (known.length > 0) {
    // Most literal segments first, then the better match confidence (exact > param > guess).
    known.sort((a, b) => b.match.literals - a.match.literals || rank(a.match.confidence) - rank(b.match.confidence) ||
      compare(a.candidate.path, b.candidate.path));
    const best = known[0]!;
    const tied = known.filter((k) => k.match.literals === best.match.literals && k.match.confidence === best.match.confidence);
    if (tied.length > 1) {
      const winner = leftmostLiteralWinner(callPath, tied.map((t) => t.candidate.path));
      if (winner !== undefined && best.match.confidence !== "guess") {
        const w = tied[winner]!;
        return { item: w.candidate.item, match: {
          confidence: worse(w.match.confidence, "param"), literals: w.match.literals, reason: "literal segment preferred over a parameter",
        } };
      }
      return { item: best.candidate.item, match: { confidence: "guess", literals: best.match.literals, reason: "tie between equally specific routes" } };
    }
    if (best.match.confidence === "guess" && known.length > 1) return null;
    return { item: best.candidate.item, match: best.match };
  }
  if (suffixOnly.length === 1) {
    const only = suffixOnly[0]!;
    return { item: only.candidate.item, match: { confidence: "guess", literals: only.match.literals, reason: "suffix match under unknown mount" } };
  }
  return null;
}
