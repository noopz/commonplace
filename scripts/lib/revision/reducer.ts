/**
 * The reducer: ledger events → the state of every proposal and the accepted
 * edges (docs/revision-design.md, "Trust model": only the reducer creates
 * accepted state). Pure: the CLI reads the ledger and hands the events in.
 *
 * A proposal moves through
 *   review → verify → because → accept
 * with `escalate` (one stronger model reading the full sources) taken once
 * when the review is unsure or the verifier cannot confirm, and `pending`
 * (no edge, no label) when even that stays unsure. Nothing waits for a human.
 */

import { createHash } from "crypto";
import { edgeKey, type EdgeRel, type RevisionRelation } from "../../../hooks/lib/revision/edges.ts";
import type { AcceptedEdge, StaleMark } from "../../../hooks/lib/revision/projection.ts";
import type { RevEvent } from "./ledger.ts";

type E<K extends RevEvent["kind"]> = Extract<RevEvent, { kind: K }> & { shard: string };

export type Stage = "review" | "verify" | "escalate" | "because" | "accept";
export type Status = Stage | "accepting" | "accepted" | "pending" | "rejected" | "withdrawn" | "reverted";

export type Decision = {
  relation: RevisionRelation;
  kindOf?: "correction" | "world-change";
  within?: string;
  effective?: string;
  because?: string;
  /** Escalated: the stronger model read the full sources itself. */
  escalated: boolean;
};

export type ProposalState = {
  id: string;
  shard: string;
  propose: E<"propose">;
  reviews: E<"review">[];
  verifies: E<"verify">[];
  escalation?: E<"escalate">;
  because?: E<"because">;
  accept?: E<"accept">;
  committed?: E<"committed">;
  failed?: E<"accept-failed">;
  revert?: E<"revert">;
  terminal?: E<"pending"> | E<"reject"> | E<"withdraw">;
  /** Last time an accept was put off (uncommitted note, paused, lock): retried later, not looped on. */
  deferredAt?: string;
  status: Status;
  decision?: Decision;
  /** Identity independent of relation: (newer note, older note, claim). */
  identity: string;
  /** Hash of the evidence this proposal was judged on (reopen key). */
  packet: string;
};

export type Reduced = {
  proposals: Map<string, ProposalState>;
  /** Each with the scope of the ledger it was accepted in. */
  accepted: Array<AcceptedEdge & { shard: string }>;
  /** Per scope ("main" or a shard): its mode and legacy baseline, from its latest `enable`. */
  scopes: Map<string, { mode: "auto" | "manual"; baseline: string[] }>;
  paused: boolean;
  maxSeq: number;
  stale: Array<StaleMark & { shard: string }>;
  checked: Array<{ rel: string; blob: string; event: string }>;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export const identityOf = (p: { old: { rel: string; claim: string }; new: { rel: string } }) =>
  [p.new.rel, p.old.rel, norm(p.old.claim)].join("\u001f");

/** The evidence packet: note versions, the claim, and every artifact passage examined. */
export function packetOf(p: E<"propose">, verifies: readonly E<"verify">[] = []): string {
  const h = createHash("sha256");
  h.update([p.old.rel, p.old.rev, p.new.rel, p.new.rev, norm(p.old.claim)].join("\n"));
  for (const v of verifies) for (const e of v.evidence) h.update(`\n${e.note}|${e.artifact}|${e.locator}`);
  return h.digest("hex").slice(0, 24);
}

function decide(p: ProposalState): void {
  const review = p.reviews[0];
  if (p.terminal) {
    p.status = p.terminal.kind === "pending" ? "pending" : p.terminal.kind === "reject" ? "rejected" : "withdrawn";
  }
  const fromVerdict = (v: E<"review"> | E<"escalate">, escalated: boolean): Decision | undefined =>
    v.verdict === "none" || v.verdict === "insufficient"
      ? undefined
      : {
          relation: v.verdict,
          ...(v.kindOf ? { kindOf: v.kindOf } : {}),
          ...(v.within ? { within: v.within } : {}),
          ...(v.effective ? { effective: v.effective } : {}),
          ...(v.because ? { because: v.because } : {}),
          escalated,
        };
  if (p.escalation) p.decision = fromVerdict(p.escalation, true);
  else if (review) p.decision = fromVerdict(review, false);
  if (p.terminal) return;

  if (p.accept) {
    if (p.revert) p.status = "reverted";
    else if (p.committed) p.status = "accepted";
    else if (p.failed) p.status = "pending";
    else p.status = "accepting";
    return;
  }
  if (!review) {
    p.status = "review";
    return;
  }
  if (p.escalation) {
    // The stronger model read the full sources itself: its verdict is grounded or nothing is.
    p.status = p.decision ? (p.because ? "accept" : "because") : "pending";
    return;
  }
  if (review.verdict === "none") {
    p.status = "rejected";
    return;
  }
  if (review.verdict === "insufficient") {
    p.status = "escalate";
    return;
  }
  const v = p.verifies[p.verifies.length - 1];
  if (!v) {
    p.status = "verify";
    return;
  }
  if (v.result !== "confirmed") {
    p.status = "escalate";
    return;
  }
  p.status = p.because ? "accept" : "because";
}

export function reduce(events: ReadonlyArray<RevEvent & { shard: string }>): Reduced {
  const proposals = new Map<string, ProposalState>();
  const accepts = new Map<string, ProposalState>();
  const scopes: Reduced["scopes"] = new Map();
  let paused = false;
  let maxSeq = 0;
  const staleByEvent = new Map<string, { marks: Array<{ rel: string; displaced: string }>; shard: string }>();
  const checked: Reduced["checked"] = [];

  for (const e of events) {
    switch (e.kind) {
      case "propose": {
        const p: ProposalState = {
          id: e.id,
          shard: e.shard,
          propose: e as E<"propose">,
          reviews: [],
          verifies: [],
          status: "review",
          identity: identityOf(e),
          packet: packetOf(e as E<"propose">),
        };
        proposals.set(e.id, p);
        break;
      }
      case "review":
        proposals.get(e.proposal)?.reviews.push(e as E<"review">);
        break;
      case "verify":
        proposals.get(e.proposal)?.verifies.push(e as E<"verify">);
        break;
      case "escalate": {
        const p = proposals.get(e.proposal);
        if (p && !p.escalation) p.escalation = e as E<"escalate">;
        break;
      }
      case "because": {
        const p = proposals.get(e.proposal);
        if (p) p.because = e as E<"because">;
        break;
      }
      case "accept": {
        const p = proposals.get(e.proposal);
        if (p && !p.accept) {
          p.accept = e as E<"accept">;
          accepts.set(e.id, p);
        }
        maxSeq = Math.max(maxSeq, e.seq);
        break;
      }
      case "committed": {
        const p = accepts.get(e.accept);
        if (p && !p.failed) p.committed = e as E<"committed">;
        break;
      }
      case "accept-failed": {
        const p = accepts.get(e.accept);
        if (p && !p.committed) p.failed = e as E<"accept-failed">;
        break;
      }
      case "revert": {
        const p = accepts.get(e.accept);
        if (p && p.committed && !p.revert) p.revert = e as E<"revert">;
        break;
      }
      case "pending":
      case "reject":
      case "withdraw": {
        const p = proposals.get(e.proposal);
        if (p && !p.accept) p.terminal = e as E<"pending"> | E<"reject"> | E<"withdraw">;
        break;
      }
      case "deferred": {
        const p = proposals.get(e.proposal);
        if (p) p.deferredAt = e.at;
        break;
      }
      case "enable":
        scopes.set(e.shard, { mode: e.mode, baseline: e.baseline });
        break;
      case "pause":
        paused = true;
        break;
      case "resume":
        paused = false;
        break;
      case "stale":
        staleByEvent.set(e.event, { marks: e.marks, shard: e.shard });
        break;
      case "checked":
        checked.push({ rel: e.rel, blob: e.blob, event: e.event });
        break;
    }
  }

  const accepted: Reduced["accepted"] = [];
  for (const p of proposals.values()) {
    p.packet = packetOf(p.propose, p.verifies);
    decide(p);
    if (p.status === "accepted" && p.accept && p.committed) {
      accepted.push({
        key: p.accept.key,
        from: p.accept.from,
        relation: p.accept.relation,
        to: p.accept.to,
        rel: p.accept.rel,
        event: p.accept.id,
        seq: p.accept.seq,
        commit: p.committed.commit,
        shard: p.shard,
      });
    }
  }
  accepted.sort((a, b) => a.seq - b.seq);

  // Stale marks from every accept or revert that recorded them; a mark is
  // cleared later by a `checked` receipt the CLI matches against the note.
  const stale: Array<StaleMark & { shard: string }> = [];
  for (const [event, { marks, shard }] of staleByEvent) for (const m of marks) stale.push({ rel: m.rel, displaced: m.displaced, event, shard });

  return { proposals, accepted, scopes, paused, maxSeq, stale, checked };
}

/** The edge an accept of `p` would write. */
export function edgeFor(p: ProposalState): { key: string; relation: RevisionRelation; rel: EdgeRel } | null {
  const d = p.decision;
  if (!d) return null;
  const rel: EdgeRel = {
    claim: norm(p.propose.old.claim),
    ...(p.because?.text || d.because ? { because: norm(p.because?.text || d.because || "") } : {}),
    ...(d.relation === "bounds" && d.within ? { within: norm(d.within) } : {}),
    ...(d.relation === "supersedes" ? { kind: d.kindOf ?? "correction" } : {}),
    ...(d.relation === "supersedes" && d.kindOf === "world-change" && d.effective ? { effective: d.effective } : {}),
  };
  return { key: edgeKey(p.propose.new.rel, d.relation, p.propose.old.title, rel.claim), relation: d.relation, rel };
}

/**
 * Why `p` may not be accepted yet, or null when the relation table's
 * conditions hold (design, "Accept"): a decision, grounding against the
 * artifacts (a verifier confirmation or the escalation's full-source read),
 * `within` for bounds, and an evidenced time when a world change claims one.
 */
export function acceptBlocker(p: ProposalState): string | null {
  const d = p.decision;
  if (!d) return "no decision";
  if (!d.escalated && p.verifies[p.verifies.length - 1]?.result !== "confirmed") return "not confirmed against the artifacts";
  if (d.relation === "bounds" && !d.within) return "bounds without conditions";
  if (!p.propose.old.claim.trim()) return "no claim (whole-note edges are never accepted autonomously)";
  return null;
}
