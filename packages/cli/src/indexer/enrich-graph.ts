import type { GraphEdge, GraphNode, KnowledgeGraph } from "@codeloom/core";
import type { RepoCodeIndex } from "../linker/code-index.js";
import type { CallResolver } from "../linker/resolve-calls.js";
import { compare } from "../util.js";

/** Edge weight per resolved-call confidence. Only these two become `calls` edges: a `guess` never does. */
const WEIGHT = { exact: 1, param: 0.6 } as const;
type EdgeConfidence = keyof typeof WEIGHT;
/** Weight of a tree-sitter `calls` edge the resolver cannot check (a file it does not index). */
const UNVERIFIED_WEIGHT = 0.3;

const fnId = (file: string, symbol: string) => `function:${file}:${symbol}`;

/**
 * v0.2a §1: add what the linker's code index knows to a repo's graph.json — a `function` node per class
 * method / object-literal method (`function:<file>:<Class.method>`, tag "method"), `contains` edges from
 * its file (and from its class node when one exists), and a `calls` edge per caller→callee pair the
 * resolver resolves `exact` or `param` (never `guess`), between function nodes of this repo. Existing tree-sitter
 * `calls` edges are checked against the resolver: confirmed ones get its confidence, unconfirmed ones between two
 * indexed (JS/TS) files are dropped, and ones touching an unindexed file stay as `description: "unverified"`.
 *
 * Pure: the input graph is not mutated. Existing nodes and non-calls edges keep their order and content; new nodes
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

  // Best confidence per (caller, callee) pair the resolver confirms. The call must sit inside the caller node's
  // lines: a nested `function submit()` shares its name with a top-level `submit`, and only its own node may
  // carry its calls.
  const rangeOf = new Map(graph.nodes.map((n) => [n.id, n.lineRange]));
  for (const n of newNodes) rangeOf.set(n.id, n.lineRange);
  const best = new Map<string, { source: string; target: string; confidence: EdgeConfidence }>();
  for (const file of files) {
    for (const site of codeIndex.get(file)!.calls) {
      const rc = resolver.resolve(file, site);
      if (!rc || (rc.confidence !== "exact" && rc.confidence !== "param")) continue;
      const source = fnId(file, site.caller);
      const target = fnId(rc.target.file, rc.target.symbol);
      if (!ids.has(source) || !ids.has(target)) continue;
      const range = rangeOf.get(source);
      if (range && (site.line < range[0] || site.line > range[1])) continue;
      const key = `calls|${source}|${target}`;
      const prev = best.get(key);
      if (!prev || (prev.confidence === "param" && rc.confidence === "exact")) best.set(key, { source, target, confidence: rc.confidence });
    }
  }

  // Existing (tree-sitter) calls edges: the resolver is the authority for the files it indexes. A confirmed edge
  // takes its confidence; an unconfirmed one between two indexed files is dropped (tree-sitter matches callers by
  // bare name, so a nested `submit` lends its calls to a top-level `submit`); one touching a file the resolver
  // does not index (another language) stays, tagged "unverified".
  const fileOf = new Map(graph.nodes.map((n) => [n.id, n.filePath]));
  const indexed = (id: string) => { const f = fileOf.get(id); return f !== undefined && codeIndex.has(f); };
  const kept: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (e.type !== "calls") { kept.push(e); continue; }
    const hit = best.get(`calls|${e.source}|${e.target}`);
    if (hit) kept.push({ ...e, weight: WEIGHT[hit.confidence], description: hit.confidence });
    else if (!indexed(e.source) || !indexed(e.target)) kept.push({ ...e, weight: UNVERIFIED_WEIGHT, description: "unverified" });
  }

  const newCalls: GraphEdge[] = [...best.entries()]
    .filter(([key]) => !edgeKeys.has(key))
    .map(([, c]) => c)
    .sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target))
    .map((c) => ({ source: c.source, target: c.target, type: "calls", direction: "forward", weight: WEIGHT[c.confidence], description: c.confidence }));

  newNodes.sort((a, b) => compare(a.id, b.id));
  newContains.sort((a, b) => compare(a.target, b.target) || compare(a.source, b.source));
  return { ...graph, nodes: [...graph.nodes, ...newNodes], edges: [...kept, ...newContains, ...newCalls] };
}
