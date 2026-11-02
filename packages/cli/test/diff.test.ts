import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { changedLines, changedLinesAtBase, isGitRepo, resolveRange } from "../src/workspace/diff.js";
import { commitAll, makeRepo } from "./helpers.js";

const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";
const sha = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.com", ...args], { cwd: dir, stdio: "pipe" });

function edit(dir: string, rel: string, change: (rows: string[]) => string[]): void {
  const rows = lines(10).trimEnd().split("\n");
  writeFileSync(join(dir, rel), change(rows).join("\n") + "\n");
}

describe("changedLines", () => {
  it("is empty on a clean tree", () => {
    const dir = makeRepo({ "a.ts": lines(10) });
    expect(changedLines(dir)).toEqual([]);
  });

  it("maps hunk headers to new-file line ranges (staged + unstaged), deletions to the line after", () => {
    const dir = makeRepo({ "a.ts": lines(10), "b.ts": lines(10), "c.ts": lines(10) });
    edit(dir, "a.ts", (r) => r.map((x, i) => (i === 2 || i === 3 ? `${x} changed` : x))); // lines 3-4
    edit(dir, "b.ts", (r) => r.filter((_, i) => i !== 4)); // delete line 5
    gitIn(dir, "add", "b.ts"); // staged
    edit(dir, "c.ts", (r) => [...r.slice(0, 7), "new", ...r.slice(7)]); // insert at 8
    expect(changedLines(dir)).toEqual([
      { file: "a.ts", lines: [[3, 4]] },
      { file: "b.ts", lines: [[4, 4]] },
      { file: "c.ts", lines: [[8, 8]] },
    ]);
  });

  it("never reads hunk content that looks like a ---/+++ header as a file name", () => {
    const dir = makeRepo({ "a.sql": "-- comment\nselect 1;\n" });
    writeFileSync(join(dir, "a.sql"), "++ other\nselect 1;\n");
    expect(changedLines(dir)).toEqual([{ file: "a.sql", lines: [[1, 1]] }]);
  });

  it("lists untracked, added and deleted files as all", () => {
    const dir = makeRepo({ "a.ts": lines(3), "gone.ts": lines(3), ".gitignore": "ignored.ts\n" });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "new.ts"), "x\n");
    writeFileSync(join(dir, "ignored.ts"), "x\n");
    writeFileSync(join(dir, "staged.ts"), "x\n");
    gitIn(dir, "add", "staged.ts");
    rmSync(join(dir, "gone.ts"));
    expect(changedLines(dir)).toEqual([
      { file: "gone.ts", lines: "all" },
      { file: "src/new.ts", lines: "all" },
      { file: "staged.ts", lines: "all" },
    ]);
  });

  it("does not C-quote non-ASCII or spaced names", () => {
    const dir = makeRepo({ "café menu.ts": lines(3), "tab\there.ts": lines(3) });
    writeFileSync(join(dir, "café menu.ts"), "changed\n" + lines(3).split("\n").slice(1).join("\n"));
    writeFileSync(join(dir, "tab\there.ts"), "changed\n" + lines(3).split("\n").slice(1).join("\n"));
    writeFileSync(join(dir, "naïve.ts"), "x\n");
    expect(changedLines(dir)).toEqual([
      { file: "café menu.ts", lines: [[1, 1]] },
      { file: "naïve.ts", lines: "all" },
      { file: "tab\there.ts", lines: [[1, 1]] },
    ]);
  });

  it("lists both the old and the new path of a rename as all (staged or committed)", () => {
    const dir = makeRepo({ "old.ts": lines(20) });
    const base = sha(dir);
    gitIn(dir, "mv", "old.ts", "renamed.ts");
    const both = [
      { file: "old.ts", lines: "all" },
      { file: "renamed.ts", lines: "all" },
    ];
    expect(changedLines(dir)).toEqual(both);
    commitAll(dir);
    expect(changedLines(dir, base)).toEqual(both);
    expect(changedLinesAtBase(dir, base)).toEqual(both);
  });

  it("reads a quoted name that holds a tab and a space (git adds a trailing TAB after the quote)", () => {
    const dir = makeRepo({ "t\tab b.ts": lines(3) });
    writeFileSync(join(dir, "t\tab b.ts"), "changed\n" + lines(3).split("\n").slice(1).join("\n"));
    expect(changedLines(dir)).toEqual([{ file: "t\tab b.ts", lines: [[1, 1]] }]);
  });

  it("lists a binary change to a name that needs quoting, and a mode-only change, as all", () => {
    const dir = makeRepo({ "a.ts": lines(2), "run.sh": "echo\n" });
    writeFileSync(join(dir, "bin\tary x.bin"), Buffer.from([0, 1, 2, 0, 255]));
    commitAll(dir);
    writeFileSync(join(dir, "bin\tary x.bin"), Buffer.from([0, 9, 9, 0, 255]));
    chmodSync(join(dir, "run.sh"), 0o755);
    expect(changedLines(dir)).toEqual([
      { file: "bin\tary x.bin", lines: "all" },
      { file: "run.sh", lines: "all" },
    ]);
  });

  it("lists binary changes as all", () => {
    const dir = makeRepo({ "a.ts": lines(2) });
    writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
    commitAll(dir);
    writeFileSync(join(dir, "img.bin"), Buffer.from([0, 9, 9, 0, 255]));
    expect(changedLines(dir)).toEqual([{ file: "img.bin", lines: "all" }]);
  });

  it("diffs a commit range (base..head and base alone = base..HEAD), ignoring the working tree", () => {
    const dir = makeRepo({ "a.ts": lines(10) });
    const base = sha(dir);
    edit(dir, "a.ts", (r) => r.map((x, i) => (i === 5 ? "six" : x)));
    commitAll(dir);
    const head = sha(dir);
    writeFileSync(join(dir, "wip.ts"), "x\n");
    expect(changedLines(dir, `${base}..${head}`)).toEqual([{ file: "a.ts", lines: [[6, 6]] }]);
    expect(changedLines(dir, base)).toEqual([{ file: "a.ts", lines: [[6, 6]] }]);
    expect(changedLines(dir, `${head}..${base}`)).toEqual([{ file: "a.ts", lines: [[6, 6]] }]);
  });

  it("only reports files under the repo folder, relative to it, when the repo is a subfolder of a git repo", () => {
    const top = makeRepo({ "pkg/a.ts": lines(3), "other.ts": lines(3) });
    writeFileSync(join(top, "pkg", "a.ts"), "x\n" + lines(3).split("\n").slice(1).join("\n"));
    writeFileSync(join(top, "other.ts"), "x\n");
    writeFileSync(join(top, "pkg", "u.ts"), "x\n");
    writeFileSync(join(top, "u2.ts"), "x\n");
    expect(changedLines(join(top, "pkg"))).toEqual([
      { file: "a.ts", lines: [[1, 1]] },
      { file: "u.ts", lines: "all" },
    ]);
  });

  it("rejects option-like and unresolvable ranges with a data error", () => {
    const dir = makeRepo({ "a.ts": lines(3) });
    for (const bad of ["--output=/tmp/x", "-p", "nope..HEAD", "does-not-exist", "", "a b"]) {
      try {
        changedLines(dir, bad);
        throw new Error(`should have thrown for ${bad}`);
      } catch (err) {
        expect(err, bad).toBeInstanceOf(CodeloomError);
        expect((err as CodeloomError).exitCode).toBe(2);
      }
    }
  });

  it("lists a file deleted since base and now untracked again once", () => {
    const dir = makeRepo({ "a.ts": lines(3), "back.ts": lines(3) });
    const base = sha(dir);
    gitIn(dir, "rm", "-q", "back.ts");
    commitAll(dir);
    writeFileSync(join(dir, "back.ts"), lines(3));
    expect(changedLinesAtBase(dir, base)).toEqual([{ file: "back.ts", lines: "all" }]);
  });
});

describe("changedLinesAtBase", () => {
  it("reports the OLD side of each hunk: base line numbers, insertions as the line before them", () => {
    const dir = makeRepo({ "a.ts": lines(10) });
    const base = sha(dir);
    // Two lines inserted after line 3 (committed), then line 8 edited (unstaged).
    edit(dir, "a.ts", (r) => [...r.slice(0, 3), "// one", "// two", ...r.slice(3)]);
    commitAll(dir);
    const head = sha(dir);
    const rows = lines(10).trimEnd().split("\n");
    writeFileSync(join(dir, "a.ts"), [...rows.slice(0, 3), "// one", "// two", ...rows.slice(3).map((x) => (x === "line 8" ? "eight" : x))].join("\n") + "\n");
    expect(changedLinesAtBase(dir, base)).toEqual([{ file: "a.ts", lines: [[3, 3], [8, 8]] }]);
    expect(changedLinesAtBase(dir, base, head)).toEqual([{ file: "a.ts", lines: [[3, 3]] }]);
    // The new side for comparison: the inserted lines, then the edit at its new place.
    expect(changedLines(dir, base).map((f) => f.lines)).toEqual([[[4, 5]]]);
  });

  it("an insertion at the top of a file is line 1", () => {
    const dir = makeRepo({ "a.ts": lines(3) });
    const base = sha(dir);
    writeFileSync(join(dir, "a.ts"), "top\n" + lines(3));
    expect(changedLinesAtBase(dir, base)).toEqual([{ file: "a.ts", lines: [[1, 1]] }]);
  });
});

describe("resolveRange / isGitRepo", () => {
  it("resolves base..head, base alone, and base...head (merge base)", () => {
    const dir = makeRepo({ "a.ts": lines(3) });
    const base = sha(dir);
    writeFileSync(join(dir, "a.ts"), "x\n");
    commitAll(dir);
    const head = sha(dir);
    expect(resolveRange(dir, `${base}..${head}`)).toEqual({ base, head });
    expect(resolveRange(dir, base)).toEqual({ base, head });
    expect(resolveRange(dir, `${head}...${base}`)).toEqual({ base, head: base });
    expect(() => resolveRange(dir, "--output=/tmp/x")).toThrow(CodeloomError);
    expect(() => resolveRange(dir, "nope..HEAD")).toThrow(CodeloomError);
  });

  it("tells a git work tree from a plain folder", () => {
    const dir = makeRepo({ "a.ts": lines(1) });
    expect(isGitRepo(dir)).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), "codeloom-plain-"));
    expect(isGitRepo(plain)).toBe(false);
  });
});
