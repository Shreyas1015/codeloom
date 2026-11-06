import { existsSync, type FSWatcher, readFileSync, watch as fsWatch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { progressPath } from "../store/progress.js";
import { type RepoRef, WorkspaceFileSchema } from "../store/schemas.js";
import { TOURS_DIR } from "../store/tours.js";
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
const ignored = (name: string) => name.endsWith(".tmp");
/** A re-index rewrites the git-ignored fingerprints cache even when the map files stay byte-identical (a code
 * edit that changes no node). File hashes may have changed, so only what is derived from them refreshes:
 * progress (re-walks) and tours ("may be out of date"). */
const REINDEXED: ChangeKey[] = ["progress", "tours"];

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

/** What the watcher knows of the workspace: its root, name (for the progress file's id) and repos. */
interface WatchedWorkspace {
  root: string;
  name: string;
  repos: RepoRef[];
}

/** This workspace's personal progress file (store/progress.ts), or null when there are no repos yet or
 * the path would be inside the workspace (progressPath refuses that). */
function progressFileFor(ws: WatchedWorkspace): string | null {
  if (ws.repos.length === 0) return null;
  try {
    return progressPath({ root: ws.root, name: ws.name, repos: ws.repos.map((r) => ({ ref: { id: r.id }, abs: resolve(ws.root, r.path) })) });
  } catch {
    return null;
  }
}

/** The workspace root and its repos, read without git and without throwing: a missing or bad workspace
 * file falls back to the git root as one repo (as loadWorkspace does), or to no repos. `previous` is kept
 * when the workspace file is present but unreadable (mid-edit), so a typo does not drop every watcher. */
function readRepos(start: string, previous: WatchedWorkspace | null): WatchedWorkspace {
  const wsRoot = findWorkspaceRoot(start);
  if (wsRoot) {
    try {
      const parsed = WorkspaceFileSchema.safeParse(JSON.parse(readFileSync(join(wsRoot, WORKSPACE_FILE), "utf8")));
      if (parsed.success) return { root: wsRoot, name: parsed.data.name, repos: parsed.data.repos };
    } catch {
      // unreadable or not JSON yet: fall through
    }
    if (previous && previous.root === wsRoot) return previous;
    return { root: wsRoot, name: "", repos: [] };
  }
  const top = gitRoot(start);
  if (top) {
    const id = defaultRepoId(top);
    return { root: top, name: id, repos: [{ id, path: "." }] };
  }
  return { root: resolve(start), name: "", repos: [] };
}

/** Watch a workspace's map files and call `onChange` with the sorted set of changed keys, once per burst
 * (debounced). Watches the workspace root folder (for the workspace file and its .codeloom appearing), the
 * root .codeloom (chains.json → chains, journeys.json → journeys), its tours/ folder (→ tours), this
 * workspace's progress file under CODELOOM_HOME or ~/.codeloom (→ progress) and, for each repo, its folder (for
 * .codeloom appearing) and its .codeloom (any map file → repo:<id>; fingerprints.json, rewritten by every
 * re-index → progress + tours). *.tmp files are ignored. A workspace file change re-reads the repo list and re-arms the watchers. Never reads the map
 * itself and never runs git. Returns a stop function that closes every watcher. */
export function watchMap(start: string, onChange: (keys: ChangeKey[]) => void, opts: WatchMapOptions = {}): () => void {
  const debounceMs = opts.debounceMs ?? 250;
  const watchFn = opts.watch ?? fsWatch;
  const watchers = new Map<string, { sig: string; w: FSWatcher }>();
  const pending = new Set<ChangeKey>();
  let timer: NodeJS.Timeout | undefined;
  let firstPendingAt = 0;
  let stopped = false;
  let ws: WatchedWorkspace | null = null;

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

    const rootDirKeys = (): ChangeKey[] => ["chains", "journeys", "tours", ...(rootRepo ? [`repo:${rootRepo.id}` as ChangeKey] : [])];
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
        if (name === FILES.fingerprints) return rootRepo ? emit(REINDEXED) : undefined;
        if (name === TOURS_DIR) {
          // The tours folder appeared (or went): arm its watcher.
          sync();
          return emit(["tours"]);
        }
        if (name === FILES.chains) emit(["chains"]);
        else if (name === FILES.journeys) emit(["journeys"]);
        else if (rootRepo) emit([`repo:${rootRepo.id}`]);
      },
    });
    want.set(join(root, CODELOOM_DIR, TOURS_DIR), {
      sig: "tours",
      onName: (name) => {
        if (name === null || !ignored(name)) emit(["tours"]);
      },
    });
    // Personal progress lives outside the workspace (CODELOOM_HOME or ~/.codeloom): watch its folder for
    // this workspace's file only; until the folder exists, watch its nearest existing parent for the
    // next folder down to appear (then re-arm).
    const progressFile = progressFileFor(ws);
    if (progressFile) {
      const dir = dirname(progressFile);
      const base = basename(progressFile);
      if (existsSync(dir)) {
        want.set(dir, {
          sig: `progress:${base}`,
          onName: (name) => {
            if (name === null || name === base) emit(["progress"]);
          },
        });
      } else {
        let child = dir;
        let parent = dirname(dir);
        while (!existsSync(parent) && dirname(parent) !== parent) {
          child = parent;
          parent = dirname(parent);
        }
        const next = basename(child);
        if (!want.has(parent)) {
          want.set(parent, {
            sig: `progress-up:${next}`,
            onName: (name) => {
              if (name === null || name === next) {
                sync();
                emit(["progress"]);
              }
            },
          });
        }
      }
    }
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
          if (name === FILES.fingerprints) emit(REINDEXED);
          else if (name === null || !ignored(name)) emit([key]);
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
