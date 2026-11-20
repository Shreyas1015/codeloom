import { compare } from "../util.js";
import { ancestors, downstream, isWrite } from "./paths.js";
import type { Review, ReviewStop } from "./types.js";

/** Nodes shown before "+N more — see the full map" (PR review maps design §4). */
const DEFAULT_MAX_NODES = 30;

const CHANGED_CLASS_DEF = "classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px";

/** Mermaid decodes `#name;`/`#NNN;` sequences itself (the same codes as HTML entities, minus the leading
 * `&`); using that form (not `&quot;`/`&#96;`) consistently is what actually survives Mermaid's own
 * parser. A literal `#` is escaped first, so a label that already contains text like "#91;" isn't
 * decoded into "[" by Mermaid — only entities THIS function produced are real. A newline is flattened to a
 * space first too: a raw one inside a quoted Mermaid label breaks the diagram's own line-based syntax. */
export function escapeMermaidLabel(s: string): string {
  return s
    .replace(/\r?\n/g, " ")
    .replace(/#/g, "#35;")
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\|/g, "#124;");
}

/** A Mermaid `flowchart LR` of every chain in `review.chains`, laid out in each chain's own stop order
 * (review.chainStops; page → call → route → handler → … → table/queue, the linker's own order), stops
 * shared by more than one chain (same ReviewStop.ref) drawn once, edges from each stop's real predecessor
 * (ReviewStop.from — I1: not just the previous array entry, so a chain that branches, e.g. a handler with
 * two db writes, draws two edges from the handler rather than one straight line through both writes).
 * A stop with `changed: true` gets a ✏️ prefix and the `changed` style. At most `maxNodes` nodes; the rest
 * collapse into one "+N more" node. Returns a fenced ```mermaid block, ready to paste into a PR
 * description. Review is self-contained: no MapState needed (PR review maps design §5 — the publish step
 * renders this from data/review.json alone). */
export function renderMermaid(review: Review, maxNodes = DEFAULT_MAX_NODES): string {
  const ids = new Map<string, string>();
  const stopsByRef = new Map<string, ReviewStop>();
  const changed = new Set<string>();
  const edges: string[] = [];
  const seenEdges = new Set<string>();

  const idFor = (ref: string): string => {
    let id = ids.get(ref);
    if (id === undefined) {
      id = `n${ids.size + 1}`;
      ids.set(ref, id);
    }
    return id;
  };

  for (const chainId of review.chains) {
    // Own-key lookup only (security review I1'a): review.chainStops is a plain object, and a chain id
    // that collides with an inherited Object.prototype property name (e.g. "constructor") would
    // otherwise resolve to that inherited FUNCTION instead of undefined — `?? []` never catches that,
    // since a function is never nullish, and stops.forEach would then throw.
    const stops = Object.hasOwn(review.chainStops, chainId) ? review.chainStops[chainId]! : [];
    const idAt: string[] = [];
    stops.forEach((s, i) => {
      const id = idFor(s.ref);
      idAt[i] = id;
      if (!stopsByRef.has(s.ref)) stopsByRef.set(s.ref, s);
      if (s.changed) changed.add(s.ref);
      const fromId = s.from !== undefined ? idAt[s.from] : undefined;
      if (fromId !== undefined && fromId !== id) {
        const edge = `${fromId} --> ${id}`;
        if (!seenEdges.has(edge)) {
          seenEdges.add(edge);
          edges.push(edge);
        }
      }
    });
  }

  const allRefs = [...ids.keys()];
  const shown = allRefs.slice(0, maxNodes);
  const shownIds = new Set(shown.map((ref) => ids.get(ref)!));
  const lines: string[] = ["```mermaid", "flowchart LR"];
  for (const ref of shown) {
    const id = ids.get(ref)!;
    const label = escapeMermaidLabel(stopsByRef.get(ref)!.label);
    const text = changed.has(ref) ? `✏️ ${label}` : label;
    lines.push(changed.has(ref) ? `${id}["${text}"]:::changed` : `${id}["${text}"]`);
  }
  const hidden = allRefs.length - shown.length;
  if (hidden > 0) lines.push(`n${shown.length + 1}["+${hidden} more — see the full map"]`);
  for (const edge of edges) {
    const [from, to] = edge.split(" --> ");
    if (shownIds.has(from!) && shownIds.has(to!)) lines.push(edge);
  }
  if ([...changed].some((ref) => shownIds.has(ids.get(ref)!))) lines.push(CHANGED_CLASS_DEF);
  lines.push("```");
  return lines.join("\n");
}

/** Nodes the 0.5 draft's changed-path diagram shows before "+N more" (spec §2). */
export const DRAFT_MAX_NODES = 8;

/** Stop kinds the changed-path diagram keeps on the way to a changed stop (besides the chain's own entry,
 * the changed stops and what they write): UI helper functions, call sites and unchanged plain functions are
 * skipped, so a reviewer sees "entry → route → handler → ✏️ changed → table". */
const PATH_KINDS = new Set(["route", "handler", "consume"]);

/** Whether stop `i` of a chain is drawn, given it is on a changed path. A 0.4 review.json has no `kind`:
 * then the api lane stands in for "route". */
function drawn(stops: readonly ReviewStop[], i: number): boolean {
  const s = stops[i]!;
  // 0.6: a service's outgoing call is the function it sits in calling another repo's route: the edge from that
  // function to the route shows it, not a second box of the same function.
  if (i > 0 && s.kind === "call" && s.lane === "code") return false;
  if (i === 0 || s.changed || isWrite(s)) return true;
  return s.kind !== undefined ? PATH_KINDS.has(s.kind) : s.lane === "api";
}

/** The 0.5 draft's diagram (spec §2): only the changed path — each touched chain's entry point → … → each
 * changed stop → the tables/queues it writes after it (never past a queue's consumer, never reads), shared
 * stops drawn once, edges from the nearest drawn predecessor. Chains named by a journey come first. At most
 * `maxNodes` nodes, then one "+N more" node. When cut: the changed stops come first and are guaranteed the
 * slots entries do not reserve; entries reserve at most half the slots (one per drawn chain while there is
 * room, at least one) and are drawn only for chains whose changed stop is drawn — so a changed function
 * reached from many routes never loses its ✏️ box to them, and a reviewer still sees how it is reached; then
 * (0.6) the other repos' routes the changed stops call; then what the changed stops write; then whatever else
 * fits. Edges connect only what is drawn. Empty string when
 * no chain has a changed stop. Every label goes through escapeMermaidLabel, as in renderMermaid. */
export function renderChangedPath(review: Review, maxNodes = DRAFT_MAX_NODES): string {
  const named = new Map<string, string>();
  for (const j of [...review.journeys].sort((a, b) => compare(a.name, b.name))) {
    for (const id of j.chains) if (!named.has(id)) named.set(id, j.name);
  }
  const chainOrder = [...review.chains].sort((a, b) => {
    const na = named.get(a);
    const nb = named.get(b);
    if ((na === undefined) !== (nb === undefined)) return na === undefined ? 1 : -1;
    return compare(na ?? "", nb ?? "") || compare(a, b);
  });

  /** Every drawn stop's ref, in first-seen order (render order, left to right). */
  const order: string[] = [];
  const stopsByRef = new Map<string, ReviewStop>();
  /** Selection: changed stops, then entries (per chain, only once one of its changed stops is drawn), then
   * their writes, then whatever else is on the path — each ref classified once, by the first chain that draws
   * it; a changed stop is always "changed", even as its chain's own first stop. */
  const writeRefs: string[] = [];
  /** 0.6: another repo's route a changed stop calls (a service hop): drawn before the writes. */
  const hopRefs: string[] = [];
  const restRefs: string[] = [];
  const ranked = new Set<string>();
  /** Per drawn chain: its own entry's ref (unless that entry is itself changed) and its changed stops' refs. */
  const chainEntries: Array<{ entry?: string; changed: string[] }> = [];
  /** Per chain: its stops, the path indices, and which of those are drawn — for the edges, once the shown
   * set is known. */
  const paths: Array<{ stops: ReviewStop[]; onPath: Set<number>; drawnIdx: number[] }> = [];

  for (const chainId of chainOrder) {
    // Own-key lookup only, as in renderMermaid (security review I1'a).
    const stops = Object.hasOwn(review.chainStops, chainId) ? review.chainStops[chainId]! : [];
    if (!Array.isArray(stops)) continue;
    const onPath = new Set<number>();
    const changedIdx = new Set<number>();
    const writeIdx = new Set<number>();
    const hopIdx = new Set<number>();
    stops.forEach((s, i) => {
      if (!s.changed) return;
      onPath.add(i);
      changedIdx.add(i);
      for (const a of ancestors(stops, i)) onPath.add(a);
      for (const d of downstream(stops, i)) {
        const t = stops[d]!;
        if (t.kind === "route" && t.repo !== s.repo) {
          onPath.add(d);
          hopIdx.add(d);
          for (const a of ancestors(stops, d)) onPath.add(a);
        }
        if (!isWrite(stops[d]!)) continue;
        onPath.add(d);
        writeIdx.add(d);
        for (const a of ancestors(stops, d)) onPath.add(a);
      }
    });
    const drawnIdx = [...onPath].sort((a, b) => a - b).filter((i) => drawn(stops, i));
    if (drawnIdx.length === 0) continue;
    const mine: { entry?: string; changed: string[] } = { changed: [] };
    for (const i of drawnIdx) {
      const s = stops[i]!;
      if (!stopsByRef.has(s.ref)) {
        stopsByRef.set(s.ref, s);
        order.push(s.ref);
      }
      if (changedIdx.has(i)) mine.changed.push(s.ref);
      else if (i === 0) mine.entry = s.ref;
      if (ranked.has(s.ref)) continue;
      ranked.add(s.ref);
      if (changedIdx.has(i) || i === 0) continue; // changed stops and entries are picked per chain below
      if (hopIdx.has(i)) hopRefs.push(s.ref);
      else if (writeIdx.has(i)) writeRefs.push(s.ref);
      else restRefs.push(s.ref);
    }
    chainEntries.push(mine);
    paths.push({ stops, onPath, drawnIdx });
  }

  if (order.length === 0) return "";
  const shownRefs = new Set<string>();
  if (order.length <= maxNodes) {
    for (const ref of order) shownRefs.add(ref);
  } else {
    const wantEntries = new Set(chainEntries.flatMap((c) => (c.entry !== undefined ? [c.entry] : []))).size;
    const entrySlots = Math.min(wantEntries, Math.max(1, Math.floor(maxNodes / 2)));
    const add = (ref: string): void => {
      if (shownRefs.size < maxNodes) shownRefs.add(ref);
    };
    // Changed stops round-robin across chains (each chain's first changed stop, then each one's second, …), so
    // every drawn chain gets one drawn — and so its entry — while there is room.
    const changedPick: string[] = [];
    const picked = new Set<string>();
    const longest = Math.max(0, ...chainEntries.map((c) => c.changed.length));
    for (let k = 0; k < longest; k++) {
      for (const c of chainEntries) {
        const ref = c.changed[k];
        if (ref !== undefined && !picked.has(ref)) {
          picked.add(ref);
          changedPick.push(ref);
        }
      }
    }
    for (const ref of changedPick.slice(0, Math.max(1, maxNodes - entrySlots))) add(ref);
    let entries = 0;
    for (const c of chainEntries) {
      if (entries >= entrySlots || c.entry === undefined || shownRefs.has(c.entry)) continue;
      if (!c.changed.some((ref) => shownRefs.has(ref))) continue;
      add(c.entry);
      entries++;
    }
    for (const ref of [...hopRefs, ...writeRefs, ...restRefs]) add(ref);
  }
  const ids = new Map(order.map((ref, i) => [ref, `n${i + 1}`]));

  const edges: string[] = [];
  const seenEdges = new Set<string>();
  for (const { stops, onPath, drawnIdx } of paths) {
    const drawnSet = new Set(drawnIdx);
    for (const i of drawnIdx) {
      const ref = stops[i]!.ref;
      if (!shownRefs.has(ref)) continue;
      const prev = ancestors(stops, i)
        .reverse()
        .find((a) => onPath.has(a) && drawnSet.has(a) && shownRefs.has(stops[a]!.ref));
      if (prev === undefined) continue;
      const edge = `${ids.get(stops[prev]!.ref)!} --> ${ids.get(ref)!}`;
      if (stops[prev]!.ref !== ref && !seenEdges.has(edge)) {
        seenEdges.add(edge);
        edges.push(edge);
      }
    }
  }

  const lines: string[] = ["```mermaid", "flowchart LR"];
  let anyChanged = false;
  for (const ref of order) {
    if (!shownRefs.has(ref)) continue;
    const stop = stopsByRef.get(ref)!;
    const label = escapeMermaidLabel(stop.label);
    if (stop.changed) {
      anyChanged = true;
      lines.push(`${ids.get(ref)!}["✏️ ${label}"]:::changed`);
    } else {
      lines.push(`${ids.get(ref)!}["${label}"]`);
    }
  }
  const hidden = order.length - shownRefs.size;
  if (hidden > 0) lines.push(`n${order.length + 1}["+${hidden} more"]`);
  lines.push(...edges);
  if (anyChanged) lines.push(CHANGED_CLASS_DEF);
  lines.push("```");
  return lines.join("\n");
}
