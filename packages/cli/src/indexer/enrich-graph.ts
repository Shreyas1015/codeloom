import type { GraphEdge, GraphNode, KnowledgeGraph } from "@codeloom/core";
import type { RepoCodeIndex } from "../linker/code-index.js";
import type { CallResolver } from "../linker/resolve-calls.js";
import { compare } from "../util.js";

/** Edge weight per resolved-call confidence. Only these two become `calls` edges: a `guess` never does. */
const WEIGHT = { exact: 1, param: 0.6 } as const;
type EdgeConfidence = keyof typeof WEIGHT;

const fnId = (file: string, symbol: string) => `function:${file}:${symbol}`;

/**
 * v0.2a §1: add what the linker's code index knows to a repo's graph.json — a `function` node per class
 * method / object-literal method (`function:<file>:<Class.method>`, tag "method"), `contains` edges from
 * its file (and from its class node when one exists), and a `calls` edge per caller→callee pair the
 * resolver resolves `exact` or `param` (never `guess`), between function nodes of this repo.
 *
 * Pure: the input graph is not mutated. Existing nodes and edges keep their order and content; new nodes
 * and edges are appended in a fixed order (nodes by id; contains edges by target; calls edges by source,
 * target), so the output is a deterministic function of graph + code index. Idempotent: enriching an
 * enriched graph adds nothing. Layers are unchanged — they list file nodes only, and a method belongs to
 * its file's layer like every other function node.
 */
export function enrichGraph(graph: KnowledgeGraph, codeIndex: RepoCodeIndex, resolver: CallResolver): KnowledgeGraph {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edgeKeys = new Set(graph.edges.map((e) => `${e.type}|${e.source}|${e.target}`));
  const files = [...codeIndex.keys()].sort(compare);

  const newNodes: GraphNode[] = [];
  const newContains: GraphEdge[] = [];
  for (const file of files) {
    if (!ids.has(`file:${file}`)) continue;
    for (const s of codeIndex.get(file)!.symbols) {
      if (s.kind !== "method" && s.kind !== "object-method") continue;
      const id = fnId(file, s.name);
      if (ids.has(id)) continue; // a getter/setter pair, or a node that already exists
      ids.add(id);
      newNodes.push({
        id, type: "function", name: s.name, filePath: file, lineRange: [s.lines[0], s.lines[1]],
        summary: "", tags: ["method"], complexity: "simple",
      });
      const parents = [`file:${file}`];
      const cls = `class:${file}:${s.name.slice(0, s.name.indexOf("."))}`;
      if (s.kind === "method" && ids.has(cls)) parents.push(cls);
      for (const source of parents) newContains.push({ source, target: id, type: "contains", direction: "forward", weight: 1 });
    }
  }

  // Best confidence per (caller, callee) pair.
  const best = new Map<string, { source: string; target: string; confidence: EdgeConfidence }>();
  for (const file of files) {
    for (const site of codeIndex.get(file)!.calls) {
      const rc = resolver.resolve(file, site);
      if (!rc || (rc.confidence !== "exact" && rc.confidence !== "param")) continue;
      const source = fnId(file, site.caller);
      const target = fnId(rc.target.file, rc.target.symbol);
      if (!ids.has(source) || !ids.has(target)) continue;
      const key = `calls|${source}|${target}`;
      if (edgeKeys.has(key)) continue; // an existing calls edge (or one added before) stays as it is
      const prev = best.get(key);
      if (!prev || (prev.confidence === "param" && rc.confidence === "exact")) best.set(key, { source, target, confidence: rc.confidence });
    }
  }
  const newCalls: GraphEdge[] = [...best.values()]
    .sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target))
    .map((c) => ({ source: c.source, target: c.target, type: "calls", direction: "forward", weight: WEIGHT[c.confidence], description: c.confidence }));

  newNodes.sort((a, b) => compare(a.id, b.id));
  newContains.sort((a, b) => compare(a.target, b.target) || compare(a.source, b.source));
  return { ...graph, nodes: [...graph.nodes, ...newNodes], edges: [...graph.edges, ...newContains, ...newCalls] };
}
