/**
 * The revision ledger (docs/revision-design.md, "The ledger"): append-only
 * events, one file per session so concurrent sessions and sync never
 * interleave a file. It lives OUTSIDE `.wiki/` — `.wiki/` is usually
 * gitignored, and the ledger is the record git must keep:
 *
 *   <vault>/.revision/<session>.jsonl                    public revisions
 *   <vault>/.revision/sealed/<shard>/<session>.jsonl     a private shard's
 *
 * Each line is one complete event written with one append; a torn last line
 * is skipped on read. Prompt text is never logged.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import type { EdgeRel, RevisionRelation } from "../../../hooks/lib/revision/edges.ts";

export const MAIN = "main";

export type Actor = { type: string; session: string; unit?: string };

/** A note at a version: vault-relative path, title, and a content hash. */
export type NoteRef = { rel: string; title: string; rev: string };

export type Evidence = { note: string; artifact: string; locator: string };

export type Verdict = RevisionRelation | "none" | "insufficient";

type Base = { id: string; at: string; actor: Actor };

export type VerdictFields = {
  proposal: string;
  verdict: Verdict;
  kindOf?: "correction" | "world-change";
  within?: string;
  effective?: string;
  because?: string;
  quotesOld?: string[];
  quotesNew?: string[];
  model: string;
  /** Claim order shown (true: the older note's claim first). */
  oldFirst?: boolean;
};

export type RevEvent = Base &
  (
    | {
        kind: "propose";
        /** The older note and the claim in it. */
        old: NoteRef & { claim: string };
        /** The newer note that would carry the edge. */
        new: NoteRef;
        /** Every scope any input to this proposal came from: "main" or shard ids. */
        inputScope: string[];
        origin: "write-trigger" | "impact-checker" | "owner" | "external" | "agent";
        /** The proposer's rationale: withheld from reviewers until they commit. */
        rationale?: string;
      }
    | ({ kind: "review" } & VerdictFields)
    | ({ kind: "escalate" } & VerdictFields)
    | {
        kind: "verify";
        proposal: string;
        result: "confirmed" | "refuted" | "abstain";
        evidence: Evidence[];
        reason?: string;
        model: string;
      }
    | { kind: "rationale-seen"; proposal: string; flipped: boolean }
    | { kind: "because"; proposal: string; text: string; checked: boolean }
    | {
        kind: "accept";
        proposal: string;
        seq: number;
        key: string;
        relation: RevisionRelation;
        from: string;
        to: string;
        rel: EdgeRel;
        expectedParent: string | null;
      }
    | { kind: "committed"; accept: string; commit: string }
    | { kind: "accept-failed"; accept: string; reason: string }
    | { kind: "pending"; proposal: string; reason: string; packet: string }
    | { kind: "reject"; proposal: string; reason: string; packet: string }
    | { kind: "withdraw"; proposal: string; reason: string }
    | { kind: "deferred"; proposal: string; reason: string }
    | { kind: "revert"; accept: string; reason: string; commit?: string; conflict?: string }
    | { kind: "external"; rel: string; keys: string[] }
    | { kind: "checked"; rel: string; blob: string; event: string }
    | { kind: "stale"; event: string; marks: Array<{ rel: string; displaced: string }> }
    | { kind: "enable"; mode: "auto" | "manual"; baseline: string[] }
    | { kind: "pause" | "resume" }
    | {
        /** A write-trigger job: one finished unit of work's notes at their versions (design, "Triggers"). */
        kind: "job-queued";
        job: string;
        /** Dedup key over the written notes' revisions (and the pairs, for an overflow job). */
        key: string;
        written: Array<{ rel: string; rev: string }>;
        /** Whole reads in this ledger's scope, at the version the agent read (`rev` "" when unknown). */
        reads: Array<{ rel: string; rev: string }>;
        /** Overflow: (written, older) pairs already detected as changed, still to propose. */
        pairs?: Array<{ written: string; old: string; why: string }>;
        origin: string;
        unit?: string;
      }
    | { kind: "job-claimed"; job: string; until: string }
    | { kind: "job-done"; job: string; poolSize: number; truncated: boolean; changed: number; proposals: number }
    | { kind: "job-failed"; job: string; reason: string }
  );

export type EventKind = RevEvent["kind"];

/** Distributive Omit, so each variant keeps its own fields. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEvent = DistOmit<RevEvent, "id" | "at" | "actor"> & { id?: string };

export const ledgerDir = (vault: string) => join(resolve(vault), ".revision");
export const ledgerShardDir = (vault: string, shard: string) =>
  shard === MAIN ? ledgerDir(vault) : join(ledgerDir(vault), "sealed", shard);

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session";

/** Vault-relative ledger file for (scope, session). */
export const ledgerRel = (shard: string, session: string) =>
  shard === MAIN ? `.revision/${safe(session)}.jsonl` : `.revision/sealed/${safe(shard)}/${safe(session)}.jsonl`;

/** Time-sortable unique id. */
export function newId(): string {
  return `${Date.now().toString(36).padStart(9, "0")}${randomBytes(5).toString("hex")}`;
}

/** Append one event; returns it with its id and time filled in. */
export function append(vault: string, shard: string, actor: Actor, ev: NewEvent): RevEvent {
  const full = { id: ev.id ?? newId(), at: new Date().toISOString(), actor, ...ev } as RevEvent;
  const rel = ledgerRel(shard, actor.session || "cli");
  const abs = join(resolve(vault), rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  appendFileSync(abs, JSON.stringify(full) + "\n");
  return full;
}

function readFile(path: string): RevEvent[] {
  const out: RevEvent[] = [];
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RevEvent;
      if (e && typeof e.id === "string" && typeof e.kind === "string") out.push(e);
    } catch {
      // a torn last line, or a foreign one: skipped, never fatal
    }
  }
  return out;
}

/** Every event of the given scopes, merged in (time, id) order. */
export function readAll(vault: string, shards: readonly string[] = [MAIN]): Array<RevEvent & { shard: string }> {
  const out: Array<RevEvent & { shard: string }> = [];
  for (const shard of shards) {
    const dir = ledgerShardDir(vault, shard);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      for (const e of readFile(join(dir, f))) out.push({ ...e, shard });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Shards that have a ledger directory. */
export function ledgerShards(vault: string): string[] {
  const dir = join(ledgerDir(vault), "sealed");
  try {
    return readdirSync(dir).filter((d) => !d.startsWith("."));
  } catch {
    return [];
  }
}
