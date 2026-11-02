/** Response shapes the dashboard reads.
 * Interim: mirrors workspace_overview + index_status from packages/cli. Task 3 adds
 * packages/cli/src/web/api-types.ts; these then become `import type` re-exports from there. */

export type RepoRole = "ui" | "api" | "worker" | "lib";

export interface OverviewRepo {
  id: string;
  path: string;
  role?: RepoRole;
  files: number;
  nodes: number;
  edges: number;
  pages: number;
  routes: number;
  calls: number;
  tables: number;
  queues: number;
}

export interface RepoIndexStatus {
  id: string;
  head: string;
  indexedCommit: string | null;
  stale: boolean;
  changedFiles: string[];
  truncated: boolean;
}

export interface Overview {
  name: string;
  repos: OverviewRepo[];
  chains: { total: number; complete: number; byConfidence: { exact: number; param: number; guess: number } };
  journeys: { total: number; orphaned: number };
  unnamedChains: number;
  indexStatus: { repos: RepoIndexStatus[] };
  mcpConnected: boolean;
}
