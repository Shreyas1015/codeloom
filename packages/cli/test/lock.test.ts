import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withLock } from "../src/store/lock.js";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "codeloom-lock-")), "x.lock");

describe("withLock", () => {
  it("runs the function holding the lock, then removes it", () => {
    const path = lockPath();
    expect(withLock(path, () => existsSync(path))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("takes over a lock whose process is gone", () => {
    const path = lockPath();
    writeFileSync(path, "999999\n2026-11-18T00:00:00.000Z x\n");
    expect(withLock(path, () => 42, { timeoutMs: 2000 })).toBe(42);
  });

  it("takes over a lock older than staleMs even if its process runs", () => {
    const path = lockPath();
    writeFileSync(path, `${process.ppid}\nold\n`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    expect(withLock(path, () => "ok", { timeoutMs: 2000 })).toBe("ok");
  });

  it("waits for a live holder, and gives up with a clear error after the timeout", async () => {
    const path = lockPath();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    try {
      writeFileSync(path, `${child.pid}\nnow\n`);
      expect(() => withLock(path, () => 1, { timeoutMs: 300 })).toThrow(/still holding/);
      expect(existsSync(path)).toBe(true); // never removed someone else's lock
    } finally {
      child.kill();
    }
  });
});

describe("withLock while waiting (fix round 2)", () => {
  it("says once on stderr that it waits for another run, naming its pid", () => {
    const path = lockPath();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      writeFileSync(path, `${child.pid}\nnow\n`);
      expect(() => withLock(path, () => 1, { timeoutMs: 2600 })).toThrow(/still holding/);
    } finally {
      spy.mockRestore();
      child.kill();
    }
    const waiting = writes.filter((w) => w.includes("waiting for another codeloom run"));
    expect(waiting).toEqual([expect.stringContaining(`(pid ${child.pid})`)]);
  });
});
