import { type FSWatcher, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../src/store/json.js";
import { progressPath } from "../src/store/progress.js";
import { type ChangeKey, watchMap } from "../src/web/events.js";

const DEBOUNCE = 120;
const wsFile = (repos: Array<{ id: string; path: string }>) =>
  JSON.stringify({ version: 1, name: "ws", repos, links: [] }, null, 2) + "\n";

/** A temp workspace: codeloom.workspace.json with repos api and web, each with a .codeloom folder, plus the root .codeloom. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-events-"));
  for (const r of ["api", "web"]) mkdirSync(join(root, r, ".codeloom"), { recursive: true });
  mkdirSync(join(root, ".codeloom"), { recursive: true });
  writeFileSync(join(root, "codeloom.workspace.json"), wsFile([{ id: "api", path: "api" }, { id: "web", path: "web" }]));
  return root;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Watch `root`, collecting every onChange call. fs.watch needs a moment to arm, and macOS FSEvents may
 * replay the test's own setup writes (made just before) right after arming: let that settle, then start
 * from an empty list. */
async function collect(root: string, opts: Parameters<typeof watchMap>[2] = {}) {
  const calls: ChangeKey[][] = [];
  const stop = watchMap(root, (keys) => calls.push(keys), { debounceMs: DEBOUNCE, ...opts });
  stops.push(stop);
  await sleep(150 + DEBOUNCE * 3);
  calls.length = 0;
  return { calls, stop };
}

/** Resolves once `calls` has at least `n` entries; fails after `ms`. */
async function waitFor(calls: unknown[], n = 1, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (calls.length < n) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${n} change event(s); got ${calls.length}`);
    await sleep(20);
  }
}

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe("watchMap", () => {
  it("an atomic write of journeys.json → [journeys] within 2 s", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, ".codeloom", "journeys.json"), { version: 1, journeys: [] });
    await waitFor(calls);
    expect(calls).toEqual([["journeys"]]);
  });

  it("chains.json → [chains]", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, ".codeloom", "chains.json"), { version: 1, chains: [] });
    await waitFor(calls);
    expect(calls).toEqual([["chains"]]);
  });

  it("a repo's graph.json change → [repo:<id>]", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, "web", ".codeloom", "graph.json"), { nodes: [] });
    await waitFor(calls);
    expect(calls).toEqual([["repo:web"]]);
  });

  it("a burst of 5 writes → one event with the sorted set of keys", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, "web", ".codeloom", "graph.json"), { n: 1 });
    writeJsonAtomic(join(root, ".codeloom", "journeys.json"), { n: 2 });
    writeJsonAtomic(join(root, "api", ".codeloom", "endpoints.json"), { n: 3 });
    writeJsonAtomic(join(root, ".codeloom", "journeys.json"), { n: 4 });
    writeJsonAtomic(join(root, "web", ".codeloom", "summaries.json"), { n: 5 });
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls).toEqual([["journeys", "repo:api", "repo:web"]]);
  });

  it("ignores temp files", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeFileSync(join(root, ".codeloom", "journeys.json.123.456.tmp"), "{}");
    writeFileSync(join(root, "web", ".codeloom", "graph.json.1.2.tmp"), "{}");
    writeFileSync(join(root, "api", ".codeloom", "fingerprints.json.9.9.tmp"), "{}");
    await sleep(DEBOUNCE * 5);
    expect(calls).toEqual([]);
  });

  // A re-index after a code edit that leaves the map itself unchanged (graph.json, chains.json byte-identical)
  // still changes file hashes, so tours' "may be out of date" stops and progress re-walks must refresh: but
  // only those, not the whole repo's map.
  it("a repo's fingerprints.json change (a re-index) → [progress, tours] only", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeFileSync(join(root, "api", ".codeloom", "fingerprints.json"), "{}");
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls).toEqual([["progress", "tours"]]);
  });

  it("a workspace file change → [workspace], and the repo list is re-read", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    mkdirSync(join(root, "billing", ".codeloom"), { recursive: true });
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      wsFile([{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }]),
    );
    await waitFor(calls);
    expect(calls[0]).toEqual(["workspace"]);
    await sleep(150);
    writeJsonAtomic(join(root, "billing", ".codeloom", "graph.json"), { nodes: [] });
    await waitFor(calls, 2);
    expect(calls[1]).toEqual(["repo:billing"]);
  });

  it("a repo's .codeloom folder created after start is picked up", async () => {
    const root = makeWorkspace();
    rmSync(join(root, "web", ".codeloom"), { recursive: true });
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, "web", ".codeloom", "graph.json"), { nodes: [] });
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls.flat()).toContain("repo:web");
  });

  it("a single repo at the root (path '.') maps its own files to repo:<id> and chains/journeys to their keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-events-one-"));
    mkdirSync(join(root, ".codeloom"));
    writeFileSync(join(root, "codeloom.workspace.json"), wsFile([{ id: "solo", path: "." }]));
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, ".codeloom", "graph.json"), { nodes: [] });
    writeJsonAtomic(join(root, ".codeloom", "chains.json"), { chains: [] });
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls).toEqual([["chains", "repo:solo"]]);
  });

  it("stop() closes every watcher it opened (none leak, also across workspace re-reads)", async () => {
    const root = makeWorkspace();
    let open = 0;
    let opened = 0;
    const countingWatch = ((path: string, listener: (event: string, filename: string | null) => void): FSWatcher => {
      const w = watch(path, listener);
      open++;
      opened++;
      const close = w.close.bind(w);
      let closed = false;
      w.close = () => {
        if (!closed) {
          closed = true;
          open--;
        }
        close();
      };
      return w;
    }) as unknown as typeof watch;
    const { calls, stop } = await collect(root, { watch: countingWatch });
    expect(open).toBeGreaterThan(0);
    const before = open;
    // Drop a repo: its watchers close; the count goes down.
    writeFileSync(join(root, "codeloom.workspace.json"), wsFile([{ id: "api", path: "api" }]));
    await waitFor(calls);
    await sleep(100);
    expect(open).toBeLessThan(before);
    expect(opened).toBeGreaterThanOrEqual(before);
    stop();
    expect(open).toBe(0);
  });

  it("after stop() no more events are emitted", async () => {
    const root = makeWorkspace();
    const { calls, stop } = await collect(root);
    writeJsonAtomic(join(root, ".codeloom", "journeys.json"), { n: 1 });
    stop();
    await sleep(DEBOUNCE * 4);
    expect(calls).toEqual([]);
  });

  it("a tour written to .codeloom/tours/ → [tours] (temp files ignored)", async () => {
    const root = makeWorkspace();
    mkdirSync(join(root, ".codeloom", "tours"));
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, ".codeloom", "tours", "j_000000000001.json"), { version: 1 });
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls).toEqual([["tours"]]);
  });

  it("the tours folder created after start is picked up", async () => {
    const root = makeWorkspace();
    const { calls } = await collect(root);
    writeJsonAtomic(join(root, ".codeloom", "tours", "j_000000000001.json"), { version: 1 });
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls.flat()).toContain("tours");
    calls.length = 0;
    writeJsonAtomic(join(root, ".codeloom", "tours", "j_000000000002.json"), { version: 1 });
    await waitFor(calls);
    await sleep(DEBOUNCE * 3);
    expect(calls).toEqual([["tours"]]);
  });

  describe("progress (the personal file under CODELOOM_HOME)", () => {
    const saved = process.env.CODELOOM_HOME;
    afterEach(() => {
      process.env.CODELOOM_HOME = saved;
    });
    /** A fresh CODELOOM_HOME (`create`: also its progress folder) and this workspace's progress file in it. */
    function home(root: string, create: boolean) {
      const h = mkdtempSync(join(tmpdir(), "codeloom-home-ev-"));
      process.env.CODELOOM_HOME = h;
      if (create) mkdirSync(join(h, "progress"));
      const file = progressPath({ root, name: "ws", repos: [{ ref: { id: "api" }, abs: join(root, "api") }, { ref: { id: "web" }, abs: join(root, "web") }] });
      return { home: h, file };
    }

    it("this workspace's progress file → [progress]; another workspace's file is ignored", async () => {
      const root = makeWorkspace();
      const { home: h, file } = home(root, true);
      const { calls } = await collect(root);
      writeJsonAtomic(join(h, "progress", "0000000000000000.json"), { version: 1, journeys: {} });
      await sleep(DEBOUNCE * 3);
      expect(calls).toEqual([]);
      writeJsonAtomic(file, { version: 1, journeys: {} });
      await waitFor(calls);
      await sleep(DEBOUNCE * 3);
      expect(calls).toEqual([["progress"]]);
    });

    it("a progress folder (and home) created after start is picked up", async () => {
      const root = makeWorkspace();
      const { home: h, file } = home(root, false);
      rmSync(h, { recursive: true });
      const { calls } = await collect(root);
      writeJsonAtomic(file, { version: 1, journeys: {} });
      await waitFor(calls);
      await sleep(DEBOUNCE * 3);
      expect(calls.flat()).toContain("progress");
      calls.length = 0;
      writeJsonAtomic(file, { version: 1, journeys: { a: 1 } });
      await waitFor(calls);
      await sleep(DEBOUNCE * 3);
      expect(calls).toEqual([["progress"]]);
    });
  });

  it("works on a folder with no workspace file yet (watches for one to appear)", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-events-none-"));
    const { calls } = await collect(root);
    writeFileSync(join(root, "codeloom.workspace.json"), wsFile([]));
    await waitFor(calls);
    expect(calls[0]).toEqual(["workspace"]);
  });
});
