import { createCallResolver } from "./resolve-calls.js";
import { linkAll } from "./link.js";
import { buildChains, sortChains, syncJourneys, writeChains } from "./chains.js";
import type { IndexResult } from "../indexer/index-repo.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { RepoRef, TracesConfig, WorkspaceFile } from "../store/schemas.js";
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
  ws: { root: string; name: string; repos: RepoRef[]; links: WorkspaceFile["links"]; traces?: TracesConfig },
  indexed: Array<{ ref: RepoRef; abs: string; result: IndexResult }>,
): LinkerSummary {
  const repos: RepoData[] = indexed
    .map((x) => ({ ref: x.ref, abs: x.abs, graph: x.result.graph, endpoints: x.result.endpoints }))
    .sort((a, b) => compare(a.ref.id, b.ref.id));
  const wsData: WorkspaceData = { root: ws.root, name: ws.name, repos, links: ws.links, ...(ws.traces ? { traces: ws.traces } : {}) };
  const resolvers = new Map(
    indexed.map((x) => [
      x.ref.id,
      createCallResolver({ repo: x.ref.id, index: x.result.codeIndex, files: x.result.files, aliases: x.result.aliases }),
    ]),
  );
  const links = linkAll({ ws: wsData, resolvers });
  const chains = sortChains(buildChains(wsData, links));
  const wrote = writeChains(ws.root, chains);
  const sync = syncJourneys(ws.root, new Set(chains.map((c) => c.id)));
  return {
    chains: chains.length,
    complete: chains.filter((c) => c.complete).length,
    orphanedJourneys: sync.orphaned,
    wrote: wrote || sync.created || sync.changed,
  };
}
