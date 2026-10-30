import { join } from "node:path";
import { type IndexStats, indexRepo } from "../indexer/index-repo.js";
import type { EndpointsFile } from "../store/schemas.js";
import { loadWorkspace } from "../workspace/repos.js";

export interface IndexRunResult {
  root: string;
  repos: Array<{ id: string; stats: IndexStats; endpoints: EndpointsFile }>;
}

export async function runIndex(start: string): Promise<IndexRunResult> {
  const ws = loadWorkspace(start);
  const repos: IndexRunResult["repos"] = [];
  for (const repo of ws.repos) {
    const res = await indexRepo(join(ws.root, repo.path), repo.id);
    repos.push({ id: repo.id, stats: res.stats, endpoints: res.endpoints });
  }
  return { root: ws.root, repos };
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
  return [
    line(header),
    ...rows.map(line),
    "",
    `${r.repos.length} repos indexed in ${r.root}`,
    ...(skipped.length ? ["Skipped files:", ...skipped] : []),
  ].join("\n");
}
