import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { codeloomHome } from "../store/home.js";
import { writeJsonIfChanged } from "../store/json.js";
import { withLock } from "../store/lock.js";
import type { RepoRef } from "../store/schemas.js";
import { compare } from "../util.js";
import { git } from "./git.js";

/** The machine-local list of every repo indexed outside a workspace folder (0.6 spec §1):
 * `<CODELOOM_HOME or ~/.codeloom>/registry.json`. Repos register themselves on `codeloom index`; repos
 * of one group (one remote host + owner, or a `--group` name) form a workspace whose data lives in
 * `<home>/groups/<group>/.codeloom/`. Never committed. */
export const REGISTRY_FILE = "registry.json";
export const GROUPS_DIR = "groups";

export const RegistryEntrySchema = z.object({
  /** The repo's id inside its group (unique among the group's repos; copies share their repo's id). */
  id: z.string().min(1),
  /** The repo's top folder: absolute, symlinks resolved. */
  path: z.string().min(1),
  /** `host/owner/name` of the repo's git remote, lower-cased, never with credentials. */
  remote: z.string().optional(),
  group: z.string().min(1),
  /** Where the group came from: the remote, the parent folder (no remote) or `--group` (kept until another `--group`). */
  groupFrom: z.enum(["remote", "folder", "flag"]),
  indexedAt: z.string(),
  role: z.string().optional(),
  /** Set on a duplicate checkout of a remote: the path of the group's copy (the most recently indexed one).
   * Copies are ignored for linking. */
  copyOf: z.string().optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistryFileSchema = z.object({ version: z.literal(1), repos: z.array(RegistryEntrySchema) });
export type RegistryFile = z.infer<typeof RegistryFileSchema>;

export function registryPath(): string {
  return join(codeloomHome(), REGISTRY_FILE);
}

/** Missing file → an empty registry. A bad file → CodeloomError (exit 2) naming it and its backup: it lists
 * every repo indexed on this machine, so it is fixed or restored, never thrown away. */
export function readRegistry(): RegistryFile {
  const path = registryPath();
  if (!existsSync(path)) return { version: 1, repos: [] };
  const fix = `Fix it by hand, or restore the copy codeloom saved before its last change: ${path}.bak ` +
    `(copy it over ${REGISTRY_FILE}). It lists the repos you indexed on this machine and the group each one is in.`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw dataError(`${path} is not valid JSON. ${fix}`);
  }
  const r = RegistryFileSchema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw dataError(`${path} has an unexpected shape (${where}). ${fix}`);
  }
  return r.data;
}

/** Normalise (see `normalizeRegistry`) and write; untouched when nothing changed. Before a change, the current
 * file is copied to `registry.json.bak`. Call it inside `withRegistryLock` (updateRegistry does). */
export function writeRegistry(reg: RegistryFile): boolean {
  const path = registryPath();
  const next = normalizeRegistry(reg);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current === text) return false;
  if (current !== null) copyFileSync(path, `${path}.bak`);
  return writeJsonIfChanged(path, next);
}

/** Run `fn` holding the registry lock (`<home>/registry.lock`), so two codeloom runs never interleave their
 * read → change → write of the registry. */
export function withRegistryLock<T>(fn: () => T): T {
  return withLock(join(codeloomHome(), "registry.lock"), fn);
}

/** Read the registry, change it with `fn` and write it back, all under the registry lock. */
export function updateRegistry<T>(fn: (reg: RegistryFile) => { registry: RegistryFile; value: T }): T {
  return withRegistryLock(() => {
    const { registry, value } = fn(readRegistry());
    writeRegistry(registry);
    return value;
  });
}

/** Run `fn` holding the group's link lock: one re-link of a group at a time, so the last one to finish has
 * seen every member's saved map. Linking a large group can take a while: stale after 10 minutes. */
export function withGroupLinkLock<T>(group: string, fn: () => T): T {
  return withLock(join(codeloomHome(), GROUPS_DIR, `${groupDirName(group)}.link.lock`), fn, { staleMs: 600_000, timeoutMs: 1_200_000 });
}

/** The real path of `p` (symlinks resolved), else `p` resolved: what registry paths are compared by. */
export function realPath(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// ---- remotes and groups ---------------------------------------------------------------------------------

export interface ParsedRemote { host: string; owner: string; name: string }

/** `host/owner/name` from a git remote URL (`resolveHost`: maps the URL's host first, e.g. an ssh alias) (scp-like `git@host:owner/name.git`, `ssh://`, `https://`,
 * `git://`), lower-cased and without credentials or port. A local path or `file://` URL → null (no host to
 * group by). A path deeper than two segments (GitLab subgroups) keeps the first segment as the owner. */
export function parseRemote(url: string, resolveHost?: (host: string) => string): ParsedRemote | null {
  const raw = url.trim();
  if (raw === "") return null;
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === "file") return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    host = u.hostname;
    path = decodeURIComponent(u.pathname);
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
    if (!scp || /^[a-z]$/i.test(scp[1]!)) return null; // a local path, or a Windows drive letter
    host = scp[1]!;
    path = scp[2]!;
  }
  let parts = path.replace(/\.git\/?$/i, "").split("/").filter((s) => s !== "" && s !== "~");
  host = (resolveHost ? resolveHost(host) : host).toLowerCase();
  // Azure DevOps: ssh `ssh.dev.azure.com:v3/<org>/<project>/<repo>`, https `dev.azure.com/<org>/<project>/_git/<repo>`.
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    host = "dev.azure.com";
    if (parts[0]?.toLowerCase() === "v3") parts = parts.slice(1);
  }
  if (host === "dev.azure.com") parts = parts.filter((p) => p !== "_git");
  host = SSH_443_HOSTS[host] ?? host;
  if (host === "" || parts.length < 2) return null;
  const [owner, ...rest] = parts;
  return { host, owner: owner!.toLowerCase(), name: rest.join("/").toLowerCase() };
}

/** The ssh hosts of the big sites (ssh over port 443, Bitbucket's `ssh.bitbucket.org`), as the site they serve, so
 * one owner's repos stay one group whichever host a clone used (an ssh alias often points at one). */
const SSH_443_HOSTS: Record<string, string> = {
  "ssh.github.com": "github.com",
  "altssh.github.com": "github.com",
  "ssh.bitbucket.org": "bitbucket.org",
  "altssh.bitbucket.org": "bitbucket.org",
  "ssh.gitlab.com": "gitlab.com",
  "altssh.gitlab.com": "gitlab.com",
};

/** Whether a remote URL goes over ssh (scp-like or `ssh://`): its host may be an alias from ~/.ssh/config. */
function isSshRemote(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  return scheme ? /^(ssh|git\+ssh|ssh\+git)$/i.test(scheme[1]!) : true;
}

const sshHosts = new Map<string, string>();

/** For tests: forget the hosts ssh resolved. */
export function clearSshHostCache(): void {
  sshHosts.clear();
}

/** The real host behind an ssh alias (`Host github-work` → `HostName github.com` in ~/.ssh/config), read
 * with `ssh -G` once per alias. The alias itself when ssh is missing or fails, or the name is not a plain host. */
function sshHostname(alias: string): string {
  const cached = sshHosts.get(alias);
  if (cached !== undefined) return cached;
  let host = alias;
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(alias)) {
    try {
      const out = execFileSync("ssh", ["-G", "--", alias], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
      const line = out.split("\n").find((l) => /^hostname\s/i.test(l));
      const name = line?.split(/\s+/)[1]?.trim();
      if (name) host = name.toLowerCase();
    } catch {
      host = alias; // no ssh, or it failed: keep the alias
    }
  }
  sshHosts.set(alias, host);
  return host;
}

export const remoteKey = (r: ParsedRemote): string => `${r.host}/${r.owner}/${r.name}`;

/** The repo's remote: `origin`, else its first remote. Null when it has none (or none with a host). */
export function readRemote(repoAbs: string): ParsedRemote | null {
  const urlOf = (name: string): string | null => {
    try {
      return git(repoAbs, ["remote", "get-url", name]).trim();
    } catch {
      return null;
    }
  };
  let url = urlOf("origin");
  if (url === null) {
    let names: string[] = [];
    try {
      names = git(repoAbs, ["remote"]).split("\n").map((s) => s.trim()).filter(Boolean).sort(compare);
    } catch {
      names = [];
    }
    url = names.length > 0 ? urlOf(names[0]!) : null;
  }
  if (url === null) return null;
  return parseRemote(url, isSshRemote(url) ? sshHostname : undefined);
}

/** A group's folder name under `<home>/groups/`: anything outside `[A-Za-z0-9._-]` becomes `-`. */
export function groupSlug(group: string): string {
  return group.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
}

/** A `--group` value, checked: it must leave a usable folder name. */
export function checkGroupName(group: string): string {
  const name = group.trim();
  if (groupSlug(name) === "") throw dataError(`Bad group name "${group}": use letters, digits, ".", "_", "-" or "/".`);
  return name;
}

/** The group a repo joins on its own: its remote's `host/owner`, else its parent folder's name. */
export function autoGroup(repoAbs: string, remote: ParsedRemote | null): { group: string; from: "remote" | "folder" } {
  if (remote) return { group: `${remote.host}/${remote.owner}`, from: "remote" };
  const parent = basename(dirname(repoAbs));
  return { group: groupSlug(parent) === "" ? "repos" : parent, from: "folder" };
}

/** A group's folder name: its slug plus 8 hex of the exact name's sha256, so `a/b`, `a-b` and a parent folder
 * named like a remote group never share a folder. */
export function groupDirName(group: string): string {
  return `${groupSlug(group) || "group"}-${createHash("sha256").update(group).digest("hex").slice(0, 8)}`;
}

/** `<home>/groups/<groupDirName>`: the group's data root (its `.codeloom/` holds chains, journeys, tours...). */
export function groupRoot(group: string): string {
  return join(codeloomHome(), GROUPS_DIR, groupDirName(group));
}

// ---- copies, ids, registration ------------------------------------------------------------------------

/** What makes two entries checkouts of the same repo: the remote, else the path. */
const identity = (e: RegistryEntry): string => (e.remote !== undefined ? `remote:${e.remote}` : `path:${e.path}`);
const newestFirst = (a: RegistryEntry, b: RegistryEntry) => compare(b.indexedAt, a.indexedAt) || compare(a.path, b.path);

/** Sorted (group, id, path); in each group, every set of checkouts of one remote has one copy (the most
 * recently indexed) with no `copyOf`, and the others point at it and share its id. */
export function normalizeRegistry(reg: RegistryFile): RegistryFile {
  const byIdentity = new Map<string, RegistryEntry[]>();
  for (const e of reg.repos) {
    const k = `${e.group}\0${identity(e)}`;
    byIdentity.set(k, [...(byIdentity.get(k) ?? []), e]);
  }
  const out: RegistryEntry[] = [];
  for (const list of byIdentity.values()) {
    const [primary, ...copies] = [...list].sort(newestFirst);
    const { copyOf: _drop, ...rest } = primary!;
    out.push(rest);
    for (const c of copies) out.push({ ...c, id: primary!.id, copyOf: primary!.path });
  }
  out.sort((a, b) => compare(a.group, b.group) || compare(a.id, b.id) || compare(a.path, b.path));
  return { version: 1, repos: out };
}

export function entryFor(reg: RegistryFile, repoAbs: string): RegistryEntry | undefined {
  const real = realPath(repoAbs);
  return reg.repos.find((e) => e.path === real);
}

export interface Registration {
  entry: RegistryEntry;
  /** The registry with this repo registered (normalised; not written yet). */
  registry: RegistryFile;
  /** Other checkouts of the same remote in the group, now copies of this one. */
  copies: string[];
}

/** Register (or refresh) the repo at `repoAbs` (its top folder) as indexed `now`. The group: `group`
 * (`--group`), else a group set earlier with `--group`, else from the remote / parent folder. The id: the
 * id of an earlier checkout of the same remote in the group, else the id it already had in this group,
 * else `baseId` made unique among the group's repos (`-2`, `-3`, ...). Pure: the caller writes it. */
export function planRegistration(
  reg: RegistryFile,
  repoAbs: string,
  opts: { baseId: string; remote: ParsedRemote | null; group?: string; now?: Date },
): Registration {
  const path = realPath(repoAbs);
  const existing = reg.repos.find((e) => e.path === path);
  const auto = autoGroup(path, opts.remote);
  const { group, from } = opts.group !== undefined
    ? { group: checkGroupName(opts.group), from: "flag" as const }
    : existing?.groupFrom === "flag" ? { group: existing.group, from: "flag" as const } : auto;
  const remote = opts.remote ? remoteKey(opts.remote) : undefined;
  const others = reg.repos.filter((e) => e.path !== path);
  const siblings = remote === undefined ? [] : others.filter((e) => e.group === group && e.remote === remote).sort(newestFirst);
  let id: string;
  if (siblings.length > 0) id = siblings[0]!.id;
  else if (existing && existing.group === group) id = existing.id;
  else {
    const taken = new Set(others.filter((e) => e.group === group).map((e) => e.id));
    id = opts.baseId;
    for (let n = 2; taken.has(id); n++) id = `${opts.baseId}-${n}`;
  }
  const entry: RegistryEntry = {
    id, path, ...(remote !== undefined ? { remote } : {}), group, groupFrom: from,
    indexedAt: (opts.now ?? new Date()).toISOString(), ...(existing?.role !== undefined ? { role: existing.role } : {}),
  };
  const registry = normalizeRegistry({ version: 1, repos: [...others, entry] });
  return { entry, registry, copies: siblings.map((s) => s.path).sort(compare) };
}

// ---- a group as a workspace -----------------------------------------------------------------------------

export interface GroupWorkspace {
  root: string;
  name: string;
  /** The group's repos for linking: one per remote (the newest indexed checkout still on disk); ABSOLUTE paths. */
  repos: RepoRef[];
  links: [];
  group: string;
  /** Registered checkouts whose folder is gone (moved or deleted). */
  missing: RegistryEntry[];
  /** Checkouts ignored for linking (an older checkout of a remote another member stands for). */
  copies: RegistryEntry[];
}

const isRepoDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, ".git"));
  } catch {
    return false;
  }
};

/** The group as a workspace. A copy whose primary folder is gone stands in for it (newest present wins). */
export function groupWorkspace(reg: RegistryFile, group: string): GroupWorkspace {
  const entries = reg.repos.filter((e) => e.group === group);
  const missing = entries.filter((e) => !isRepoDir(e.path));
  const present = entries.filter((e) => isRepoDir(e.path));
  const byIdentity = new Map<string, RegistryEntry[]>();
  for (const e of present) byIdentity.set(identity(e), [...(byIdentity.get(identity(e)) ?? []), e]);
  const repos: RepoRef[] = [];
  const copies: RegistryEntry[] = [];
  for (const list of byIdentity.values()) {
    const [primary, ...rest] = [...list].sort(newestFirst);
    repos.push({ id: primary!.id, path: primary!.path });
    copies.push(...rest);
  }
  repos.sort((a, b) => compare(a.id, b.id));
  return {
    root: groupRoot(group), name: group, repos, links: [], group,
    missing: missing.sort((a, b) => compare(a.path, b.path)), copies: copies.sort((a, b) => compare(a.path, b.path)),
  };
}

function isInside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The group whose data root holds `start` (`<home>/groups/<groupDirName>/...`), if any registered group has that slug. */
export function groupAtDataRoot(reg: RegistryFile, start: string): string | null {
  const groups = realPath(join(codeloomHome(), GROUPS_DIR));
  const real = realPath(start);
  if (!isInside(groups, real) || real === groups) return null;
  const dir = relative(groups, real).split(/[\\/]/)[0]!;
  const names = [...new Set(reg.repos.map((e) => e.group))].sort(compare);
  return names.find((g) => groupDirName(g) === dir) ?? null;
}

/** The registered group of the repo whose top folder is `top`, or of the group data root holding `start`. */
export function findGroup(reg: RegistryFile, start: string, top: string | null): string | null {
  if (reg.repos.length === 0) return null;
  const atRoot = groupAtDataRoot(reg, start);
  if (atRoot) return atRoot;
  if (top === null) return null;
  return entryFor(reg, top)?.group ?? null;
}

/** The repo's absolute folder: `ref.path` as is when absolute (a group), else under `root` (a workspace folder). */
export function repoAbsPath(root: string, ref: Pick<RepoRef, "path">): string {
  return isAbsolute(ref.path) ? ref.path : join(root, ref.path);
}
