import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram, VERSION } from "../src/cli.js";
import { CATALOGUE } from "./mcp-catalogue.js";

// The README is the user's contract: every command, flag, MCP tool and prompt it names must exist, and
// every one that exists must be named. packages/cli/README.md (the npm page) is generated from the root
// README with relative links made absolute; run `CODELOOM_UPDATE_DOCS=1 pnpm --filter codeloom test docs`
// to rewrite it after editing the root README.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliDir = join(repoRoot, "packages/cli");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

const program = buildProgram();
const commands = new Map(program.commands.map((c) => [c.name(), c]));
const optionsOf = (name: string): string[] => commands.get(name)!.options.map((o) => o.long!).filter(Boolean);
const GLOBAL_FLAGS = ["--help", "--version"];

/** The code on each README line: the whole line inside a fenced block (minus a trailing `# comment`),
 * else its `inline code` spans. */
function codeLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    out.push(fenced ? line.replace(/\s#.*$/, "") : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).join(" "));
  }
  return out;
}

/** `codeloom <word>` mentions in code (prose like "codeloom never..." is not a command), per line. */
function commandMentions(text: string): Array<{ line: string; cmd: string }> {
  const out: Array<{ line: string; cmd: string }> = [];
  for (const line of codeLines(text)) {
    for (const m of line.matchAll(/\bcodeloom ([a-z][a-z-]*)/g)) out.push({ line, cmd: m[1]! });
  }
  return out;
}

const flagsIn = (text: string): string[] =>
  [...new Set(codeLines(text).flatMap((l) => [...l.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0])))];

/** The npm page: the root README with repo-relative links pointing at GitHub. */
function npmReadme(root: string): string {
  const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { repository: { url: string } };
  const base = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const body = root.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, path: string) => `](${base}/blob/main/${path})`);
  return `<!-- Generated from the repo's README.md by packages/cli/test/docs.test.ts. Do not edit by hand. -->\n\n${body}`;
}

describe("README matches the code", () => {
  it("every `codeloom <command>` in the README is a real command", () => {
    const mentioned = new Set(commandMentions(readme).map((m) => m.cmd));
    for (const cmd of mentioned) expect([...commands.keys()], `codeloom ${cmd}`).toContain(cmd);
  });

  it("every command is documented", () => {
    const mentioned = new Set(commandMentions(readme).map((m) => m.cmd));
    for (const cmd of commands.keys()) expect([...mentioned], `codeloom ${cmd} is missing from the README`).toContain(cmd);
  });

  it("a flag on a line that names one command belongs to that command", () => {
    for (const { line, cmd } of commandMentions(readme)) {
      const cmds = new Set([...line.matchAll(/\bcodeloom ([a-z][a-z-]*)/g)].map((m) => m[1]!));
      if (cmds.size !== 1) continue;
      for (const flag of new Set([...line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]))) expect([...optionsOf(cmd), ...GLOBAL_FLAGS], `${flag} on: ${line}`).toContain(flag);
    }
  });

  it("every flag in the README exists, and every flag is documented", () => {
    const all = new Set([...commands.keys()].flatMap(optionsOf));
    const inReadme = flagsIn(readme);
    for (const flag of inReadme) expect([...all, ...GLOBAL_FLAGS], flag).toContain(flag);
    for (const flag of all) expect(inReadme, `${flag} is missing from the README`).toContain(flag);
  });

  it("the MCP tool table lists exactly the tool catalogue", () => {
    const tools = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect([...tools].sort()).toEqual([...CATALOGUE].sort());
  });

  it("the prompt table lists exactly the registered prompts", () => {
    const src = readFileSync(join(cliDir, "src/mcp/prompts.ts"), "utf8");
    const registered = [...src.matchAll(/registerPrompt\(\s*"([a-z-]+)"/g)].map((m) => m[1]!).sort();
    const documented = [...readme.matchAll(/^\| `([a-z]+-[a-z-]+)` \|/gm)].map((m) => m[1]!).sort();
    expect(registered.length).toBeGreaterThan(0);
    expect(documented).toEqual(registered);
  });

  it("every relative link points at a file in the repo", () => {
    const links = [...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)].map((m) => m[1]!);
    expect(links).toContain("docs/dashboard.md");
    for (const link of links) expect(existsSync(join(repoRoot, link)), link).toBe(true);
  });

  it("CHANGELOG.md has an entry for the package version", () => {
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(new RegExp(`^## ${VERSION.replace(/\./g, "\\.")}\\b`, "m"));
  });

  it("packages/cli/README.md (the npm page) is generated from the root README", () => {
    const path = join(cliDir, "README.md");
    const want = npmReadme(readme);
    if (process.env.CODELOOM_UPDATE_DOCS === "1") writeFileSync(path, want);
    const have = existsSync(path) ? readFileSync(path, "utf8") : "";
    expect(have, 'packages/cli/README.md is out of date: run "CODELOOM_UPDATE_DOCS=1 pnpm --filter codeloom test docs"').toBe(want);
    expect(want).not.toMatch(/\]\((?!https?:|#|mailto:)/);
  });
});
