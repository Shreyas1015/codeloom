import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  });

export function commitAll(dir: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "update");
}

/** Create a git repo with the given files committed. Returns its absolute path. */
export function makeRepo(files: Record<string, string>, dir = mkdtempSync(join(tmpdir(), "codeloom-repo-"))): string {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir);
  return dir;
}

/** Copy fixtures/<name> to a temp folder and turn each child folder into a git repo. */
export function materializeFixture(name: string): string {
  const src = fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
  const root = mkdtempSync(join(tmpdir(), `codeloom-${name}-`));
  cpSync(src, root, { recursive: true });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repo = join(root, entry.name);
    git(repo, "init", "-q", "-b", "main");
    commitAll(repo);
  }
  return root;
}
