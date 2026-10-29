/**
 * The accept lock: held by a live process for the short prepare-and-commit
 * section, plus a fence checked at publication (docs/revision-design.md,
 * "Accept").
 *
 * Node has no flock, so ownership is a directory created with one atomic
 * mkdir and an owner file naming pid, host and a random token. It is taken
 * over only when the owner process is DEAD (same host, `kill(pid, 0)` fails)
 * — never on age, which is the defect in the index lock (a slow live holder
 * lost its lock after 120 s). A takeover renames a fresh directory into
 * place, so two contenders cannot both win, and release removes the
 * directory only while it still holds our token.
 *
 * The fence is the second line: the commit lands with `update-ref` against
 * the expected parent, so even a holder that lost the lock cannot publish
 * over a newer commit.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export type Lock = { dir: string; token: string };

type Owner = { pid: number; host: string; token: string; at: string };

function owner(dir: string): Owner | null {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf-8")) as Owner;
  } catch {
    return null;
  }
}

function alive(o: Owner): boolean {
  if (o.host !== hostname()) return true; // another machine: never presume it dead
  try {
    process.kill(o.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How long a lock directory may sit without an owner file before it counts as abandoned. */
const ORPHAN_MS = 30_000;
function ownerlessFor(dir: string): number {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take the lock at `dir`, waiting up to `waitMs`. Null when another live process holds it. */
export function takeLock(dir: string, waitMs = 10_000): Lock | null {
  const token = randomBytes(8).toString("hex");
  const me: Owner = { pid: process.pid, host: hostname(), token, at: new Date().toISOString() };
  const deadline = Date.now() + waitMs;
  mkdirSync(join(dir, ".."), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner.json"), JSON.stringify(me));
      return { dir, token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const o = owner(dir);
    // No owner file: the holder is between mkdir and write — or died there,
    // which only a directory older than any such gap can mean.
    if (o ? !alive(o) : ownerlessFor(dir) > ORPHAN_MS) {
      const fresh = `${dir}.${token}`;
      try {
        mkdirSync(fresh);
        writeFileSync(join(fresh, "owner.json"), JSON.stringify(me));
        const graveyard = `${dir}.dead.${token}`;
        renameSync(dir, graveyard); // only one contender's rename of the dead dir succeeds
        rmSync(graveyard, { recursive: true, force: true });
        renameSync(fresh, dir);
        return { dir, token };
      } catch {
        rmSync(fresh, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) return null;
    sleep(100);
  }
}

/** True while `lock` is still ours. */
export function holds(lock: Lock): boolean {
  return owner(lock.dir)?.token === lock.token;
}

/** Release only our own lock. */
export function releaseLock(lock: Lock): void {
  if (!holds(lock)) return;
  const gone = `${lock.dir}.released.${lock.token}`;
  try {
    renameSync(lock.dir, gone);
    rmSync(gone, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}
