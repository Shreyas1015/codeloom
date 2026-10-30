import {
  builtinLanguageConfigs,
  type CallGraphEntry,
  LanguageRegistry,
  type StructuralAnalysis,
  TreeSitterPlugin,
} from "@codeloom/core";

export interface FileEntry {
  structure: StructuralAnalysis;
  calls: CallGraphEntry[];
}

export const EMPTY_STRUCTURE: StructuralAnalysis = { functions: [], classes: [], imports: [], exports: [] };

const registry = LanguageRegistry.createDefault();
let pluginPromise: Promise<TreeSitterPlugin> | undefined;

export function getPlugin(): Promise<TreeSitterPlugin> {
  pluginPromise ??= (async () => {
    const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter((c) => c.treeSitter));
    await plugin.init();
    return plugin;
  })();
  return pluginPromise;
}

/** Files codeloom reads as text: anything UA has a language config for, plus Prisma schemas. */
export function isSourceFile(rel: string): boolean {
  return registry.getForFile(rel) !== null || rel.endsWith(".prisma");
}

export function analyzeStructure(plugin: TreeSitterPlugin, rel: string, content: string): FileEntry {
  return { structure: plugin.analyzeFile(rel, content), calls: plugin.extractCallGraph(rel, content) };
}
