import { formatNodeRef, type MapState } from "../mcp/state.js";
import type { ChainStop } from "../store/schemas.js";
import type { Review } from "./types.js";

/** Nodes shown before "+N more — see the full map" (PR review maps design §4). */
const DEFAULT_MAX_NODES = 30;

const CHANGED_CLASS_DEF = "classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px";

/** Mermaid node labels are plain text between quotes: escape the characters that would otherwise end the
 * quoted string, read as a shape (`[`, `]`, `|`) or carry HTML/script through to the rendered page. */
export function escapeMermaidLabel(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\|/g, "#124;");
}

/** A stable identity for a chain stop, so the same function, table or queue reached by more than one chain
 * collapses into one diagram node. Stops on a graph node share its ref; others (db/queue) share repo + lane
 * + label. */
function stopKey(s: ChainStop): string {
  return s.nodeId !== undefined ? formatNodeRef({ repo: s.repo, nodeId: s.nodeId }) : `${s.repo}::${s.lane}:${s.label ?? s.symbol}`;
}

function stopLabel(s: ChainStop): string {
  const base = s.label ?? s.symbol;
  return s.op !== undefined && (s.lane === "db" || s.lane === "queue") ? `${base} (${s.op})` : base;
}

/** A Mermaid `flowchart LR` of every chain in `review.chains`, laid out in each chain's own stop order
 * (page → call → route → handler → … → table/queue, mcp/state.ts / the linker already orders them this
 * way), stops shared by more than one chain drawn once. A node whose ref is a changed node
 * (review.nodes) gets a ✏️ prefix and the `changed` style. At most `maxNodes` nodes; the rest collapse into
 * one "+N more" node. Returns a fenced ```mermaid block, ready to paste into a PR description. */
export function renderMermaid(review: Review, state: MapState, maxNodes = DEFAULT_MAX_NODES): string {
  const changedRefs = new Set(review.nodes.map((n) => n.ref));
  const chainsById = new Map(state.chains.map((c) => [c.id, c]));

  const ids = new Map<string, string>();
  const labels = new Map<string, string>();
  const changed = new Set<string>();
  const edges: string[] = [];
  const seenEdges = new Set<string>();

  const idFor = (key: string): string => {
    let id = ids.get(key);
    if (id === undefined) {
      id = `n${ids.size + 1}`;
      ids.set(key, id);
    }
    return id;
  };

  for (const chainId of review.chains) {
    const chain = chainsById.get(chainId);
    if (!chain) continue;
    const keyOf: string[] = [];
    chain.stops.forEach((s, i) => {
      const key = stopKey(s);
      keyOf[i] = key;
      const id = idFor(key);
      if (!labels.has(key)) labels.set(key, stopLabel(s));
      const ref = s.nodeId !== undefined ? formatNodeRef({ repo: s.repo, nodeId: s.nodeId }) : undefined;
      if (ref !== undefined && changedRefs.has(ref)) changed.add(key);
      if (i > 0 && s.from !== undefined) {
        const fromId = idFor(keyOf[s.from]!);
        const edge = `${fromId} --> ${id}`;
        if (!seenEdges.has(edge)) {
          seenEdges.add(edge);
          edges.push(edge);
        }
      }
    });
  }

  const allKeys = [...ids.keys()];
  const shown = allKeys.slice(0, maxNodes);
  const shownIds = new Set(shown.map((k) => ids.get(k)!));
  const lines: string[] = ["```mermaid", "flowchart LR"];
  for (const key of shown) {
    const id = ids.get(key)!;
    const label = escapeMermaidLabel(labels.get(key)!);
    const text = changed.has(key) ? `✏️ ${label}` : label;
    lines.push(changed.has(key) ? `${id}["${text}"]:::changed` : `${id}["${text}"]`);
  }
  const hidden = allKeys.length - shown.length;
  if (hidden > 0) lines.push(`n${shown.length + 1}["+${hidden} more — see the full map"]`);
  for (const edge of edges) {
    const [from, to] = edge.split(" --> ");
    if (shownIds.has(from!) && shownIds.has(to!)) lines.push(edge);
  }
  if ([...changed].some((k) => shownIds.has(ids.get(k)!))) lines.push(CHANGED_CLASS_DEF);
  lines.push("```");
  return lines.join("\n");
}
