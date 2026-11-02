import { join } from "node:path";
import { formatCheckJson, formatCheckText } from "../check/format.js";
import { belowFailUnder, buildCheckReport } from "../check/report.js";
import { runTraces } from "../check/traces/run.js";
import { dataError } from "../errors.js";
import { readJson } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { loadWorkspaceData } from "../store/read.js";
import { ChainsFileSchema, type CheckReport } from "../store/schemas.js";

export interface CheckOptions {
  json?: boolean;
  failUnder?: string;
  traces?: boolean;
}

export interface BuildReportOptions {
  /** Compare the map with runtime traces from the workspace's `traces` source (check/traces/run.ts). */
  traces?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function parseFailUnder(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > 100) {
    throw dataError(`--fail-under must be a whole number between 0 and 100, got "${raw}".`);
  }
  return Number(raw);
}

/** The check report, shared by `codeloom check` and the check_chains MCP tool. Missing/old/invalid data
 * throws a CodeloomError with exitCode 2 (loadWorkspaceData, readJson, dataError).
 * With `opts.traces` the report gains a `traces` section (or a `skipped` reason); without it, none. */
export async function buildReport(start: string, opts: BuildReportOptions = {}): Promise<CheckReport> {
  const ws = loadWorkspaceData(start);
  const chainsPath = join(ws.root, CODELOOM_DIR, FILES.chains);
  const chainsFile = readJson(chainsPath, ChainsFileSchema);
  if (!chainsFile) throw dataError(`${chainsPath} not found. Run "codeloom index" first.`);
  const report = buildCheckReport(chainsFile.chains, ws, chainsFile.uiReach ?? [], chainsFile.manualLinks ?? []);
  if (!opts.traces) return report;
  return { ...report, traces: await runTraces(ws, chainsFile.chains, opts) };
}

/** Exit code 0 = report printed; 1 = complete% below --fail-under (traces never change it). Data errors and a bad flag value
 * throw a CodeloomError with exitCode 2. */
export async function runCheck(
  start: string,
  opts: CheckOptions,
): Promise<{ report: CheckReport; output: string; exitCode: 0 | 1 }> {
  const failUnder = parseFailUnder(opts.failUnder);
  const report = await buildReport(start, { traces: opts.traces });
  const output = opts.json ? formatCheckJson(report) : formatCheckText(report);
  const exitCode: 0 | 1 = failUnder !== undefined && belowFailUnder(report, failUnder) ? 1 : 0;
  return { report, output, exitCode };
}
