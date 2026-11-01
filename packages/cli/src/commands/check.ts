import { join } from "node:path";
import { formatCheckJson, formatCheckText } from "../check/format.js";
import { buildCheckReport, completePercent } from "../check/report.js";
import { dataError } from "../errors.js";
import { readJson } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { loadWorkspaceData } from "../store/read.js";
import { ChainsFileSchema, type CheckReport } from "../store/schemas.js";

export interface CheckOptions {
  json?: boolean;
  failUnder?: string;
}

function parseFailUnder(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > 100) {
    throw dataError(`--fail-under must be a whole number between 0 and 100, got "${raw}".`);
  }
  return Number(raw);
}

/** Exit code 0 = report printed; 1 = complete% below --fail-under. Missing/old/invalid data and a bad
 * flag value throw a CodeloomError with exitCode 2 (loadWorkspaceData, readJson, dataError). */
export function runCheck(start: string, opts: CheckOptions): { report: CheckReport; output: string; exitCode: 0 | 1 } {
  const failUnder = parseFailUnder(opts.failUnder);
  const ws = loadWorkspaceData(start);
  const chainsPath = join(ws.root, CODELOOM_DIR, FILES.chains);
  const chainsFile = readJson(chainsPath, ChainsFileSchema);
  if (!chainsFile) throw dataError(`${chainsPath} not found. Run "codeloom index" first.`);

  const report = buildCheckReport(chainsFile.chains, ws, chainsFile.uiReach ?? []);
  const output = opts.json ? formatCheckJson(report) : formatCheckText(report);
  const exitCode: 0 | 1 = failUnder !== undefined && completePercent(report) < failUnder ? 1 : 0;
  return { report, output, exitCode };
}
