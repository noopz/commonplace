/**
 * Revision's deterministic steps (docs/revision-design.md, "Protocol"):
 * propose, accept (prepare → commit → publish), revert (a compensating
 * revision), recovery, reconciliation of a manual `git revert`, enabling a
 * scope, and writing the accepted projection. No model calls happen here;
 * the module makes those and records their results through `revise record`.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { parseFrontmatter } from "../../../hooks/lib/index/yaml.ts";
import { KIND_INDEX } from "../../../hooks/lib/graph/csr.ts";
import {
  REVISION_RELATIONS,
  edgeKey,
  locateClaim,
  type RevisionRelation,
} from "../../../hooks/lib/revision/edges.ts";
import { PROJECTION_FILE, shardProjectionFile, type Projection } from "../../../hooks/lib/revision/projection.ts";
import { blobAt, blobOfFile, commitUnit, headOf, inverseOnto, readUnit, recordAppendOnly, recordTouch, repoOf, type Repo } from "../git-unit.ts";
import { MAIN, append, ledgerRel, readAll, type Actor, type RevEvent } from "./ledger.ts";
import { acceptBlocker, edgeFor, reduce, type ProposalState, type Reduced } from "./reducer.ts";
import { holds, releaseLock, takeLock } from "./lock.ts";
import { insertEdge, removeEdge, hasEdge } from "./fm-edit.ts";
import { loadIndex } from "./vault-index.ts";

export type Ctx = { vault: string; actor: Actor; open: string[] };

export const scopesOf = (ctx: Ctx) => [MAIN, ...ctx.open.filter((s) => s !== MAIN)];
export const state = (ctx: Ctx): Reduced => reduce(readAll(ctx.vault, scopesOf(ctx)));

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 32)}`;
export const noteRev = (vault: string, rel: string): string | null => {
  try {
    return sha(readFileSync(join(vault, rel), "utf-8"));
  } catch {
    return null;
  }
};
const titleOf = (rel: string) => rel.split("/").pop()!.replace(/\.md$/, "");
const bodyOf = (text: string) => parseFrontmatter(text).body;
const lockDir = (vault: string) => join(vault, ".wiki", "revision", "accept.lock");

export function config(vault: string): { revision?: string } {
  try {
    return JSON.parse(readFileSync(join(vault, ".wiki", "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ scope

/**
 * The scope a proposal's events and edge live in, or why it may not exist.
 * Public text only from public inputs; private → public links never; v1
 * mixes at most one private shard with public notes.
 */
export function scopeFor(inputScope: readonly string[], newShard: string, oldShard: string): { shard: string } | { error: string } {
  const priv = [...new Set(inputScope.filter((s) => s !== MAIN))];
  if (priv.length > 1) return { error: "inputs span two private shards (v1 allows public plus one)" };
  if (newShard === MAIN) {
    if (priv.length) return { error: "a public note's revision cannot rest on private inputs" };
    if (oldShard !== MAIN) return { error: "a public note cannot link to a private one" };
    return { shard: MAIN };
  }
  if (priv.length && priv[0] !== newShard) return { error: "inputs come from a different private shard than the note" };
  if (oldShard !== MAIN && oldShard !== newShard) return { error: "the older note is in another private shard" };
  return { shard: newShard };
}

// ---------------------------------------------------------------- propose

export type ProposeInput = {
  old: string; // ref: path or title
  new: string;
  claim: string;
  inputs?: string[]; // refs of every other note the proposer read
  origin?: "write-trigger" | "impact-checker" | "owner" | "external" | "agent";
  rationale?: string;
};

export type ProposeResult =
  | { status: "proposed"; id: string; shard: string }
  | { status: "duplicate"; id: string; state: string }
  | { status: "refused"; reason: string };

export async function propose(ctx: Ctx, input: ProposeInput): Promise<ProposeResult> {
  const loaded = await loadIndex(ctx.vault, ctx.open);
  if (!loaded) return { status: "refused", reason: "the vault index is not built (run `commonplace index`)" };
  const v = loaded.index.view!;
  const resolve = (ref: string) => {
    const id = v.resolve(ref);
    if (id === null || !v.visible(id)) return null;
    const rel = v.relOfId(id);
    return rel ? { id, rel, shard: v.shard(id) } : null;
  };
  const oldN = resolve(input.old);
  const newN = resolve(input.new);
  if (!oldN) return { status: "refused", reason: `no visible note "${input.old}"` };
  if (!newN) return { status: "refused", reason: `no visible note "${input.new}"` };
  if (oldN.rel === newN.rel) return { status: "refused", reason: "a note cannot revise itself" };
  const oldText = readFileSync(join(ctx.vault, oldN.rel), "utf-8");
  const where = locateClaim(bodyOf(oldText), input.claim);
  if ("error" in where) {
    const why = { missing: "the claim is not quoted exactly from the older note", ambiguous: "the claim occurs more than once in the older note", empty: "no claim given (whole-note edges are never proposed autonomously)" }[where.error];
    return { status: "refused", reason: why };
  }
  const inputScope = new Set<string>([oldN.shard, newN.shard]);
  for (const ref of input.inputs ?? []) {
    const n = resolve(ref);
    if (n) inputScope.add(n.shard);
  }
  const sc = scopeFor([...inputScope], newN.shard, oldN.shard);
  if ("error" in sc) return { status: "refused", reason: sc.error };

  const red = state(ctx);
  const claim = input.claim.replace(/\s+/g, " ").trim();
  const identity = [newN.rel, oldN.rel, claim].join("\u001f");
  const oldRev = sha(oldText);
  const newRev = noteRev(ctx.vault, newN.rel)!;
  for (const p of red.proposals.values()) {
    if (p.identity !== identity) continue;
    const live = !["rejected", "pending", "withdrawn", "reverted"].includes(p.status);
    // A closed case reopens only on a changed evidence packet: new note versions.
    const sameEvidence = p.propose.old.rev === oldRev && p.propose.new.rev === newRev;
    if (live || sameEvidence) return { status: "duplicate", id: p.id, state: p.status };
  }
  const ev = append(ctx.vault, sc.shard, ctx.actor, {
    kind: "propose",
    old: { rel: oldN.rel, title: titleOf(oldN.rel), rev: oldRev, claim },
    new: { rel: newN.rel, title: titleOf(newN.rel), rev: newRev },
    inputScope: [...inputScope].sort(),
    origin: input.origin ?? "agent",
    ...(input.rationale ? { rationale: input.rationale.slice(0, 2000) } : {}),
  });
  return { status: "proposed", id: ev.id, shard: sc.shard };
}

// ----------------------------------------------------------------- record

/** Append a step's result to the proposal's own scope. */
export function record(ctx: Ctx, proposalId: string, ev: Parameters<typeof append>[3]): RevEvent | null {
  const p = state(ctx).proposals.get(proposalId);
  if (!p) return null;
  return append(ctx.vault, p.shard, ctx.actor, ev);
}

// ----------------------------------------------------------------- accept

export type AcceptResult =
  | { status: "accepted"; accept: string; commit: string; stale: number }
  | { status: "already"; accept: string }
  | { status: "deferred"; reason: string }
  | { status: "pending"; reason: string }
  | { status: "refused"; reason: string };

/** Concepts and MOCs that cite `oldRel` and may have absorbed its claim. */
async function dependents(ctx: Ctx, oldRel: string, exclude: string): Promise<string[]> {
  const loaded = await loadIndex(ctx.vault, ctx.open);
  const v = loaded?.index.view;
  if (!loaded || !v) return [];
  const id = v.idOfRel(oldRel);
  if (id === undefined) return [];
  const ins = v.links(id, "in").filter((l) => l.kind !== "supersedes" && l.kind !== "contests" && l.kind !== "bounds" && l.kind !== "withdrawsSupport");
  const cards = await loaded.index.cards(ins.map((l) => l.id));
  const out = new Set<string>();
  for (const l of ins) {
    const c = cards.get(l.id);
    const rel = v.relOfId(l.id);
    if (c && rel && rel !== exclude && (c.k === "concept" || c.k === "moc")) out.add(rel);
  }
  return [...out].sort();
}

function pendingOn(ctx: Ctx, p: ProposalState, reason: string): AcceptResult {
  append(ctx.vault, p.shard, ctx.actor, { kind: "pending", proposal: p.id, reason, packet: p.packet });
  return { status: "pending", reason };
}

export async function accept(ctx: Ctx, proposalId: string): Promise<AcceptResult> {
  const red = state(ctx);
  const p = red.proposals.get(proposalId);
  if (!p) return { status: "refused", reason: "no such proposal in the open scopes" };
  if (p.status === "accepted" || p.status === "accepting") return { status: "already", accept: p.accept!.id };
  if (p.status !== "accept") return { status: "refused", reason: `the proposal is at "${p.status}", not ready to accept` };
  const blocker = acceptBlocker(p);
  if (blocker) return pendingOn(ctx, p, blocker);
  if (red.paused) return { status: "deferred", reason: "revision is paused (/vault revise resume)" };
  if (config(ctx.vault).revision === "manual") return { status: "deferred", reason: "the vault is in manual revision mode" };
  const repo = repoOf(ctx.vault);
  if (!repo) return { status: "deferred", reason: "the vault is not a git repository: revision runs propose-only" };
  if (!repo.ref) return { status: "deferred", reason: "the vault's HEAD is detached: revision runs propose-only" };
  const edge = edgeFor(p)!;
  const dup = red.accepted.find((a) => a.key === edge.key);
  if (dup) return { status: "already", accept: dup.event };
  for (const s of p.propose.inputScope) if (s !== MAIN && !ctx.open.includes(s)) return { status: "deferred", reason: "a private input's domain is closed in this session" };

  const lock = takeLock(lockDir(ctx.vault));
  if (!lock) return { status: "deferred", reason: "another accept is running" };
  try {
    // Recheck under the lock: nothing the review judged may have moved.
    const oldRel = p.propose.old.rel;
    const newRel = p.propose.new.rel;
    if (noteRev(ctx.vault, oldRel) !== p.propose.old.rev) return pendingOn(ctx, p, "the older note changed after review");
    if (noteRev(ctx.vault, newRel) !== p.propose.new.rev) return pendingOn(ctx, p, "the newer note changed after review");
    const oldText = readFileSync(join(ctx.vault, oldRel), "utf-8");
    if ("error" in locateClaim(bodyOf(oldText), p.propose.old.claim)) return pendingOn(ctx, p, "the claim no longer occurs exactly once");
    const head = headOf(repo);
    // The newer note must be committed as it is: an accept commits only its
    // own change, and an uncommitted edit there is someone else's work.
    if (blobOfFile(repo, newRel) !== blobAt(repo, head, newRel)) {
      return { status: "deferred", reason: "the newer note has uncommitted changes; the accept waits for them to be committed" };
    }

    // Prepare.
    const acceptEv = append(ctx.vault, p.shard, ctx.actor, {
      kind: "accept",
      proposal: p.id,
      seq: red.maxSeq + 1,
      key: edge.key,
      relation: edge.relation,
      from: newRel,
      to: p.propose.old.title,
      rel: edge.rel,
      expectedParent: head,
    });

    // Commit: the frontmatter edge and the ledger, as one unit.
    const abs = join(ctx.vault, newRel);
    const text = readFileSync(abs, "utf-8");
    let next: string;
    try {
      next = insertEdge(text, edge.relation, p.propose.old.title, edge.rel);
    } catch (e) {
      append(ctx.vault, p.shard, ctx.actor, { kind: "accept-failed", accept: acceptEv.id, reason: `frontmatter: ${String((e as Error).message)}` });
      return { status: "pending", reason: "the newer note's frontmatter could not take the edge" };
    }
    const before = blobOfFile(repo, newRel, true);
    writeFileSync(abs, next);
    const after = blobOfFile(repo, newRel, true);
    const unit = `rev-${acceptEv.id}`;
    const who = { actor: ctx.actor.type, session: ctx.actor.session };
    recordTouch(ctx.vault, unit, who, newRel, before, after, repo);
    recordAppendOnly(ctx.vault, unit, who, [ledgerRel(p.shard, ctx.actor.session || "cli")], repo);
    const res = commitUnit(ctx.vault, unit, {
      message: `commonplace revision: accept ${acceptEv.id}`,
      trailers: { "Revision-Event": acceptEv.id },
    });
    if (res.status !== "committed" || !holds(lock)) {
      if (blobOfFile(repo, newRel) === after) writeFileSync(abs, text); // take our uncommitted edit back out
      const reason = res.status === "conflict" ? res.conflicts.map((c) => c.reason).join("; ") : !holds(lock) ? "lost the accept lock" : res.status;
      append(ctx.vault, p.shard, ctx.actor, { kind: "accept-failed", accept: acceptEv.id, reason });
      return { status: "deferred", reason: `commit failed: ${reason}` };
    }

    // Publish.
    append(ctx.vault, p.shard, ctx.actor, { kind: "committed", accept: acceptEv.id, commit: res.commit });
    const marks = (await dependents(ctx, oldRel, newRel)).map((rel) => ({ rel, displaced: p.propose.old.title }));
    if (marks.length) append(ctx.vault, p.shard, ctx.actor, { kind: "stale", event: acceptEv.id, marks });
    writeProjections(ctx);
    return { status: "accepted", accept: acceptEv.id, commit: res.commit, stale: marks.length };
  } finally {
    releaseLock(lock);
  }
}

// ----------------------------------------------------------------- revert

export type RevertResult =
  | { status: "reverted"; revert: string; commit?: string; conflict?: string }
  | { status: "refused"; reason: string };

/**
 * Withdraw an accepted decision: a new, opposite revision. The ledger keeps
 * the accept; the projection drops it at once; dependents are marked; the
 * frontmatter edge is removed from the CURRENT text so later edits survive.
 * A conflict there still withdraws the decision — the reducer, not the file,
 * decides what is accepted.
 */
export async function revert(ctx: Ctx, acceptId: string, reason: string): Promise<RevertResult> {
  const red = state(ctx);
  const p = [...red.proposals.values()].find((x) => x.accept?.id === acceptId || x.id === acceptId);
  if (!p || !p.accept) return { status: "refused", reason: "no such accepted revision in the open scopes" };
  if (p.status !== "accepted") return { status: "refused", reason: `the revision is ${p.status}` };
  const a = p.accept;
  const lock = takeLock(lockDir(ctx.vault));
  if (!lock) return { status: "refused", reason: "another accept or revert is running; try again" };
  try {
    const repo = repoOf(ctx.vault);
    const abs = join(ctx.vault, a.from);
    let commit: string | undefined;
    let conflict: string | undefined;
    const current = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const revertId = `${Date.now().toString(36).padStart(9, "0")}r${createHash("sha256").update(acceptId + Math.random()).digest("hex").slice(0, 8)}`;
    if (current !== null && hasEdge(current, a.relation, a.to, a.rel.claim) && repo?.ref) {
      let next: string | null = null;
      const accCommit = p.committed?.commit;
      if (accCommit) {
        const show = (spec: string) => {
          try {
            return execFileSync("git", ["show", spec], { cwd: repo.top, stdio: "pipe" }).toString();
          } catch {
            return null;
          }
        };
        const rp = repo.prefix ? `${repo.prefix}/${a.from}` : a.from;
        const afterText = show(`${accCommit}:${rp}`);
        const beforeText = show(`${accCommit}^:${rp}`);
        if (afterText !== null && beforeText !== null) next = inverseOnto(repo, current, afterText, beforeText);
      }
      if (next === null) {
        try {
          next = removeEdge(current, a.relation, a.to, a.rel.claim);
        } catch (e) {
          conflict = `frontmatter: ${(e as Error).message}`;
        }
      }
      if (next !== null && blobOfFile(repo, a.from) === blobAt(repo, headOf(repo), a.from)) {
        append(ctx.vault, p.shard, ctx.actor, { id: revertId, kind: "revert", accept: a.id, reason });
        const before = blobOfFile(repo, a.from, true);
        writeFileSync(abs, next);
        const after = blobOfFile(repo, a.from, true);
        const unit = `revert-${revertId}`;
        const who = { actor: ctx.actor.type, session: ctx.actor.session };
        recordTouch(ctx.vault, unit, who, a.from, before, after, repo);
        recordAppendOnly(ctx.vault, unit, who, [ledgerRel(p.shard, ctx.actor.session || "cli")], repo);
        const res = commitUnit(ctx.vault, unit, {
          message: `commonplace revision: revert ${a.id}`,
          trailers: { "Revision-Event": revertId, "Reverts-Event": a.id },
        });
        if (res.status === "committed") commit = res.commit;
        else {
          if (blobOfFile(repo, a.from) === after) writeFileSync(abs, current);
          conflict = res.status === "conflict" ? res.conflicts.map((c) => c.reason).join("; ") : res.status;
        }
      } else if (next !== null) {
        conflict = conflict ?? "the note has uncommitted changes; the edge stays in the file until the reducer's next pass";
      }
    }
    const red2 = state(ctx);
    const already = [...red2.proposals.values()].some((x) => x.revert?.id === revertId);
    if (!already) append(ctx.vault, p.shard, ctx.actor, { id: revertId, kind: "revert", accept: a.id, reason, ...(conflict ? { conflict } : {}) });
    if (commit) append(ctx.vault, p.shard, ctx.actor, { kind: "committed", accept: revertId, commit });
    const marks = (await dependents(ctx, p.propose.old.rel, a.from)).map((rel) => ({ rel, displaced: p.propose.old.title }));
    if (marks.length) append(ctx.vault, p.shard, ctx.actor, { kind: "stale", event: revertId, marks });
    writeProjections(ctx);
    return { status: "reverted", revert: revertId, ...(commit ? { commit } : {}), ...(conflict ? { conflict } : {}) };
  } finally {
    releaseLock(lock);
  }
}

// --------------------------------------------------- recover / reconcile

/**
 * Finish what a crash interrupted: an accept prepared but never published is
 * bound to its commit when one carries its trailer, else abandoned (and our
 * uncommitted frontmatter edit, if it is still exactly ours, taken back out).
 * A manual `git revert` of a revision commit becomes a revert event, so a
 * projection rebuild cannot resurrect the decision.
 */
export function recover(ctx: Ctx, minAgeMs = 120_000): { bound: number; abandoned: number; reconciled: number } {
  const repo = repoOf(ctx.vault);
  const red = state(ctx);
  let bound = 0;
  let abandoned = 0;
  let reconciled = 0;
  const lock = takeLock(lockDir(ctx.vault), 0);
  if (!lock) return { bound, abandoned, reconciled };
  try {
    for (const p of red.proposals.values()) {
      if (p.status !== "accepting" || !p.accept) continue;
      const age = Date.now() - Date.parse(p.accept.at);
      const found = repo ? gitFind(repo, `Revision-Event: ${p.accept.id}`) : null;
      if (found) {
        append(ctx.vault, p.shard, ctx.actor, { kind: "committed", accept: p.accept.id, commit: found });
        bound++;
      } else if (age > minAgeMs) {
        const u = readUnit(ctx.vault, `rev-${p.accept.id}`);
        const path = u?.paths[p.accept.from];
        if (repo && path?.after && blobOfFile(repo, p.accept.from) === path.after && path.before) {
          try {
            const text = execFileSync("git", ["cat-file", "blob", path.before], { cwd: repo.top, stdio: "pipe" }).toString();
            writeFileSync(join(ctx.vault, p.accept.from), text);
          } catch {}
        }
        append(ctx.vault, p.shard, ctx.actor, { kind: "accept-failed", accept: p.accept.id, reason: "interrupted before commit; recovered" });
        abandoned++;
      }
    }
    if (repo) {
      const byCommit = new Map<string, ProposalState>();
      for (const p of red.proposals.values()) if (p.status === "accepted" && p.committed) byCommit.set(p.committed.commit, p);
      if (byCommit.size) {
        let log = "";
        try {
          log = execFileSync("git", ["log", "--format=%H%x00%B%x01", "--grep=This reverts commit", "-n", "500"], { cwd: repo.top, stdio: "pipe" }).toString();
        } catch {}
        for (const entry of log.split("\u0001")) {
          const [hash, body] = entry.trim().split("\u0000");
          if (!hash || !body) continue;
          for (const m of body.matchAll(/This reverts commit ([0-9a-f]{7,64})/g)) {
            const hit = [...byCommit.entries()].find(([c]) => c.startsWith(m[1]));
            if (!hit) continue;
            append(ctx.vault, hit[1].shard, ctx.actor, { kind: "revert", accept: hit[1].accept!.id, reason: "manual git revert", commit: hash });
            byCommit.delete(hit[0]);
            reconciled++;
          }
        }
      }
    }
  } finally {
    releaseLock(lock);
  }
  if (bound || abandoned || reconciled) writeProjections(ctx);
  return { bound, abandoned, reconciled };
}

function gitFind(repo: Repo, needle: string): string | null {
  try {
    const out = execFileSync("git", ["log", "--all", "--format=%H", "-F", `--grep=${needle}`, "-n", "1"], { cwd: repo.top, stdio: "pipe" }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- enable

/**
 * Turn auto mode on for the open scopes that lack it, recording the edges
 * already present as the legacy baseline (shown unreviewed, never hidden).
 * Auto needs a git repository on a branch — rollback has to be real.
 */
export async function ensureEnabled(ctx: Ctx): Promise<{ enabled: string[]; reason?: string }> {
  if (config(ctx.vault).revision === "manual") return { enabled: [], reason: "manual mode (config)" };
  const repo = repoOf(ctx.vault);
  if (!repo || !repo.ref) return { enabled: [], reason: repo ? "detached HEAD" : "not a git repository" };
  const red = state(ctx);
  const missing = scopesOf(ctx).filter((s) => !red.scopes.has(s));
  if (missing.length === 0) return { enabled: [] };
  const loaded = await loadIndex(ctx.vault, ctx.open);
  if (!loaded) return { enabled: [], reason: "index not built" };
  const v = loaded.index.view!;
  const baseline = new Map<string, string[]>(missing.map((s) => [s, []]));
  for (let id = 0; id < v.n; id++) {
    if (!v.visible(id)) continue;
    const fromRel = v.relOfId(id);
    const shard = v.shard(id);
    if (!fromRel || !baseline.has(shard)) continue;
    for (const r of REVISION_RELATIONS) {
      const kind = KIND_INDEX[r];
      const targets: number[] = [];
      v.eachOut(id, (t, _w, k) => {
        if (k === kind && v.visible(t)) targets.push(t);
      });
      for (const t of targets) {
        const toRel = v.relOfId(t);
        if (!toRel) continue;
        for (const rel of await loaded.index.revisionRels(id, t, r)) {
          baseline.get(shard)!.push(edgeKey(fromRel, r, titleOf(toRel), rel?.claim));
        }
      }
    }
  }
  for (const s of missing) append(ctx.vault, s, ctx.actor, { kind: "enable", mode: "auto", baseline: [...new Set(baseline.get(s)!)].sort() });
  writeProjections(ctx);
  return { enabled: missing };
}

// ------------------------------------------------------------- projection

/** Write the accepted projection for every open scope (public + open shards). */
export function writeProjections(ctx: Ctx): void {
  const red = state(ctx);
  const repo = repoOf(ctx.vault);
  const cleared = (rel: string, event: string) => {
    if (!repo) return false;
    const now = blobOfFile(repo, rel);
    return red.checked.some((c) => c.rel === rel && c.event === event && c.blob === now);
  };
  const withdrawn = new Set<string>();
  for (const p of red.proposals.values()) if (p.revert) withdrawn.add(p.accept!.id);
  for (const shard of scopesOf(ctx)) {
    const sc = red.scopes.get(shard);
    const proj: Projection = {
      v: 1,
      mode: sc?.mode ?? "manual",
      autoScopes: sc?.mode === "auto" ? [shard] : [],
      builtAt: new Date().toISOString(),
      accepted: red.accepted.filter((a) => a.shard === shard).map(({ shard: _s, ...a }) => a),
      baseline: sc?.baseline ?? [],
      stale: red.stale.filter((m) => m.shard === shard && !cleared(m.rel, m.event)).map(({ shard: _s, ...m }) => m),
    };
    const rel = shard === MAIN ? PROJECTION_FILE : shardProjectionFile(shard);
    const abs = join(ctx.vault, ".wiki", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(proj));
    renameSync(tmp, abs);
  }
}

/** Record that a concept/MOC was checked against a revision and still holds (clears its mark). */
export function checked(ctx: Ctx, rel: string, event: string): boolean {
  const repo = repoOf(ctx.vault);
  const red = state(ctx);
  const mark = red.stale.find((m) => m.rel === rel && m.event === event);
  if (!repo || !mark) return false;
  const blob = blobOfFile(repo, rel);
  if (!blob) return false;
  append(ctx.vault, mark.shard, ctx.actor, { kind: "checked", rel, blob, event });
  writeProjections(ctx);
  return true;
}

export type { RevisionRelation };
