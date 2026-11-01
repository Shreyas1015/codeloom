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

  it("uses the nearest package's own `paths` in a monorepo, not a sibling's", () => {
    // Documents behaviour that already fell out of nearestConfigDir scoping both `paths` and
    // `baseUrl` (see h4-report.md review notes) but was never asserted directly for `paths`.
    const repo = makeRepo({
      "api/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
      "ui/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./other-src/*"] } } }`,
      "api/src/thing.ts": "",
      "ui/other-src/thing.ts": "",
      "api/src/x.ts": "",
      "ui/other-src/y.ts": "",
    });
    const files = new Set(["api/src/thing.ts", "ui/other-src/thing.ts", "api/src/x.ts", "ui/other-src/y.ts"]);
    const aliases = loadAliases(repo, ["api/tsconfig.json", "ui/tsconfig.json", ...files]);
    expect(resolveImport("api/src/x.ts", "@/thing", files, aliases)).toBe("api/src/thing.ts");
    expect(resolveImport("ui/other-src/y.ts", "@/thing", files, aliases)).toBe("ui/other-src/thing.ts");
  });

  it('lets a local folder shadow a same-named package when baseUrl is "." (matches tsc\'s own resolution order)', () => {
    // Deliberate: baseUrl "." makes the whole repo root a resolution root for bare specifiers, same
    // as tsc. A local `express/` folder therefore resolves before the real npm package would. This
    // is not a bug to special-case — it is exactly what `tsc` itself does.
    const repo = makeRepo({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": "." } }`,
      "express/index.ts": "",
      "src/app.ts": "",
    });
    const files = new Set(["express/index.ts", "src/app.ts"]);
    const aliases = loadAliases(repo, ["tsconfig.json", ...files]);
    expect(resolveImport("src/app.ts", "express", files, aliases)).toBe("express/index.ts");
  });

  it("follows a relative tsconfig `extends` and inherits baseUrl from the base config", () => {
    const repo = makeRepo({
      "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": "./src" } }`,
      "tsconfig.json": `{ "extends": "./tsconfig.base.json" }`,
      "src/user/user.entity.ts": "",
      "src/app.module.ts": "",
    });
    const files = new Set(["src/user/user.entity.ts", "src/app.module.ts"]);
    const aliases = loadAliases(repo, ["tsconfig.base.json", "tsconfig.json", ...files]);
    expect(resolveImport("src/app.module.ts", "user/user.entity", files, aliases)).toBe("src/user/user.entity.ts");
  });

  it("follows a multi-level `extends` chain, skipping an intermediate config that declares nothing itself", () => {
    const repo = makeRepo({
      "pkg/tsconfig.root.json": `{ "compilerOptions": { "baseUrl": "./root-src" } }`,
      "pkg/tsconfig.mid.json": `{ "extends": "./tsconfig.root.json" }`,
      "pkg/tsconfig.json": `{ "extends": "./tsconfig.mid.json" }`,
      "pkg/root-src/shared.ts": "",
      "pkg/x.ts": "",
    });
    const files = new Set(["pkg/root-src/shared.ts", "pkg/x.ts"]);
    const aliases = loadAliases(repo, ["pkg/tsconfig.root.json", "pkg/tsconfig.mid.json", "pkg/tsconfig.json", ...files]);
    expect(resolveImport("pkg/x.ts", "shared", files, aliases)).toBe("pkg/root-src/shared.ts");
  });

  it("uses the child's own baseUrl/paths instead of the extended base's when the child declares its own", () => {
    const repo = makeRepo({
      "pkg/tsconfig.base.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./base-src/*"] } } }`,
      "pkg/tsconfig.json": `{ "extends": "./tsconfig.base.json", "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }`,
      "pkg/base-src/thing.ts": "",
      "pkg/src/thing.ts": "",
      "pkg/x.ts": "",
    });
    const files = new Set(["pkg/base-src/thing.ts", "pkg/src/thing.ts", "pkg/x.ts"]);
    const aliases = loadAliases(repo, ["pkg/tsconfig.base.json", "pkg/tsconfig.json", ...files]);
    expect(resolveImport("pkg/x.ts", "@/thing", files, aliases)).toBe("pkg/src/thing.ts");
  });

  it("stops following a circular `extends` without throwing or looping forever", () => {
    const repo = makeRepo({
      "tsconfig.json": `{ "extends": "./tsconfig.b.json", "compilerOptions": { "baseUrl": "./a-src" } }`,
      "tsconfig.b.json": `{ "extends": "./tsconfig.json" }`,
      "a-src/thing.ts": "",
      "x.ts": "",
    });
    const files = new Set(["a-src/thing.ts", "x.ts"]);
    expect(() => loadAliases(repo, ["tsconfig.json", "tsconfig.b.json", ...files])).not.toThrow();
    const aliases = loadAliases(repo, ["tsconfig.json", "tsconfig.b.json", ...files]);
    expect(resolveImport("x.ts", "thing", files, aliases)).toBe("a-src/thing.ts");
  });

  it("stops following `extends` after 5 levels", () => {
    const repo = makeRepo({
      "tsconfig.json": `{ "extends": "./tsconfig.1.json" }`,
      "tsconfig.1.json": `{ "extends": "./tsconfig.2.json" }`,
      "tsconfig.2.json": `{ "extends": "./tsconfig.3.json" }`,
      "tsconfig.3.json": `{ "extends": "./tsconfig.4.json" }`,
      "tsconfig.4.json": `{ "extends": "./tsconfig.5.json" }`,
      "tsconfig.5.json": `{ "compilerOptions": { "baseUrl": "./src" } }`,
      "src/thing.ts": "",
      "x.ts": "",
    });
    const files = new Set(["src/thing.ts", "x.ts"]);
    const aliases = loadAliases(repo, [
      "tsconfig.json",
      "tsconfig.1.json",
      "tsconfig.2.json",
      "tsconfig.3.json",
      "tsconfig.4.json",
      "tsconfig.5.json",
      ...files,
    ]);
    // tsconfig.json -> .1 -> .2 -> .3 -> .4 is 5 configs; tsconfig.5.json (the 6th, holding baseUrl)
    // is never reached, so the bare specifier stays unresolved.
    expect(resolveImport("x.ts", "thing", files, aliases)).toBeNull();
  });

  it("ignores a package-name `extends` (not a relative path) and still uses the config's own compilerOptions", () => {
    const repo = makeRepo({
      "tsconfig.json": `{ "extends": "@tsconfig/node20/tsconfig.json", "compilerOptions": { "baseUrl": "./src" } }`,
      "src/thing.ts": "",
      "x.ts": "",
    });
    const files = new Set(["src/thing.ts", "x.ts"]);
    const aliases = loadAliases(repo, ["tsconfig.json", ...files]);
    expect(resolveImport("x.ts", "thing", files, aliases)).toBe("src/thing.ts");
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
