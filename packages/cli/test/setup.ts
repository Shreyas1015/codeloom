import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

// Personal progress, the repo registry and group data live under CODELOOM_HOME (else ~/.codeloom): never let
// a test read or write the real home folder, and give every test its own, so no two tests share a registry
// (since 0.6, `codeloom index` in a lone repo registers it there). A file's beforeAll runs with the first.
process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));
beforeEach(() => {
  process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));
});

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
