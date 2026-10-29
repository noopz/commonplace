/**
 * The write-trigger job queue (docs/revision-design.md, "Triggers"): durable
 * in the ledger, one job per finished unit of work (the module debounces),
 * deduplicated by the written notes' revisions, one job running per vault
 * under a lease, a bounded number of attempts, and overflow queued rather
 * than dropped.
 *
 * Generated writes never become jobs: a write whose origin is commonplace
 * itself or a maintenance agent (they move links, counts and dates; they make
 * no new claim), and a write that left the note's body unchanged.
 */

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { join } from "path";
import { readFileSync } from "fs";
import { parseFrontmatter } from "../../../hooks/lib/index/yaml.ts";
import { repoOf, readUnit } from "../git-unit.ts";
import { MAIN, append, newId } from "./ledger.ts";
import { holds, processAlive, releaseLock, takeLock } from "./lock.ts";
import { hostname } from "os";
import { loadIndex } from "./vault-index.ts";
import { noteRev, state, type Ctx } from "./engine.ts";
import type { JobState } from "./reducer.ts";

/** Origins whose writes make no claims: never a trigger. */
const GENERATED_ORIGIN =
  /^(commonplace|cli-revise|commonplace:wiki-(linter|pruner|moc-updater|moc-splitter|deep-linker|cross-domain-linker|freshness-checker|impact-checker|conventions-tuner|domain-manager))$/;

/** How long a claimed job is held before another session may take it. */
export const JOB_LEASE_MS = 15 * 60_000;
/** Jobs running at once per vault. */
export const JOB_CONCURRENCY = 1;

export type EnqueueInput = {
  written: string[];
  reads?: Array<string | { rel: string; rev?: string }>;
  pairs?: Array<{ written: string; old: string; why: string }>;
  origin?: string;
  unit?: string;
};

export type EnqueueResult = {
  queued: string[];
  duplicate: number;
  skipped: Array<{ rel?: string; why: string }>;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const bodyOf = (text: string) => norm(parseFrontmatter(text).body);

/** The note's text before this unit first wrote it, or null (a new note, no unit, no repo). */
function textBefore(ctx: Ctx, unit: string | undefined, rel: string): string | null {
  if (!unit) return null;
  const before = readUnit(ctx.vault, unit)?.paths[rel]?.before;
  const repo = repoOf(ctx.vault);
  if (!before || !repo) return null;
  try {
    return execFileSync("git", ["cat-file", "blob", before], { cwd: repo.top, stdio: "pipe" }).toString();
  } catch {
    return null;
  }
}

export async function enqueue(ctx: Ctx, input: EnqueueInput): Promise<EnqueueResult> {
  const res: EnqueueResult = { queued: [], duplicate: 0, skipped: [] };
  const origin = input.origin || "agent";
  if (GENERATED_ORIGIN.test(origin)) {
    res.skipped.push({ why: `generated (${origin})` });
    return res;
  }
  const loaded = await loadIndex(ctx.vault, ctx.open);
  if (!loaded) {
    res.skipped.push({ why: "index not built" });
    return res;
  }
  const v = loaded.index.view!;
  const shardOf = (rel: string) => {
    const id = v.idOfRel(rel);
    return id !== undefined && v.visible(id) ? v.shard(id) : null;
  };
  const groups = new Map<string, Array<{ rel: string; rev: string }>>();
  for (const rel of [...new Set(input.written)]) {
    const shard = shardOf(rel);
    const rev = noteRev(ctx.vault, rel);
    if (!shard || !rev) {
      res.skipped.push({ why: "not visible" });
      continue;
    }
    if (!input.pairs) {
      const before = textBefore(ctx, input.unit, rel);
      let now = "";
      try {
        now = readFileSync(join(ctx.vault, rel), "utf-8");
      } catch {}
      if (before !== null && bodyOf(before) === bodyOf(now)) {
        res.skipped.push({ rel: shard === MAIN ? rel : undefined, why: "frontmatter-only" });
        continue;
      }
    }
    if (!groups.has(shard)) groups.set(shard, []);
    groups.get(shard)!.push({ rel, rev });
  }
  const red = state(ctx);
  for (const [shard, written] of groups) {
    // A public job's reads stay public; a private one may also read its own shard.
    const seenReads = new Set<string>();
    const reads = (input.reads ?? [])
      .map((r) => (typeof r === "string" ? { rel: r, rev: "" } : { rel: r.rel, rev: r.rev ?? "" }))
      .filter((r) => {
        if (seenReads.has(r.rel)) return false;
        seenReads.add(r.rel);
        const s = shardOf(r.rel);
        return s === MAIN || (s !== null && s === shard);
      });
    const pairs = input.pairs?.filter((p) => written.some((w) => w.rel === p.written));
    const key = createHash("sha256")
      .update(written.map((w) => `${w.rel}@${w.rev}`).sort().join("\n"))
      .update(pairs ? `\n${pairs.map((p) => `${p.written}>${p.old}`).sort().join("\n")}` : "")
      .digest("hex")
      .slice(0, 24);
    if ([...red.jobs.values()].some((j) => j.queued.key === key && j.status !== "abandoned")) {
      res.duplicate++;
      continue;
    }
    const job = newId();
    append(ctx.vault, shard, ctx.actor, {
      kind: "job-queued",
      job,
      key,
      written,
      reads,
      ...(pairs?.length ? { pairs } : {}),
      origin,
      ...(input.unit ? { unit: input.unit } : {}),
    });
    res.queued.push(job);
  }
  return res;
}

export type ClaimedJob = {
  job: string;
  written: string[];
  reads: string[];
  pairs?: Array<{ written: string; old: string; why: string }>;
  attempt: number;
};

const jobsLock = (vault: string) => join(vault, ".wiki", "revision", "jobs.lock");

/** The oldest queued job, claimed under a lease; null when none is due or the concurrency bound is reached. */
export function claim(ctx: Ctx, now = Date.now()): { job: ClaimedJob } | { none: true; busy?: boolean } {
  const lock = takeLock(jobsLock(ctx.vault), 2_000);
  if (!lock) return { none: true, busy: true };
  try {
    // A job whose session exited mid-run is not held for the rest of its lease:
    // that attempt failed, and it is queued again (or abandoned at the limit).
    for (const j of state(ctx).jobs.values()) {
      if (j.status === "claimed" && j.claimer && !processAlive(j.claimer.pid, j.claimer.host)) {
        append(ctx.vault, j.shard, ctx.actor, { kind: "job-failed", job: j.id, reason: "the session running it exited" });
      }
    }
    const jobs = [...state(ctx).jobs.values()];
    if (jobs.filter((j) => j.status === "claimed").length >= JOB_CONCURRENCY) return { none: true, busy: true };
    const next = jobs.filter((j) => j.status === "queued").sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!next || !holds(lock)) return { none: true };
    // The process that ran `commonplace` (the Claude Code session running the job), set by the launcher.
    const pid = Number(process.env.COMMONPLACE_CALLER_PID) || process.ppid;
    append(ctx.vault, next.shard, ctx.actor, { kind: "job-claimed", job: next.id, until: new Date(now + JOB_LEASE_MS).toISOString(), pid, host: hostname() });
    return {
      job: {
        job: next.id,
        written: next.queued.written.map((w) => w.rel),
        reads: next.queued.reads.map((r) => r.rel),
        ...(next.queued.pairs ? { pairs: next.queued.pairs } : {}),
        attempt: next.attempts + 1,
      },
    };
  } finally {
    releaseLock(lock);
  }
}

const jobOf = (ctx: Ctx, id: string): JobState | undefined => state(ctx).jobs.get(id);

export function finish(ctx: Ctx, id: string, r: { poolSize?: number; truncated?: boolean; changed?: number; proposals?: number }): boolean {
  const j = jobOf(ctx, id);
  if (!j || j.status === "done") return false;
  append(ctx.vault, j.shard, ctx.actor, {
    kind: "job-done",
    job: id,
    poolSize: Number(r.poolSize ?? 0),
    truncated: r.truncated === true,
    changed: Number(r.changed ?? 0),
    proposals: Number(r.proposals ?? 0),
  });
  return true;
}

export function fail(ctx: Ctx, id: string, reason: string): JobState["status"] | null {
  const j = jobOf(ctx, id);
  if (!j || j.status === "done") return null;
  append(ctx.vault, j.shard, ctx.actor, { kind: "job-failed", job: id, reason: reason.slice(0, 200) });
  return jobOf(ctx, id)?.status ?? null;
}
