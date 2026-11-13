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
