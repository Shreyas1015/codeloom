import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CodeloomError } from "../errors.js";

export interface LockOptions {
  /** A lock older than this is taken over even if its process still runs. Default 30 s. */
  staleMs?: number;
  /** Give up (CodeloomError) after waiting this long. Default 2 min. */
  timeoutMs?: number;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The lock file's content when it is left over (its process is gone, or it is older than `staleMs`), else
 * null. A lock that vanished meanwhile → "" (retry at once). */
function staleContent(path: string, staleMs: number): string | null {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return "";
  }
  const text = readText(path);
  if (text === null) return "";
  if (age > staleMs) return text;
  const pid = Number.parseInt(text.split("\n")[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return age > 1000 ? text : null; // still being written: give it a moment
  return !pidAlive(pid) ? text : null;
}

/** Remove the stale lock whose content was `stale`, without ever removing a fresh lock another process took
 * meanwhile: move it aside first, and put it back if it turns out to be someone else's. */
function breakLock(path: string, stale: string): void {
  if (stale === "") return;
  const aside = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return; // gone already
  }
  if (readText(aside) !== stale) {
    try {
      linkSync(aside, path); // a fresh lock: put it back (fails only if yet another one exists, which then wins)
    } catch {
      // ignore
    }
  }
  rmSync(aside, { force: true });
}

/** Run `fn` holding the lock file `path` (created with O_EXCL, holding this pid). Waits with backoff while
 * another process holds it; takes over a stale one (see staleContent). Synchronous: meant for short read → change
 * → write sections such as the registry. Not re-entrant. */
export function withLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  mkdirSync(dirname(path), { recursive: true });
  let wait = 5;
  const waitingFrom = Date.now();
  let told = false;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      // EPERM: Windows reports a file being deleted by its holder this way; retry like EEXIST.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw err;
    }
    if (fd !== undefined) {
      const token = `${process.pid}\n${new Date().toISOString()} ${randomBytes(6).toString("hex")}\n`;
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      try {
        return fn();
      } finally {
        // Only our own lock: had it been taken over as stale, the file is someone else's now.
        if (readText(path) === token) rmSync(path, { force: true });
      }
    }
    const stale = staleContent(path, staleMs);
    if (stale !== null) {
      breakLock(path, stale);
      continue;
    }
    if (Date.now() > deadline) {
      throw new CodeloomError(`Another codeloom is still holding ${path}. If none is running, delete that file and try again.`);
    }
    if (!told && Date.now() - waitingFrom >= 2000) {
      told = true;
      const pid = Number.parseInt((readText(path) ?? "").split("\n")[0] ?? "", 10);
      process.stderr.write(`codeloom: waiting for another codeloom run${Number.isInteger(pid) && pid > 0 ? ` (pid ${pid})` : ""}…\n`);
    }
    sleepSync(wait + Math.floor(Math.random() * wait));
    wait = Math.min(wait * 2, 250);
  }
}
