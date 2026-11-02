import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { createServer } from "../src/mcp/server.js";
import { commitAll, materializeFixture } from "./helpers.js";

let demo: string;
let client: Client;
let createId: string;
let showId: string;
const SIGNUP = "j_00000000c0de";
const SHOW = "j_0000000000bb";
const REPOS = ["api", "billing", "web"];

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sc(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  const item = r.content[0];
  if (item?.type !== "text") throw new Error("expected a text item");
  expect(JSON.parse(item.text)).toEqual(r.structuredContent);
  return r.structuredContent;
}

/** The commit each repo was indexed at (fingerprints.json). */
const indexed = (repo: string): string =>
  JSON.parse(readFileSync(join(demo, repo, ".codeloom", "fingerprints.json"), "utf8")).gitCommitHash;

/** The reviewer's probe: two comment lines above store() shift the file, and show()'s body is edited. */
function shiftAndEditShow(): void {
  const rel = "api/app/controllers/customers_controller.ts";
  const rows = readFileSync(join(demo, rel), "utf8").split("\n");
  rows[14] = "    return new CustomerService().find(Number(params.id) + 0);"; // show() body, line 15
  rows.splice(8, 0, "  // a comment", "  // another"); // above store() (line 9)
  writeFileSync(join(demo, rel), rows.join("\n"));
}

/** Rewrite one line (1-based) of a file in the demo workspace. */
function editLine(rel: string, line: number, text: string): void {
  const p = join(demo, rel);
  const rows = readFileSync(p, "utf8").split("\n");
  rows[line - 1] = text;
  writeFileSync(p, rows.join("\n"));
}

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: REPOS.map((id) => ({ id, path: id })), links: [] }),
  );
  await runIndex(demo);
  const chains: Array<{ id: string; routeKey: string }> = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains;
  createId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  showId = chains.find((c) => c.routeKey === "api:GET /api/customers/:id")!.id;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({
      version: 1,
      journeys: [
        { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" },
        { id: SHOW, name: "View a customer", area: "customers", note: "", chainIds: [showId], status: "ok" },
      ],
    }),
  );
  // As in real use: each repo's .codeloom files are committed after indexing.
  for (const r of REPOS) commitAll(join(demo, r));
  const server = createServer({ start: demo });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
}, 60_000);

afterEach(() => {
  for (const r of REPOS) {
    const dir = join(demo, r);
    sh(dir, "checkout", "-q", "--", ".");
    sh(dir, "clean", "-fdq");
  }
});

describe("check_chains", () => {
  it("returns the same CheckReport as codeloom check --json", async () => {
    const r = await sc("check_chains");
    const { output } = await runCheck(demo, { json: true });
    expect(r).toEqual(JSON.parse(output));
    expect(r.summary.chains).toBe(7);
  });

  it("passes traces: true through: no trace source → a skipped traces section", async () => {
    const plain = await sc("check_chains");
    expect(plain.traces).toBeUndefined();
    expect(await sc("check_chains", { traces: true })).toEqual({ ...plain, traces: { skipped: "no trace source in codeloom.workspace.json" } });
  });
});

describe("impact_of_diff", () => {
  it("is empty on a clean workspace", async () => {
    expect(await sc("impact_of_diff")).toEqual({
      range: null, repos: [], chains: [], chainsTruncated: false, journeys: [], tables: [], queues: [], skippedRepos: [], notes: [],
      truncated: false,
    });
  });

  it("maps an edit inside the customers controller's store() body to its chain, journey and tables", async () => {
    editLine("api/app/controllers/customers_controller.ts", 11, "    return response.created({ ...customer });");
    const r = await sc("impact_of_diff");
    expect(r.range).toBeNull();
    expect(r.repos).toEqual([
      {
        id: "api",
        changedFiles: ["app/controllers/customers_controller.ts"],
        changedFilesTruncated: false,
        changedNodes: ["api::class:app/controllers/customers_controller.ts:CustomersController"],
        changedNodesTruncated: false,
      },
    ]);
    // show() is in the same class but untouched: its chain is not listed.
    expect(r.chains).toEqual([createId]);
    expect(r.journeys).toEqual([{ id: SIGNUP, name: "Sign up a customer" }]);
    expect(r.tables).toEqual(["audit_logs", "customers"]);
    expect(r.queues).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("lists an untracked file as changed, and a deleted file's chains", async () => {
    writeFileSync(join(demo, "web", "lib", "brand-new.ts"), "export const x = 1;\n");
    rmSync(join(demo, "web", "lib", "get-customer.ts"));
    const r = await sc("impact_of_diff");
    expect(r.repos).toEqual([
      {
        id: "web",
        changedFiles: ["lib/brand-new.ts", "lib/get-customer.ts"],
        changedFilesTruncated: false,
        changedNodes: expect.arrayContaining(["web::file:lib/get-customer.ts"]),
        changedNodesTruncated: false,
      },
    ]);
    expect(r.chains).toEqual([showId]);
    expect(r.journeys).toEqual([{ id: SHOW, name: "View a customer" }]);
    expect(r.tables).toEqual(["customers"]);
  });

  it("reports queues of affected chains", async () => {
    editLine("billing/src/notify-consumer.ts", 14, "    // touched");
    const r = await sc("impact_of_diff");
    expect(r.queues).toEqual(expect.arrayContaining(["emails"]));
    expect(r.tables).toEqual(expect.arrayContaining(["email_logs"]));
  });

  it("diffs a commit range in the repos that have it, skipping the others, and ignores the working tree", async () => {
    const api = join(demo, "api");
    const base = sh(api, "rev-parse", "HEAD");
    editLine("api/app/services/customer_service.ts", 12, "    return Customer.findOrFail(Number(id));");
    commitAll(api);
    const head = sh(api, "rev-parse", "HEAD");
    writeFileSync(join(demo, "web", "lib", "wip.ts"), "x\n");
    try {
      const r = await sc("impact_of_diff", { range: `${base}..${head}` });
      expect(r.range).toBe(`${base}..${head}`);
      expect(r.repos.map((x: { id: string }) => x.id)).toEqual(["api"]);
      expect(r.repos[0].changedFiles).toEqual(["app/services/customer_service.ts"]);
      expect(r.chains).toEqual([showId]);
      expect(r.skippedRepos.map((x: { id: string }) => x.id)).toEqual(["billing", "web"]);
      // The map was indexed one commit before `base` (the .codeloom commit).
      expect(r.notes).toEqual([
        `api: map indexed at ${indexed("api").slice(0, 7)}, not at ${base.slice(0, 7)}; line matches are approximate`,
      ]);
    } finally {
      sh(api, "reset", "-q", "--hard", base);
    }
  });

  it("returns a tool error for a range no repo can resolve, or an option-like range", async () => {
    for (const range of ["nope..HEAD", "--output=/tmp/x", "-p"]) {
      const r = await call("impact_of_diff", { range });
      expect(r.isError, range).toBe(true);
    }
  });

  it("matches in the map's line space: lines added above store() plus an edit in show() list only show", async () => {
    shiftAndEditShow();
    const r = await sc("impact_of_diff");
    expect(r.chains).toEqual([showId]);
    expect(r.journeys).toEqual([{ id: SHOW, name: "View a customer" }]);
    expect(r.notes).toEqual([]);
  });

  it("matches in the base's line space for a range too", async () => {
    const api = join(demo, "api");
    const base = sh(api, "rev-parse", "HEAD");
    shiftAndEditShow();
    commitAll(api);
    try {
      const r = await sc("impact_of_diff", { range: `${base}..HEAD` });
      expect(r.chains).toEqual([showId]);
    } finally {
      sh(api, "reset", "-q", "--hard", base);
    }
  });

  it("ignores changes under .codeloom/ (the map itself)", async () => {
    writeFileSync(join(demo, "api", ".codeloom", "scratch.json"), "{}\n");
    const r = await sc("impact_of_diff");
    expect(r.repos).toEqual([]);
    expect(r.chains).toEqual([]);
  });

  it("skips a repo that is not a git repo in working-tree mode", async () => {
    const web = join(demo, "web");
    renameSync(join(web, ".git"), join(web, ".git-off"));
    try {
      editLine("api/app/controllers/customers_controller.ts", 11, "    return response.created({ ...customer });");
      const r = await sc("impact_of_diff");
      expect(r.skippedRepos).toEqual([{ id: "web", reason: expect.stringMatching(/not a git repository/) }]);
      expect(r.chains).toEqual([createId]);
    } finally {
      renameSync(join(web, ".git-off"), join(web, ".git"));
    }
  });
});
