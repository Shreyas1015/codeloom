import { detectLayers, GraphBuilder, type KnowledgeGraph } from "@codeloom/core";
import { type Alias, resolveImport } from "./resolve-imports.js";
import type { FileEntry } from "./structure.js";

export function buildGraph(name: string, head: string, entries: Map<string, FileEntry>, aliases: Alias[]): KnowledgeGraph {
  const builder = new GraphBuilder(name, head);
  const files = new Set(entries.keys());
  for (const [rel, e] of entries) {
    builder.addFileWithAnalysis(rel, e.structure, { summary: "", fileSummary: "", summaries: {}, tags: [], complexity: "simple" });
  }

  const importsByFile = new Map<string, Array<{ target: string; specifiers: string[] }>>();
  for (const [rel, e] of entries) {
    const list: Array<{ target: string; specifiers: string[] }> = [];
    for (const imp of e.structure.imports) {
      const target = resolveImport(rel, imp.source, files, aliases);
      if (!target || target === rel) continue;
      builder.addImportEdge(rel, target);
      list.push({ target, specifiers: imp.specifiers });
    }
    importsByFile.set(rel, list);
  }

  const fnNames = new Map<string, Set<string>>();
  for (const [rel, e] of entries) fnNames.set(rel, new Set(e.structure.functions.map((f) => f.name)));

  for (const [rel, e] of entries) {
    const own = fnNames.get(rel)!;
    for (const call of e.calls) {
      if (!own.has(call.caller)) continue;
      const callee = call.callee.split(".").pop()!;
      if (own.has(callee)) {
        builder.addCallEdge(rel, call.caller, rel, callee);
        continue;
      }
      const imp = importsByFile.get(rel)!.find((i) => i.specifiers.includes(callee) && fnNames.get(i.target)?.has(callee));
      if (imp) builder.addCallEdge(rel, call.caller, imp.target, callee);
    }
  }

  const graph = builder.build();
  graph.layers = detectLayers(graph);
  return graph;
}
