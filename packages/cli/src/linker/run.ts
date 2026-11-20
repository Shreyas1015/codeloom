import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createCallResolver } from "./resolve-calls.js";
import { linkAll } from "./link.js";
import { externalCallFacts } from "./external.js";
import { buildChainsAndLinks, sortChains, syncJourneys, writeChains } from "./chains.js";
import type { SymbolLineLookup } from "./chains.js";
import type { IndexResult } from "../indexer/index-repo.js";
import type { RepoData, WorkspaceData } from "../store/read.js";
import type { ExternalService, RepoRef, TracesConfig, WorkspaceFile } from "../store/schemas.js";
import { compare } from "../util.js";
import { enrichGraph } from "../indexer/enrich-graph.js";
import { writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { packageName } from "../workspace/repos.js";

/** The repo name of `abs`'s git remote (`origin`, else the first remote), read straight from its git config: no
 * git or ssh process, no host lookup — only the last path segment of the URL is used. */
export function remoteRepoName(abs: string): string | undefined {
  let gitDir = join(abs, ".git");
  try {
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = resolve(abs, pointer);
      const common = join(gitDir, "commondir");
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
    }
    const config = readFileSync(join(gitDir, "config"), "utf8");
    const urls = new Map<string, string>();
    let remote: string | undefined;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[(.+)\]\s*$/.exec(line);
      if (section) {
        remote = /^remote\s+"(.+)"$/.exec(section[1]!.trim())?.[1];
        continue;
      }
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
      if (remote !== undefined && url !== undefined && !urls.has(remote)) urls.set(remote, url);
    }
    const url = urls.get("origin") ?? [...urls.entries()].sort(([a], [b]) => compare(a, b))[0]?.[1];
    const name = url?.replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop();
    return name ? name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** 0.6 §2: the names a repo goes by besides its id, for matching call bases to it: its package name, its
 * folder name and its git remote's repo name (`remote`, when the caller already knows it — `host/owner/name`; else
 * read from the repo's git config). */
export function repoNames(abs: string, remote?: string | null): string[] {
  const remoteName = remote === undefined ? remoteRepoName(abs) : remote?.split("/").pop();
  const names = [packageName(abs), basename(abs), remoteName];
  return [...new Set(names.filter((n): n is string => n !== undefined && n !== ""))];
}
import { type Answer, applyAnswers, readAnswers, withAnsweredQueues } from "../map/answers.js";

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
export type LinkerWorkspace = { root: string; name: string; repos: RepoRef[]; links: WorkspaceFile["links"]; traces?: TracesConfig; external?: ExternalService[] };
/** `saved`: the repo was not indexed this run (0.6 §1, a group member read back by loadSavedIndex): its graph is
 * already enriched and is neither enriched nor written again. */
export type LinkerInput = Array<{ ref: RepoRef; abs: string; result: IndexResult; saved?: boolean; remote?: string | null }>;

/** Everything a link writes, computed in memory. */
export type LinkOutput = ReturnType<typeof linkInMemory>;

export function runLinker(ws: LinkerWorkspace, indexed: LinkerInput): LinkerSummary {
  return writeLink(ws, indexed, linkInMemory(ws, indexed));
}

/** Write a link computed by linkInMemory: the enriched graphs of freshly indexed repos, chains.json, and the
 * journeys' status (0.6 §5: save_map_answers writes the link it checked, without linking a third time). */
export function writeLink(ws: LinkerWorkspace, indexed: LinkerInput, out: LinkOutput): LinkerSummary {
  const { chains, graphs, uiReach, manualLinks, external, unresolvedBases, wrapperCalls } = out;
  for (const x of indexed) if (!x.saved) writeJsonIfChanged(join(x.abs, CODELOOM_DIR, FILES.graph), graphs.get(x.ref.id)!);
  const wrote = writeChains(ws.root, chains, uiReach, manualLinks, external, unresolvedBases, wrapperCalls);
  const sync = syncJourneys(ws.root, chains);
  return {
    chains: chains.length,
    complete: chains.filter((c) => c.complete).length,
    orphanedJourneys: sync.orphaned,
    wrote: wrote || sync.created || sync.changed,
  };
}

/** Link in memory, writing nothing. `answers`: link with these instead of the saved answers.json (0.6 §5:
 * save_map_answers checks an answer this way before saving it). */
export function linkInMemory(ws: LinkerWorkspace, indexed: LinkerInput, answers?: Answer[]) {
  const resolvers = new Map(
    indexed.map((x) => [
      x.ref.id,
      createCallResolver({ repo: x.ref.id, index: x.result.codeIndex, files: x.result.files, aliases: x.result.aliases }),
    ]),
  );
  const graphs = new Map(indexed.map((x) => [
    x.ref.id, x.saved ? x.result.graph : enrichGraph(x.result.graph, x.result.codeIndex, resolvers.get(x.ref.id)!),
  ]));
  // 0.6 §5: the user's answers (answers.json) are applied on every link, so re-indexing any repo keeps them.
  const cfg = applyAnswers({ repos: indexed.map((x) => x.ref), links: ws.links, ...(ws.external ? { external: ws.external } : {}) }, answers ?? readAnswers(ws.root));
  const refs = new Map(cfg.repos.map((r) => [r.id, r]));
  const repos: RepoData[] = indexed
    .filter((x) => !cfg.ignored.has(x.ref.id))
    .map((x) => ({
      ref: refs.get(x.ref.id) ?? x.ref, abs: x.abs, graph: graphs.get(x.ref.id)!,
      endpoints: withAnsweredQueues(x.result.endpoints, x.ref.id, cfg.queueNames), names: repoNames(x.abs, x.remote),
    }))
    .sort((a, b) => compare(a.ref.id, b.ref.id));
  const wsData: WorkspaceData = {
    root: ws.root, name: ws.name, repos, links: cfg.links,
    ...(ws.traces ? { traces: ws.traces } : {}), ...(cfg.external ? { external: cfg.external } : {}),
    ...(cfg.queueAliases.length > 0 ? { queueAliases: cfg.queueAliases } : {}),
    ...(cfg.baseHints.length > 0 ? { baseHints: cfg.baseHints } : {}),
  };
  const links = linkAll({ ws: wsData, resolvers });
  const codeIndex = new Map(indexed.map((x) => [x.ref.id, x.result.codeIndex]));
  const symbolLine: SymbolLineLookup = (repo, file, symbol) =>
    codeIndex.get(repo)?.get(file)?.symbols.find((s) => s.name === symbol)?.lines[0];
  const built = buildChainsAndLinks(wsData, links, symbolLine);
  const chains = sortChains(built.chains);
  // The calls derived through HTTP wrappers (only the linker sees them): the gaps and answers read them back.
  const wrapperCalls = links.ui.filter((l) => l.call.via === "wrapper" && l.call.wrapper !== undefined).map((l) => {
    const { via: _via, wrapper, confidence: _confidence, ...call } = l.call;
    return { repo: l.repo, wrapper: wrapper!, call };
  });
  return {
    chains, graphs, uiReach: links.uiReach, manualLinks: built.manualLinks, external: externalCallFacts(links.ui), unresolvedBases: links.unresolvedBases,
    wrapperCalls,
  };
}
