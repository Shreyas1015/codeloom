import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../analyzer/graph-builder.js";

// A function or class named like an Object.prototype member (valueOf, toString, constructor, …) must
// not pick up that built-in as its summary: JSON.stringify drops a function value, and the written
// graph.json then fails codeloom's own schema check (summary must be a string).
describe("GraphBuilder with names that are Object.prototype members", () => {
  it("gives functions and classes named valueOf / toString / constructor an empty string summary", () => {
    const builder = new GraphBuilder("demo", "abc123");
    builder.addFileWithAnalysis(
      "src/state.ts",
      {
        functions: [
          { name: "valueOf", lineRange: [1, 1], params: [] },
          { name: "toString", lineRange: [2, 2], params: [] },
          { name: "hasOwnProperty", lineRange: [3, 3], params: [] },
        ],
        classes: [{ name: "constructor", lineRange: [4, 6], methods: [], properties: [] }],
        imports: [],
        exports: [],
      },
      { summary: "", fileSummary: "", summaries: {}, tags: [], complexity: "simple" },
    );
    const graph = JSON.parse(JSON.stringify(builder.build())) as { nodes: Array<{ name: string; summary: unknown }> };
    for (const name of ["valueOf", "toString", "hasOwnProperty", "constructor"]) {
      expect(graph.nodes.find((n) => n.name === name)?.summary, name).toBe("");
    }
  });

  it("still uses a real summary given for such a name", () => {
    const builder = new GraphBuilder("demo", "abc123");
    builder.addFileWithAnalysis(
      "src/state.ts",
      { functions: [{ name: "valueOf", lineRange: [1, 1], params: [] }], classes: [], imports: [], exports: [] },
      { summary: "", fileSummary: "", summaries: { valueOf: "Returns the state's number." }, tags: [], complexity: "simple" },
    );
    expect(builder.build().nodes.find((n) => n.name === "valueOf")?.summary).toBe("Returns the state's number.");
  });
});
