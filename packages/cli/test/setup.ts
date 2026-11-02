import { afterEach } from "vitest";

// Many tests run git and the indexer synchronously (execFileSync), which starves the worker's event
// loop. Yield one macrotask between tests so vitest's worker RPC (onTaskUpdate) gets through and
// does not time out.
afterEach(() => new Promise<void>((r) => setImmediate(r)));
