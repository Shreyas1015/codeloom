import { compare } from "../util.js";

/** 0.6 spec §2: a call's base names the repo it goes to — an env var (`CORE_API_URL`, `${BILLING_URL}`), a config
 * key (`config.get("services.core.url")`, `configService.getOrThrow("CORE_SERVICE_URL")`, `env.get(...)`), an
 * internal host (`http://billing:3000`, `billing.default.svc.cluster.local`) or the identifier a base is read from
 * (`this.config.coreServiceUrl`). Its name, with the words every base carries dropped (`NEXT_PUBLIC_`, `_API`,
 * `_URL`, `SERVICE`, `V2`, `INTERNAL`, ...), is matched to the group's repos by id, package name, remote repo name
 * and folder name. A hint is used only when exactly one repo matches; otherwise it is reported (an unresolved
 * base) and nothing is guessed. */

/** Where a call's base comes from. `env`: an env var or a config key read by name (`process.env.X`,
 * `config.get("X")`); `host`: an absolute URL's host; `name`: a plain identifier or dotted path the base is read
 * from. (`relative` / `expr` only describe unresolved bases: a backend URL with no base, or a base expression
 * whose name cannot be read.) */
export interface CallBase {
  kind: "env" | "host" | "name" | "relative" | "expr";
  /** The env var / config key, the host (port kept), the identifier path, the client name or the expression. */
  text: string;
}

/** What a base's name says about the group's repos: exactly one (`one`), several (`ambiguous`), or none
 * (`unknown`, also when the name carries nothing but generic words, like `API_URL`). */
export type BaseMatch =
  | { kind: "one"; repo: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown" };

/** A repo as hints see it: its id and every name it goes by. */
export interface NamedRepo {
  id: string;
  names: string[];
}

/** Leading words framework env prefixes add (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, ...). */
const ENV_PREFIXES: string[][] = [
  ["next", "public"], ["expo", "public"], ["nuxt", "public"], ["react", "app"], ["vue", "app"], ["vite"], ["public"], ["gatsby"],
];

/** Words that only say "this is a base" (`_API_URL`, `_HOST`, `ServiceUrl`, `_V2`, `_INTERNAL`, ...): dropped
 * wherever they trail the name. */
const BASE_WORDS = new Set([
  "api", "url", "uri", "host", "hostname", "base", "baseurl", "endpoint", "origin", "addr", "address", "server", "service",
  "svc", "domain", "root", "prefix", "http", "https", "port", "internal", "external", "private", "public", "rest", "grpc",
]);

/** Segments of a dotted path that hold settings rather than name a service (`this.config.x`, `services.core.url`). */
const CONTAINER_WORDS = new Set([
  "this", "config", "configuration", "setting", "env", "environment", "process", "option", "opt", "cfg", "conf", "app",
  "constant", "prop", "param", "props", "settings",
]);

/** Trailing words a repo name carries that do not tell services apart (`billing-service`, `core-api`). */
const REPO_WORDS = new Set(["api", "service", "svc", "server", "backend", "ms"]);

const VERSION_RE = /^v\d+$/;

/** One word in a comparable form: plurals folded (`notifications` → `notification`, never `-ss`). */
function fold(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Lower-case words of a name: split on anything not a letter or digit, and on camelCase boundaries; plurals folded. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(fold);
}

/** Drop base words and version words (`v2`) wherever they trail, and version words anywhere. */
function dropBaseWords(list: string[], drop: Set<string>): string[] {
  const out = list.filter((w) => !VERSION_RE.test(w));
  while (out.length > 0 && drop.has(out[out.length - 1]!)) out.pop();
  // `CORE_SERVICE_URL_V2`, `CORE_BASE_URL_INTERNAL`: base words before a trailing qualifier go too.
  return out.filter((w, i) => !(drop.has(w) && out.slice(i).every((x) => drop.has(x))));
}

function dropPrefix(list: string[]): string[] {
  for (const prefix of ENV_PREFIXES) {
    if (prefix.length < list.length && prefix.every((w, i) => list[i] === w)) return list.slice(prefix.length);
  }
  return list;
}

/** The words of one name that can name a repo (empty: only generic words). */
function nameWords(name: string): string[] {
  const list = dropPrefix(words(name));
  if (list.every((w) => CONTAINER_WORDS.has(w))) return [];
  return dropBaseWords(list, BASE_WORDS);
}

/** The words of a base that can name a repo: `NEXT_PUBLIC_BILLING_API_URL` → ["billing"], `API_URL` → [],
 * `billing-svc:8080` → ["billing"], `config.coreServiceUrl` → ["core"], `services.core.url` → ["core"] (the
 * last dotted segment that still has words). */
export function baseWords(base: CallBase): string[] {
  if (base.kind === "relative" || base.kind === "expr") return [];
  if (base.kind === "host") {
    const hostname = base.text.replace(/:\d+$/, "");
    if (/^\d+(\.\d+){3}$/.test(hostname)) return [];
    return dropBaseWords(words(hostname.split(".")[0] ?? ""), BASE_WORDS);
  }
  const segments = base.text.split(".");
  for (let i = segments.length - 1; i >= 0; i--) {
    const found = nameWords(segments[i]!);
    if (found.length > 0) return found;
  }
  return [];
}

/** The words of a repo name: `@acme/billing-service` → ["billing"], `demo-billing` → ["demo", "billing"]. */
export function repoWords(name: string): string[] {
  const bare = name.replace(/^@[^/]+\//, "");
  return dropBaseWords(words(bare), REPO_WORDS);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => w === b[i]);
/** `long` is `short` with words before it (a repo `sunny-core` for a base `core`), never the other way round. */
const endsWith = (long: string[], short: string[]) =>
  short.length > 0 && short.length < long.length && same(long.slice(long.length - short.length), short);

/** Match a base to the repos: first by equal words (`billing` = repo `billing`), then, only when no repo matched
 * that way, by a repo name that adds leading words to the base's (`core` ~ `sunny-core`). A base that adds a
 * leading word (`payment-gateway`) never matches a shorter repo name (`gateway`). */
export function matchBase(base: CallBase, repos: NamedRepo[]): BaseMatch {
  const want = baseWords(base);
  if (want.length === 0) return { kind: "unknown" };
  const named = repos.map((r) => ({ id: r.id, lists: r.names.map(repoWords).filter((l) => l.length > 0) }));
  for (const test of [(l: string[]) => same(l, want), (l: string[]) => endsWith(l, want)]) {
    const hits = named.filter((r) => r.lists.some(test)).map((r) => r.id).sort(compare);
    if (hits.length === 1) return { kind: "one", repo: hits[0]! };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  }
  return { kind: "unknown" };
}

const PUBLIC_SUFFIX_RE = /\.(svc|svc\.cluster\.local|internal|local|lan)$/;

/** A host that looks like part of your own system, so a name match is trusted: a single-label name
 * (docker-compose style), a cluster / private suffix (`.svc`, `.svc.cluster.local`, `.internal`, `.local`,
 * `.lan`), or any host with an explicit port. Anything else (`billing.vendor.com`) is public-looking. */
export function isInternalHost(host: string): boolean {
  if (/:\d+$/.test(host)) return true;
  const hostname = host.toLowerCase();
  return !hostname.includes(".") || PUBLIC_SUFFIX_RE.test(hostname);
}

const ENV_RE = /(?:process\.env|import\.meta\.env)\.(\w+)|(?:process\.env|import\.meta\.env)\[\s*["'`]([\w.-]+)["'`]\s*\]/;
/** A config getter called with a literal key: `config.get("x")`, `configService.getOrThrow<string>("X")`,
 * `env("X")`, `Env.get("X")`. */
const GETTER_RE = /(?:^|[^\w$])(?:(?:[\w$]+\.)*(?:get|getOrThrow|getString|require)|env|Env)\s*(?:<[^<>()]*>)?\s*\(\s*["'`]([\w.:-]+)["'`]/;
const NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** The env var, config key, or plain identifier path a base expression is read from (`process.env.X ?? "..."`
 * reads X; `config.get("services.core.url")` reads that key). Undefined when it names nothing readable. */
export function baseFromExpr(expr: string): CallBase | undefined {
  const env = ENV_RE.exec(expr);
  if (env) return { kind: "env", text: env[1] ?? env[2]! };
  const getter = GETTER_RE.exec(expr);
  if (getter) return /^[A-Z0-9_]+$/.test(getter[1]!) ? { kind: "env", text: getter[1]! } : { kind: "name", text: getter[1]! };
  const trimmed = expr.trim();
  return NAME_RE.test(trimmed) && trimmed !== "this" ? { kind: "name", text: trimmed } : undefined;
}
