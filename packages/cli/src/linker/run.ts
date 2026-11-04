import { createCallResolver } from "./resolve-calls.js";
import { linkAll } from "./link.js";
import { externalCallFacts } from "./external.js";
import { buildChainsAndLinks, sortChains, syncJourneys, writeChains } from "./chains.js";
import type { SymbolLineLookup } from "./chains.js";
import type { IndexResult } from "../indexer/index-repo.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { ExternalService, RepoRef, TracesConfig, WorkspaceFile } from "../store/schemas.js";
import { compare } from "../util.js";

export interface LinkerSummary {
  chains: number;
  complete: number;
  orphanedJourneys: number;
  /** True when chains.json or journeys.json was written (created or changed). */
  wrote: boolean;
}

/** Link every freshly indexed repo, write `<ws.root>/.codeloom/chains.json` (only when its content
 * changes) and create / status-sync `journeys.json`. */
export function runLinker(
  ws: { root: string; name: string; repos: RepoRef[]; links: WorkspaceFile["links"]; traces?: TracesConfig; external?: ExternalService[] },
  indexed: Array<{ ref: RepoRef; abs: string; result: IndexResult }>,
): LinkerSummary {
  const repos: RepoData[] = indexed
    .map((x) => ({ ref: x.ref, abs: x.abs, graph: x.result.graph, endpoints: x.result.endpoints }))
    .sort((a, b) => compare(a.ref.id, b.ref.id));
  const wsData: WorkspaceData = {
    root: ws.root, name: ws.name, repos, links: ws.links,
    ...(ws.traces ? { traces: ws.traces } : {}), ...(ws.external ? { external: ws.external } : {}),
  };
  const resolvers = new Map(
    indexed.map((x) => [
      x.ref.id,
      createCallResolver({ repo: x.ref.id, index: x.result.codeIndex, files: x.result.files, aliases: x.result.aliases }),
    ]),
  );
  const links = linkAll({ ws: wsData, resolvers });
  const codeIndex = new Map(indexed.map((x) => [x.ref.id, x.result.codeIndex]));
  const symbolLine: SymbolLineLookup = (repo, file, symbol) =>
    codeIndex.get(repo)?.get(file)?.symbols.find((s) => s.name === symbol)?.lines[0];
  const built = buildChainsAndLinks(wsData, links, symbolLine);
  const chains = sortChains(built.chains);
  const wrote = writeChains(ws.root, chains, links.uiReach, built.manualLinks, externalCallFacts(links.ui));
  const sync = syncJourneys(ws.root, chains);
  return {
    chains: chains.length,
    complete: chains.filter((c) => c.complete).length,
    orphanedJourneys: sync.orphaned,
    wrote: wrote || sync.created || sync.changed,
  };
}
