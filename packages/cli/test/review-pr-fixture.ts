import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runIndex } from "../src/commands/index-cmd.js";
import { chainId } from "../src/linker/chains.js";
import { saveJourneysTool } from "../src/mcp/tools/journeys.js";
import { git } from "../src/workspace/git.js";
import { commitChange, materializeFixture } from "./helpers.js";

// A demo-shop pull request for the check (Task 3) tests: the same set-up as review-draft.test.ts.

export const CREATE_CUSTOMER_CHAIN = chainId("page:web:/customers/new", "api:POST /api/customers");
const AUDIT_LOG_LINE = '    await db.table("audit_logs").insert({ action: "customer.created", customer_id: customer.id });\n';
const WEBHOOK_LINES = AUDIT_LOG_LINE + '    if (process.env.CUSTOMER_WEBHOOK_URL) await fetch(process.env.CUSTOMER_WEBHOOK_URL, { method: "POST" });\n';
const FIND_OLD = "  async find(id: number) {\n    return Customer.findOrFail(id);\n  }";
const FIND_NEW = "  async find(id: number) {\n    return Customer.findOrFail(Number(id));\n  }";
export const MIGRATION = "database/migrations/1730000000002_add_phone_to_customers.ts";

const commitAllIn = (dir: string, message: string): void => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
};

/** demo-shop as a folder of separate repos (api, billing, web), indexed, with the create-customer journey named. */
export async function setUpFolder(): Promise<string> {
  const root = materializeFixture("demo-shop");
  writeFileSync(
    join(root, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  writeFileSync(join(root, "api/.env.example"), "PORT=3333\n");
  await runIndex(root);
  for (const repo of ["api", "billing", "web"]) commitAllIn(join(root, repo), "index");
  saveJourneysTool(root, [{ op: "create", name: "Create a customer", chainIds: [CREATE_CUSTOMER_CHAIN] }]);
  return root;
}

/** The api PR on branch "feature": CustomerService.create notifies a webhook, find coerces its id, plus a
 * migration, a new .env.example key and a docs edit. */
export function makeApiPr(root: string): void {
  const api = join(root, "api");
  git(api, ["checkout", "-q", "-b", "feature"]);
  commitChange(api, "app/services/customer_service.ts", (t) => t.replace(AUDIT_LOG_LINE, WEBHOOK_LINES), "notify a webhook on create");
  commitChange(api, "app/services/customer_service.ts", (t) => t.replace(FIND_OLD, FIND_NEW), "coerce the id in find");
  writeFileSync(join(api, MIGRATION), 'export default class { tableName = "customers"; }\n');
  writeFileSync(join(api, ".env.example"), "PORT=3333\nGST_RATE=0.18\n");
  writeFileSync(join(api, "docs/customers.md"), `${readFileSync(join(api, "docs/customers.md"), "utf8")}\nPhone numbers are optional.\n`);
  commitAllIn(api, "phone numbers\n\nCustomers can now have a phone number.");
}
