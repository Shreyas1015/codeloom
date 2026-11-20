import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { isTestFile } from "../src/linker/resolve-calls.js";
import { mapGaps } from "../src/map/gaps.js";
import { loadMapState } from "../src/mcp/state.js";
import { freshHome, makeRepo } from "./helpers.js";

// 0.6 Task E (acceptance run 2): chains began in test files (unit tests, e2e specs, load scripts, mocks). Test
// files are never a chain's entry, and never count in check or the gaps.

describe("test files", () => {
  it("recognises the usual test, e2e, load and mock folders", () => {
    for (const f of [
      "tests/unit/orders.test.ts", "tests/acceptance/orders.ts", "tests/load/smoke.js", "e2e/checkout.spec.ts", "e2e/helpers/login.ts",
      "cypress/e2e/orders.cy.ts", "playwright/orders.ts", "src/__mocks__/api.ts", "src/mocks/handlers.ts", "load-tests/orders.js",
      "test/fixtures/orders.json", "src/orders.e2e.ts",
    ]) expect([f, isTestFile(f)]).toEqual([f, true]);
    for (const f of ["src/orders.ts", "app/latest/page.tsx", "lib/testimonials.ts", "app/contest/page.tsx"]) expect([f, isTestFile(f)]).toEqual([f, false]);
  });

  it("are never chain entries and never count in check or the gaps", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-tests-excluded-"));
    const call = (path: string, method = "GET") => `export async function hit() {\n  const r = await fetch(\`\${process.env.NEXT_PUBLIC_API_URL}${path}\`, { method: "${method}" });\n  return r.json();\n}\n`;
    const api = makeRepo({
      "package.json": JSON.stringify({ name: "demo-api", dependencies: { express: "^4", "@prisma/client": "^5" } }),
      "prisma/schema.prisma": 'model Order {\n  id Int @id\n  @@map("orders")\n}\n',
      "src/server.ts": 'import express from "express";\nimport { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nconst app = express();\napp.get("/orders/:id", async (req, res) => { res.json(await prisma.order.findUnique({ where: { id: 1 } })); });\napp.listen(1);\n',
      "tests/mocks/server.ts": 'import express from "express";\nconst app = express();\napp.get("/mock/orders", (req, res) => { res.json([]); });\n',
    }, join(parent, "demo-api"));
    const web = makeRepo({
      "package.json": JSON.stringify({ name: "demo-web", dependencies: { next: "^15", react: "^19" } }),
      "app/orders/[id]/page.tsx": 'import { hit } from "../../../lib/orders";\nexport default async function Order() {\n  await hit();\n  return <p>x</p>;\n}\n',
      "lib/orders.ts": call("/orders/1"),
      "tests/unit/orders.test.ts": call("/orders/2"),
      "tests/load/smoke.js": call("/orders/3"),
      "e2e/checkout.spec.ts": call("/orders/4"),
      "src/__mocks__/api.ts": call("/orders/5"),
      "e2e/helpers/login.ts": call("/login", "POST"),
    }, join(parent, "demo-web"));
    await runIndex(api);
    await runIndex(web);
    const state = loadMapState(web);
    const fromTests = state.chains.flatMap((c) => c.stops).filter((s) => isTestFile(s.file));
    expect(fromTests.map((s) => `${s.repo} ${s.file}`)).toEqual([]);
    expect(state.ws.repos.flatMap((r) => [...r.endpoints.httpCalls, ...r.endpoints.routes].map((x) => x.at.file)).filter(isTestFile)).toEqual([]);
    const report = await buildReport(web);
    expect(report.items.filter((i) => isTestFile(i.file))).toEqual([]);
    expect(mapGaps(web).gaps.flatMap((g) => g.evidence).filter((e) => /tests\/|e2e\/|__mocks__/.test(e))).toEqual([]);
    expect(state.chains.filter((c) => c.complete).map((c) => c.entry)).toContain("page:demo-web:/orders/:id");
  }, 120_000);
});
