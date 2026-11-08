import { expect, type Page, test } from "@playwright/test";
import { join } from "node:path";
import { mcpClient, openDemoShop, SCREENSHOTS, type Workspace } from "./workspace";

let ws: Workspace;
test.beforeAll(async () => {
  ws = await openDemoShop();
  const signUp = ws.chains().find((c) => c.entry === "page:web:/customers/new")!.id;
  const client = await mcpClient(ws.root);
  try {
    const r = await client.callTool({
      name: "save_journeys",
      arguments: { ops: [{ op: "create", name: "Sign up a customer", area: "customers", chainIds: [signUp] }] },
    });
    if (r.isError) throw new Error(JSON.stringify(r.content));
  } finally {
    await client.close();
  }
});
test.afterAll(async () => {
  await ws?.close();
});

const folder = (page: Page, name: string) => page.locator('[data-card="folder"]').filter({ has: page.getByRole("button", { name: new RegExp(`^${name}/ folder`) }) });
const file = (page: Page, name: string) => page.locator('[data-card="file"]').filter({ has: page.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}(,|$)`) }) });

test("Map shows the api repo's folders, drills in, and the journey overlay marks its files", async ({ page }) => {
  await page.goto(ws.url);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Map/ }).click();
  await expect(page).toHaveURL(/\/map/);
  const map = page.getByTestId("screen-map");
  await expect(map.getByRole("group", { name: "Repo" }).getByRole("button", { name: "api" })).toHaveAttribute("aria-pressed", "true");

  // the api repo root: four folders (docs holds the spec doc) and package.json
  for (const name of ["app", "database", "docs", "start"]) await expect(folder(page, name)).toBeVisible();
  await expect(page.locator('[data-card="folder"]')).toHaveCount(4);
  await expect(file(page, "package.json")).toBeVisible();

  // drill in: Enter on a folder opens it
  await folder(page, "app").getByRole("button", { name: /^app\/ folder, 3 files/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]dir=app\b/);
  await expect(map.getByRole("navigation", { name: "Folder" }).locator('[aria-current="location"]')).toHaveText("app");
  for (const name of ["controllers", "models", "services"]) await expect(folder(page, name)).toBeVisible();

  // journey overlay: the folders the journey passes through are stops, the rest are dimmed
  await map.getByLabel("Journey overlay").selectOption({ label: "Sign up a customer" });
  await expect(page).toHaveURL(/[?&]overlay=journey(:|%3A)j_[0-9a-f]+/);
  await expect(folder(page, "controllers")).toHaveAttribute("data-overlay", "stop");
  await expect(folder(page, "services")).toHaveAttribute("data-overlay", "stop");
  await expect(folder(page, "models")).toHaveAttribute("data-overlay", "dim");

  // and down to the files: the controller file is a stop
  await folder(page, "controllers").getByRole("button", { name: /^controllers\/ folder/ }).dblclick();
  await expect(page).toHaveURL(/[?&]dir=app(%2F|\/)controllers\b/);
  await expect(file(page, "customers_controller.ts")).toHaveAttribute("data-overlay", "stop");

  // back to the repo root with the overlay on: app and start are on the journey, database is not
  await map.getByRole("navigation", { name: "Folder" }).getByRole("button", { name: "api" }).click();
  await expect(folder(page, "app")).toHaveAttribute("data-overlay", "stop");
  await expect(folder(page, "start")).toHaveAttribute("data-overlay", "stop");
  await expect(folder(page, "database")).toHaveAttribute("data-overlay", "dim");

  await page.screenshot({ path: join(SCREENSHOTS, "map.png"), fullPage: true });
});
