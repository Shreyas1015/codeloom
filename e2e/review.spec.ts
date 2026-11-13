import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The built CLI (run `pnpm -r build` first): the same code `codeloom snapshot` runs.
import { runIndex } from "../packages/cli/dist/commands/index-cmd.js";
import { runSnapshot } from "../packages/cli/dist/commands/snapshot.js";
import { chainId } from "../packages/cli/dist/linker/chains.js";
import { saveJourneysTool } from "../packages/cli/dist/mcp/tools/journeys.js";
import { commitChange, git, materializeSingleRepoDemoShop, serveSnapshot, type StaticSite } from "./workspace";

// This PR review maps' hosted snapshot (design §7): a real `codeloom snapshot` of demo-shop after a commit
// that edits CustomerService.create, served as plain files under a GitHub-Pages-style sub-path (`/pr-12/`)
// by a tiny static server with no SPA fallback and no /api — proving the dashboard's static mode (hash
// routes, relative assets, `data/*.json` instead of a live server) works, not just the real dashboard
// server every other spec in this folder starts.

const CREATE_CUSTOMER_CHAIN = chainId("page:web:/customers/new", "api:POST /api/customers");
const AUDIT_LOG_LINE = '    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });\n';
const VALIDATE_LINES = '    if (!payload.email) {\n      throw new Error("email required");\n    }\n';
const ID_PAGE = "web/app/customers/[id]/page.tsx";

let repoRoot: string;
let outDir: string;
let site: StaticSite;
let journeyId: string;

test.beforeAll(async () => {
  // demo-shop as ONE git repo (api/billing/web as subfolders), indexed, with the create-customer journey
  // named — then a feature branch that edits CustomerService.create, so `main..feature` has a real diff.
  repoRoot = materializeSingleRepoDemoShop();
  await runIndex(repoRoot);
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "index");

  const { created } = saveJourneysTool(repoRoot, [{ op: "create", name: "Create a customer", chainIds: [CREATE_CUSTOMER_CHAIN] }]) as {
    created: string[];
  };
  journeyId = created[0]!;
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "name the create-customer journey");

  git(repoRoot, "checkout", "-q", "-b", "feature");
  commitChange(
    repoRoot,
    "api/app/services/customer_service.ts",
    (text) => text.replace(AUDIT_LOG_LINE, VALIDATE_LINES),
    "edit CustomerService.create",
  );
  // A Next.js dynamic segment: "[id]" in the path (final review C1 — such a path used to make the publish
  // step refuse the whole snapshot, and its %-escaped Map folder key 404'd on a static host).
  commitChange(repoRoot, ID_PAGE, (text) => text.replace("<h1>{customer.name}</h1>", "<h1>Customer {customer.name}</h1>"), "edit the [id] page");

  // `codeloom snapshot --base main --out <dir>`: the full static site (data + dashboard assets +
  // review.md), not `--data-only` — this is what `codeloom init --github`'s publish workflow serves.
  outDir = mkdtempSync(join(tmpdir(), "codeloom-e2e-review-site-"));
  rmSync(outDir, { recursive: true, force: true }); // runSnapshot requires `--out` empty or absent
  await runSnapshot(repoRoot, { base: "main", out: outDir });

  // Served under /pr-12/ (not the server root) to prove the dashboard's relative asset paths survive a
  // real sub-path, the way GitHub Pages serves `pr-<n>/`.
  site = await serveSnapshot(outDir, "/pr-12");
});

test.afterAll(async () => {
  await site?.close();
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

async function openApp(page: Page) {
  await page.goto(site.url);
}

test("a hosted PR snapshot: This PR screen, the diff, rail navigation, hash reload, no /api", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/")) apiRequests.push(req.url());
  });
  // Every data file the dashboard fetches, with its status: a static host must serve each one byte-for-byte
  // (final review I1: a %-escaped name used to be decoded by the server into a file that does not exist).
  const dataResponses: Array<{ name: string; status: number }> = [];
  page.on("response", (res) => {
    const m = /\/data\/([^/?#]+)$/.exec(new URL(res.url()).pathname);
    if (m) dataResponses.push({ name: decodeURIComponent(m[1]!), status: res.status() });
  });
  const loaded = (prefix: string) => dataResponses.filter((r) => r.name.startsWith(prefix) && r.status === 200).length;

  // ---- lands on #/review with the snapshot banner ----
  await openApp(page);
  await expect(page).toHaveURL(/#\/review$/);
  const banner = page.getByRole("status", { name: "Read-only snapshot" });
  await expect(banner).toContainText("Snapshot");
  await expect(banner).toContainText("read-only");
  // "vs main": the --base given (manifest.baseRef), never the 40-character merge-base SHA (final review m1)
  await expect(banner).toHaveText(/^Snapshot · commit [0-9a-f]{7} vs main · read-only$/);

  const screen = page.getByTestId("screen-review");
  await expect(screen.getByRole("heading", { level: 1, name: "What this PR touches" })).toBeVisible();

  const rail = page.getByRole("complementary", { name: "codeloom" });
  await expect(rail.getByRole("link", { name: "This PR" })).toHaveAttribute("aria-current", "page");

  // ---- the changed stop: Change tab shows the added lines by default ----
  const stop = screen.getByRole("button", { name: /CustomerService\.create/ });
  await expect(stop).toHaveAttribute("data-changed", "true");
  await stop.click();

  const panel = page.getByRole("complementary", { name: "Code panel" });
  await expect(panel.getByRole("tab", { name: "Change" })).toHaveAttribute("aria-selected", "true");
  const diff = panel.locator('[data-slot="diff-view"]');
  await expect(diff).toBeVisible();
  await expect(diff.locator('[data-line-type="add"]')).toHaveCount(3);
  await expect(diff.locator('[data-line-type="del"]')).toHaveCount(1);
  await expect(diff).toContainText("email required");
  await expect(diff).toContainText("audit_logs");

  // ---- Code before tab: the pre-change text, no trace of the new validation ----
  await panel.getByRole("tab", { name: "Code before" }).click();
  const before = panel.locator('[data-slot="code-block"]');
  await expect(before).toBeVisible();
  await expect(before).toContainText("audit_logs");
  await expect(before).not.toContainText("email required");

  // ---- Home via the rail: Home opens (final review I5 — only a bare link starts on Review) ----
  await rail.getByRole("link", { name: /^Home/ }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId("screen-home")).toBeVisible();

  // ---- back on This PR, a journey row's own link opens its Journey screen (final review I5) ----
  await rail.getByRole("link", { name: "This PR" }).click();
  await screen.getByRole("link", { name: "Open journey Create a customer" }).click();
  await expect(page).toHaveURL(new RegExp(`#/journeys/${journeyId}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Create a customer" })).toBeVisible();

  // ---- a Journey stop: the node inspector reads its node~ file (an encoded node ref: ":" and "/" in it) ----
  const nodesBefore = loaded("node~");
  await page.getByRole("list", { name: "Code stops" }).getByRole("button").first().click();
  const inspector = page.getByRole("complementary", { name: "Stop inspector" });
  await expect(inspector.getByRole("heading", { level: 2 })).toContainText("CustomersController.store");
  await expect.poll(() => loaded("node~")).toBeGreaterThan(nodesBefore);

  // ---- reload on #/journeys/<id> works: a real reload, not a soft nav. The server only ever sees the
  // sub-path + index.html — the hash never reaches it — so there is nothing for a static host to fall back
  // on; this is the "no SPA fallback" assumption actually being exercised. ----
  await page.goto(`${site.url}#/journeys/${journeyId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Create a customer" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Create a customer" })).toBeVisible();

  // ---- a nested Map folder down to app/customers/[id]: each level's graph@ file is served (final review
  // C1/I1), and the [id] folder shows the changed page ----
  await rail.getByRole("link", { name: /^Map/ }).click();
  const map = page.getByTestId("screen-map");
  await map.getByRole("group", { name: "Repo" }).getByRole("button", { name: "web" }).click();
  const openFolder = async (name: string) => {
    await page.locator('[data-card="folder"]').getByRole("button", { name: new RegExp(`^${name.replace(/[[\]]/g, "\\$&")}/ folder`) }).dblclick();
    await expect(map.getByRole("navigation", { name: "Folder" }).locator('[aria-current="location"]')).toHaveText(name);
  };
  await openFolder("app");
  await openFolder("customers");
  await openFolder("[id]");
  await expect(page.locator('[data-card="file"]').getByRole("button", { name: /^page\.tsx(,|$)/ })).toBeVisible();
  expect(dataResponses.filter((r) => r.name.startsWith("graph@") && r.status !== 200)).toEqual([]);
  expect(dataResponses.filter((r) => r.name.startsWith("node~") && r.status !== 200)).toEqual([]);

  // ---- never a request to /api/: this is a static snapshot, not the live dashboard server ----
  expect(apiRequests).toEqual([]);
});
