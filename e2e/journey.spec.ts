import { expect, test } from "@playwright/test";
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

// demo-shop's /customers/new chain: page → hook → POST call (UI) → route (API) → controller → service (Code) →
// insert customers, insert audit_logs (DB). Both inserts hang off the service (stop 6), not off each other.
test("a journey opens from Home with its lanes, and the inspector shows the stop's code", async ({ page }) => {
  await page.goto(ws.url);
  await page.getByRole("list", { name: "User journeys" }).getByRole("link", { name: /Sign up a customer/ }).click();
  await expect(page).toHaveURL(/\/journeys\/j_[0-9a-f]+/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign up a customer" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Lanes" })).toHaveAttribute("aria-selected", "true");

  const lane = (name: string) => page.getByRole("list", { name: `${name} stops` }).getByRole("button");
  await expect(lane("UI")).toHaveCount(3);
  await expect(lane("API")).toHaveCount(1);
  await expect(lane("Code")).toHaveCount(2);
  await expect(lane("DB")).toHaveCount(2);
  await expect(lane("DB").nth(0)).toHaveAccessibleName(/^Stop 7: .*customers/);
  await expect(lane("DB").nth(1)).toHaveAccessibleName(/^Stop 8: .*audit_logs/);

  // the `from` parent rule: a line from the service to each table, none between the two tables
  const wire = (from: number, to: number) => page.locator(`[data-slot="journey-wire"][data-from="${from}"][data-to="${to}"]`);
  await expect(wire(6, 7)).toHaveCount(1);
  await expect(wire(6, 8)).toHaveCount(1);
  await expect(wire(7, 8)).toHaveCount(0);
  const hops = page.getByRole("list", { name: "Hops", includeHidden: true }).getByRole("listitem", { includeHidden: true });
  await expect(hops.filter({ hasText: /^Stop 6 to stop 7:/ })).toHaveCount(1);
  await expect(hops.filter({ hasText: /^Stop 6 to stop 8:/ })).toHaveCount(1);
  await expect(hops.filter({ hasText: /^Stop 7 to stop 8:/ })).toHaveCount(0);
  // in the DB lane the two tables share the column but no line joins them: a plain gap
  const db = page.locator('[data-slot="lane-column"][data-lane="db"]');
  await expect(db.locator('[data-slot="lane-gap"]')).toHaveCount(1);
  // the wires are measured to real positions, not left at the origin
  await expect(wire(6, 8)).not.toHaveAttribute("d", "M0 0");

  await lane("Code").nth(0).click();
  await expect(page).toHaveURL(/[?&]stop=5\b/);
  const inspector = page.getByRole("complementary", { name: "Stop inspector" });
  await expect(inspector.getByRole("heading", { level: 2 })).toContainText("CustomersController.store");
  const code = inspector.locator('[data-slot="code-block"]');
  await expect(code).toBeVisible();
  await expect(code.locator('[data-line="9"]')).toHaveAttribute("data-highlighted", "");
  await expect(code.locator('[data-line="9"]')).toContainText("async store(");

  // v0.2a: the controller method's resolved call to the service method, exact, and the service is stop 6
  const calls = inspector.getByRole("list", { name: "Calls" });
  const create = calls.getByRole("listitem").filter({ hasText: "CustomerService.create" });
  await expect(create).toContainText("(exact)");
  await expect(create.locator('[data-slot="confidence-line"]')).toHaveAttribute("data-stroke", "solid");
  await expect(inspector.getByText(/Call edges for methods aren't mapped yet/)).toHaveCount(0);

  await page.screenshot({ path: join(SCREENSHOTS, "journey.png"), fullPage: true });

  await create.getByRole("button", { name: "Go to stop 6" }).click();
  await expect(page).toHaveURL(/[?&]stop=6\b/);
  await expect(inspector.getByRole("heading", { level: 2 })).toContainText("CustomerService.create");
  await expect(inspector.getByRole("list", { name: "Called by" }).getByRole("link", { name: "CustomersController.store" })).toBeVisible();
});
