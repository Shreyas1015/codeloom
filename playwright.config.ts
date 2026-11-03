import { defineConfig, devices } from "@playwright/test";

/** End-to-end smoke for the dashboard. No `webServer`: each spec starts the real dashboard server itself on an
 * indexed temp copy of fixtures/demo-shop (see e2e/workspace.ts). Needs `pnpm -r build` and, once,
 * `pnpm exec playwright install chromium`. */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  outputDir: "test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
