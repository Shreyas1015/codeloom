import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runIndex, runLink } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { answersPath } from "../src/map/answers.js";
import { capGaps, type Gap, MAX_GAPS, MAX_GAPS_CHARS, mapGaps } from "../src/map/gaps.js";
import { saveMapAnswers } from "../src/map/save.js";
import type { Chain } from "../src/store/schemas.js";
import { freshHome, makeRepo } from "./helpers.js";
import { interviewGroup, REPOS } from "./interview-fixture.js";

// 0.6 spec §5: codeloom lists what it could not settle, Claude asks the user, and the answers fix the map.
// The setup is test/interview-fixture.ts.

const chainsOf = (root: string): Chain[] => JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).chains;
const reposOf = (c: Chain) => [...new Set(c.stops.map((s) => s.repo))];
const find = (gaps: Gap[], kind: string, text: string) => gaps.find((g) => g.kind === kind && (g.question + g.evidence.join(" ")).includes(text));

describe("map gaps and answers (0.6 §5)", () => {
  let g: Awaited<ReturnType<typeof interviewGroup>>;
  beforeAll(async () => {
    g = await interviewGroup();
  }, 120_000);
  // Every test gets its own CODELOOM_HOME (test/setup.ts): use the one the group was indexed in.
  beforeEach(() => {
    process.env.CODELOOM_HOME = g.home;
  });

  it("lists what codeloom could not settle, with evidence, a question and the answers that close it", () => {
    const r = mapGaps(g.repo.web!);
    const kinds = r.gaps.map((x) => x.kind);
    expect(r.open).toBe(r.gaps.length);
    const base = find(r.gaps, "unknown-base", "LEGACY_BILLING_URL")!;
    expect(base.question).toMatch(/LEGACY_BILLING_URL/);
    expect(base.evidence[0]).toMatch(/^demo-web lib\/invoices\.ts:2 getInvoice: GET \/invoices\/:id → tie demo-api\|demo-billing/);
    expect(base.close).toBe("env|external|ignore-gap");
    expect(base.suggest).toEqual([JSON.stringify({ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing", from: "demo-web" })]);
    expect(base.chains).toBe(1);

    const unreadable = find(r.gaps, "call-no-route", "loadReport")!;
    expect(unreadable.evidence[0]).toMatch(/URL not readable/);
    // No link proposed from name words (loadReport ~ /reports): a proposal needs a real path match (0.6 Task E).
    expect(unreadable.suggest).toBeUndefined();
    const uncalled = find(r.gaps, "route-no-caller", "demo-api")!;
    // GET /invoices/:id too: the call two repos serve links to neither (a tie across repos is a question, 0.6)
    expect(uncalled.evidence).toEqual(["demo-api src/server.ts:5 GET /invoices/:id → getInvoice", "demo-api src/server.ts:6 GET /reports → getReport"]);
    expect(uncalled.suggest).toBeUndefined();

    const pub = find(r.gaps, "queue-no-consumer", "shop:order.placed")!;
    expect(pub.suggest).toEqual([JSON.stringify({ kind: "queue-alias", publish: "shop:order.placed", consume: "orders-queue" })]);
    expect(find(r.gaps, "queue-no-publisher", "orders-queue")).toBeDefined();

    const search = find(r.gaps, "unconnected-repo", "demo-search is not connected")!;
    expect(search.suggest).toEqual([JSON.stringify({ kind: "proxy", repo: "demo-web", from: "/api/search", to: "demo-search" })]);
    expect(find(r.gaps, "unconnected-repo", "demo-billing is not connected")!.related).toContain(base.id);
    expect(find(r.gaps, "unconnected-repo", "demo-worker is not connected")).toBeDefined();
    expect(find(r.gaps, "unclear-role", "demo-tools")).toBeDefined();
    expect(kinds).not.toContain("ambiguous-match"); // the tie is part of the LEGACY_BILLING_URL question

    // ranked by journeys, then chains affected
    for (let i = 1; i < r.gaps.length; i++) {
      const [a, b] = [r.gaps[i - 1]!, r.gaps[i]!]; // 0 counts are left out
      const [aj, bj, ac, bc] = [a.journeys ?? 0, b.journeys ?? 0, a.chains ?? 0, b.chains ?? 0];
      expect(aj > bj || (aj === bj && ac >= bc)).toBe(true);
    }
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(MAX_GAPS_CHARS); // as map_gaps sends it
  });

  it("refuses invented names and writes nothing", () => {
    const before = readFileSync(join(g.root, ".codeloom", "chains.json"), "utf8");
    const bad = [
      [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-ghost" }, /demo-ghost/],
      [{ kind: "env", name: "NOPE_URL", repo: "demo-billing" }, /NOPE_URL/],
      [{ kind: "link", from: "demo-web:lib/reports.ts#loadReport", to: "route:demo-api:GET /nope" }, /GET \/nope/],
      [{ kind: "link", from: "demo-web:lib/ghost.ts#loadReport", to: "route:demo-api:GET /reports" }, /lib\/ghost\.ts/],
      [{ kind: "queue-alias", publish: "shop:order.placed", consume: "ghost-queue" }, /ghost-queue/],
      [{ kind: "proxy", repo: "demo-web", from: "/api/serch", to: "demo-search" }, /\/api\/serch/],
      [{ kind: "proxy", repo: "demo-web", from: "/api/search", to: "demo-web" }, /its own repo/],
      [{ kind: "role", repo: "demo-nope", role: "lib" }, /demo-nope/],
      [{ kind: "ignore-gap", gap: "g_000000000000" }, /g_000000000000/],
    ] as const;
    for (const [answer, message] of bad) {
      let err: unknown;
      try {
        saveMapAnswers(g.repo.web!, { answers: [answer] });
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(answer)).toBeInstanceOf(CodeloomError);
      expect((err as Error).message, JSON.stringify(answer)).toMatch(message);
    }
    // one bad answer among good ones: nothing is saved
    expect(() => saveMapAnswers(g.repo.web!, { answers: [{ kind: "role", repo: "demo-tools", role: "lib" }, { kind: "role", repo: "x", role: "lib" }] })).toThrow(/"x"/);
    expect(() => saveMapAnswers(g.repo.web!, { answers: [] })).toThrow();
    expect(existsSync(answersPath(g.root))).toBe(false);
    expect(readFileSync(join(g.root, ".codeloom", "chains.json"), "utf8")).toBe(before);
  });

  it("each answer closes its gaps and the chain appears; re-linking parses nothing; answers survive a re-index", async () => {
    const start = mapGaps(g.repo.api!);
    const fp = join(g.repo.web!, ".codeloom", "fingerprints.json");
    const fpTime = statSync(fp).mtimeMs;

    // 1. the unreadable call is GET /reports
    const link = saveMapAnswers(g.repo.web!, { answers: [{ kind: "link", from: "demo-web:lib/reports.ts#loadReport", to: "route:demo-api:GET /reports" }] });
    expect(link.closed.map((x) => x.id)).toEqual([find(start.gaps, "call-no-route", "loadReport")!.id]);
    // demo-api's GET /invoices/:id still has no caller (the tie linked neither repo)
    expect(mapGaps(g.repo.web!).gaps.find((x) => x.kind === "route-no-caller" && x.question.includes("demo-api"))!.question)
      .toBe("Nothing in the map calls demo-api's GET /invoices/:id. Which page or service calls it, or is it called from outside?");
    expect(link.newChains.some((c) => c.repos === "demo-web → demo-api" && c.complete)).toBe(true);
    expect(chainsOf(g.root).some((c) => c.entry === "page:demo-web:/reports" && reposOf(c).join(" ") === "demo-web demo-api")).toBe(true);

    // 2. LEGACY_BILLING_URL points at demo-billing: the call now reaches demo-billing (whose route had no caller), and
    //    demo-api's twin route still has none
    const env = saveMapAnswers(g.repo.web!, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing" }] });
    const byId = new Map(start.gaps.map((x) => [x.id, x]));
    expect(env.closed.map((x) => `${x.kind} ${byId.get(x.id)!.question.split(" ").find((w) => w.startsWith("demo-")) ?? ""}`).sort()).toEqual([
      "route-no-caller demo-billing's", "unconnected-repo demo-billing", "unknown-base ",
    ]);
    expect(env.newChains.some((c) => c.repos === "demo-web → demo-billing" && c.complete)).toBe(true);
    expect(env.opened).toEqual([]);
    const billing = chainsOf(g.root).find((c) => c.entry.startsWith("page:demo-web:/invoices") && reposOf(c).includes("demo-billing"))!;
    expect(reposOf(billing)).toEqual(["demo-web", "demo-billing"]);
    expect(billing.stops.find((s) => s.kind === "route")!.hop.confidence).toBe("exact");

    // 3. order.placed arrives on orders-queue
    const queue = saveMapAnswers(g.repo.worker!, { answers: [{ kind: "queue-alias", publish: "shop:order.placed", consume: "orders-queue" }] });
    expect(queue.closed.map((x) => x.kind).sort()).toEqual(["queue-no-consumer", "queue-no-publisher", "unconnected-repo"]);
    const viaQueue = chainsOf(g.root).find((c) => c.stops.some((s) => s.kind === "consume" && s.repo === "demo-worker") && c.stops.some((s) => s.kind === "publish"))!;
    expect(viaQueue.stops.find((s) => s.kind === "consume")!.hop).toEqual({ confidence: "exact", reason: "from your answer" });
    expect(viaQueue.stops.some((s) => s.kind === "db" && s.label === "order_events")).toBe(true);

    // 4. demo-web's /api/search/* forwards to demo-search
    const proxy = saveMapAnswers(g.repo.search!, { answers: [{ kind: "proxy", repo: "demo-web", from: "/api/search", to: "demo-search" }] });
    expect(proxy.closed.map((x) => x.kind).sort()).toEqual(["route-no-caller", "unconnected-repo"]); // demo-search's GET /products has a caller now
    expect(proxy.newChains.some((c) => c.repos === "demo-web → demo-search" && c.complete)).toBe(true);

    // 5. demo-tools is a library; demo-api's twin route is called from outside
    const role = saveMapAnswers(g.repo.tools!, { answers: [{ kind: "role", repo: "demo-tools", role: "lib" }] });
    expect(role.closed.map((x) => x.kind)).toEqual(["unclear-role"]);
    const left = mapGaps(g.repo.web!);
    expect(left.gaps.map((x) => x.kind)).toEqual(["route-no-caller"]);
    saveMapAnswers(g.repo.web!, { answers: [{ kind: "ignore-gap", gap: left.gaps[0]!.id }] });
    expect(mapGaps(g.repo.web!).open).toBe(0);
    expect(statSync(fp).mtimeMs).toBe(fpTime); // no repo was parsed again

    // answers live in the group and are applied on every later link
    const saved = JSON.parse(readFileSync(answersPath(g.root), "utf8"));
    expect(saved.answers).toHaveLength(6);
    const chains = chainsOf(g.root);
    await runIndex(g.repo.api!);
    expect(chainsOf(g.root)).toEqual(chains);
    expect(mapGaps(g.repo.api!).open).toBe(0);
    runLink(g.repo.web!);
    expect(chainsOf(g.root)).toEqual(chains);
  }, 120_000);
});

describe("caps", () => {
  it("keeps at most 40 gaps and 12,000 characters, best-ranked first, and says how many were left out", () => {
    const many: Gap[] = Array.from({ length: 300 }, (_, i) => ({
      id: `g_${i.toString(16).padStart(12, "0")}`, kind: "call-no-route", journeys: 0, chains: 300 - i,
      question: `Question ${i}: ${"x".repeat(80)}`, evidence: [`demo-web lib/a.ts:${i + 1} f: GET /x/${i}`], close: "link|ignore-gap",
    }));
    const r = capGaps(many);
    expect(r.gaps.length).toBeLessThanOrEqual(MAX_GAPS);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(MAX_GAPS_CHARS); // as map_gaps sends it
    expect(r.gaps[0]!.id).toBe(many[0]!.id);
    expect(r.open).toBe(300);
    expect(r.next).toMatch(/more not shown/);
    const short = capGaps(many.slice(0, 50).map((x) => ({ ...x, question: "q", evidence: [] })));
    expect(short.gaps).toHaveLength(MAX_GAPS);
  });
});

describe("a workspace folder keeps its answers in its own .codeloom", () => {
  it("saves answers.json under the workspace root and re-links from saved data", async () => {
    freshHome();
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-answers-"));
    for (const name of ["web", "billing", "api"]) makeRepo(REPOS[name]!, join(root, name));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", repos: [{ id: "demo-api", path: "api" }, { id: "demo-billing", path: "billing" }, { id: "demo-web", path: "web" }], links: [],
    }));
    await runIndex(root);
    const fp = join(root, "web", ".codeloom", "fingerprints.json");
    const fpTime = statSync(fp).mtimeMs;
    const r = saveMapAnswers(root, { answers: [{ kind: "env", name: "LEGACY_BILLING_URL", repo: "demo-billing" }] });
    expect(r.closed.some((x) => x.kind === "unknown-base")).toBe(true);
    expect(existsSync(join(root, ".codeloom", "answers.json"))).toBe(true);
    expect(chainsOf(root).some((c) => reposOf(c).join(" ") === "demo-web demo-billing")).toBe(true);
    expect(statSync(fp).mtimeMs).toBe(fpTime);
    expect(runDoctor(root, {}).items.find((i) => i.check === "answers")).toMatchObject({ status: "ok", message: "1 answer about the map" });
    // a broken answers file is reported, never deleted, and every link refuses it until it is fixed by hand
    writeFileSync(join(root, ".codeloom", "answers.json"), JSON.stringify({ version: 1, answers: [{ kind: "env" }] }));
    expect(runDoctor(root, {}).items.find((i) => i.check === "answers")).toMatchObject({ status: "error" });
    expect(() => runLink(root)).toThrow(/answers\.json[\s\S]*Fix it by hand/);
    expect(existsSync(join(root, ".codeloom", "answers.json"))).toBe(true);
  }, 120_000);
});

describe("the other answer kinds", () => {
  it("a tie between two repos is settled by a link (never a global role), another service by external, a stray repo by ignore-repo", async () => {
    freshHome();
    const root = mkdtempSync(join(tmpdir(), "codeloom-ws-kinds-"));
    makeRepo({
      "package.json": JSON.stringify({ name: "demo-web", dependencies: { next: "^15", react: "^19" } }),
      "app/invoices/[id]/page.tsx": `import { getInvoice, pay } from "../../../lib/invoices";

export default async function InvoicePage({ params }: { params: { id: string } }) {
  const invoice = await getInvoice(params.id);
  return <button onClick={() => void pay(params.id)}>{invoice.total}</button>;
}
`,
      "lib/invoices.ts": `export async function getInvoice(id: string) {
  const res = await fetch(\`/invoices/\${id}\`);
  return res.json();
}

export async function pay(id: string) {
  const res = await fetch(\`\${process.env.PAYMENTS_URL}/charges\`, { method: "POST" });
  return res.json();
}
`,
    }, join(root, "web"));
    makeRepo(REPOS.api!, join(root, "api"));
    makeRepo(REPOS.billing!, join(root, "billing"));
    makeRepo(REPOS.tools!, join(root, "tools"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "demo-shop", links: [],
      repos: [{ id: "demo-api", path: "api" }, { id: "demo-billing", path: "billing" }, { id: "demo-tools", path: "tools" }, { id: "demo-web", path: "web" }],
    }));
    await runIndex(root);
    const gaps = mapGaps(root).gaps;
    const tie = find(gaps, "ambiguous-match", "GET /invoices/:id")!;
    expect(tie.question).toMatch(/demo-api and demo-billing both serve/);
    expect(tie.close).toBe("link|ignore-gap");
    expect(tie.evidence[1]).toBe('answer with a link from "demo-web:lib/invoices.ts#getInvoice" to one of: route:demo-api:GET /invoices/:id | route:demo-billing:GET /invoices/:id');
    expect(find(gaps, "unknown-base", "PAYMENTS_URL")!.evidence[0]).toMatch(/POST \/charges → no route matches/);

    // a role only describes a repo: it settles no tie and changes no link
    const before = readFileSync(join(root, ".codeloom", "chains.json"), "utf8");
    const role = saveMapAnswers(root, { answers: [{ kind: "role", repo: "demo-billing", role: "api" }] });
    expect(role.closed).toEqual([]);
    expect(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).toBe(before);
    const link = saveMapAnswers(root, { answers: [{ kind: "link", from: "demo-web:lib/invoices.ts#getInvoice", to: "route:demo-billing:GET /invoices/:id" }] });
    expect(link.closed.map((x) => x.id)).toContain(tie.id);
    expect(chainsOf(root).find((c) => c.entry.startsWith("page:demo-web:/invoices") && reposOf(c).includes("demo-billing"))!
      .stops.find((s) => s.kind === "route")!.hop.confidence).toBe("exact");

    const ext = saveMapAnswers(root, { answers: [{ kind: "external", base: "PAYMENTS_URL", name: "Payments" }] });
    expect(ext.closed.map((x) => x.kind)).toEqual(["unknown-base"]);
    const external = JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")).external;
    expect(external).toEqual([expect.objectContaining({ repo: "demo-web", base: "PAYMENTS_URL", name: "Payments", path: "/charges" })]);

    const ignore = saveMapAnswers(root, { answers: [{ kind: "ignore-repo", repo: "demo-tools" }] });
    expect(ignore.closed.map((x) => x.kind)).toEqual(["unclear-role"]);
    expect(mapGaps(root).gaps.some((x) => x.question.includes("demo-tools"))).toBe(false);
  }, 120_000);
});
