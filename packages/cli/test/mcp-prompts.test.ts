import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

async function connect(): Promise<Client> {
  // Prompts are static text templates: they never touch the map, so any folder works as `start`.
  const server = createServer({ start: process.cwd() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function text(r: GetPromptResult): string {
  const item = r.messages[0]!.content;
  if (item.type !== "text") throw new Error("expected a text item");
  return item.text;
}

describe("mcp prompts", () => {
  it("lists name-journeys (no args) and verify-journey (required journey arg)", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const byName = Object.fromEntries(prompts.map((p) => [p.name, p]));

    expect(byName["name-journeys"]).toBeDefined();
    expect(byName["name-journeys"]!.arguments).toBeUndefined();

    expect(byName["verify-journey"]).toBeDefined();
    expect(byName["verify-journey"]!.arguments).toEqual([{ name: "journey", description: expect.any(String), required: true }]);
  });

  it("name-journeys tells the agent to page list_chains, group, name, and save", async () => {
    const client = await connect();
    const r = (await client.getPrompt({ name: "name-journeys" })) as GetPromptResult;
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.role).toBe("user");
    const t = text(r);
    expect(t).toContain("list_chains");
    expect(t).toContain("unnamed");
    expect(t).toContain("offset");
    expect(t).toContain("save_journeys");
    expect(t).toContain("create");
    expect(t).toContain("area");
    expect(t).toContain("chainIds");
    expect(t).toMatch(/never invent chain ids/i);
    expect(t).toMatch(/leave/i);
    // list_chains rows are compact by default: the prompt asks for stops explicitly (H5)
    expect(t).toContain("detail: true");
    expect(t).toMatch(/truncatedNote/);
  });

  it("verify-journey names get_journey and explain_context, includes the given id, and never changes confidence", async () => {
    const client = await connect();
    const r = (await client.getPrompt({ name: "verify-journey", arguments: { journey: "j_0000000000aa" } })) as GetPromptResult;
    expect(r.messages).toHaveLength(1);
    const t = text(r);
    expect(t).toContain("get_journey");
    expect(t).toContain("explain_context");
    expect(t).toContain("j_0000000000aa");
    expect(t).toMatch(/agrees/);
    expect(t).toMatch(/doubtful/);
    expect(t).toMatch(/never change[^.]*confidence/i);
    expect(t).toContain("save_journeys");
    expect(t).toContain("update");
    expect(t).toContain("note");
    // A chain id has no journey of its own, and stops without a graph ref still get read.
    expect(t).toMatch(/chain id\s+\(ch_…\)[^.]*`chains\[0\]\.journeys`/);
    expect(t).toMatch(/list is empty[^.]*nothing\s+to save — just report/);
    expect(t).toMatch(/without a `ref`[^.]*`file`/);
    // a journey too big for one response: verify it one chain at a time (H5)
    expect(t).toMatch(/`truncated`[^.]*get_journey[^.]*chain id/);
  });

  it("verify-journey without the journey arg errors", async () => {
    const client = await connect();
    await expect(client.getPrompt({ name: "verify-journey", arguments: {} })).rejects.toThrow();
  });
});
