/**
 * Revision's file-level pieces: the frontmatter edit, the accept lock and the
 * reducer's stage machine. Invented notes and events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { insertEdge, removeEdge, hasEdge, withoutEdges } from "./fm-edit.ts";
import { takeLock, holds, releaseLock } from "./lock.ts";
import { reduce, acceptBlocker, edgeFor, ACCEPT_RETRIES } from "./reducer.ts";
import type { RevEvent } from "./ledger.ts";

const NOTE = "---\ntitle: New Study\ntags:\n  - alpha\nsupersedes:\n  - \"[[Older Draft]]\"\nrelated: x\n---\n# New Study\n\nBody.\n";

test("insertEdge rewrites only the relation's block and round-trips", () => {
  const out = insertEdge(NOTE, "supersedes", "Alpha Study", { claim: "reaches 71%", because: "a leak", kind: "correction" });
  assert.ok(out.startsWith("---\ntitle: New Study\ntags:\n  - alpha\nsupersedes:\n"));
  assert.ok(out.includes('  - "[[Older Draft]]"'), "the existing whole-note edge stays");
  assert.ok(out.includes('  - note: "[[Alpha Study]]"\n    claim: "reaches 71%"\n    because: "a leak"\n    kind: correction'));
  assert.ok(out.endsWith("related: x\n---\n# New Study\n\nBody.\n"), "lines after the block are untouched");
  assert.ok(hasEdge(out, "supersedes", "Alpha Study", "reaches 71%"));
  assert.ok(!hasEdge(out, "supersedes", "Alpha Study", "another claim"));
  // Same note and claim again replaces rather than duplicates.
  const again = insertEdge(out, "supersedes", "Alpha Study", { claim: "reaches 71%", because: "updated", kind: "correction" });
  assert.equal(again.split("Alpha Study").length - 1, 1);
  assert.equal(removeEdge(again, "supersedes", "Alpha Study", "reaches 71%"), NOTE);
});

test("insertEdge adds a new key before the closing fence, or a frontmatter when there is none", () => {
  const out = insertEdge(NOTE, "withdrawsSupport", "Beta Paper", { claim: "c" });
  assert.match(out, /related: x\nwithdraws_support:\n  - note: "\[\[Beta Paper\]\]"\n    claim: "c"\n---/);
  const bare = insertEdge("# Plain\n", "bounds", "Gamma", { claim: "c", within: "w" });
  assert.ok(bare.startsWith("---\nbounds:\n  - note: \"[[Gamma]]\"") && bare.endsWith("---\n# Plain\n"));
});

test("withoutEdges drops every relation block and nothing else", () => {
  const one = insertEdge(NOTE, "bounds", "Gamma", { claim: "c", within: "w" });
  const two = insertEdge(one, "supersedes", "Alpha Study", { claim: "reaches 71%" });
  const bare = "---\ntitle: New Study\ntags:\n  - alpha\nrelated: x\n---\n# New Study\n\nBody.\n";
  assert.equal(withoutEdges(two), bare);
  assert.equal(withoutEdges(NOTE), bare);
  assert.equal(withoutEdges("# Plain\n"), "# Plain\n");
});

test("an edit that would not parse back is refused", () => {
  assert.throws(() => insertEdge("---\nbad: [unclosed\n---\nx", "contests", "A", { claim: "c" }));
});

test("the lock is exclusive, released only by its holder, and taken from a dead or ownerless one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-lock-"));
  try {
    const at = join(dir, "accept.lock");
    const a = takeLock(at, 0)!;
    assert.ok(a && holds(a));
    assert.equal(takeLock(at, 0), null, "a live holder keeps it");
    releaseLock({ dir: at, token: "not-ours" });
    assert.ok(holds(a));
    releaseLock(a);
    assert.ok(!holds(a));

    // A dead holder (an impossible pid on this host) is taken over.
    const b = takeLock(at, 0)!;
    writeFileSync(join(at, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), token: "dead", at: "" }));
    const c = takeLock(at, 0);
    assert.ok(c && holds(c) && !holds(b));
    releaseLock(c!);

    // A directory left with no owner file, long enough ago, is abandoned.
    mkdirSync(at);
    const old = new Date(Date.now() - 120_000);
    utimesSync(at, old, old);
    const d = takeLock(at, 0);
    assert.ok(d && holds(d));
    releaseLock(d!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let seq = 0;
const ev = (e: Record<string, unknown>): RevEvent & { shard: string } =>
  ({ id: `e${String(++seq).padStart(3, "0")}`, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), actor: { type: "t", session: "s" }, shard: "main", ...e }) as never;

const propose = () =>
  ev({ kind: "propose", old: { rel: "Old.md", title: "Old", rev: "r1", claim: "the claim" }, new: { rel: "New.md", title: "New", rev: "r2" }, inputScope: ["main"], origin: "agent" });
const review = (pid: string, verdict: string, extra: Record<string, unknown> = {}) =>
  ev({ kind: "review", proposal: pid, verdict, quotesOld: [], quotesNew: [], model: "m", oldFirst: false, ...extra });

test("reducer: the stages advance in order and the edge carries the decision", () => {
  const p = propose();
  const evs = [p, review(p.id, "bounds", { within: "small inputs", because: "b" })];
  assert.equal(reduce(evs).proposals.get(p.id)!.status, "verify");
  evs.push(ev({ kind: "verify", proposal: p.id, result: "confirmed", evidence: [], model: "m" }));
  assert.equal(reduce(evs).proposals.get(p.id)!.status, "because");
  evs.push(ev({ kind: "because", proposal: p.id, text: "holds only for small inputs", checked: true }));
  const st = reduce(evs).proposals.get(p.id)!;
  assert.equal(st.status, "accept");
  assert.equal(acceptBlocker(st), null);
  const e = edgeFor(st)!;
  assert.deepEqual(e.rel, { claim: "the claim", because: "holds only for small inputs", within: "small inputs" });

  evs.push(ev({ kind: "accept", proposal: p.id, seq: 1, key: e.key, relation: "bounds", from: "New.md", to: "Old", rel: e.rel, expectedParent: "abc" }));
  assert.equal(reduce(evs).proposals.get(p.id)!.status, "accepting", "prepared, not yet committed");
  const acc = evs[evs.length - 1];
  evs.push(ev({ kind: "committed", accept: acc.id, commit: "c1" }));
  const r = reduce(evs);
  assert.equal(r.proposals.get(p.id)!.status, "accepted");
  assert.equal(r.accepted.length, 1);
  evs.push(ev({ kind: "revert", accept: acc.id, reason: "undo" }));
  const r2 = reduce(evs);
  assert.equal(r2.proposals.get(p.id)!.status, "reverted");
  assert.equal(r2.accepted.length, 0);
});

test("reducer: unsure goes to one escalation, then accept or pending — never a human", () => {
  const p = propose();
  const evs = [p, review(p.id, "insufficient")];
  assert.equal(reduce(evs).proposals.get(p.id)!.status, "escalate");
  evs.push(ev({ kind: "escalate", proposal: p.id, verdict: "supersedes", kindOf: "correction", quotesOld: [], quotesNew: [], model: "big" }));
  const st = reduce(evs).proposals.get(p.id)!;
  assert.equal(st.status, "because");
  assert.equal(st.decision?.escalated, true);

  const q = propose();
  const evs2 = [q, review(q.id, "supersedes"), ev({ kind: "verify", proposal: q.id, result: "refuted", evidence: [], model: "m" })];
  assert.equal(reduce(evs2).proposals.get(q.id)!.status, "escalate", "a refuted verify is escalated, not accepted");
  evs2.push(ev({ kind: "pending", proposal: q.id, reason: "could not ground", packet: "x" }));
  assert.equal(reduce(evs2).proposals.get(q.id)!.status, "pending");
});

test("reducer: a commit that failed never becomes accepted; acceptBlocker guards bounds without conditions", () => {
  const p = propose();
  const evs = [p, review(p.id, "supersedes"), ev({ kind: "verify", proposal: p.id, result: "confirmed", evidence: [], model: "m" })];
  evs.push(ev({ kind: "because", proposal: p.id, text: "t", checked: true }));
  const acc = ev({ kind: "accept", proposal: p.id, seq: 1, key: "k", relation: "supersedes", from: "New.md", to: "Old", rel: { claim: "the claim" }, expectedParent: "abc" });
  evs.push(acc, ev({ kind: "accept-failed", accept: acc.id, reason: "conflict" }), ev({ kind: "committed", accept: acc.id, commit: "late" }));
  const r = reduce(evs);
  assert.equal(r.proposals.get(p.id)!.status, "pending");
  assert.equal(r.accepted.length, 0);

  // A commit that failed for a passing reason goes back to "accept", up to the retry limit.
  const t = propose();
  const tev = [t, review(t.id, "supersedes"), ev({ kind: "verify", proposal: t.id, result: "confirmed", evidence: [], model: "m" }), ev({ kind: "because", proposal: t.id, text: "t", checked: true })];
  for (let i = 1; i <= ACCEPT_RETRIES; i++) {
    const a = ev({ kind: "accept", proposal: t.id, seq: i, key: "k2", relation: "supersedes", from: "New.md", to: "Old", rel: { claim: "the claim" }, expectedParent: "abc" });
    tev.push(a, ev({ kind: "accept-failed", accept: a.id, reason: "the branch kept moving", retry: true }));
    assert.equal(reduce(tev).proposals.get(t.id)!.status, i < ACCEPT_RETRIES ? "accept" : "pending", `after ${i} failures`);
  }
  // And a retry that commits is accepted.
  const u = propose();
  const uev = [u, review(u.id, "supersedes"), ev({ kind: "verify", proposal: u.id, result: "confirmed", evidence: [], model: "m" }), ev({ kind: "because", proposal: u.id, text: "t", checked: true })];
  const a1 = ev({ kind: "accept", proposal: u.id, seq: 1, key: "k3", relation: "supersedes", from: "New.md", to: "Old", rel: { claim: "the claim" }, expectedParent: "abc" });
  const a2 = ev({ kind: "accept", proposal: u.id, seq: 2, key: "k3", relation: "supersedes", from: "New.md", to: "Old", rel: { claim: "the claim" }, expectedParent: "def" });
  uev.push(a1, ev({ kind: "accept-failed", accept: a1.id, reason: "busy", retry: true }), a2, ev({ kind: "committed", accept: a2.id, commit: "c2" }));
  const ur = reduce(uev);
  assert.equal(ur.proposals.get(u.id)!.status, "accepted");
  assert.equal(ur.accepted.length, 1);
  assert.equal(ur.accepted[0].event, a2.id);

  const q = propose();
  const st = reduce([q, review(q.id, "bounds"), ev({ kind: "verify", proposal: q.id, result: "confirmed", evidence: [], model: "m" })]).proposals.get(q.id)!;
  assert.equal(acceptBlocker(st), "bounds without conditions");
});

test("reducer: a claimed job whose lease ran out goes back to the queue, and is abandoned at the attempt limit", () => {
  const q = ev({ kind: "job-queued", job: "j1", key: "k", written: [{ rel: "New.md", rev: "r" }], reads: [], origin: "main" });
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(reduce([q, ev({ kind: "job-claimed", job: "j1", until: future })]).jobs.get("j1")!.status, "claimed");
  assert.equal(reduce([q, ev({ kind: "job-claimed", job: "j1", until: past })]).jobs.get("j1")!.status, "queued");
  const three = [q, ...[1, 2].flatMap(() => [ev({ kind: "job-claimed", job: "j1", until: future }), ev({ kind: "job-failed", job: "j1", reason: "x" })]), ev({ kind: "job-claimed", job: "j1", until: past })];
  assert.equal(reduce(three).jobs.get("j1")!.status, "abandoned");
  assert.equal(reduce([q, ev({ kind: "job-claimed", job: "j1", until: future }), ev({ kind: "job-done", job: "j1", poolSize: 1, truncated: false, changed: 0, proposals: 0 })]).jobs.get("j1")!.status, "done");
});
