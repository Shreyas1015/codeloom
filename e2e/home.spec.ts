import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { openDemoShop, SCREENSHOTS, type Workspace } from "./workspace";

let ws: Workspace;
test.beforeAll(async () => {
  ws = await openDemoShop();
});
test.afterAll(async () => {
  await ws?.close();
});

test("Home shows the six workspace counts and the unnamed chains hint", async ({ page }) => {
  await page.goto(ws.url);
  // the token visit sets the session cookie and redirects to the same path without the token
  await expect(page).toHaveURL(/\/$/);
  expect(page.url()).not.toContain("token=");

  const home = page.getByTestId("screen-home");
  await expect(home.getByRole("heading", { level: 1, name: "demo-shop" })).toBeVisible();
  await expect(home.getByText("0 journeys · 7 chains, 5 complete")).toBeVisible();

  const totals = home.getByRole("list", { name: "Totals" });
  const cells = totals.getByRole("listitem");
  await expect(cells).toHaveCount(6);
  // demo-shop: 23 files, 3 pages, 5 routes, 5 tables, 3 queues, no journeys yet
  const expected: Array<[string, string]> = [
    ["23", "Files"],
    ["3", "UI pages"],
    ["5", "API routes"],
    ["5", "DB tables"],
    ["3", "Queues"],
    ["0", "User journeys"],
  ];
  for (const [i, [value, caption]] of expected.entries()) {
    await expect(cells.nth(i)).toHaveText(`${value}${caption}`);
  }

  await expect(home.getByText("No named journeys yet.")).toBeVisible();
  await expect(home.getByRole("heading", { name: /Unnamed chains/ })).toContainText("7");
  await expect(home.getByRole("list", { name: "Unnamed chains" }).getByRole("listitem")).toHaveCount(7);
  await expect(home.getByText("/codeloom:name-journeys").first()).toBeVisible();

  await page.screenshot({ path: join(SCREENSHOTS, "home-unnamed.png"), fullPage: true });
});

test("an unnamed chain opens its Journey screen", async ({ page }) => {
  await page.goto(ws.url);
  await page.getByRole("list", { name: "Unnamed chains" }).getByRole("link", { name: /POST \/api\/customers · NewCustomerPage/ }).click();
  await expect(page).toHaveURL(/\/journeys\/ch_[0-9a-f]+/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("POST /api/customers");
});
