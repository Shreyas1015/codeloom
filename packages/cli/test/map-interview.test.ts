import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { runAsk, runGaps } from "../src/commands/gaps.js";
import { createServer } from "../src/mcp/server.js";
import { MAX_GAPS_CHARS } from "../src/map/gaps.js";
import { overview } from "../src/web/api.js";
import { type ChangeKey, watchMap } from "../src/web/events.js";
import { bigInterviewGroup, interviewGroup } from "./interview-fixture.js";

// 0.6 spec §5 end to end: the map-interview as Claude would run it over MCP on the test setup, counting every
// character codeloom sends back (the gap list, the snippets, the save results). Budget: 40,000.

const INTERVIEW_BUDGET = 40_000;

/** An MCP client on `start` that counts every character codeloom sends: each tool result's text and any
 * structuredContent copy, and the prompt text. */
async function interviewClient(start: string) {
  const server = createServer({ start });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "interview", version: "0" });
  await client.connect(a);
  const counter = { sent: 0, calls: 0 };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (r.content[0] as { text: string }).text;
    counter.sent += text.length + (r.structuredContent ? JSON.stringify(r.structuredContent).length : 0);
    counter.calls++;
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  const prompt = async () => {
    const p = await client.getPrompt({ name: "map-interview" });
    const text = (p.messages[0]!.content as { text: string }).text;
    counter.sent += text.length;
    return text;
  };
  return { client, call, prompt, counter };
}

describe("the map interview over MCP (0.6 §5)", () => {
  let g: Awaited<ReturnType<typeof interviewGroup>>;
  beforeAll(async () => {
    g = await interviewGroup();
  }, 120_000);
  // Every test gets its own CODELOOM_HOME (test/setup.ts): use the one the group was indexed in.
  beforeEach(() => {
    process.env.CODELOOM_HOME = g.home;
  });

  it("codeloom gaps and codeloom ask print the questions and how to answer them; Home counts them", async () => {
    const text = runGaps(g.repo.web!);
    expect(text).toMatch(/^11 open questions about the map/);
    expect(text).toMatch(/Where does LEGACY_BILLING_URL point: one of your repos \(demo-billing\?\), or another service\?/);
    expect(text).toMatch(/proposed answer: \{"kind":"env","name":"LEGACY_BILLING_URL","repo":"demo-billing","from":"demo-web"\}/);
    const json = JSON.parse(runGaps(g.repo.web!, { json: true })) as { open: number };
    expect(json.open).toBe(11);
    expect(runAsk(g.repo.api!)).toMatch(/11 open questions[\s\S]*\/mcp__codeloom__map-interview/);
    expect((await overview(g.repo.web!)).gaps).toEqual({ open: 11 });
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["gaps", "ask", "link"]));
  });

  it("an interview closes every gap in fewer than 15 questions, within the character budget, and the dashboard hears each answer", async () => {
    const { client, call, prompt, counter } = await interviewClient(g.repo.web!);
    const events: ChangeKey[][] = [];
    const stop = watchMap(g.repo.web!, (keys) => events.push(keys), { debounceMs: 20 });

    expect(await prompt()).toMatch(/one short question at a time/);

    const list = await call("map_gaps");
    expect(list.open).toBe(11);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(MAX_GAPS_CHARS);
    const gap = (kind: string, text: string) => (list.gaps as Array<Record<string, any>>).find((x) => x.kind === kind && JSON.stringify(x).includes(text))!;
    const proposal = (x: Record<string, any>) => JSON.parse(x.suggest[0]);

    // Each question as Claude asks it (the user says yes); a snippet only where the evidence alone is thin.
    const questions: Array<{ answers: unknown[]; snippet?: string }> = [
      { answers: [proposal(gap("unknown-base", "LEGACY_BILLING_URL"))] },
      // No proposal for a URL codeloom cannot read: Claude reads the snippet and asks "does it call GET /reports?".
      { answers: [{ kind: "link", from: "demo-web:lib/reports.ts#loadReport", to: "route:demo-api:GET /reports" }], snippet: "demo-web::function:lib/reports.ts:loadReport" },
      { answers: [proposal(gap("queue-no-consumer", "order.placed"))] },
      { answers: [proposal(gap("unconnected-repo", "demo-search"))], snippet: "demo-web::function:app/api/search/[...path]/route.ts:GET" },
      { answers: [{ kind: "role", repo: "demo-tools", role: "lib" }] },
    ];
    let closed = 0;
    for (const q of questions) {
      if (q.snippet) await call("explain_context", { node: q.snippet, maxChars: 1500 });
      const r = await call("save_map_answers", { answers: q.answers });
      expect(r.closed.length, JSON.stringify(q.answers)).toBeGreaterThan(0);
      closed += r.closed.length;
    }
    // The LEGACY_BILLING_URL answer left demo-api's twin route with no caller: the user says it is called from outside.
    const again = await call("map_gaps");
    expect(again.gaps.map((x: { kind: string }) => x.kind)).toEqual(["route-no-caller"]);
    await call("save_map_answers", { answers: [{ kind: "ignore-gap", gap: again.gaps[0].id }] });
    expect((await call("map_gaps")).open).toBe(0);

    const asked = questions.length + 1;
    expect(asked).toBeLessThan(15);
    expect(closed).toBe(10); // + the ignored one: all 11 first listed, and the twin route the answers showed
    expect(counter.sent).toBeLessThanOrEqual(INTERVIEW_BUDGET);
    // Measured for the report (codeloom output only: gap lists, snippets, save results).
    console.log(`map-interview on the test setup: ${asked} questions, ${counter.calls} tool calls, ${counter.sent} characters sent (prompt included)`);

    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(events.flat()).toContain("chains");
    expect((await overview(g.repo.web!)).gaps).toEqual({ open: 0 });
    await client.close();
  }, 120_000);
});

describe("a bigger interview: 13 repos (fix round 1)", () => {
  let g: Awaited<ReturnType<typeof bigInterviewGroup>>;
  beforeAll(async () => {
    g = await bigInterviewGroup();
  }, 300_000);
  beforeEach(() => {
    process.env.CODELOOM_HOME = g.home;
  });

  it("14 questions close every gap within 40,000 characters", async () => {
    const { client, call, prompt, counter } = await interviewClient(g.repo.shop!);
    await prompt();
    let list = (await call("map_gaps")) as { open: number; gaps: Array<Record<string, any>> };
    expect(list.open).toBeGreaterThanOrEqual(25);
    const answered = new Set<string>();
    /** The gap the next question is about, from the list Claude has (a fresh map_gaps when it is not in it). */
    const next = async (pick: (x: Record<string, any>) => boolean) => {
      let found = list.gaps.find((x) => !answered.has(x.id) && pick(x));
      if (!found) {
        list = (await call("map_gaps")) as typeof list;
        found = list.gaps.find((x) => !answered.has(x.id) && pick(x));
      }
      expect(found, String(pick)).toBeDefined();
      answered.add(found!.id);
      return found!;
    };
    const proposed = (x: Record<string, any>) => [JSON.parse(x.suggest[0])];
    const env = (from: string, base: string) => async () =>
      proposed(await next((x) => x.kind === "unknown-base" && (x.suggest ?? []).join(" ").includes(`"name":"${base}"`) && (x.suggest ?? []).join(" ").includes(`"from":"${from}"`)));
    const plan: Array<{ answers: () => Promise<unknown[]>; snippet?: string }> = [
      { answers: env("demo-shop", "ORDERS_LEGACY_URL") },
      { answers: env("demo-shop", "CATALOG_LEGACY_URL") },
      { answers: env("demo-shop", "PAYMENTS_LEGACY_URL") },
      { answers: env("demo-admin", "ORDERS_LEGACY_URL") },
      { answers: env("demo-admin", "USERS_LEGACY_URL") },
      { answers: env("demo-admin", "REVIEWS_LEGACY_URL") },
      { answers: env("demo-partner", "SHIPPING_LEGACY_URL") },
      { answers: env("demo-partner", "CATALOG_LEGACY_URL") },
      { answers: async () => (await next((x) => x.kind === "call-no-route" && x.question.includes("loadReport")), [{ kind: "link", from: "demo-shop:lib/reports.ts#loadReport", to: "route:demo-catalog:GET /reports" }]), snippet: "demo-shop::function:lib/reports.ts:loadReport" },
      { answers: async () => (await next((x) => x.kind === "queue-no-publisher" && x.question.includes("mail-queue")), [{ kind: "queue-alias", publish: "shop:order.created", consume: "mail-queue" }]) },
      { answers: async () => proposed(await next((x) => x.kind === "queue-no-consumer" && x.question.includes("audit.events"))) },
      { answers: async () => proposed(await next((x) => x.kind === "unconnected-repo" && x.question.includes("demo-search"))), snippet: "demo-admin::function:app/api/search/[...path]/route.ts:GET" },
      { answers: async () => (await next((x) => x.kind === "unclear-role"), [{ kind: "role", repo: "demo-kit", role: "lib" }]) },
      { answers: async () => [{ kind: "ignore-gap", gap: (await next((x) => x.kind === "route-no-caller" && x.question.includes("demo-payments") && x.question.includes("/health"))).id }] },
    ];
    for (const q of plan) {
      if (q.snippet) await call("explain_context", { node: q.snippet, maxChars: 1500 });
      const r = await call("save_map_answers", { answers: await q.answers() });
      expect(r.closed.length + (r.saved > 0 ? 0 : 1)).toBeGreaterThan(0);
    }
    const left = await call("map_gaps");
    expect(left.open).toBe(0);
    expect(plan.length).toBeGreaterThanOrEqual(14);
    expect(counter.sent).toBeLessThanOrEqual(INTERVIEW_BUDGET);
    console.log(`map-interview on 13 repos: ${plan.length} questions, ${counter.calls} tool calls, ${counter.sent} characters sent (prompt included)`);
    await client.close();
  }, 300_000);
});
