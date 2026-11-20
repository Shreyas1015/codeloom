import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonIfChanged } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import {
  type EndpointsFile, type ExternalService, ProxyRuleSchema, type QueueOp, type QueueUnknown, type RepoRef, RepoRoleSchema, type WorkspaceFile,
} from "../store/schemas.js";
import type { AnswerHint } from "../linker/link.js";
import { compare } from "../util.js";

// 0.6 spec §5: what the user told Claude about the map (the map-interview), kept in the group's (or the
// workspace folder's) `.codeloom/answers.json`. Every link reads it (linker/run.ts), so re-indexing any repo
// keeps them: nothing is asked twice. Written only by save_map_answers, which checks every name first.

const name = z.string().trim().min(1).max(200);

/** One answer. Each kind feeds an input the linker already has:
 * - `env`: calls whose base is this env var / host / base expression (its full text) go to `repo`. `from` is the
 *   calling repo: required when more than one repo calls through that base (two frontends may point the same env
 *   var at different backends), and only that repo's calls are placed;
 * - `external`: calls through this base (from repo `from`, as for `env`) go to another service, `name`;
 * - `proxy`: `repo`'s calls under `from` are forwarded to `to` (the repo's `proxies`);
 * - `link`: a manual hop (the workspace file's `links`: "<repo>:<file>#<symbol>", "route:<repo>:<METHOD> <path>",
 *   "queue:<repo>:<queue>");
 * - `role`: what the repo is (`ui`, `api`, `worker`, `lib`: a `lib` is expected to stand alone). It only
 *   describes the repo: it never changes how calls are matched (a global "api" role would narrow every call);
 * - `ignore-repo`: the repo is not part of this system: left out of linking and of the gaps;
 * - `queue-alias`: messages published as `publish` arrive on the consumed queue `consume` (a binding codeloom
 *   cannot see, e.g. made by infrastructure);
 * - `ignore-gap`: this gap is expected (nothing to connect): not asked again;
 * - `join-group`: `repo`, alone in its group, belongs with the repos of `group` (0.6 Task E). Done at once (the
 *   registry entry moves, as `codeloom index --group` would), never kept in answers.json;
 * - `queue-name`: the publish / consume codeloom found at `at` ("<file>:<line>") in `repo` but could not read the
 *   names of (a `queue-unknown` gap) uses these names: `queue`, or for a publish through an exchange `exchange` +
 *   `routingKey`. The parts codeloom did read may be left out. */
export const AnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: z.string().trim().min(1).max(2000), repo: name, from: name.optional() }).strict(),
  z.object({ kind: z.literal("external"), base: z.string().trim().min(1).max(2000), name: name.optional(), from: name.optional() }).strict(),
  z.object({ kind: z.literal("proxy"), repo: name, from: ProxyRuleSchema.shape.from, to: name, stripPrefix: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("link"), from: name, to: name }).strict(),
  z.object({ kind: z.literal("role"), repo: name, role: RepoRoleSchema }).strict(),
  z.object({ kind: z.literal("ignore-repo"), repo: name }).strict(),
  z.object({ kind: z.literal("queue-alias"), publish: name, consume: name }).strict(),
  z.object({ kind: z.literal("ignore-gap"), gap: z.string().regex(/^g_[0-9a-f]{12}$/, "a gap id from map_gaps (g_…)") }).strict(),
  z.object({ kind: z.literal("join-group"), repo: name, group: name }).strict(),
  z.object({
    kind: z.literal("queue-name"), repo: name, at: z.string().trim().regex(/^.+:\d+$/, 'a place "<file>:<line>" from the gap'),
    queue: name.optional(), exchange: name.optional(), routingKey: z.string().trim().max(200).optional(),
  }).strict(),
]);
export type Answer = z.infer<typeof AnswerSchema>;
export type AnswerKind = Answer["kind"];

export const AnswersFileSchema = z.object({ version: z.literal(1), answers: z.array(AnswerSchema) });
export type AnswersFile = z.infer<typeof AnswersFileSchema>;

export function answersPath(root: string): string {
  return join(root, CODELOOM_DIR, FILES.answers);
}

/** The saved answers (missing file → none). A bad file → CodeloomError: it holds the user's own answers, so it
 * is never deleted or rebuilt; it must be fixed by hand. */
export function readAnswers(root: string): Answer[] {
  return readJson(answersPath(root), AnswersFileSchema, { handWritten: true })?.answers ?? [];
}

/** What an answer is about: a later answer with the same key replaces it. */
export function answerKey(a: Answer): string {
  switch (a.kind) {
    case "env": return `base:${a.from ?? "*"}:${a.name}`;
    case "external": return `base:${a.from ?? "*"}:${a.base}`;
    case "proxy": return `proxy:${a.repo}:${a.from}`;
    case "link": return `link:${a.from}>${a.to}`;
    case "role": return `role:${a.repo}`;
    case "ignore-repo": return `ignore-repo:${a.repo}`;
    case "queue-alias": return `queue:${a.publish}>${a.consume}`;
    case "ignore-gap": return `ignore-gap:${a.gap}`;
    case "join-group": return `join-group:${a.repo}`;
    case "queue-name": return `queue-name:${a.repo}:${a.at}`;
  }
}

/** `old` with `add` applied in order (same key → replaced), sorted by key so the file is stable. */
export function mergeAnswers(old: Answer[], add: Answer[]): Answer[] {
  const byKey = new Map(old.map((a) => [answerKey(a), a]));
  for (const a of add) byKey.set(answerKey(a), a);
  return [...byKey.entries()].sort(([a], [b]) => compare(a, b)).map(([, a]) => a);
}

/** Write the answers (sorted); untouched when nothing changed. */
export function writeAnswers(root: string, answers: Answer[]): boolean {
  const file: AnswersFile = { version: 1, answers: mergeAnswers([], answers) };
  return writeJsonIfChanged(answersPath(root), file);
}

export interface QueueAlias { publish: string; consume: string }

export type QueueNameAnswer = Extract<Answer, { kind: "queue-name" }>;

/** The op a `queue-name` answer makes of the unknown it is about; undefined when it leaves a name out. */
export function answeredOp(u: QueueUnknown, a: QueueNameAnswer): QueueOp | undefined {
  if (u.op === "consume") {
    const queue = a.queue ?? u.queue;
    return queue ? { queue, op: "consume", at: u.at, ...(u.handler ? { handler: u.handler } : {}) } : undefined;
  }
  if (u.missing.includes("queue")) return a.queue ? { queue: a.queue, op: "publish", at: u.at } : undefined;
  const exchange = a.exchange ?? u.exchange;
  const routingKey = a.routingKey ?? u.routingKey;
  if (exchange === undefined || routingKey === undefined) return undefined;
  const queue = exchange && routingKey ? `${exchange}:${routingKey}` : exchange || routingKey;
  return queue ? { queue, op: "publish", exchange, routingKey, at: u.at } : undefined;
}

/** `endpoints` with the user's `queue-name` answers for `repo` applied: each answered unknown becomes a queue op
 * at its place (and is no longer unknown). Never edits the saved file. */
export function withAnsweredQueues(endpoints: EndpointsFile, repo: string, answers: QueueNameAnswer[]): EndpointsFile {
  const mine = answers.filter((a) => a.repo === repo);
  if (mine.length === 0 || !endpoints.queueUnknown?.length) return endpoints;
  const added: QueueOp[] = [];
  const left: QueueUnknown[] = [];
  for (const u of endpoints.queueUnknown) {
    const a = mine.find((x) => x.at === `${u.at.file}:${u.at.line}`);
    const op = a && answeredOp(u, a);
    if (op) added.push(op);
    else left.push(u);
  }
  if (added.length === 0) return endpoints;
  const { queueUnknown: _old, ...rest } = endpoints;
  return { ...rest, queues: [...endpoints.queues, ...added], ...(left.length > 0 ? { queueUnknown: left } : {}) };
}

/** The linker's inputs with the answers applied. */
export interface LinkConfig {
  /** The workspace's own repo refs, unchanged (answers never edit apiBase, proxies aside, or roles). */
  repos: RepoRef[];
  links: Array<WorkspaceFile["links"][number] & { source?: "answers" }>;
  external?: ExternalService[];
  queueAliases: QueueAlias[];
  /** `queue-name` answers: names for publishes / consumes codeloom could not read. */
  queueNames: QueueNameAnswer[];
  /** `env` / `external` answers, per calling repo (`from`; every repo when absent). */
  baseHints: AnswerHint[];
  /** Answered roles (for the gaps only). */
  roles: Map<string, RepoRef["role"]>;
  /** Repos answered "not part of this system": left out of linking. */
  ignored: Set<string>;
  /** Gap ids answered "expected". */
  ignoredGaps: Set<string>;
}

/** Add the answers to the workspace's own config (the workspace file, or nothing for a group). An answer
 * naming a repo that is not here is skipped (the repo left the group); the rest is added beside what the
 * workspace file says. A base hint for one calling repo wins over one for every repo (linker/link.ts hintFor). */
export function applyAnswers(
  cfg: { repos: RepoRef[]; links: WorkspaceFile["links"]; external?: ExternalService[] },
  answers: Answer[],
): LinkConfig {
  const repos = new Map(cfg.repos.map((r) => [r.id, { ...r }]));
  const links: LinkConfig["links"] = [...cfg.links];
  const external = [...(cfg.external ?? [])];
  const queueAliases: QueueAlias[] = [];
  const queueNames: QueueNameAnswer[] = [];
  const baseHints: AnswerHint[] = [];
  const roles = new Map<string, RepoRef["role"]>();
  const ignored = new Set<string>();
  const ignoredGaps = new Set<string>();
  for (const a of answers) {
    switch (a.kind) {
      case "env":
        if (repos.has(a.repo)) baseHints.push({ ...(a.from !== undefined ? { from: a.from } : {}), base: a.name, repo: a.repo });
        break;
      case "external":
        baseHints.push({ ...(a.from !== undefined ? { from: a.from } : {}), base: a.base, external: a.name ?? a.base });
        break;
      case "proxy": {
        const r = repos.get(a.repo);
        if (r && repos.has(a.to) && a.to !== a.repo) {
          r.proxies = [...(r.proxies ?? []), { from: a.from, to: a.to, ...(a.stripPrefix !== undefined ? { stripPrefix: a.stripPrefix } : {}) }];
        }
        break;
      }
      case "link":
        if (!links.some((l) => l.from === a.from && l.to === a.to)) links.push({ from: a.from, to: a.to, source: "answers" });
        break;
      case "role":
        if (repos.has(a.repo)) roles.set(a.repo, a.role);
        break;
      case "ignore-repo":
        ignored.add(a.repo);
        break;
      case "queue-alias":
        queueAliases.push({ publish: a.publish, consume: a.consume });
        break;
      case "ignore-gap":
        ignoredGaps.add(a.gap);
        break;
      case "join-group":
        break; // a registry move, never a link input
      case "queue-name":
        if (repos.has(a.repo)) queueNames.push(a);
        break;
    }
  }
  return {
    repos: cfg.repos.map((r) => repos.get(r.id)!),
    links,
    ...(external.length > 0 ? { external } : {}),
    queueAliases,
    queueNames,
    baseHints,
    roles,
    ignored,
    ignoredGaps,
  };
}
