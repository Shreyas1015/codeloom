import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

// Personal progress lives under CODELOOM_HOME (else ~/.codeloom): never let a test read or write the
// real home folder.
process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));

// Tests commit to temp git repos through codeloom's own git() wrapper, which (like the product) passes no
// identity. CI runners have no git identity and no full user name, so give every test commit one here.
process.env.GIT_AUTHOR_NAME = "codeloom-test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "codeloom-test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";

// Many tests run git and the indexer synchronously (execFileSync), which starves the worker's event
// loop. Yield one macrotask between tests so vitest's worker RPC (onTaskUpdate) gets through and
// does not time out.
afterEach(() => new Promise<void>((r) => setImmediate(r)));
