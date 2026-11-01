import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeStructure, type FileEntry, getPlugin, isSourceFile } from "../src/indexer/structure.js";
import { loadAliases, resolveImport } from "../src/indexer/resolve-imports.js";
import { buildGraph } from "../src/indexer/build-graph.js";
import { makeRepo } from "./helpers.js";

describe("resolveImport", () => {
  it("resolves relative, .js-suffixed, index, package imports and tsconfig paths", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ imports: { "#services/*": "./app/services/*.js" } }),
      "tsconfig.json": `{ // comments are allowed\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }`,
      "app/services/customer_service.ts": "",
      "app/controllers/c.ts": "",
      "src/lib/api.ts": "",
      "src/lib/util/index.ts": "",
    });
    const files = new Set(["app/services/customer_service.ts", "app/controllers/c.ts", "src/lib/api.ts", "src/lib/util/index.ts"]);
    const aliases = loadAliases(repo, ["package.json", "tsconfig.json", ...files]);
    expect(resolveImport("app/controllers/c.ts", "#services/customer_service", files, aliases)).toBe("app/services/customer_service.ts");
    expect(resolveImport("app/controllers/c.ts", "../services/customer_service.js", files, aliases)).toBe("app/services/customer_service.ts");
    expect(resolveImport("app/x.ts", "@/lib/api", files, aliases)).toBe("src/lib/api.ts");
    expect(resolveImport("src/lib/api.ts", "./util", files, aliases)).toBe("src/lib/util/index.ts");
    expect(resolveImport("src/lib/api.ts", "react", files, aliases)).toBeNull();
  });

  it("resolves bare imports through tsconfig baseUrl (realworld-nest shape: baseUrl: \"./src\")", () => {
    const repo = makeRepo({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": "./src" } }`,
      "src/user/user.entity.ts": "",
      "src/app.module.ts": "",
    });
    const files = new Set(["src/user/user.entity.ts", "src/app.module.ts"]);
    const aliases = loadAliases(repo, ["tsconfig.json", ...files]);
    expect(resolveImport("src/app.module.ts", "user/user.entity", files, aliases)).toBe("src/user/user.entity.ts");
    // a package with no matching file under baseUrl stays unresolved
    expect(resolveImport("src/app.module.ts", "express", files, aliases)).toBeNull();
  });

  it("prefers tsconfig paths over baseUrl when both could resolve the same bare specifier", () => {
    const repo = makeRepo({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": "./src", "paths": { "user/*": ["./other/*"] } } }`,
      "src/user/user.entity.ts": "",
      "src/other/user.entity.ts": "",
      "src/app.module.ts": "",
    });
    const files = new Set(["src/user/user.entity.ts", "src/other/user.entity.ts", "src/app.module.ts"]);
    const aliases = loadAliases(repo, ["tsconfig.json", ...files]);
    // both "src/user/user.entity.ts" (via baseUrl) and "src/other/user.entity.ts" (via paths) exist;
    // paths must win.
    expect(resolveImport("src/app.module.ts", "user/user.entity", files, aliases)).toBe("src/other/user.entity.ts");
  });

  it("uses the tsconfig nearest the importing file in a monorepo, not a sibling app's", () => {
    const repo = makeRepo({
      "api/tsconfig.json": `{ "compilerOptions": { "baseUrl": "./src" } }`,
      "ui/tsconfig.json": `{ "compilerOptions": { "baseUrl": "./src" } }`,
      "api/src/shared/thing.ts": "",
      "ui/src/shared/thing.ts": "",
      "api/src/x.ts": "",
    });
    const files = new Set(["api/src/shared/thing.ts", "ui/src/shared/thing.ts", "api/src/x.ts"]);
    const aliases = loadAliases(repo, ["api/tsconfig.json", "ui/tsconfig.json", ...files]);
    expect(resolveImport("api/src/x.ts", "shared/thing", files, aliases)).toBe("api/src/shared/thing.ts");
  });
});

describe("buildGraph", () => {
  it("builds file, function, import and call nodes with layers", async () => {
    const repo = makeRepo({
      "src/api.ts": `export function post(url: string) { return url; }`,
      "src/use-create.ts": `import { post } from "./api";\nexport function useCreate() { return post("/x"); }`,
      "README.md": "# demo",
    });
    const plugin = await getPlugin();
    const entries = new Map<string, FileEntry>();
    for (const rel of ["README.md", "src/api.ts", "src/use-create.ts"]) {
      expect(isSourceFile(rel)).toBe(true);
      entries.set(rel, analyzeStructure(plugin, rel, readFileSync(join(repo, rel), "utf8")));
    }
    const graph = buildGraph("demo", "abc123", entries, []);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["file:src/api.ts", "function:src/api.ts:post", "function:src/use-create.ts:useCreate"]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "imports", source: "file:src/use-create.ts", target: "file:src/api.ts" }),
      expect.objectContaining({ type: "calls", source: "function:src/use-create.ts:useCreate", target: "function:src/api.ts:post" }),
    ]));
    expect(graph.project.gitCommitHash).toBe("abc123");
    expect(Array.isArray(graph.layers)).toBe(true);
  });
});
