import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram, exitCodeFor } from "../src/cli.js";
import { formatViewsList, runViewsReset } from "../src/commands/views.js";
import { CodeloomError } from "../src/errors.js";
import { saveView, viewPath } from "../src/store/views.js";
import { makeRepo } from "./helpers.js";

function shop(): string {
  const root = makeRepo({ "package.json": '{"name":"shop-api"}', "src/app.ts": "export const x = 1;\n" });
  writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "shop", repos: [{ id: "shop-api", path: "." }], links: [] }));
  return root;
}

describe("codeloom views", () => {
  it("registers views list and views reset <id>", () => {
    const views = buildProgram().commands.find((c) => c.name() === "views")!;
    expect(views).toBeDefined();
    expect(views.commands.map((c) => c.name()).sort()).toEqual(["list", "reset"]);
  });

  it("list: no views, then one line per view, broken ones with their error", () => {
    const root = shop();
    expect(formatViewsList(root)).toBe('No views yet. Ask your agent for one with the make-view prompt.');
    saveView(root, { id: "no-spec-audit", title: "No-spec audit", widgets: [{ type: "counts" }, { type: "note", markdown: "hi" }] });
    saveView(root, { id: "home", title: "Team home", widgets: [{ type: "counts" }] });
    mkdirSync(join(root, ".codeloom", "views"), { recursive: true });
    writeFileSync(viewPath(root, "broken"), "{}");
    const out = formatViewsList(root);
    expect(out.split("\n")).toEqual([
      expect.stringMatching(/^broken\s+broken: .*unexpected shape/),
      expect.stringMatching(/^home\s+Team home \(1 widget\)\s+\/ \(replaces the built-in Home\)$/),
      expect.stringMatching(/^no-spec-audit\s+No-spec audit \(2 widgets\)\s+\/views\/no-spec-audit$/),
    ]);
  });

  it("reset deletes a view; for home it brings back the built-in Home", () => {
    const root = shop();
    saveView(root, { id: "audit", title: "Audit", widgets: [{ type: "counts" }] });
    expect(runViewsReset(root, "audit")).toMatch(/Deleted view "audit"/);
    expect(existsSync(viewPath(root, "audit"))).toBe(false);
    expect(() => runViewsReset(root, "audit")).toThrow(CodeloomError);
    saveView(root, { id: "home", title: "Home", widgets: [{ type: "counts" }] });
    expect(runViewsReset(root, "home")).toMatch(/built-in Home/);
    expect(existsSync(viewPath(root, "home"))).toBe(false);
    // home with no file is already the built-in one: not an error
    expect(runViewsReset(root, "home")).toMatch(/already/);
    try {
      runViewsReset(root, "Bad Id");
      expect.unreachable();
    } catch (err) {
      expect(exitCodeFor(err)).toBe(2);
    }
  });
});
