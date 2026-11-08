// v0.3 final review §1-2: the one path-safety check for repo files (/api/code, /api/docs, save_spec_links
// doc refs, match_specs snippets).
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hiddenSegments, safeRepoFile } from "../src/store/safe-file.js";

/** A demo-shop-like api repo (docs/customers.md) and a billing repo next to it. */
function repos(): { api: string; billing: string } {
  const root = mkdtempSync(join(tmpdir(), "codeloom-safe-"));
  const api = join(root, "api");
  const billing = join(root, "billing");
  mkdirSync(join(api, "docs"), { recursive: true });
  mkdirSync(join(api, ".git"), { recursive: true });
  mkdirSync(join(api, ".codeloom"), { recursive: true });
  mkdirSync(join(billing, "docs"), { recursive: true });
  writeFileSync(join(api, "docs", "customers.md"), "# Customers\n");
  writeFileSync(join(api, ".env"), "SECRET=1\n");
  writeFileSync(join(api, ".env.local"), "SECRET=2\n");
  writeFileSync(join(api, ".git", "config"), "[core]\n");
  writeFileSync(join(api, ".codeloom", "graph.json"), "{}");
  writeFileSync(join(billing, "docs", "invoices.md"), "# Invoices\n");
  return { api, billing };
}

describe("hiddenSegments", () => {
  it("compares lowercased: .git, .codeloom, .env and .env.* in any case are hidden", () => {
    for (const p of [".git/config", ".GIT/config", ".Git/HEAD", ".codeloom/graph.json", ".CODELOOM/graph.json", ".env", ".ENV", ".Env.local", "a/.env.production", "docs/.git"]) {
      expect(hiddenSegments(p.split("/")), p).toBe(true);
    }
    for (const p of ["docs/customers.md", ".github/workflows/ci.yml", ".envrc", "env/x", ".gitignore", "docs/codeloom.md"]) {
      expect(hiddenSegments(p.split("/")), p).toBe(false);
    }
  });
});

describe("safeRepoFile", () => {
  it("accepts a plain file inside the repo", () => {
    const { api } = repos();
    const r = safeRepoFile(api, "docs/customers.md");
    expect(r).toMatchObject({ ok: true, size: "# Customers\n".length });
    if (r.ok) expect(r.real).toBe(realpathSync(join(api, "docs", "customers.md")));
  });

  it("refuses absolute, .., NUL, git, env and .codeloom paths", () => {
    const { api } = repos();
    const cases: Array<[string, string]> = [
      ["/etc/hosts", "outside"],
      ["\\etc\\hosts", "outside"],
      ["C:/Windows/win.ini", "outside"],
      ["../billing/docs/invoices.md", "outside"],
      ["docs/../.git/config", "hidden"],
      ["docs/a\0b", "outside"],
      ["", "outside"],
      [".env", "hidden"],
      [".env.local", "hidden"],
      [".git/config", "hidden"],
      [".codeloom/graph.json", "hidden"],
      [".ENV", "hidden"],
      [".Env.local", "hidden"],
      [".GIT/config", "hidden"],
      [".CODELOOM/graph.json", "hidden"],
      ["docs/ghost.md", "missing"],
      ["docs", "not-file"],
    ];
    for (const [p, reason] of cases) expect(safeRepoFile(api, p), JSON.stringify(p)).toEqual({ ok: false, reason });
  });

  it("refuses a symlink to /etc/hosts, a symlinked folder into another repo and a symlink to .env or .git", () => {
    const { api, billing } = repos();
    symlinkSync("/etc/hosts", join(api, "docs", "hosts.md"));
    symlinkSync(join(billing, "docs"), join(api, "docs", "billing"));
    symlinkSync(join(api, ".env"), join(api, "docs", "env.md"));
    symlinkSync(join(api, ".git"), join(api, "docs", "gitdir"));
    expect(safeRepoFile(api, "docs/hosts.md")).toEqual({ ok: false, reason: "outside" });
    expect(safeRepoFile(api, "docs/billing/invoices.md")).toEqual({ ok: false, reason: "outside" });
    expect(safeRepoFile(api, "docs/env.md")).toEqual({ ok: false, reason: "hidden" });
    expect(safeRepoFile(api, "docs/gitdir/config")).toEqual({ ok: false, reason: "hidden" });
  });
});
