import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runIndex } from "../packages/cli/dist/commands/index-cmd.js";
import { mcpClient, openDemoShop, SCREENSHOTS, type Workspace } from "./workspace";

// v0.2b acceptance: an agent saves a tour over MCP → Tour mode shows it → walking all four phases marks the
// journey toured → a check-me pass (record_check) marks it understood → editing one stop's file and re-indexing
// flags that stop only for a re-walk. The Progress screen follows along without a reload.

interface CtxStop {
  chainId: string;
  stopIndex: number;
  key: string;
  repo: string;
  file: string;
  symbol: string;
  sameAs?: unknown;
}

let ws: Workspace;
let home: string;
let savedHome: string | undefined;
let signUp: string;
let pay: string;
let stops: CtxStop[];

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.structuredContent as any;
}

/** One MCP session per call, like an agent turn. */
async function agent<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await mcpClient(ws.root);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test.beforeAll(async () => {
  // Progress is personal: keep it out of the real ~/.codeloom (the dashboard server runs in this process).
  savedHome = process.env.CODELOOM_HOME;
  home = mkdtempSync(join(tmpdir(), "codeloom-e2e-home-"));
  process.env.CODELOOM_HOME = home;

  ws = await openDemoShop();
  const chain = (entry: string) => ws.chains().find((c) => c.entry === entry)!.id;
  const saved = await agent((c) =>
    tool(c, "save_journeys", {
      ops: [
        { op: "create", name: "Sign up a customer", area: "customers", chainIds: [chain("page:web:/customers/new")] },
        { op: "create", name: "Pay an invoice", area: "billing", chainIds: [chain("route:billing:POST /billing/invoices/:id/pay")] },
      ],
    }),
  );
  const id = (name: string) => (saved.journeys as Array<{ id: string; name: string }>).find((j) => j.name === name)!.id;
  signUp = id("Sign up a customer");
  pay = id("Pay an invoice");

  // write-tour, the way the prompt asks: build_tour_context, then save_tour with no hashes
  stops = await agent(async (c) => (await tool(c, "build_tour_context", { journey: signUp })).stops as CtxStop[]);
  const service = stops.find((s) => s.file.endsWith("customer_service.ts"))!;
  const res = await agent((c) =>
    tool(c, "save_tour", {
      journey: signUp,
      tour: {
        stops: stops.map((s) => ({
          chainId: s.chainId,
          stopIndex: s.stopIndex,
          key: s.key,
          explanation: `**${s.symbol}** in \`${s.file}\`: this is where the sign-up goes next.`,
        })),
        dataJourney: {
          input: '{ "name": "Ada Lovelace", "email": "ada@example.com" }',
          steps: [
            { stopKey: stops[0]!.key, note: "The form collects name and email." },
            { stopKey: service.key, note: "The service creates the customer and an audit row.", sql: "INSERT INTO customers (name, email) VALUES ($1, $2)" },
          ],
          output: '{ "id": 1, "name": "Ada Lovelace" }',
        },
        fileNotes: [{ repo: service.repo, file: service.file, notes: [{ kind: "trap", text: "It also writes an audit_logs row." }] }],
        check: [
          { question: "Where is the customer saved?", expected: ["CustomerService.create"] },
          { question: "What else is written when a customer signs up?", expected: ["an audit_logs row"] },
          { question: "What does the form send?", expected: ["name and email as JSON"] },
        ],
      },
    }),
  );
  expect(res.uncoveredStops).toEqual([]);
});

test.afterAll(async () => {
  await ws?.close();
  if (savedHome === undefined) delete process.env.CODELOOM_HOME;
  else process.env.CODELOOM_HOME = savedHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

const origin = () => new URL(ws.url).origin;
async function openApp(page: Page, path: string) {
  await page.goto(ws.url); // sets the session cookie
  await expect(page.getByTestId("screen-home")).toBeVisible();
  await page.goto(origin() + path);
}

test("walk a saved tour → toured; check-me pass → understood; an edited stop → needs re-walk on that stop only", async ({ page, context }) => {
  // ---- Tour mode shows the saved tour ----
  await openApp(page, `/journeys/${signUp}/tour`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign up a customer" })).toBeVisible();
  const phases = page.getByRole("navigation", { name: "Tour phases" });
  await expect(phases.getByRole("link")).toHaveText(["Flow", "Data journey", "File notes", "Check yourself"]);
  await expect(page.getByRole("list", { name: "Tour stops" }).getByRole("listitem")).toHaveCount(stops.length);
  await expect(page.locator('[data-slot="code-block"]').first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "tour-flow.png"), fullPage: true });

  // ---- walk every place: each Flow stop, then the other three phases ----
  const toured = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/progress/toured" && r.request().method() === "POST");
  const status = page.locator('p[role="status"][aria-live="polite"]');
  for (let i = 2; i <= stops.length; i++) {
    await page.getByRole("button", { name: /^Next: / }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]stop=${i}\\b`));
    await expect(status).toContainText(`Stop ${i}`);
  }
  await page.getByRole("button", { name: /^Next: Data journey/ }).click();
  await expect(page.getByText("ada@example.com").first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "tour-data.png"), fullPage: true });
  await page.getByRole("button", { name: /^Next: File notes/ }).click();
  await expect(page.getByText("It also writes an audit_logs row.")).toBeVisible();
  await page.getByRole("button", { name: /^Next: Check yourself/ }).click();
  const questions = page.getByRole("list", { name: "Questions" });
  await expect(questions.getByRole("listitem")).toHaveCount(3);
  // the expected points are for the agent judging only: never on the page
  await expect(page.getByText("CustomerService.create", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/good answer covers/i)).toHaveCount(0);
  expect((await toured).status()).toBe(200);
  await expect(phases.getByRole("link", { name: "Check yourself (viewed)" })).toBeVisible();
  await expect(page.getByText("You have walked all four phases of this tour.")).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "tour-check.png"), fullPage: true });

  // ---- Progress, open while the agent works: it updates live ----
  const progress = await context.newPage();
  const events = progress.waitForResponse((r) => new URL(r.url()).pathname === "/api/events" && r.status() === 200);
  await progress.goto(origin() + "/progress");
  const screen = progress.getByTestId("screen-progress");
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText(/You understand (0|none) of 2 journeys/i);
  const apiRow = screen.getByRole("table", { name: "Progress by repo" }).getByRole("row").filter({ hasText: /^api/ });
  await expect(apiRow.getByRole("cell").nth(3)).toHaveText("1 / 1");
  await events;
  await progress.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

  // check-me: Claude asked the three questions and judged the answers against the code → pass
  const check = await agent((c) =>
    tool(c, "record_check", {
      journey: signUp,
      questions: ["Where is the customer saved?", "What else is written when a customer signs up?", "What does the form send?"],
      answers: ["CustomerService.create", "an audit_logs row", "name and email as JSON"],
      verdict: "pass",
      notes: "All three match the code.",
    }),
  );
  expect(check).toMatchObject({ verdict: "pass", understood: true });
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("You understand 1 of 2 journeys", { timeout: 5_000 });
  await expect(apiRow.getByRole("cell").nth(2)).toHaveText("1 / 1");
  await expect(screen.getByRole("list", { name: "Recent checks" }).getByRole("listitem").first()).toContainText("Sign up a customer");
  await expect(screen.getByRole("list", { name: "customers" })).toHaveCount(0); // nothing left in that area
  await expect(screen.getByRole("list", { name: "billing" })).toContainText("Pay an invoice");
  await progress.screenshot({ path: join(SCREENSHOTS, "progress.png"), fullPage: true });

  // ---- edit one stop's file (append, so no line moves) and re-index ----
  const target = stops.filter((s) => s.file.endsWith("customers_controller.ts"));
  expect(target).toHaveLength(1);
  appendFileSync(join(ws.root, target[0]!.repo, target[0]!.file), "\n// changed after the check\n");
  await runIndex(ws.root);

  const rewalk = screen.getByRole("region", { name: "Needs a re-walk" });
  await expect(rewalk.getByText("Sign up a customer")).toBeVisible({ timeout: 10_000 });
  await expect(rewalk.getByText("1 stop changed")).toBeVisible();
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText(/You understand (0|none) of 2 journeys/i);
  expect(await progress.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  const p = await agent((c) => tool(c, "get_progress", {}));
  const row = (p.journeys as Array<{ journeyId: string; needsReWalk: string[] }>).find((j) => j.journeyId === signUp)!;
  expect(row.needsReWalk).toEqual([target[0]!.key]);
  expect((p.journeys as Array<{ journeyId: string; level: string }>).find((j) => j.journeyId === pay)!.level).toBe("none");
  await progress.screenshot({ path: join(SCREENSHOTS, "progress-rewalk.png"), fullPage: true });

  // Re-walk opens Tour mode on the changed stop, marked "may be out of date"
  await rewalk.getByRole("link", { name: "Re-walk Sign up a customer" }).click();
  await expect(progress).toHaveURL(new RegExp(`/journeys/${signUp}/tour`));
  await expect(progress.getByText(/May be out of date/i).first()).toBeVisible();
  await expect(progress.getByRole("main").getByRole("heading", { level: 2 })).toContainText(target[0]!.symbol);
});

// Screens for the design review (no pixel diffs): a journey with no tour yet, and both screens at phone width.
test("design-review captures: no-tour empty state, and Tour mode + Progress at 390px", async ({ page }) => {
  await openApp(page, `/journeys/${pay}/tour`);
  await expect(page.getByText(`/mcp__codeloom__write-tour ${pay}`)).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "tour-empty.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin() + `/journeys/${signUp}/tour?phase=flow&stop=1`);
  await expect(page.getByRole("navigation", { name: "Tour phases" })).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "tour-flow-390.png"), fullPage: true });
  await page.goto(origin() + "/progress");
  await expect(page.getByTestId("screen-progress").getByRole("heading", { level: 1 })).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "progress-390.png"), fullPage: true });
});
