import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { loadMapState, type MapState } from "../src/mcp/state.js";
import { markSeen, progressPath, readProgress } from "../src/store/progress.js";
import { materializeFixture } from "./helpers.js";

// Progress is read-modify-written by the MCP server and the dashboard server at once: a lock keeps every
// write, and a write that changes nothing is skipped (spec §2, v0.2b final review).

const SIGNUP = "j_00000000c0de";
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const JITI = fileURLToPath(new URL("../node_modules/.bin/jiti", import.meta.url));

let demo: string;
let state: MapState;

beforeEach(() => {
  process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));
});

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string }>;
  const createId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({ version: 1, journeys: [{ id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" }] }),
  );
  state = loadMapState(demo);
}, 120_000);

/** A child process that records `n` failed checks on SIGNUP and marks `n` distinct journeys seen, interleaved. */
function hammer(tag: string, n: number): Promise<void> {
  const script = join(mkdtempSync(join(tmpdir(), "codeloom-hammer-")), "hammer.ts");
  writeFileSync(
    script,
    `import { loadMapState } from ${JSON.stringify(join(SRC, "mcp/state.ts"))};
import { markSeen, recordCheck } from ${JSON.stringify(join(SRC, "store/progress.ts"))};
const state = loadMapState(${JSON.stringify(demo)});
for (let i = 0; i < ${n}; i++) {
  recordCheck(state, ${JSON.stringify(SIGNUP)}, { questions: ["q"], answers: ["${tag}" + i], verdict: "fail", notes: "" });
  markSeen(state.ws, "j_" + ${JSON.stringify(tag)} + String(i).padStart(10, "0"));
}
`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(JITI, [script], { env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`hammer ${tag} exited ${code}: ${err}`))));
  });
}

describe("progress writes", () => {
  it("two processes recording checks and marking seen at once lose no write", async () => {
    const n = 15;
    await Promise.all([hammer("aa", n), hammer("bb", n)]);
    const file = readProgress(state.ws);
    expect(file.journeys[SIGNUP]!.checks).toHaveLength(2 * n);
    const answers = file.journeys[SIGNUP]!.checks.map((c) => c.answers[0]);
    for (const tag of ["aa", "bb"]) for (let i = 0; i < n; i++) expect(answers).toContain(`${tag}${i}`);
    const seen = Object.keys(file.journeys).filter((id) => id !== SIGNUP);
    expect(seen).toHaveLength(2 * n);
    expect(existsSync(`${progressPath(state.ws)}.lock`)).toBe(false);
  }, 120_000);

  it("markSeen on an already-seen journey writes nothing", () => {
    markSeen(state.ws, SIGNUP);
    const path = progressPath(state.ws);
    const before = statSync(path);
    const text = readFileSync(path, "utf8");
    markSeen(state.ws, SIGNUP, { now: new Date("2030-01-01T00:00:00.000Z") });
    const after = statSync(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("clears a stale lock (older than 30 s) and writes", () => {
    const path = progressPath(state.ws);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.lock`, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    markSeen(state.ws, SIGNUP);
    expect(readProgress(state.ws).journeys[SIGNUP]!.seenAt).toBeDefined();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("waits for a held lock, then gives up with a clear error and writes nothing", () => {
    const path = progressPath(state.ws);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.lock`, "99999");
    const t0 = Date.now();
    let err: unknown;
    try {
      markSeen(state.ws, SIGNUP);
    } catch (e) {
      err = e;
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_000);
    expect(err).toBeInstanceOf(CodeloomError);
    expect((err as Error).message).toContain(`${path}.lock`);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(true);
  }, 20_000);
});

describe("progress path", () => {
  it("refuses a CODELOOM_HOME that is a symlink into the workspace", () => {
    const link = join(mkdtempSync(join(tmpdir(), "codeloom-link-")), "home");
    symlinkSync(join(demo, "api"), link);
    process.env.CODELOOM_HOME = link;
    expect(() => progressPath(state.ws)).toThrow(/inside the workspace/);
  });

  it("refuses a CODELOOM_HOME inside a repo folder that sits outside the workspace root", () => {
    const outerRepo = mkdtempSync(join(tmpdir(), "codeloom-outer-repo-"));
    const ws = { root: mkdtempSync(join(tmpdir(), "codeloom-ws-")), name: "x", repos: [{ ref: { id: "outer" }, abs: outerRepo }] };
    process.env.CODELOOM_HOME = join(outerRepo, ".codeloom-home");
    expect(() => progressPath(ws)).toThrow(/inside repo "outer"/);
  });
});
