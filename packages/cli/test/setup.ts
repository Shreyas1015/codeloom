import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

// Personal progress lives under CODELOOM_HOME (else ~/.codeloom): never let a test read or write the
// real home folder.
process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));

// Many tests run git and the indexer synchronously (execFileSync), which starves the worker's event
// loop. Yield one macrotask between tests so vitest's worker RPC (onTaskUpdate) gets through and
// does not time out.
afterEach(() => new Promise<void>((r) => setImmediate(r)));
