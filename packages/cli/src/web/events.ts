import { existsSync, type FSWatcher, readFileSync, watch as fsWatch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { type RepoRef, WorkspaceFileSchema } from "../store/schemas.js";
import { compare } from "../util.js";
import { defaultRepoId, findWorkspaceRoot } from "../workspace/repos.js";
import type { ChangeKey } from "./api-types.js";

export type { ChangeKey };

export interface WatchMapOptions {
  /** Quiet time before a batch of changes is emitted. Default 250 ms. */
  debounceMs?: number;
  /** fs.watch (tests pass a counting wrapper). */
  watch?: typeof fsWatch;
}

/** Files that never produce a change key: the indexer's own bookkeeping and the atomic writer's temp files. */
const ignored = (name: string) => name === FILES.fingerprints || name.endsWith(".tmp");

/** The nearest folder at or above `start` that holds .git (a single repo with no workspace file). No git call. */
function gitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The workspace root and its repos, read without git and without throwing: a missing or bad workspace
 * file falls back to the git root as one repo (as loadWorkspace does), or to no repos. `previous` is kept
 * when the workspace file is present but unreadable (mid-edit), so a typo does not drop every watcher. */
function readRepos(start: string, previous: { root: string; repos: RepoRef[] } | null): { root: string; repos: RepoRef[] } {
  const wsRoot = findWorkspaceRoot(start);
  if (wsRoot) {
    try {
      const parsed = WorkspaceFileSchema.safeParse(JSON.parse(readFileSync(join(wsRoot, WORKSPACE_FILE), "utf8")));
      if (parsed.success) return { root: wsRoot, repos: parsed.data.repos };
    } catch {
      // unreadable or not JSON yet: fall through
    }
    if (previous && previous.root === wsRoot) return previous;
    return { root: wsRoot, repos: [] };
  }
  const top = gitRoot(start);
  if (top) return { root: top, repos: [{ id: defaultRepoId(top), path: "." }] };
  return { root: resolve(start), repos: [] };
}

/** Watch a workspace's map files and call `onChange` with the sorted set of changed keys, once per burst
 * (debounced). Watches the workspace root folder (for the workspace file and its .codeloom appearing), the
 * root .codeloom (chains.json → chains, journeys.json → journeys) and, for each repo, its folder (for
 * .codeloom appearing) and its .codeloom (any map file → repo:<id>). fingerprints.json and *.tmp are
 * ignored. A workspace file change re-reads the repo list and re-arms the watchers. Never reads the map
 * itself and never runs git. Returns a stop function that closes every watcher. */
export function watchMap(start: string, onChange: (keys: ChangeKey[]) => void, opts: WatchMapOptions = {}): () => void {
  const debounceMs = opts.debounceMs ?? 250;
  const watchFn = opts.watch ?? fsWatch;
  const watchers = new Map<string, { sig: string; w: FSWatcher }>();
  const pending = new Set<ChangeKey>();
  let timer: NodeJS.Timeout | undefined;
  let firstPendingAt = 0;
  let stopped = false;
  let ws: { root: string; repos: RepoRef[] } | null = null;

  const flush = () => {
    timer = undefined;
    if (stopped || pending.size === 0) return;
    const keys = [...pending].sort(compare);
    pending.clear();
    onChange(keys);
  };

  const emit = (keys: ChangeKey[]) => {
    if (stopped || keys.length === 0) return;
    if (pending.size === 0) firstPendingAt = Date.now();
    for (const k of keys) pending.add(k);
    if (timer) clearTimeout(timer);
    // Trailing debounce, but a steady stream of writes still flushes at least every 4 debounce periods.
    const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + debounceMs * 4 - Date.now()));
    timer = setTimeout(flush, wait);
  };

  const closeWatcher = (path: string) => {
    const entry = watchers.get(path);
    if (!entry) return;
    watchers.delete(path);
    entry.w.close();
  };

  /** One folder to watch: `sig` identifies what its events mean, so a changed meaning re-arms it. */
  type Spec = { sig: string; onName: (name: string | null) => void };

  const sync = () => {
    if (stopped) return;
    ws = readRepos(start, ws);
    const { root, repos } = ws;
    const rootRepo = repos.find((r) => resolve(root, r.path) === root);
    const want = new Map<string, Spec>();

    const rootDirKeys = (): ChangeKey[] => ["chains", "journeys", ...(rootRepo ? [`repo:${rootRepo.id}` as ChangeKey] : [])];
    want.set(root, {
      sig: `root:${rootRepo?.id ?? ""}`,
      onName: (name) => {
        if (name === WORKSPACE_FILE || name === null) {
          sync();
          emit(["workspace"]);
        } else if (name === CODELOOM_DIR) {
          sync();
          emit(rootDirKeys());
        }
      },
    });
    want.set(join(root, CODELOOM_DIR), {
      sig: `rootdata:${rootRepo?.id ?? ""}`,
      onName: (name) => {
        if (name === null) return emit(rootDirKeys());
        if (ignored(name)) return;
        if (name === FILES.chains) emit(["chains"]);
        else if (name === FILES.journeys) emit(["journeys"]);
        else if (rootRepo) emit([`repo:${rootRepo.id}`]);
      },
    });
    for (const repo of repos) {
      const abs = resolve(root, repo.path);
      if (abs === root) continue;
      const key: ChangeKey = `repo:${repo.id}`;
      want.set(abs, {
        sig: `repo:${repo.id}`,
        onName: (name) => {
          if (name === CODELOOM_DIR || name === null) {
            sync();
            emit([key]);
          }
        },
      });
      want.set(join(abs, CODELOOM_DIR), {
        sig: `repodata:${repo.id}`,
        onName: (name) => {
          if (name === null || !ignored(name)) emit([key]);
        },
      });
    }

    for (const [path, entry] of watchers) {
      if (want.get(path)?.sig !== entry.sig || !existsSync(path)) closeWatcher(path);
    }
    for (const [path, spec] of want) {
      if (watchers.has(path) || !existsSync(path)) continue;
      try {
        const w = watchFn(path, (_event, filename) => {
          if (stopped) return;
          spec.onName(filename === null || filename === undefined ? null : String(filename));
        });
        w.on("error", () => {
          // The folder went away (deleted or replaced): drop this watcher; the next sync re-arms it.
          if (watchers.get(path)?.w === w) closeWatcher(path);
        });
        watchers.set(path, { sig: spec.sig, w });
      } catch {
        // Gone between the check and the watch, or not watchable: skip it; the next sync retries.
      }
    }
  };

  sync();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    pending.clear();
    for (const path of [...watchers.keys()]) closeWatcher(path);
  };
}
