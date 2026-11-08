import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Commit `message` in `repo` after appending `line` to each of `files` (repo-relative). */
export function commitChange(repo: string, files: string[], message: string, line = "// changed"): void {
  for (const rel of files) writeFileSync(join(repo, rel), `${readFileSync(join(repo, rel), "utf8")}${line}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

/** Give a materialized demo-shop's `api` repo a short history with generic ticket keys (spec §1 tickets):
 * - `SHOP-12` (subject) and `SHOP-13` (body) on a commit touching CustomerService;
 * - a commit whose subject only has ignored keys (`UTF-8`, `CVE-2024-1234`);
 * - branch `feat/SHOP-14-show-customer` (its own commit has no key) merged into main with --no-ff, so
 *   `SHOP-14` is known only from the merge commit's branch name. */
export function commitTicketHistory(root: string): void {
  const api = join(root, "api");
  commitChange(api, ["app/services/customer_service.ts"], "SHOP-12 validate new customers\n\nAlso covers SHOP-13.");
  commitChange(api, ["app/services/customer_service.ts"], "Handle UTF-8 names (CVE-2024-1234)");
  git(api, "checkout", "-q", "-b", "feat/SHOP-14-show-customer");
  commitChange(api, ["app/controllers/customers_controller.ts"], "tweak the show handler");
  git(api, "checkout", "-q", "main");
  git(api, "merge", "-q", "--no-ff", "-m", "Merge branch 'feat/SHOP-14-show-customer'", "feat/SHOP-14-show-customer");
}

/** Copy fixtures/evals/<app> to a temp folder and git-init every repo its own codeloom.workspace.json lists
 * (unlike materializeFixture, which blindly git-inits every child folder — an eval app's root also holds
 * LICENSE/SOURCE.md/expected-journeys.json/codeloom.workspace.json, which are not repos). */
export function materializeEval(app: string): string {
  const src = fileURLToPath(new URL(`../../../fixtures/evals/${app}`, import.meta.url));
  const root = mkdtempSync(join(tmpdir(), `codeloom-eval-${app}-`));
  cpSync(src, root, { recursive: true });
  const ws = JSON.parse(readFileSync(join(root, "codeloom.workspace.json"), "utf8")) as { repos: Array<{ path: string }> };
  for (const repo of ws.repos) {
    const repoAbs = join(root, repo.path);
    git(repoAbs, "init", "-q", "-b", "main");
    commitAll(repoAbs);
  }
  return root;
}
