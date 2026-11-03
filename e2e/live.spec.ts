import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { runIndex } from "../packages/cli/dist/commands/index-cmd.js";
import { mcpClient, openDemoShop, SCREENSHOTS, type Workspace } from "./workspace";

test.describe("live updates", () => {
  let ws: Workspace;
  test.afterEach(async () => {
    await ws?.close();
  });

  // Acceptance criterion 4: journeys an agent saves over MCP appear on an open Home without a reload.
  test("journeys saved over MCP appear on Home without a reload", async ({ page }) => {
    ws = await openDemoShop();
    const chain = (entry: string) => ws.chains().find((c) => c.entry === entry)!.id;
    const signUp = chain("page:web:/customers/new");
    const pay = chain("route:billing:POST /billing/invoices/:id/pay");

    // the SSE stream must be open before the save, or the change could land before the page listens
    const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events" && r.status() === 200);
    await page.goto(ws.url);
    const home = page.getByTestId("screen-home");
    await expect(home.getByText("No named journeys yet.")).toBeVisible();
    await events;
    // a marker on the window: a reload would wipe it
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    let navigations = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigations++;
    });

    const client = await mcpClient(ws.root);
    try {
      const r = await client.callTool({
        name: "save_journeys",
        arguments: {
          ops: [
            { op: "create", name: "Sign up a customer", area: "customers", chainIds: [signUp] },
            { op: "create", name: "Pay an invoice", area: "billing", chainIds: [pay] },
          ],
        },
      });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    } finally {
      await client.close();
    }

    const rows = home.getByRole("list", { name: "User journeys" });
    await expect(rows.getByRole("link", { name: /Sign up a customer/ })).toBeVisible({ timeout: 5_000 });
    await expect(rows.getByRole("link", { name: /Pay an invoice/ })).toBeVisible({ timeout: 5_000 });
    await expect(home.getByRole("heading", { name: /User journeys/ })).toContainText("2");
    await expect(home.getByRole("list", { name: "Totals" }).getByRole("listitem").nth(5)).toHaveText("2User journeys");
    await expect(home.getByRole("list", { name: "Unnamed chains" }).getByRole("listitem")).toHaveCount(5);

    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    expect(navigations).toBe(0);
    await page.screenshot({ path: join(SCREENSHOTS, "home.png"), fullPage: true });
  });

  test("an un-indexed workspace shows the not-mapped state, then the map once indexing finishes", async ({ page }) => {
    ws = await openDemoShop({ indexed: false });
    await page.goto(ws.url);
    const state = page.locator('[data-state="not-indexed"]');
    await expect(state.getByRole("heading", { name: "This code isn't mapped yet" })).toBeVisible();
    await expect(state.getByText("codeloom index", { exact: true })).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOTS, "not-indexed.png"), fullPage: true });

    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    await runIndex(ws.root);
    // "This page updates by itself when indexing finishes."
    await expect(page.getByTestId("screen-home").getByRole("list", { name: "Totals" })).toBeVisible({ timeout: 10_000 });
    await expect(state).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });
});
