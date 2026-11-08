import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runIndex } from "../packages/cli/dist/commands/index-cmd.js";
import { mcpClient, openDemoShop, SCREENSHOTS, type Workspace } from "./workspace";

// v0.3 acceptance: codeloom finds candidate docs and tickets for a journey with no AI → Claude (an in-process
// MCP client) confirms spec links and saves a "No-spec audit" view → both appear in the open dashboard without
// a reload. A broken home.json never costs you Home: the built-in Home shows with a notice.

let ws: Workspace;
let home: string;
let savedHome: string | undefined;
let signUp: string;
let pay: string;

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd, stdio: "pipe" });

test.beforeAll(async () => {
  savedHome = process.env.CODELOOM_HOME;
  home = mkdtempSync(join(tmpdir(), "codeloom-e2e-home-"));
  process.env.CODELOOM_HOME = home;

  ws = await openDemoShop({ indexed: false });
  // a ticket key in the history of a sign-up stop's file (generic test data)
  const api = join(ws.root, "api");
  appendFileSync(join(api, "app/services/customer_service.ts"), "\n// validates new customers\n");
  git(api, "add", "-A");
  git(api, "commit", "-q", "-m", "SHOP-12 validate new customers");
  await runIndex(ws.root);

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
  // candidates are built by `codeloom index` (the post-commit hook) for the journeys that exist then
  await runIndex(ws.root);
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
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events" && r.status() === 200);
  await page.goto(origin() + path);
  await events;
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}
/** Screenshots wait for the overview (the rail's workspace card) so they show the settled screen. */
const settled = (page: Page) => expect(page.getByRole("complementary", { name: "codeloom" }).getByText("demo-shop")).toBeVisible();
const noReload = (page: Page) => page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload);

test("Claude confirms spec links and saves a No-spec audit view; both appear live", async ({ page }) => {
  // ---- before any check: candidates found by codeloom alone ----
  await openApp(page, `/journeys/${signUp}?tab=specs`);
  const state = page.getByRole("region", { name: "Spec state" });
  await expect(state.getByText("Spec candidates", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Candidate docs" })).toContainText("docs/customers.md");
  await expect(page.getByRole("list", { name: "Candidate tickets" })).toContainText("SHOP-12");
  await expect(state.getByText(`/mcp__codeloom__match-specs ${signUp}`)).toBeVisible();
  await settled(page);
  await page.screenshot({ path: join(SCREENSHOTS, "specs-candidates.png"), fullPage: true });

  // ---- Claude runs match-specs: reads the candidates, keeps what fits ----
  const match = await agent((c) => tool(c, "match_specs", { journey: signUp }));
  const docRefs = (match.docs as Array<{ ref: string }>).map((d) => d.ref);
  const ticketRefs = (match.tickets as Array<{ ref: string }>).map((t) => t.ref);
  expect(docRefs).toContain("api:docs/customers.md");
  expect(ticketRefs).toContain("SHOP-12");
  await agent((c) =>
    tool(c, "save_spec_links", {
      journey: signUp,
      links: [
        { kind: "doc", ref: "api:docs/customers.md", reason: "Describes the sign-up form, POST /api/customers and CustomerService.create." },
        { kind: "ticket", ref: "SHOP-12", reason: "Added validation to the customer service this journey calls." },
      ],
    }),
  );
  await agent((c) => tool(c, "save_spec_links", { journey: pay, links: [] }));

  await expect(state.getByText("Spec linked", { exact: true })).toBeVisible({ timeout: 5_000 });
  const linkedDocs = page.getByRole("list", { name: "Linked docs" });
  await expect(linkedDocs).toContainText("Describes the sign-up form");
  await expect(page.getByRole("list", { name: "Linked tickets" })).toContainText("SHOP-12");
  await linkedDocs.getByRole("button", { name: "Open docs/customers.md" }).click();
  await expect(page.locator('[data-slot="code-block"]')).toContainText("CustomerService.create");
  await settled(page);
  await page.screenshot({ path: join(SCREENSHOTS, "specs-linked.png"), fullPage: true });
  expect(await noReload(page)).toBe(true);

  // ---- Claude runs make-view: a No-spec audit ----
  const saved = await agent((c) =>
    tool(c, "save_view", {
      view: {
        id: "no-spec-audit",
        title: "No-spec audit",
        description: "Journeys Claude checked and found no spec for.",
        widgets: [
          { type: "counts", show: ["journeys", "specLinked", "understood"] },
          { type: "journeys", title: "Journeys with no spec", filter: { spec: "none" } },
          { type: "specCoverage", by: "area" },
          { type: "note", markdown: "Ask Claude to **write a spec** for each one, then run `match-specs` again." },
        ],
      },
    }),
  );
  expect(JSON.stringify(saved)).toContain("/views/no-spec-audit");

  const rail = page.getByRole("complementary", { name: "codeloom" });
  const viewLink = rail.getByRole("link", { name: /No-spec audit/ });
  await expect(viewLink).toBeVisible({ timeout: 5_000 });
  expect(await noReload(page)).toBe(true);
  await viewLink.click();
  await expect(page).toHaveURL(/\/views\/no-spec-audit$/);
  const view = page.getByTestId("screen-view");
  await expect(view.getByRole("heading", { level: 1, name: "No-spec audit" })).toBeVisible();
  const noSpec = view.getByRole("list", { name: "Journeys with no spec" });
  await expect(noSpec).toContainText("Pay an invoice");
  await expect(noSpec).not.toContainText("Sign up a customer");
  await expect(noSpec.getByText("No spec", { exact: true })).toBeVisible();
  await expect(view.getByRole("strong").filter({ hasText: "write a spec" })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: join(SCREENSHOTS, "view-no-spec-audit.png"), fullPage: true });

  // ---- Home: each journey row carries its spec badge ----
  await page.getByRole("link", { name: /^Home/ }).click();
  const rows = page.getByRole("list", { name: "User journeys" });
  await expect(rows.getByRole("listitem").filter({ hasText: "Sign up a customer" }).getByText("Spec linked", { exact: true })).toBeVisible();
  await expect(rows.getByRole("listitem").filter({ hasText: "Pay an invoice" }).getByText("No spec", { exact: true })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: join(SCREENSHOTS, "home-specs.png"), fullPage: true });
});

test("a broken home.json falls back to the built-in Home with a notice; a valid one replaces Home", async ({ page }) => {
  const views = join(ws.root, ".codeloom", "views");
  mkdirSync(views, { recursive: true });
  writeFileSync(join(views, "home.json"), '{ "version": 1, "id": "home", "widgets": [ { "type": "chart" } ] }');

  await page.goto(ws.url);
  const homeScreen = page.getByTestId("screen-home");
  await expect(homeScreen.getByRole("list", { name: "User journeys" })).toBeVisible();
  const notice = page.getByRole("status", { name: "Home view" });
  await expect(notice).toContainText("Your home view can't be read");
  await expect(notice).toContainText("codeloom doctor");
  await settled(page);
  await page.screenshot({ path: join(SCREENSHOTS, "home-broken-view.png"), fullPage: true });

  // Claude fixes it over MCP: Home becomes the view, live
  await agent((c) =>
    tool(c, "save_view", {
      view: {
        id: "home",
        title: "Team home",
        widgets: [
          { type: "note", markdown: "Start with **Sign up a customer**." },
          { type: "counts" },
          { type: "journeys", sort: "spec" },
        ],
      },
    }),
  );
  await expect(page.getByRole("heading", { level: 1, name: "Team home" })).toBeVisible({ timeout: 5_000 });
  await expect(notice).toHaveCount(0);

  // a fresh load goes straight to the view: the built-in Home's skeleton never shows first
  await page.addInitScript(() => {
    const w = window as unknown as { __sawBuiltIn: boolean };
    w.__sawBuiltIn = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="home-loading"], [aria-label="Unnamed chains"]')) w.__sawBuiltIn = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(origin() + "/");
  await expect(page.getByRole("heading", { level: 1, name: "Team home" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sawBuiltIn: boolean }).__sawBuiltIn)).toBe(false);
  await settled(page);
  await page.screenshot({ path: join(SCREENSHOTS, "home-view.png"), fullPage: true });
});
