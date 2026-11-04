import { join } from "node:path";
import { createCallResolver } from "./resolve-calls.js";
import { linkAll } from "./link.js";
import { buildChainsAndLinks, sortChains, syncJourneys, writeChains } from "./chains.js";
import type { SymbolLineLookup } from "./chains.js";
import type { IndexResult } from "../indexer/index-repo.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { RepoRef, TracesConfig, WorkspaceFile } from "../store/schemas.js";
import { compare } from "../util.js";
import { enrichGraph } from "../indexer/enrich-graph.js";
import { writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";

export interface LinkerSummary {
  chains: number;
  complete: number;
  orphanedJourneys: number;
  /** True when chains.json or journeys.json was written (created or changed). */
  wrote: boolean;
}

/** Enrich every freshly indexed repo's graph with method nodes and exact/param call edges (v0.2a §1), write
 * it to `<repo>/.codeloom/graph.json` (only when its content changes), link every repo against the
 * enriched graphs — so chain stops get method node ids — write `<ws.root>/.codeloom/chains.json` (only when its content
 * changes) and create / status-sync `journeys.json`. */
export function runLinker(
  ws: { root: string; name: string; repos: RepoRef[]; links: WorkspaceFile["links"]; traces?: TracesConfig },
  indexed: Array<{ ref: RepoRef; abs: string; result: IndexResult }>,
): LinkerSummary {
  const resolvers = new Map(
    indexed.map((x) => [
      x.ref.id,
      createCallResolver({ repo: x.ref.id, index: x.result.codeIndex, files: x.result.files, aliases: x.result.aliases }),
    ]),
  );
  const graphs = new Map(indexed.map((x) => [x.ref.id, enrichGraph(x.result.graph, x.result.codeIndex, resolvers.get(x.ref.id)!)]));
  for (const x of indexed) writeJsonIfChanged(join(x.abs, CODELOOM_DIR, FILES.graph), graphs.get(x.ref.id)!);
  const repos: RepoData[] = indexed
    .map((x) => ({ ref: x.ref, abs: x.abs, graph: graphs.get(x.ref.id)!, endpoints: x.result.endpoints }))
    .sort((a, b) => compare(a.ref.id, b.ref.id));
  const wsData: WorkspaceData = { root: ws.root, name: ws.name, repos, links: ws.links, ...(ws.traces ? { traces: ws.traces } : {}) };
  const links = linkAll({ ws: wsData, resolvers });
  const codeIndex = new Map(indexed.map((x) => [x.ref.id, x.result.codeIndex]));
  const symbolLine: SymbolLineLookup = (repo, file, symbol) =>
    codeIndex.get(repo)?.get(file)?.symbols.find((s) => s.name === symbol)?.lines[0];
  const built = buildChainsAndLinks(wsData, links, symbolLine);
  const chains = sortChains(built.chains);
  const wrote = writeChains(ws.root, chains, links.uiReach, built.manualLinks);
  const sync = syncJourneys(ws.root, chains);
  return {
    chains: chains.length,
    complete: chains.filter((c) => c.complete).length,
    orphanedJourneys: sync.orphaned,
    wrote: wrote || sync.created || sync.changed,
  };
}
