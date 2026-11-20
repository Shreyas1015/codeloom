import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { loadMapState } from "../src/mcp/state.js";
import { saveJourneys } from "../src/store/journeys-edit.js";
import { shopRepo } from "./shop-group-fixture.js";
import { freshHome } from "./helpers.js";

// 0.6 Task E: index the web repo alone, name its journeys while its page chains are still broken (no api yet), then
// index the api. The page chains now link to the api's routes and get new ids; the journeys named before follow
// them (the broken chain's id is an alias of the linked one) — nothing is orphaned.

describe("journeys named on a broken page chain survive once it links", () => {
  it("index web, name journeys, index api: 0 orphaned", async () => {
    freshHome();
    const parent = mkdtempSync(join(tmpdir(), "codeloom-broken-page-"));
    const web = shopRepo("web", parent);
    const api = shopRepo("api", parent);
    await runIndex(web);
    const state = loadMapState(web);
    const pages = state.chains.filter((c) => c.entry.startsWith("page:"));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((c) => c.routeKey === "")).toBe(true);
    saveJourneys(state, pages.map((c) => ({ op: "create" as const, name: `Visit ${c.entry}`, chainIds: [c.id] })));

    const r = await runIndex(api);
    expect(r.linker.orphanedJourneys).toBe(0);
    const after = loadMapState(api);
    expect(after.journeys.every((j) => j.status === "ok")).toBe(true);
    expect(after.chains.some((c) => c.entry.startsWith("page:demo-web:") && c.routeKey !== "")).toBe(true);
  }, 300_000);
});
