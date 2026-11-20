import { createHash } from "node:crypto";
import { aloneInGroup, aloneLine, type AloneInfo, unindexedSiblings } from "../map/alone.js";
import { join } from "node:path";
import { dataError } from "../errors.js";
import { type IndexStats, indexRepo } from "../indexer/index-repo.js";
import { loadSavedIndex } from "../indexer/saved.js";
import { type LinkerWorkspace, type LinkOutput, runLinker, writeLink } from "../linker/run.js";
import type { LinkerSummary } from "../linker/run.js";
import { writeSpecCandidates } from "../specs/candidates.js";
import { CODELOOM_DIR, FILES, WORKSPACE_FILE } from "../store/paths.js";
import { codeloomHome } from "../store/home.js";
import { readJson } from "../store/json.js";
import { withLock } from "../store/lock.js";
import { ChainsFileSchema, type EndpointsFile, type RepoRef, type SpecsConfig } from "../store/schemas.js";
import { compare } from "../util.js";
import { defaultRepoId, groupRepoId, findWorkspaceRoot, gitToplevel, loadWorkspace } from "../workspace/repos.js";
import { carryOverRepoData } from "../workspace/carry-over.js";
import { carryOverProgress } from "../store/progress.js";
import { ensureExcludeLines } from "../workspace/exclude.js";
import {
  entryFor, findGroup, groupAtDataRoot, groupRoot, groupWorkspace, planRegistration, readRegistry, readRemote, realPath, type RegistryFile,
  repoAbsPath, updateRegistry, withGroupLinkLock,
} from "../workspace/registry.js";

/** What a run inside one repo of a group did to the group (0.6 §1). */
export interface GroupRunInfo {
  name: string;
  /** Ids of the group's repos linked this run (this one, and the others read from their saved data). */
  members: string[];
  /** Older checkouts of a remote another member stands for: ignored for linking. */
  copies: string[];
  /** Those this run made copies (named in the summary; the others are only counted). */
  newCopies?: string[];
  /** Registered repos whose folder is gone (moved or deleted): dropped from the registry. */
  dropped: string[];
  /** Repos chains go between, with how many chains: in chain order (UI first). */
  connections: Array<{ from: string; to: string; chains: number }>;
  /** Members that could not be linked with full detail, or at all. */
  notes: string[];
  /** What a 0.5 lone repo's own `.codeloom/` gave the group on its first 0.6 index (journeys, tours, views, specs). */
  carried?: string[];
  carriedFrom?: string;
  /** The indexed repo is its group's only repo and its calls match nothing there (0.6 Task E): which other
   * group its calls match. */
  alone?: AloneInfo;
  /** Git repos next to the group's repos not indexed yet (folder names). */
  unindexed?: string[];
}

export interface IndexRunResult {
  root: string;
  repos: Array<{ id: string; stats: IndexStats; endpoints: EndpointsFile }>;
  linker: LinkerSummary;
  /** Lines for the user from the spec-candidates step (a git history too big to read, ...). */
  specNotes: string[];
  /** Set when the run was inside a repo with no workspace file (a group, 0.6 §1). */
  group?: GroupRunInfo;
}

type Indexed = { ref: RepoRef; abs: string; result: Awaited<ReturnType<typeof indexRepo>>; saved?: boolean; remote?: string | null };

/** `codeloom index`. In a workspace folder: index every repo, then link them (as in 0.5). Inside a git repo
 * with no workspace file (0.6 §1): index that repo only, register it in the machine-local registry, then
 * re-link its whole group from the other members' saved data (never re-parsed). In a group's data folder:
 * re-link the group only. `group` (`--group`) names the group to join (outside a workspace folder only). */
export async function runIndex(start: string, opts: { group?: string } = {}): Promise<IndexRunResult> {
  if (findWorkspaceRoot(start) !== null) {
    if (opts.group !== undefined) {
      throw dataError(`--group is for a repo outside a workspace folder; this folder uses ${WORKSPACE_FILE}.`);
    }
    return runWorkspaceIndex(start);
  }
  const top = gitToplevel(start);
  if (top !== null) return runRepoIndex(top, opts.group);
  const group = groupAtDataRoot(readRegistry(), start);
  if (group !== null) {
    if (opts.group !== undefined) throw dataError(`--group is for a repo: run "codeloom index --group ${opts.group}" inside the repo.`);
    const dropped = updateRegistry((reg) => dropGone(reg, group));
    return withGroupLinkLock(group, () => linkGroup(group, [], { dropped, carried: [], carriedFrom: "" }));
  }
  return runWorkspaceIndex(start); // loadWorkspace's "no workspace or git repo" error
}

async function runWorkspaceIndex(start: string): Promise<IndexRunResult> {
  const ws = loadWorkspace(start);
  const repos: IndexRunResult["repos"] = [];
  const indexed: Indexed[] = [];
  for (const repo of ws.repos) {
    const abs = repoAbsPath(ws.root, repo);
    const res = await indexRepo(abs, repo.id, { writeGraph: false }); // runLinker writes the enriched graph
    repos.push({ id: repo.id, stats: res.stats, endpoints: res.endpoints });
    indexed.push({ ref: repo, abs, result: res });
  }
  // Link holding the map's link lock (it reads answers.json): an answer saved while the repos were parsed is
  // seen here, never overwritten by an older link (0.6 §5).
  return withMapLinkLock(start, () => {
    const linker = runLinker(ws, indexed);
    // v0.3 §1: spec candidates for every journey, from repo docs and git history (after the linker, which
    // writes the chains and journeys they are built from).
    const specNotes: string[] = [];
    writeSpecCandidates(ws.root, indexed.map((x) => ({ id: x.ref.id, abs: x.abs, files: x.result.files })), ws.specs, specNotes);
    return { root: ws.root, repos, linker, specNotes };
  });
}

/** The group a map at `start` belongs to (outside a workspace folder), else null. */
function mapGroup(start: string): string | null {
  return findWorkspaceRoot(start) === null ? findGroup(readRegistry(), start, gitToplevel(start)) : null;
}

/** Run `fn` holding the link lock of the map at `start`: the group's link lock, or (a workspace folder or a lone
 * repo) a lock kept under CODELOOM_HOME named by the folder, so nothing is written into it. One link of a map
 * at a time; saving answers and linking with them happen under it together (0.6 §5). Not re-entrant. */
export function withMapLinkLock<T>(start: string, fn: () => T): T {
  const group = mapGroup(start);
  if (group !== null) return withGroupLinkLock(group, fn);
  const key = createHash("sha256").update(realPath(loadWorkspace(start).root)).digest("hex").slice(0, 16);
  return withLock(join(codeloomHome(), "locks", `${key}.link.lock`), fn, { staleMs: 600_000, timeoutMs: 1_200_000 });
}

/** A workspace folder's (or lone repo's) repos read back from their saved data. */
function savedInputs(start: string): { ws: ReturnType<typeof loadWorkspace>; indexed: Indexed[]; notes: string[] } {
  const ws = loadWorkspace(start);
  const notes: string[] = [];
  const indexed: Indexed[] = ws.repos.map((ref) => {
    const abs = repoAbsPath(ws.root, ref);
    const saved = loadSavedIndex(abs, ref.id);
    if (!saved) throw dataError(`Repo "${ref.id}" has no .codeloom data yet. Run "codeloom index" first.`, { code: "not-indexed" });
    if (saved.note) notes.push(saved.note);
    return { ref, abs, result: saved.result, saved: true };
  });
  return { ws, indexed, notes };
}

/** What a link of the map at `start` reads, from every repo's saved data: the group of the repo or group data
 * folder holding it, else the workspace folder (or lone repo). Read once by save_map_answers, which links it in
 * memory twice and writes the second (0.6 §5). */
export interface LinkInputs {
  ws: LinkerWorkspace;
  indexed: Indexed[];
  notes: string[];
  specs?: SpecsConfig;
}

export function linkInputs(start: string): LinkInputs {
  const group = mapGroup(start);
  if (group !== null) {
    const { ws, indexed, notes } = groupInputs(group, []);
    return { ws: { root: ws.root, name: ws.name, repos: indexed.map((x) => x.ref), links: [] }, indexed, notes };
  }
  const { ws, indexed, notes } = savedInputs(start);
  return { ws, indexed, notes, ...(ws.specs ? { specs: ws.specs } : {}) };
}

/** Write a link of `inputs` already computed in memory (`out`), and the spec candidates it implies. */
export function writeLinkOf(inputs: LinkInputs, out: LinkOutput): void {
  writeLink(inputs.ws, inputs.indexed, out);
  writeSpecCandidates(inputs.ws.root, inputs.indexed.map((x) => ({ id: x.ref.id, abs: x.abs, files: x.result.files })), inputs.specs, []);
}

/** runLink's work, for a caller already holding the map's link lock (withMapLinkLock). */
export function linkMapLocked(start: string): IndexRunResult {
  const group = mapGroup(start);
  if (group !== null) return linkGroup(group, [], { dropped: [], carried: [], carriedFrom: "" });
  const { ws, indexed, notes } = savedInputs(start);
  const linker = runLinker(ws, indexed);
  writeSpecCandidates(ws.root, indexed.map((x) => ({ id: x.ref.id, abs: x.abs, files: x.result.files })), ws.specs, notes);
  return { root: ws.root, repos: [], linker, specNotes: notes };
}

/** Re-link the map from every repo's saved data, parsing nothing (0.6 §5: after the user answered a question
 * about the map, or edited answers.json): the group of the repo or group data folder holding `start`, else the
 * workspace folder (or lone repo) holding it. A repo with no saved map yet is an error there (run index). */
export function runLink(start: string): IndexRunResult {
  return withMapLinkLock(start, () => linkMapLocked(start));
}

/** `codeloom link`'s summary: what was re-linked and what it gave. */
export function formatLinkSummary(r: IndexRunResult): string {
  const lines = r.group ? groupLines(r, r.group) : [];
  lines.push(`${r.linker.chains} chains (${r.linker.complete} complete) written to ${join(r.root, CODELOOM_DIR, FILES.chains)}`);
  if (r.linker.orphanedJourneys > 0) lines.push(`${r.linker.orphanedJourneys} journeys orphaned (their chains no longer exist)`);
  lines.push(...r.specNotes);
  return lines.join("\n");
}

/** Index the repo at `top`, register it, re-link its group. The registry is written only after the index
 * succeeded, so a failed run leaves it as it was. */
async function runRepoIndex(top: string, groupFlag: string | undefined): Promise<IndexRunResult> {
  const remote = readRemote(top);
  const opts = { baseId: groupRepoId(top, remote?.name), remote, ...(groupFlag !== undefined ? { group: groupFlag } : {}) };
  const registered = readRegistry();
  const copiesBefore = new Set(registered.repos.filter((e) => e.copyOf !== undefined).map((e) => e.path));
  const first = planRegistration(registered, top, opts);
  let res = await indexRepo(top, first.entry.id, { writeGraph: false });
  // Register under the registry lock, planning again on the registry as it is now (another repo may have
  // registered meanwhile), and drop the group's repos whose folder is gone.
  const reg = updateRegistry((current) => {
    const isNew = entryFor(current, top) === undefined;
    const plan = planRegistration(current, top, opts);
    const { registry, value: dropped } = dropGone(plan.registry, plan.entry.group);
    return { registry, value: { entry: plan.entry, isNew, dropped } };
  });
  // Should that have changed this repo's id, index again under the new id (every file comes from the cache).
  if (reg.entry.id !== first.entry.id) res = await indexRepo(top, reg.entry.id, { writeGraph: false });
  // Keep `git status` clean: the repo's map is local to this machine (never .gitignore, never a hook).
  ensureExcludeLines(top, [`${CODELOOM_DIR}/`]);
  const fresh: Indexed = { ref: { id: reg.entry.id, path: reg.entry.path }, abs: reg.entry.path, result: res };
  const group = reg.entry.group;
  // One re-link of a group at a time: the last to finish has seen every member's saved map.
  return withGroupLinkLock(group, () => {
    // A 0.5 lone repo's journeys, tours, views and specs join the group the first time it is registered.
    const carried = reg.isNew ? carryOverRepoData(top, groupRoot(group)) : [];
    if (reg.isNew) {
      // ...and so does your personal progress, kept under the old one-repo workspace's id.
      const oldId = defaultRepoId(top);
      const members = groupWorkspace(readRegistry(), group).repos.map((r) => ({ ref: { id: r.id }, abs: r.path }));
      const n = carryOverProgress({ root: top, name: oldId, repos: [{ ref: { id: oldId }, abs: top }] }, { root: groupRoot(group), name: group, repos: members });
      if (n > 0) carried.push(`your progress on ${n} journey${n === 1 ? "" : "s"}`);
    }
    const out = linkGroup(group, [fresh], { dropped: reg.dropped, carried, carriedFrom: join(top, CODELOOM_DIR) });
    const now = readRegistry();
    const alone = aloneInGroup(now, group, { id: fresh.ref.id, endpoints: res.endpoints });
    const unindexed = unindexedSiblings(now, group);
    if (!out.group) return out;
    const newCopies = out.group.copies.filter((c) => !copiesBefore.has(c));
    return {
      ...out,
      group: { ...out.group, ...(alone ? { alone } : {}), ...(unindexed.length > 0 ? { unindexed } : {}), ...(newCopies.length > 0 ? { newCopies } : {}) },
    };
  });
}

/** `reg` without the group's registered checkouts whose folder is gone; and their paths. */
function dropGone(reg: RegistryFile, group: string): { registry: RegistryFile; value: string[] } {
  const gone = new Set(groupWorkspace(reg, group).missing.map((m) => m.path));
  return { registry: { version: 1, repos: reg.repos.filter((e) => !gone.has(e.path)) }, value: [...gone].sort(compare) };
}

/** Link the group (call it holding its link lock): `fresh` as indexed this run, every other member from its
 * saved data, read from the registry as it is now. */
function linkGroup(group: string, fresh: Indexed[], done: { dropped: string[]; carried: string[]; carriedFrom: string }): IndexRunResult {
  const { ws, indexed, notes } = groupInputs(group, fresh);
  const linked = { root: ws.root, name: ws.name, repos: indexed.map((x) => x.ref), links: [] };
  const linker = runLinker(linked, indexed);
  const specNotes: string[] = [];
  writeSpecCandidates(ws.root, indexed.map((x) => ({ id: x.ref.id, abs: x.abs, files: x.result.files })), undefined, specNotes);
  return {
    root: ws.root,
    repos: fresh.map((x) => ({ id: x.ref.id, stats: x.result.stats, endpoints: x.result.endpoints })),
    linker,
    specNotes,
    group: {
      name: group,
      members: indexed.map((x) => x.ref.id),
      copies: ws.copies.map((c) => c.path),
      dropped: done.dropped,
      connections: connections(ws.root),
      notes,
      ...(done.carried.length > 0 ? { carried: done.carried, carriedFrom: done.carriedFrom } : {}),
    },
  };
}

/** What a link of the group reads: `fresh` as indexed this run, every other member from its saved data (the
 * registry as it is now); members that cannot be read are left out, with a note. */
function groupInputs(group: string, fresh: Indexed[]): { ws: ReturnType<typeof groupWorkspace>; indexed: Indexed[]; notes: string[] } {
  const registry = readRegistry();
  const ws = groupWorkspace(registry, group);
  const notes: string[] = [];
  const indexed: Indexed[] = [...fresh];
  const freshIds = new Set(fresh.map((x) => x.ref.id));
  for (const ref of ws.repos) {
    if (freshIds.has(ref.id)) continue;
    let saved: ReturnType<typeof loadSavedIndex>;
    try {
      saved = loadSavedIndex(ref.path, ref.id);
    } catch (err) {
      notes.push(`${ref.id}: its saved map could not be read (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}): not linked`);
      continue;
    }
    if (!saved) {
      notes.push(`${ref.id} has no saved map of its own (run "codeloom index" in ${ref.path}): not linked`);
      continue;
    }
    if (saved.note) notes.push(saved.note);
    indexed.push({ ref, abs: ref.path, result: saved.result, saved: true });
  }
  indexed.sort((a, b) => compare(a.ref.id, b.ref.id));
  // The registry already knows each member's remote (0.6 §2 matches call bases to its repo name): no git call.
  const remoteOf = (abs: string): string | null => registry.repos.find((e) => e.path === abs)?.remote ?? null;
  return { ws, indexed: indexed.map((x) => ({ ...x, remote: remoteOf(x.abs) })), notes };
}

/** Pairs of repos one calls the other in a chain (a stop reached from a stop in another repo), with how many
 * chains (each chain counted once per pair). */
function connections(root: string): GroupRunInfo["connections"] {
  const chains = readJson(join(root, CODELOOM_DIR, FILES.chains), ChainsFileSchema)?.chains ?? [];
  const counts = new Map<string, number>();
  for (const c of chains) {
    const pairs = new Set<string>();
    // A direct edge: a stop and the stop it was reached from (`from`), never two stops that merely sit side by
    // side (an inlined service block or a paired consumer is reached from an earlier stop, not the one before it).
    const legacy = !c.stops.some((s) => s.from !== undefined);
    for (let i = 1; i < c.stops.length; i++) {
      const parent = c.stops[legacy ? i - 1 : c.stops[i]!.from ?? -1];
      if (!parent) continue;
      const a = parent.repo;
      const b = c.stops[i]!.repo;
      if (a !== b) pairs.add(`${a}\0${b}`);
    }
    for (const p of pairs) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => {
    const [from, to] = k.split("\0") as [string, string];
    return { from, to, chains: n };
  }).sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
}

/** Whether `start` is in a registered repo's group or a group data folder (for commands that report it). */
export function groupAt(start: string): string | null {
  return findGroup(readRegistry(), start, gitToplevel(start));
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** H7: why `files` and `parsed` differ, one line per repo where they do. `files` counts every file in the
 * repo; the rest were not source code (nothing to parse), unchanged (reused from the cache) or skipped. */
function filesNote(r: IndexRunResult): string[] {
  const lines = r.repos.flatMap(({ id, stats }) => {
    if (stats.files === stats.parsed) return [];
    const skipped = stats.skipped.length;
    const nothing = stats.files - stats.parsed - stats.reused - skipped;
    const parts = [
      nothing > 0 ? `${count(nothing, "file", "files")} had nothing to parse` : "",
      stats.reused > 0 ? `${stats.reused} unchanged since the last run` : "",
      skipped > 0 ? `${skipped} skipped` : "",
    ].filter(Boolean);
    return parts.length > 0 ? [`  ${id}: ${parts.join(", ")}`] : [];
  });
  return lines.length > 0 ? ["files counts every file in the repo; parsed counts the source files read again this run:", ...lines] : [];
}

export function formatIndexSummary(r: IndexRunResult): string {
  const header = ["repo", "files", "parsed", "reused", "pages", "calls", "routes", "tables", "queues", "skipped"];
  const rows = r.repos.map((x) => [
    x.id,
    x.stats.files,
    x.stats.parsed,
    x.stats.reused,
    x.endpoints.pages.length,
    x.endpoints.httpCalls.length,
    x.endpoints.routes.length,
    x.endpoints.tables.length,
    x.endpoints.queues.length,
    x.stats.skipped.length,
  ].map(String));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  const skipped = r.repos.flatMap((x) => x.stats.skipped.map((s) => `  ${x.id}/${s.file}: ${s.reason}`));
  const orphanedNote = r.linker.orphanedJourneys > 0 ? [`${r.linker.orphanedJourneys} journeys orphaned (their chains no longer exist)`] : [];
  return [
    line(header),
    ...rows.map(line),
    "",
    ...filesNote(r),
    ...(r.group ? groupLines(r, r.group) : [`${r.repos.length} repos indexed in ${r.root}`]),
    `${r.linker.chains} chains (${r.linker.complete} complete) written to ${r.group ? join(r.root, CODELOOM_DIR, FILES.chains) : ".codeloom/chains.json"}`,
    ...orphanedNote,
    ...r.specNotes,
    ...(skipped.length ? ["Skipped files:", ...skipped] : []),
  ].join("\n");
}

/** The group part of the summary: what was indexed, which repos are in the group, what got connected. */
function groupLines(r: IndexRunResult, g: GroupRunInfo): string[] {
  const indexed = r.repos.map((x) => x.id);
  const others = g.members.filter((m) => !indexed.includes(m));
  const lines = [
    indexed.length > 0
      ? `Indexed ${indexed.join(", ")} and linked it with ${others.length === 0 ? "no other repo yet" : `${count(others.length, "other repo", "other repos")} (${others.join(", ")})`}`
      : `Re-linked ${count(g.members.length, "repo", "repos")} (${g.members.join(", ")})`,
    `Group ${g.name}: ${count(g.members.length, "repo", "repos")}`,
  ];
  if (g.unindexed && g.unindexed.length > 0) {
    const shown = g.unindexed.slice(0, 8).join(", ") + (g.unindexed.length > 8 ? `, +${g.unindexed.length - 8} more` : "");
    lines.push(`Not indexed yet, next to the group's repos: ${shown} — run "npx codeloom index" in each`);
  }
  if (g.connections.length > 0) {
    lines.push("Connected:", ...g.connections.map((c) => `  ${c.from} → ${c.to}: ${count(c.chains, "chain", "chains")}`));
  } else {
    lines.push("Connected: nothing across repos yet");
  }
  const fresh = new Set(g.newCopies ?? []);
  for (const c of g.copies) if (fresh.has(c)) lines.push(`Ignored ${c}: an older checkout of a repo already in the group`);
  const known = g.copies.filter((c) => !fresh.has(c)).length;
  if (known > 0) lines.push(`${count(known, fresh.size > 0 ? "other older checkout" : "older checkout", fresh.size > 0 ? "other older checkouts" : "older checkouts")} ignored`);
  for (const d of g.dropped) lines.push(`Removed ${d} from the group: no longer found (moved or deleted)`);
  if (g.carried && g.carried.length > 0) lines.push(`Carried over from ${g.carriedFrom} into the group: ${g.carried.join(", ")}`);
  if (g.alone) lines.push(aloneLine(g.alone));
  lines.push(...g.notes);
  return lines;
}
