import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCheckReport } from "../src/check/report.js";
import { codeloomServeCommand } from "../src/claude/headless.js";
import { runAskCommand } from "../src/commands/gaps.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { answersPath } from "../src/map/answers.js";
import { mapGaps } from "../src/map/gaps.js";
import { saveMapAnswers, weakened } from "../src/map/save.js";
import { loadMapState } from "../src/mcp/state.js";
import type { Chain } from "../src/store/schemas.js";
import { freshHome, makeRepo } from "./helpers.js";
import { REPOS } from "./interview-fixture.js";

// Fix round 1 of 0.6 §5 (review probes): per-caller env answers, no global role narrowing, wrong answers refused,
// long base expressions, links never weakened, line-free gap ids, service callers, locking, `codeloom ask`.

const chainsOf = (root: string): Chain[] => JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains;
const routeHop = (root: string, entryStart: string) =>
  chainsOf(root).filter((c) => c.entry.startsWith(entryStart)).map((c) => {
    const r = c.stops.find((s) => s.kind === "route");
    return r ? `${r.repo} ${r.hop.confidence}` : "no route";
  }).sort();

/** A UI repo whose one page calls `${process.env.<env>}<path>` from lib/<file>.ts. */
function uiRepo(name: string, calls: Array<{ fn: string; url: string; method?: string }>): Record<string, string> {
  const files: Record<string, string> = { "package.json": JSON.stringify({ name, dependencies: { next: "^15", react: "^19" } }) };
  files["app/page.tsx"] = `${calls.map((c) => `import { ${c.fn} } from "../lib/${c.fn}";`).join("\n")}

export default async function Home() {
${calls.map((c) => `  await ${c.fn}();`).join("\n")}
  return <p>ok</p>;
}
`;
  for (const c of calls) {
    files[`lib/${c.fn}.ts`] = `export async function ${c.fn}() {
  const res = await fetch(\`${c.url}\`${c.method ? `, { method: "${c.method}" }` : ""});
  return res.json();
}
`;
  }
  return files;
}

/** Repos as a group (separate git repos, demo-shop remotes), indexed one by one. */
async function group(repos: Record<string, Record<string, string>>): Promise<{ repo: Record<string, string>; root: string }> {
  freshHome();
  const parent = mkdtempSync(join(tmpdir(), "codeloom-review-"));
  const repo: Record<string, string> = {};
  for (const [name, files] of Object.entries(repos)) {
    repo[name] = makeRepo(files, join(parent, name));
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["remote", "add", "origin", `git@github.com:demo-shop/demo-${name}.git`], { cwd: repo[name] }).on("exit", (c) => (c === 0 ? resolve() : reject(new Error("git"))));
    });
  }
  let root = "";
  for (const name of Object.keys(repos)) root = (await runIndex(repo[name]!)).root;
  return { repo, root };
}

const API = "process.env.NEXT_PUBLIC_API_URL";

describe("env answers are per calling repo", () => {
  it("two frontends using one env var: answering for one never moves the other's calls", async () => {
    const call = [{ fn: "getInvoice", url: `\${${API}}/invoices/\${1}` }];
    const { repo, root } = await group({ shopfront: uiRepo("demo-shopfront", call), admin: uiRepo("demo-admin", call), api: REPOS.api!, billing: REPOS.billing! });
    const gaps = mapGaps(repo.admin!).gaps.filter((x) => x.kind === "unknown-base");
    expect(gaps.map((x) => x.question).sort()).toEqual([
      "Where does demo-admin's NEXT_PUBLIC_API_URL point: one of your repos (demo-api or demo-billing?), or another service?",
      "Where does demo-shopfront's NEXT_PUBLIC_API_URL point: one of your repos (demo-api or demo-billing?), or another service?",
    ]);
    expect(() => saveMapAnswers(repo.admin!, { answers: [{ kind: "env", name: "NEXT_PUBLIC_API_URL", repo: "demo-billing" }] }))
      .toThrow(/demo-admin, demo-shopfront all call through "NEXT_PUBLIC_API_URL": say which one with "from"/);

    const before = routeHop(root, "page:demo-admin:");
    const r = saveMapAnswers(repo.admin!, { answers: [{ kind: "env", name: "NEXT_PUBLIC_API_URL", repo: "demo-billing", from: "demo-shopfront" }] });
    expect(r.closed.map((x) => x.id)).toContain(gaps.find((x) => x.question.includes("demo-shopfront"))!.id);
    expect(r.closed.map((x) => x.id)).not.toContain(gaps.find((x) => x.question.includes("demo-admin"))!.id);
    expect(routeHop(root, "page:demo-shopfront:")).toEqual(["demo-billing exact"]);
    expect(routeHop(root, "page:demo-admin:")).toEqual(before); // still unlinked, as it was
    expect(before).toEqual(["no route"]); // two repos serve it: a tie across repos links neither (0.6)
    // the other frontend gets its own answer, to another backend
    saveMapAnswers(repo.admin!, { answers: [{ kind: "env", name: "NEXT_PUBLIC_API_URL", repo: "demo-api", from: "demo-admin" }] });
    expect(routeHop(root, "page:demo-admin:")).toEqual(["demo-api exact"]);
    expect(routeHop(root, "page:demo-shopfront:")).toEqual(["demo-billing exact"]);
    expect(JSON.parse(readFileSync(answersPath(root), "utf8")).answers).toHaveLength(2);
  }, 120_000);
});

describe("answers never weaken what codeloom was sure of", () => {
  it("a role answer changes no link; an env answer may move the calls it places, and its gap shows the ones that matched", async () => {
    // weaken.mjs: LEGACY_BILLING_URL's /invoices/:id is a tie (guessed demo-api), its POST /orders matched demo-api for sure
    const web = uiRepo("demo-web", [
      { fn: "getInvoice", url: `\${process.env.LEGACY_BILLING_URL}/invoices/\${1}` },
      { fn: "placeOrder", url: `\${process.env.LEGACY_BILLING_URL}/orders`, method: "POST" },
    ]);
    const { repo, root } = await group({ web, api: REPOS.api!, billing: REPOS.billing! });
    const chains = readFileSync(join(root, ".codeloom", "chains.json"), "utf8");
    const gap = mapGaps(repo.web!).gaps.find((x) => x.kind === "unknown-base")!;
    expect(gap.evidence).toEqual([
      "demo-web lib/getInvoice.ts:2 getInvoice: GET /invoices/:param → tie demo-api|demo-billing (no link)",
      "demo-web lib/placeOrder.ts:2 placeOrder: POST /orders → matched demo-api",
    ]);

    const role = saveMapAnswers(repo.web!, { answers: [{ kind: "role", repo: "demo-billing", role: "api" }] });
    expect(role.closed).toEqual([]);
    expect(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).toBe(chains);

    // the user's answer is true: saved (from filled in: only demo-web calls through LEGACY_BILLING_URL); the call it
    // sends nowhere stays a question
    const r = saveMapAnswers(repo.web!, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing" }] });
    expect(r.saved).toBe(1);
    expect(JSON.parse(readFileSync(answersPath(root), "utf8")).answers).toContainEqual({ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing", from: "demo-web" });
    expect(chainsOf(root).find((c) => c.entry.startsWith("page:demo-web:") && c.stops.some((s) => s.symbol === "getInvoice") && c.stops.some((s) => s.repo === "demo-billing"))).toBeDefined();
    const still = mapGaps(repo.web!).gaps.find((x) => x.id === gap.id)!;
    expect(still.question).toBe("1 call through LEGACY_BILLING_URL matches no route in demo-billing, where your answer sends them. Where do they go (demo-api?)?");
    expect(still.evidence[0]).toMatch(/placeOrder: POST \/orders → guessed demo-api/);
  }, 120_000);

  it("a call matched by a parameter to a route nobody called is a true answer, not a weaker link (abuse.mjs)", async () => {
    const web = uiRepo("demo-web", [
      { fn: "getInvoice", url: `\${process.env.LEGACY_BILLING_URL}/invoices/1` },
      { fn: "getReport", url: `\${process.env.LEGACY_BILLING_URL}/reports` },
    ]);
    const { repo, root } = await group({ web, api: REPOS.api!, billing: REPOS.billing! });
    const r = saveMapAnswers(repo.web!, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing" }] });
    expect(r.saved).toBe(1);
    const inv = chainsOf(root).find((c) => c.stops.some((s) => s.symbol === "getInvoice") && c.stops.some((s) => s.repo === "demo-billing"))!;
    expect(inv.stops.find((s) => s.kind === "route")!.hop.confidence).toBe("param");
    expect(inv.stops.some((s) => s.kind === "db" && s.label === "invoices")).toBe(true);
  }, 120_000);

  it("the save result tells which of the answer's own calls moved (abuse2.mjs)", async () => {
    const web = uiRepo("demo-web", [
      { fn: "getInvoice", url: `\${process.env.LEGACY_BILLING_URL}/invoices/\${1}` },
      { fn: "placeOrder", url: `\${process.env.LEGACY_BILLING_URL}/orders`, method: "POST" },
      { fn: "getReport", url: `\${process.env.LEGACY_BILLING_URL}/reports` },
    ]);
    const { repo } = await group({ web, api: REPOS.api!, billing: REPOS.billing! });
    const r = saveMapAnswers(repo.web!, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing" }] });
    const gap = mapGaps(repo.web!).gaps.find((x) => x.kind === "unknown-base")!;
    expect(r.moved).toEqual([{ gap: gap.id, from: "demo-api exact", to: "demo-api guess", n: 2 }]);
    expect(r.opened.map((x) => x.id)).not.toContain(gap.id); // the same question, now about those two calls
    // ... answerable with a link to the route each matched before
    expect(gap.close).toBe("env|link|external|ignore-gap");
    expect(gap.suggest).toEqual([
      JSON.stringify({ kind: "link", from: "demo-web:lib/getReport.ts#getReport", to: "route:demo-api:GET /reports" }),
      JSON.stringify({ kind: "link", from: "demo-web:lib/placeOrder.ts#placeOrder", to: "route:demo-api:POST /orders" }),
    ]);
    const linked = saveMapAnswers(repo.web!, { answers: gap.suggest!.map((x) => JSON.parse(x)) });
    expect(linked.closed.map((x) => x.id)).toContain(gap.id);
  }, 120_000);

  it("a call→route hop past an answer's own call keeps its own check: one answer cannot hide another call getting weaker", () => {
    const stop = (o: Partial<Chain["stops"][number]>) => ({ lane: "api", kind: "route", repo: "web", file: "f.ts", line: 1, symbol: "s", hop: { confidence: "exact" }, ...o }) as Chain["stops"][number];
    const chain = (a: "exact" | "guess", b: "exact" | "guess") => ({
      id: "ch_000000000001", entry: "page:web:/", routeKey: "a:GET /a", name: "", unresolved: [], confidence: a, complete: false,
      stops: [
        stop({ kind: "page", lane: "ui", line: 1 }),
        stop({ kind: "call", lane: "ui", line: 2, from: 0 }), // placed by the answer
        stop({ kind: "route", repo: "a", file: "a.ts", line: 3, label: "GET /a", from: 1, hop: { confidence: a } }),
        stop({ kind: "handler", repo: "a", file: "a.ts", line: 4, lane: "code", from: 2, hop: { confidence: a } }),
        stop({ kind: "call", repo: "a", file: "a.ts", line: 5, lane: "code", from: 3, hop: { confidence: a } }), // not placed
        stop({ kind: "route", repo: "b", file: "b.ts", line: 6, label: "GET /b", from: 4, hop: { confidence: b } }),
      ],
    }) as Chain;
    const placed = (s: Chain["stops"][number]) => s.kind === "call" && s.repo === "web" && s.line === 2;
    // the answer moves its own call (a guess now) and carries that down: excused; but the B hop drops on its own
    expect(weakened([chain("exact", "exact")], [chain("guess", "guess")], new Set(), placed)).toEqual(["a a.ts:5 call → b b.ts:6 route GET /b (exact → guess)"]);
    // carried down only, the B hop kept its own confidence: nothing to refuse
    expect(weakened([chain("exact", "exact")], [chain("guess", "exact")], new Set(), placed)).toEqual([]);
  });

  it("only side effects on other calls count as weakening; an answer's own calls do not", () => {
    const stop = (o: Partial<Chain["stops"][number]>) => ({ lane: "api", kind: "route", repo: "a", file: "f.ts", line: 1, symbol: "s", hop: { confidence: "exact" }, ...o }) as Chain["stops"][number];
    const chain = (id: string, routeRepo: string, conf: "exact" | "guess", callLine = 2) => ({
      id, entry: "page:web:/", routeKey: `${routeRepo}:GET /x`, name: "", unresolved: [], confidence: conf, complete: true,
      stops: [stop({ kind: "page", repo: "web", lane: "ui" }), stop({ kind: "call", repo: "web", line: callLine, from: 0 }), stop({ kind: "route", repo: routeRepo, line: 9, from: 1, hop: { confidence: conf } })],
    }) as Chain;
    const before = [chain("ch_000000000001", "api", "exact"), chain("ch_000000000002", "api", "exact", 5)];
    const after = [chain("ch_000000000001", "api", "guess"), chain("ch_000000000002", "api", "guess", 5)];
    const none = () => false;
    expect(weakened(before, after, new Set(), none)).toEqual([
      "web f.ts:2 call → api f.ts:9 route (exact → guess)",
      "web f.ts:5 call → api f.ts:9 route (exact → guess)",
    ]);
    const placesLine2 = (s: Chain["stops"][number]) => s.kind === "call" && s.line === 2;
    expect(weakened(before, after, new Set(), placesLine2)).toEqual(["web f.ts:5 call → api f.ts:9 route (exact → guess)"]);
    expect(weakened(before, after, new Set(["api"]), none)).toEqual([]);
  });

  it("an answer is checked against a link of the map as it is now: a deleted checkout is not blamed on it (gone.mjs)", async () => {
    const { repo, root } = await group({ web: REPOS.web!, api: REPOS.api!, billing: REPOS.billing!, search: REPOS.search!, tools: REPOS.tools! });
    rmSync(repo.search!, { recursive: true, force: true });
    const r = saveMapAnswers(repo.web!, { answers: [{ kind: "role", repo: "demo-tools", role: "lib" }] });
    expect(r.saved).toBe(1);
    expect(JSON.parse(readFileSync(answersPath(root), "utf8")).answers).toEqual([{ kind: "role", repo: "demo-tools", role: "lib" }]);
  }, 120_000);

  it("a wrong env answer is refused, naming the calls that matched nothing there", async () => {
    const { repo } = await group({ web: uiRepo("demo-web", [{ fn: "getInvoice", url: `\${process.env.LEGACY_BILLING_URL}/invoices/\${1}` }]), billing: REPOS.billing!, search: REPOS.search! });
    expect(() => saveMapAnswers(repo.web!, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-search" }] }))
      .toThrow(/demo-search serves none of the calls through "LEGACY_BILLING_URL" \(GET \/invoices\/:param\); its routes: GET \/products/);
  }, 120_000);

  it("calls an answer sends where they match nothing stay a question, and the gap is not reported closed", async () => {
    const web = uiRepo("demo-web", [
      { fn: "getInvoice", url: `\${process.env.LEGACY_BILLING_URL}/invoices/\${1}` },
      { fn: "refund", url: `\${process.env.LEGACY_BILLING_URL}/refunds`, method: "POST" },
    ]);
    const { repo } = await group({ web, billing: REPOS.billing!, search: REPOS.search! });
    const gap = mapGaps(repo.web!).gaps.find((x) => x.kind === "unknown-base")!;
    const r = saveMapAnswers(repo.web!, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing" }] });
    expect(r.closed.map((x) => x.id)).not.toContain(gap.id);
    const still = mapGaps(repo.web!).gaps.find((x) => x.id === gap.id)!;
    expect(still.question).toBe("1 call through LEGACY_BILLING_URL matches no route in demo-billing, where your answer sends them. Where do they go?");
    expect(still.evidence).toEqual([
      "demo-web lib/refund.ts:2 refund: POST /refunds → no route matches",
      "demo-web lib/getInvoice.ts:2 getInvoice: GET /invoices/:param → matched demo-billing",
    ]);
  }, 120_000);
});

describe("long base expressions", () => {
  it("are shortened only for reading: the gap key, the proposal and the match use the full text", async () => {
    const expr = "settings.services.billingServiceBaseUrl ?? settings.services.fallbackBaseUrlForBilling";
    const web = uiRepo("demo-web", [{ fn: "getInvoice", url: `\${${expr}}/invoices/\${1}` }]);
    web["lib/getInvoice.ts"] = `import { settings } from "./config";\n${web["lib/getInvoice.ts"]}`;
    web["lib/config.ts"] = `export const settings = { services: { billingServiceBaseUrl: "http://billing:4000", fallbackBaseUrlForBilling: "" } };\n`;
    const { repo, root } = await group({ web, api: REPOS.api!, billing: REPOS.billing! });
    const gap = mapGaps(repo.web!).gaps.find((x) => x.kind === "unknown-base")!;
    expect(gap.question).toContain("settings.services.billingServiceBaseUrl ?? settings.service… point");
    expect(gap.suggest).toEqual([JSON.stringify({ kind: "env", name: expr, repo: "demo-billing", from: "demo-web" })]);
    const r = saveMapAnswers(repo.web!, { answers: [JSON.parse(gap.suggest![0]!)] });
    expect(r.closed.map((x) => x.id)).toContain(gap.id);
    expect(routeHop(root, "page:demo-web:")).toEqual(["demo-billing exact"]);
  }, 120_000);
});

describe("gap ids and callers", () => {
  it("two alike calls in one function get two gaps", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ids2-"));
    const web = uiRepo("demo-web", [{ fn: "loadReport", url: "${reportUrl()}" }]);
    web["lib/loadReport.ts"] = `export async function loadReport() {\n  const a = await fetch(reportUrl());\n  const b = await fetch(otherUrl());\n  return [a, b];\n}\n`;
    makeRepo(web, join(root, "web"));
    makeRepo(REPOS.api!, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "s", links: [], repos: [{ id: "demo-api", path: "api" }, { id: "demo-web", path: "web" }] }));
    await runIndex(root);
    const ids = mapGaps(root).gaps.filter((x) => x.kind === "call-no-route").map((x) => x.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  }, 120_000);

  it("a call's gap keeps its id when lines move above it", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-ids-"));
    makeRepo(uiRepo("demo-web", [{ fn: "loadReport", url: "${reportUrl()}" }]), join(root, "web"));
    makeRepo(REPOS.api!, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "s", links: [], repos: [{ id: "demo-api", path: "api" }, { id: "demo-web", path: "web" }] }));
    await runIndex(root);
    const id = mapGaps(root).gaps.find((x) => x.kind === "call-no-route")!.id;
    const file = join(root, "web", "lib", "loadReport.ts");
    writeFileSync(file, `// a comment\n\n${readFileSync(file, "utf8")}`);
    await runIndex(root);
    const again = mapGaps(root).gaps.find((x) => x.kind === "call-no-route")!;
    expect(again.evidence[0]).toMatch(/loadReport\.ts:4/);
    expect(again.id).toBe(id);
  }, 120_000);

  it("check counts a route reached from another service's call as called", () => {
    const state = { ws: { root: "", name: "", links: [], repos: [{ ref: { id: "b", path: "b" }, abs: "", graph: { nodes: [], edges: [] }, endpoints: {
      version: 2, repo: "b", pages: [], httpCalls: [], httpClients: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [],
      routes: [{ method: "GET", path: "/x", handler: "h", inline: false, framework: "express", at: { file: "s.ts", line: 3, symbol: "h" }, router: "app" }],
    } }] } } as unknown as ReturnType<typeof loadMapState>;
    const stop = (o: Partial<Chain["stops"][number]>) => ({ lane: "api", kind: "route", repo: "a", file: "f.ts", line: 1, symbol: "s", hop: { confidence: "exact" }, ...o });
    const chain = { id: "ch_000000000001", entry: "route:a:GET /y", routeKey: "a:GET /y", name: "", unresolved: [], confidence: "exact", complete: false, stops: [
      stop({ kind: "route", repo: "a", op: "GET", label: "GET /y" }),
      stop({ kind: "call", repo: "a", lane: "code", from: 0 }),
      stop({ kind: "route", repo: "b", file: "s.ts", line: 3, op: "GET", label: "GET /x", from: 1 }),
    ] } as Chain;
    const report = buildCheckReport([chain], state.ws);
    expect(report.items.filter((i) => i.kind === "route-no-caller" && i.repo === "b")).toEqual([]);
    expect(buildCheckReport([], state.ws).items.filter((i) => i.kind === "route-no-caller" && i.repo === "b")).toHaveLength(1);
  });
});

describe("two saves at the same time", () => {
  it("both keep their answers and the map is linked with both", async () => {
    const { repo, root } = await group({ web: REPOS.web!, api: REPOS.api!, billing: REPOS.billing!, search: REPOS.search!, tools: REPOS.tools! });
    const dist = fileURLToPath(new URL("../dist/map/save.js", import.meta.url));
    const save = (answer: unknown) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e",
        `const { saveMapAnswers } = await import(${JSON.stringify(dist)}); saveMapAnswers(process.argv[1], JSON.parse(process.argv[2]));`,
        repo.web!, JSON.stringify({ answers: [answer] })], { env: process.env, stdio: "inherit" });
      child.on("exit", (code) => resolve(code ?? 1));
    });
    const codes = await Promise.all([
      save({ kind: "proxy", repo: "demo-web", from: "/api/search", to: "demo-search" }),
      save({ kind: "role", repo: "demo-tools", role: "lib" }),
    ]);
    expect(codes).toEqual([0, 0]);
    expect(JSON.parse(readFileSync(answersPath(root), "utf8")).answers.map((a: { kind: string }) => a.kind).sort()).toEqual(["proxy", "role"]);
    expect(chainsOf(root).some((c) => c.stops.some((s) => s.repo === "demo-search" && s.kind === "route") && c.stops[0]!.repo === "demo-web")).toBe(true);
  }, 120_000);
});

describe("doctor and check name answers.json", () => {
  it("reports stale answers with a fix hint, and an answer link's location is answers.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-stale-"));
    makeRepo(REPOS.web!, join(root, "web"));
    makeRepo(REPOS.api!, join(root, "api"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "s", links: [], repos: [{ id: "demo-api", path: "api" }, { id: "demo-web", path: "web" }] }));
    await runIndex(root);
    writeFileSync(answersPath(root), JSON.stringify({ version: 1, answers: [
      { kind: "env", name: "GONE_URL", repo: "demo-api" },
      { kind: "link", from: "demo-web:lib/reports.ts#loadReport", to: "route:demo-api:GET /gone" },
    ] }));
    const item = runDoctor(root, {}).items.find((i) => i.check === "answers")!;
    expect(item.status).toBe("warn");
    expect(item.message).toMatch(/2 of your answers about the map name things it no longer has[\s\S]*GONE_URL[\s\S]*GET \/gone[\s\S]*codeloom link/);
    await runIndex(root);
    const state = loadMapState(root);
    const report = buildCheckReport(state.chains, state.ws, state.uiReach, state.manualLinks, state.external);
    expect(report.items.find((i) => i.kind === "manual-link-broken")).toMatchObject({ file: ".codeloom/answers.json" });
    expect(existsSync(answersPath(root))).toBe(true);
  }, 120_000);
});

describe("codeloom ask", () => {
  it("asks before starting Claude Code, starts it with the interview on yes, and only prints the command otherwise", async () => {
    const { repo } = await group({ web: REPOS.web!, api: REPOS.api!, billing: REPOS.billing! });
    const runs: Array<{ bin: string; args: string[]; cwd: string }> = [];
    const out: string[] = [];
    const questions: string[] = [];
    const deps = (o: { claude?: string | null; interactive?: boolean; yes?: boolean }) => ({
      claude: o.claude === undefined ? "/usr/local/bin/claude" : o.claude,
      interactive: o.interactive ?? true,
      confirm: async (q: string, def: boolean) => {
        questions.push(`${q} ${def}`);
        return o.yes ?? def;
      },
      spawn: async (bin: string, args: string[], cwd: string) => {
        runs.push({ bin, args, cwd });
        return 0;
      },
      print: (t: string) => out.push(t),
    });
    const open = mapGaps(repo.web!).open;
    expect(await runAskCommand(repo.web!, deps({ yes: true }))).toBe(0);
    // the default is no: never started without a yes
    expect(questions).toEqual([`Start Claude Code to go through ${open} open questions now? false`]);
    // the prompt first: `--mcp-config <configs...>` would take anything after it as one more config
    expect(runs).toEqual([{
      bin: "/usr/local/bin/claude",
      args: ["/mcp__codeloom__map-interview", "--mcp-config", JSON.stringify({ mcpServers: { codeloom: codeloomServeCommand() } })],
      cwd: repo.web!,
    }]);

    for (const o of [{}, { yes: false }, { interactive: false }, { claude: null }]) {
      runs.length = 0;
      out.length = 0;
      await runAskCommand(repo.web!, deps(o));
      expect(runs, JSON.stringify(o)).toEqual([]);
      expect(out.join("\n")).toMatch(/\/mcp__codeloom__map-interview/);
    }
  }, 120_000);
});
