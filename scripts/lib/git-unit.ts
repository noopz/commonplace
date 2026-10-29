/**
 * Units of agent work, committed to the vault's git repository
 * (docs/revision-design.md, "The commit step").
 *
 * Git commits whole files, not one writer's changes, so "stage the files this
 * agent wrote" would sweep the owner's edits into an agent's commit whenever
 * both touched one file. A unit therefore records, per path, the blob before
 * its first write and after its last, and commits only when every path still
 * holds exactly what the unit wrote AND the branch still holds what the unit
 * started from. The commit is built in a temporary index (the owner's staged
 * changes are never touched) and lands with `update-ref <ref> <new> <old>`, so
 * a commit made in between — by anyone, manual ones included — is noticed
 * instead of overwritten.
 *
 * Nothing here asks the owner anything: a unit that cannot commit cleanly is
 * reported as a conflict and left in the working tree, exactly as it was.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

export type UnitPath = {
  /** Blob before the unit's first write (null: the file did not exist). */
  before: string | null;
  /** Blob after the unit's last write (null: the unit deleted it). */
  after: string | null;
  /** Set when someone else wrote the file between two of this unit's writes. */
  tainted?: string;
};

export type Unit = {
  v: 1;
  id: string;
  actor: string;
  session: string;
  startedAt: string;
  /** HEAD when the unit's first write happened (null on an unborn branch). */
  base: string | null;
  /** Vault-relative path → blobs. */
  paths: Record<string, UnitPath>;
  /** Vault-relative append-only files (ledgers): committed whole while the committed copy is a prefix. */
  appendOnly?: string[];
  /** Set once committed. */
  commit?: string;
};

export type Repo = {
  /** Repository top level (absolute). */
  top: string;
  /** The vault's path inside the repository ("" when the vault is the top). */
  prefix: string;
  /** `refs/heads/<branch>`; null when HEAD is detached. */
  ref: string | null;
};

export type CommitResult =
  | { status: "committed"; commit: string; paths: string[] }
  | { status: "conflict"; conflicts: Array<{ path: string; reason: string }> }
  | { status: "empty" }
  | { status: "no-repo" }
  | { status: "detached" }
  | { status: "off-branch"; pinned: string; current: string | null }
  | { status: "missing" };

const ZERO = "0000000000000000000000000000000000000000";

function git(top: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync("git", args, {
    cwd: top,
    input: opts.input,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

function tryGit(top: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string | null {
  try {
    return git(top, args, opts);
  } catch {
    return null;
  }
}

/** The repository holding `vault`, or null when it is not in one. */
export function repoOf(vault: string): Repo | null {
  let abs = resolve(vault);
  try {
    abs = realpathSync(abs); // macOS: /var is /private/var, and git reports the real one
  } catch {
    return null;
  }
  const top = tryGit(abs, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return null;
  const ref = tryGit(abs, ["symbolic-ref", "-q", "HEAD"])?.trim() || null;
  const prefix = relative(top, abs).split("\\").join("/");
  return { top, prefix: prefix === "" ? "" : prefix, ref };
}

/** HEAD's commit, or null on an unborn branch. */
export function headOf(repo: Repo): string | null {
  return tryGit(repo.top, ["rev-parse", "-q", "--verify", "HEAD^{commit}"])?.trim() || null;
}

const repoPath = (repo: Repo, rel: string) => (repo.prefix ? `${repo.prefix}/${rel}` : rel);

/**
 * The blob git would store for the working-tree file now, written to the
 * object database when `write` (so a later commit can name it even after the
 * file changes again). Null when the file does not exist.
 */
export function blobOfFile(repo: Repo, rel: string, write = false): string | null {
  const rp = repoPath(repo, rel);
  if (!existsSync(join(repo.top, rp))) return null;
  return tryGit(repo.top, ["hash-object", ...(write ? ["-w"] : []), "--", rp])?.trim() || null;
}

/** The blob at `rel` in `commit` (null: absent, or no commit). */
export function blobAt(repo: Repo, commit: string | null, rel: string): string | null {
  if (!commit) return null;
  return tryGit(repo.top, ["rev-parse", "-q", "--verify", `${commit}:${repoPath(repo, rel)}`])?.trim() || null;
}

function modeAt(repo: Repo, commit: string | null, rel: string): string {
  if (!commit) return "100644";
  const line = tryGit(repo.top, ["ls-tree", commit, "--", repoPath(repo, rel)])?.trim();
  return line ? line.split(/\s/)[0] : "100644";
}

// ------------------------------------------------------------------ records

export const unitsDir = (vault: string) => join(resolve(vault), ".wiki", "units");
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
export const unitFile = (vault: string, id: string) => join(unitsDir(vault), `${safe(id)}.json`);

export function readUnit(vault: string, id: string): Unit | null {
  try {
    return JSON.parse(readFileSync(unitFile(vault, id), "utf-8")) as Unit;
  } catch {
    return null;
  }
}

function writeUnit(vault: string, u: Unit): void {
  mkdirSync(unitsDir(vault), { recursive: true });
  const f = unitFile(vault, u.id);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(u, null, 1));
  renameSync(tmp, f);
}

/**
 * Record one write of `rel` by unit `id`. `before`/`after` are blobs taken
 * around the write. A second write whose `before` is not the unit's last
 * `after` means someone else changed the file in between: the path is
 * tainted, and the unit will not commit it.
 */
export function recordTouch(
  vault: string,
  id: string,
  who: { actor: string; session: string },
  rel: string,
  before: string | null,
  after: string | null,
  repo: Repo | null = repoOf(vault),
): Unit {
  const u: Unit = readUnit(vault, id) ?? {
    v: 1,
    id,
    actor: who.actor,
    session: who.session,
    startedAt: new Date().toISOString(),
    base: repo ? headOf(repo) : null,
    paths: {},
  };
  if (u.commit) {
    // A committed unit is closed; a write after it starts a fresh record.
    return recordTouch(vault, `${id}+`, who, rel, before, after, repo);
  }
  const prev = u.paths[rel];
  if (!prev) u.paths[rel] = { before, after };
  else {
    if (prev.after !== before && !prev.tainted) prev.tainted = "another writer changed the file between this unit's writes";
    prev.after = after;
  }
  writeUnit(vault, u);
  return u;
}

/** Mark vault-relative append-only files (ledgers) as part of a unit. */
export function recordAppendOnly(vault: string, id: string, who: { actor: string; session: string }, rels: string[], repo: Repo | null = repoOf(vault)): Unit {
  const u: Unit = readUnit(vault, id) ?? {
    v: 1,
    id,
    actor: who.actor,
    session: who.session,
    startedAt: new Date().toISOString(),
    base: repo ? headOf(repo) : null,
    paths: {},
  };
  u.appendOnly = [...new Set([...(u.appendOnly ?? []), ...rels])].sort();
  writeUnit(vault, u);
  return u;
}

// ------------------------------------------------------------------ commit

export type CommitOptions = {
  message: string;
  /** `Key: value` lines appended after a blank line. Values must be opaque ids, never note text. */
  trailers?: Record<string, string>;
  /** Attempts when HEAD moves between the check and update-ref. */
  retries?: number;
  /** Injected between building and update-ref, for tests of the race. */
  beforeUpdateRef?: () => void;
  /** The branch this session pinned (`refs/heads/…`); default `COMMONPLACE_PIN`. */
  pin?: string | null;
  /** Append-only files carried along when they only grew (the public ledgers); never a conflict. */
  sweep?: string[];
};

/**
 * The branch the session pinned at its start (design, "Units of work"): the
 * module sets `COMMONPLACE_PIN` for every CLI it runs or the model runs. A
 * vault switched to another branch mid-session pauses committing rather than
 * landing agent work on a branch nobody chose for it.
 */
export const pinnedRef = (): string | null => {
  const p = String(process.env.COMMONPLACE_PIN ?? "").trim();
  return /^refs\/heads\/[^\s]+$/.test(p) ? p : null;
};

/** Why `repo` may not take agent commits now, or null. */
export function branchBlocker(repo: Repo, pin: string | null = pinnedRef()): CommitResult | null {
  if (!repo.ref) return { status: "detached" };
  if (pin && repo.ref !== pin) return { status: "off-branch", pinned: pin, current: repo.ref };
  return null;
}

function isPrefixBlob(repo: Repo, committed: string, rel: string): boolean {
  const old = tryGit(repo.top, ["cat-file", "blob", committed]);
  if (old === null) return false;
  try {
    const now = readFileSync(join(repo.top, repoPath(repo, rel)), "utf-8");
    return now.startsWith(old);
  } catch {
    return false;
  }
}

/** Keep the owner's index in step for paths the commit moved, unless they staged something there. */
function syncRealIndex(repo: Repo, moved: Array<{ rp: string; old: string | null; blob: string | null; mode: string }>): void {
  const lines: string[] = [];
  for (const m of moved) {
    const staged = tryGit(repo.top, ["ls-files", "-s", "--", m.rp])?.trim() ?? "";
    const stagedBlob = staged ? staged.split(/\s+/)[1] : null;
    if (stagedBlob !== m.old) continue; // the owner staged their own version: leave it
    lines.push(m.blob ? `${m.mode} ${m.blob}\t${m.rp}` : `0 ${ZERO}\t${m.rp}`);
  }
  if (lines.length === 0) return;
  for (let i = 0; i < 5; i++) {
    if (tryGit(repo.top, ["update-index", "--index-info"], { input: lines.join("\n") + "\n" }) !== null) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/**
 * Commit unit `id` if it is complete and clean, else report why not.
 * All-or-nothing: a unit with one conflicting path commits nothing.
 */
export function commitUnit(vault: string, id: string, opts: CommitOptions): CommitResult {
  const u = readUnit(vault, id);
  if (!u) return { status: "missing" };
  const repo = repoOf(vault);
  if (!repo) return { status: "no-repo" };
  if (u.commit) return { status: "committed", commit: u.commit, paths: Object.keys(u.paths) };
  const blocked = branchBlocker(repo, opts.pin === undefined ? pinnedRef() : opts.pin);
  if (blocked) return blocked;

  const attempts = Math.max(1, (opts.retries ?? 3) + 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = headOf(repo);
    const conflicts: Array<{ path: string; reason: string }> = [];
    const entries: Array<{ rp: string; rel: string; old: string | null; blob: string | null; mode: string }> = [];

    for (const [rel, p] of Object.entries(u.paths).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (p.tainted) {
        conflicts.push({ path: rel, reason: p.tainted });
        continue;
      }
      const now = blobOfFile(repo, rel);
      if (now !== p.after) {
        conflicts.push({ path: rel, reason: "the file changed after this unit wrote it" });
        continue;
      }
      const committed = blobAt(repo, head, rel);
      if (committed === p.after) continue; // already there
      if (committed !== p.before) {
        conflicts.push({ path: rel, reason: "another commit changed the file since this unit read it" });
        continue;
      }
      entries.push({ rp: repoPath(repo, rel), rel, old: committed, blob: p.after, mode: modeAt(repo, head, rel) });
    }
    const required = new Set(u.appendOnly ?? []);
    for (const rel of [...new Set([...required, ...(opts.sweep ?? [])])]) {
      if (u.paths[rel]) continue;
      const now = blobOfFile(repo, rel, true);
      if (!now) continue;
      const committed = blobAt(repo, head, rel);
      if (committed === now) continue;
      if (committed && !isPrefixBlob(repo, committed, rel)) {
        if (required.has(rel)) conflicts.push({ path: rel, reason: "the committed ledger is not a prefix of the current one" });
        continue;
      }
      entries.push({ rp: repoPath(repo, rel), rel, old: committed, blob: now, mode: "100644" });
    }

    if (conflicts.length) return { status: "conflict", conflicts };
    // Swept ledgers ride along with real work; they never make a commit by themselves.
    if (!entries.some((e) => required.has(e.rel) || u.paths[e.rel])) return { status: "empty" };

    // Build in a temporary index: the owner's staged changes stay theirs.
    const dir = mkdtempSync(join(tmpdir(), "cp-unit-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      git(repo.top, head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
      const info = entries.map((e) => (e.blob ? `${e.mode} ${e.blob}\t${e.rp}` : `0 ${ZERO}\t${e.rp}`)).join("\n") + "\n";
      git(repo.top, ["update-index", "--index-info"], { env, input: info });
      const tree = git(repo.top, ["write-tree"], { env }).trim();
      const trailers = Object.entries(opts.trailers ?? {}).map(([k, v]) => `${k}: ${v}`);
      const msg = [opts.message.trim(), "", `Unit: ${u.id}`, `Actor: ${u.actor}`, ...trailers].join("\n") + "\n";
      const commit = git(repo.top, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-F", "-"], {
        input: msg,
        env: { GIT_AUTHOR_NAME: `commonplace (${u.actor})` },
      }).trim();
      opts.beforeUpdateRef?.();
      if (tryGit(repo.top, ["update-ref", "-m", `commonplace: unit ${u.id}`, repo.ref!, commit, head ?? ZERO]) === null) {
        continue; // HEAD moved: re-check against the new one
      }
      syncRealIndex(repo, entries);
      u.commit = commit;
      writeUnit(vault, u);
      return { status: "committed", commit, paths: entries.map((e) => e.rel) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { status: "conflict", conflicts: [{ path: "", reason: "the branch kept moving; gave up after retries" }] };
}

/**
 * Inverse of one committed change to a single file, applied to the current
 * text: a three-way merge of (current, committed-after → committed-before).
 * Returns the merged text, or null when it does not apply cleanly.
 */
export function inverseOnto(repo: Repo, current: string, after: string, before: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "cp-inv-"));
  try {
    const cur = join(dir, "current");
    const base = join(dir, "after");
    const other = join(dir, "before");
    writeFileSync(cur, current);
    writeFileSync(base, after);
    writeFileSync(other, before);
    try {
      execFileSync("git", ["merge-file", "-q", cur, base, other], { cwd: repo.top, stdio: "pipe" });
    } catch {
      return null; // conflicts (exit > 0) or failure
    }
    return readFileSync(cur, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
