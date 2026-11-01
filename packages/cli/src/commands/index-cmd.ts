import { join } from "node:path";
import { type IndexStats, indexRepo } from "../indexer/index-repo.js";
import { runLinker } from "../linker/run.js";
import type { LinkerSummary } from "../linker/run.js";
import type { EndpointsFile, RepoRef } from "../store/schemas.js";
import { loadWorkspace } from "../workspace/repos.js";

export interface IndexRunResult {
  root: string;
  repos: Array<{ id: string; stats: IndexStats; endpoints: EndpointsFile }>;
  linker: LinkerSummary;
}

export async function runIndex(start: string): Promise<IndexRunResult> {
  const ws = loadWorkspace(start);
  const repos: IndexRunResult["repos"] = [];
  const indexed: Array<{ ref: RepoRef; abs: string; result: Awaited<ReturnType<typeof indexRepo>> }> = [];
  for (const repo of ws.repos) {
    const abs = join(ws.root, repo.path);
    const res = await indexRepo(abs, repo.id);
    repos.push({ id: repo.id, stats: res.stats, endpoints: res.endpoints });
    indexed.push({ ref: repo, abs, result: res });
  }
  const linker = runLinker(ws, indexed);
  return { root: ws.root, repos, linker };
}

export function formatIndexSummary(r: IndexRunResult): string {
  const header = ["repo", "files", "parsed", "reused", "pages", "calls", "routes", "tables", "queues", "skipped"];
  const rows = r.repos.map((x) => [
    x.id,
    x.stats.files,
    x.stats.parsed,
    x.stats.reused,
    x.endpoints.pages.length,
    x.endpoints.httpCalls.length,
    x.endpoints.routes.length,
    x.endpoints.tables.length,
    x.endpoints.queues.length,
    x.stats.skipped.length,
  ].map(String));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  const skipped = r.repos.flatMap((x) => x.stats.skipped.map((s) => `  ${x.id}/${s.file}: ${s.reason}`));
  const orphanedNote = r.linker.orphanedJourneys > 0 ? [`${r.linker.orphanedJourneys} journeys orphaned (their chains no longer exist)`] : [];
  return [
    line(header),
    ...rows.map(line),
    "",
    `${r.repos.length} repos indexed in ${r.root}`,
    `${r.linker.chains} chains (${r.linker.complete} complete) written to .codeloom/chains.json`,
    ...orphanedNote,
    ...(skipped.length ? ["Skipped files:", ...skipped] : []),
  ].join("\n");
}
