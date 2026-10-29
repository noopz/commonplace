#!/usr/bin/env node
/**
 * Vault revision (docs/revision-design.md). Deterministic steps only — the
 * module makes the model calls and records their results here.
 *
 *   commonplace revise ensure                         recover, enable auto mode where possible
 *   commonplace revise propose --old <ref> --new <ref> --claim "<exact quote>" [--rationale "…"] [--origin …] [--input <ref>]…
 *   commonplace revise next                           the next step's packet (JSON) or {"none":true}
 *   commonplace revise record --proposal <id> --stage <stage>   (result JSON on stdin)
 *   commonplace revise accept --proposal <id>
 *   commonplace revise revert --event <id> [--reason "…"]
 *   commonplace revise log [--note <ref>] [--limit N]
 *   commonplace revise status
 *   commonplace revise pause | resume
 *   commonplace revise checked --note <rel> --event <id>     a concept still holds after a revision
 *   commonplace revise job-enqueue                    (one finished unit's {written, reads, origin, unit, pairs?} on stdin)
 *   commonplace revise job-next | job-done --job <id> (counts on stdin) | job-failed --job <id> --reason "…"
 *
 * Common: [--vault <path>] [--json]. Scope comes from COMMONPLACE_OPEN, which
 * only the module sets (from shards the person opened).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { resolveVault } from "./lib/vault.ts";
import { parseFrontmatter } from "../hooks/lib/index/yaml.ts";
import { MAIN, append, newId, type Actor } from "./lib/revision/ledger.ts";
import { acceptBlocker, edgeFor, type ProposalState } from "./lib/revision/reducer.ts";
import {
  accept,
  checked,
  ensureEnabled,
  propose,
  recover,
  record,
  revert,
  state,
  writeProjections,
  type Ctx,
} from "./lib/revision/engine.ts";
import { loadArtifact, passages, sourceRefs, type Artifact } from "./lib/revision/artifact.ts";
import { openShardsFromEnv } from "./lib/revision/vault-index.ts";
import { enqueue, claim, finish, fail } from "./lib/revision/jobs.ts";
import { describeDecision } from "../hooks/lib/revision/review.ts";
import { statusLine } from "../hooks/lib/revision/edges.ts";

const sub = process.argv[2] ?? "status";
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    vault: { type: "string" },
    json: { type: "boolean", default: false },
    old: { type: "string" },
    new: { type: "string" },
    claim: { type: "string" },
    rationale: { type: "string" },
    origin: { type: "string" },
    input: { type: "string", multiple: true, default: [] },
    proposal: { type: "string" },
    stage: { type: "string" },
    event: { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
    limit: { type: "string" },
    open: { type: "string" },
    offline: { type: "boolean", default: false },
    job: { type: "string" },
  },
});

const vault = resolveVault(values.vault).vaultPath;
const actor: Actor = {
  type: process.env.COMMONPLACE_ACTOR || "cli",
  session: process.env.COMMONPLACE_SESSION || `cli-${new Date().toISOString().slice(0, 10)}`,
  ...(process.env.COMMONPLACE_UNIT ? { unit: process.env.COMMONPLACE_UNIT } : {}),
};
const ctx: Ctx = { vault, actor, open: openShardsFromEnv() };

const print = (obj: unknown, text?: string) => console.log(values.json || text === undefined ? JSON.stringify(obj) : text);

async function stdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");
  for await (const c of process.stdin) chunks.push(c as string);
  const t = chunks.join("").trim();
  return t ? (JSON.parse(t) as Record<string, unknown>) : {};
}

const noteText = (rel: string) => {
  try {
    return parseFrontmatter(readFileSync(join(vault, rel), "utf-8")).body.trim();
  } catch {
    return "";
  }
};
const rawText = (rel: string) => {
  try {
    return readFileSync(join(vault, rel), "utf-8");
  } catch {
    return "";
  }
};

async function artifactOf(rel: string): Promise<Artifact | null> {
  for (const r of sourceRefs(vault, rawText(rel))) {
    const a = await loadArtifact(vault, r, { offline: values.offline });
    if (a) return a;
  }
  return null;
}

const DEFER_MS = 10 * 60_000;
const STAGES = new Set(["review", "verify", "escalate", "because", "accept"]);

function nextProposal(): ProposalState | null {
  const red = state(ctx);
  const now = Date.now();
  const ready = [...red.proposals.values()].filter(
    (p) => STAGES.has(p.status) && !(p.status === "accept" && p.deferredAt && now - Date.parse(p.deferredAt) < DEFER_MS),
  );
  // Deepest stage first, so a case finishes before new ones start.
  const depth: Record<string, number> = { accept: 0, because: 1, escalate: 2, verify: 3, review: 4 };
  ready.sort((a, b) => depth[a.status] - depth[b.status] || (a.id < b.id ? -1 : 1));
  return ready[0] ?? null;
}

switch (sub) {
  case "ensure": {
    const rec = recover(ctx);
    const en = await ensureEnabled(ctx);
    const red = state(ctx);
    const work = [...red.proposals.values()].filter((p) => STAGES.has(p.status)).length;
    const jobs = [...red.jobs.values()].filter((j) => j.status === "queued").length;
    print({ ...en, recovered: rec, paused: red.paused, work, jobs, scopes: Object.fromEntries([...red.scopes].map(([s, v]) => [s === MAIN ? "main" : "private", v.mode])) });
    break;
  }

  case "propose": {
    const body = await stdinJson();
    const r = await propose(ctx, {
      old: String(values.old ?? body.old ?? ""),
      new: String(values.new ?? body.new ?? ""),
      claim: String(values.claim ?? body.claim ?? ""),
      inputs: [...((values.input as string[]) ?? []), ...(Array.isArray(body.inputs) ? body.inputs.map(String) : [])],
      origin: (values.origin ?? body.origin ?? "agent") as never,
      rationale: String(values.rationale ?? body.rationale ?? "") || undefined,
    });
    print(r, r.status === "proposed" ? `Proposed (${r.id}); reviewers will judge it blind.` : r.status === "duplicate" ? `Already proposed (${r.id}, ${r.state}).` : `Not proposed: ${r.reason}`);
    if (r.status === "refused") process.exitCode = 1;
    break;
  }

  case "next": {
    const p = nextProposal();
    if (!p) {
      print({ none: true });
      break;
    }
    const old = { title: p.propose.old.title, rel: p.propose.old.rel };
    const neu = { title: p.propose.new.title, rel: p.propose.new.rel };
    const base = { proposal: p.id, stage: p.status, claim: p.propose.old.claim, older: old, newer: neu };
    if (p.status === "review") {
      print({ ...base, olderText: noteText(old.rel), newerText: noteText(neu.rel), oldFirst: Math.random() < 0.5 });
    } else if (p.status === "verify" || p.status === "escalate") {
      const [oa, na] = await Promise.all([artifactOf(old.rel), artifactOf(neu.rel)]);
      const d = p.decision;
      if (p.status === "verify") {
        const query = [p.propose.old.claim, d?.within ?? "", ...(p.reviews[0]?.quotesOld ?? [])].join(" ");
        const nquery = [p.propose.old.claim, d?.because ?? "", ...(p.reviews[0]?.quotesNew ?? [])].join(" ");
        print({
          ...base,
          decision: d ? describeDecision(d) : "",
          olderArtifact: oa ? { hash: oa.hash, passages: passages(oa, query) } : null,
          newerArtifact: na ? { hash: na.hash, passages: passages(na, nquery) } : null,
        });
      } else {
        print({
          ...base,
          olderText: noteText(old.rel),
          newerText: noteText(neu.rel),
          olderSource: oa ? { hash: oa.hash, text: oa.text.slice(0, 60_000) } : null,
          newerSource: na ? { hash: na.hash, text: na.text.slice(0, 60_000) } : null,
        });
      }
    } else if (p.status === "because") {
      const v = p.verifies[p.verifies.length - 1];
      print({
        ...base,
        decision: p.decision ? describeDecision(p.decision) : "",
        confirmed: [p.decision?.because ?? "", p.decision?.escalated ? "" : v?.reason ?? ""].filter(Boolean).join(" "),
        draft: p.decision?.because ?? "",
        rationale: p.propose.rationale ?? "",
      });
    } else {
      print({ ...base, blocker: acceptBlocker(p) });
    }
    break;
  }

  case "record": {
    const id = values.proposal ?? "";
    const stage = values.stage ?? "";
    const body = await stdinJson();
    const red = state(ctx);
    const p = red.proposals.get(id);
    if (!p) {
      print({ error: "no such proposal" });
      process.exitCode = 1;
      break;
    }
    const model = String(body.model ?? "");
    const verdictFields = () => ({
      verdict: body.verdict as never,
      ...(body.kindOf ? { kindOf: body.kindOf as never } : {}),
      ...(body.within ? { within: String(body.within) } : {}),
      ...(body.effective ? { effective: String(body.effective) } : {}),
      ...(body.because ? { because: String(body.because) } : {}),
      quotesOld: Array.isArray(body.quotesOld) ? body.quotesOld.map(String) : [],
      quotesNew: Array.isArray(body.quotesNew) ? body.quotesNew.map(String) : [],
      model,
    });
    if (stage === "review") {
      record(ctx, id, { kind: "review", proposal: id, ...verdictFields(), oldFirst: body.oldFirst === true });
      if (body.verdict === "none") record(ctx, id, { kind: "reject", proposal: id, reason: "the reviewer found no relation", packet: p.packet });
    } else if (stage === "verify") {
      const ev = Array.isArray(body.evidence) ? (body.evidence as Array<Record<string, string>>).map((e) => ({ note: String(e.note), artifact: String(e.artifact), locator: String(e.locator) })) : [];
      record(ctx, id, { kind: "verify", proposal: id, result: (body.result as never) ?? "abstain", evidence: ev, ...(body.reason ? { reason: String(body.reason) } : {}), model });
    } else if (stage === "escalate") {
      const grounded = body.grounded === true;
      const verdict = grounded ? body.verdict : "insufficient";
      record(ctx, id, { kind: "escalate", proposal: id, ...verdictFields(), verdict: verdict as never });
      if (verdict === "none") record(ctx, id, { kind: "reject", proposal: id, reason: "the stronger review found no relation", packet: p.packet });
      else if (verdict === "insufficient") {
        record(ctx, id, { kind: "pending", proposal: id, reason: grounded ? "the stronger review could not decide" : body.unreachable ? "the sources could not be reached" : "the stronger review could not ground its verdict in the sources", packet: p.packet });
      }
    } else if (stage === "because") {
      if (typeof body.flipped === "boolean") record(ctx, id, { kind: "rationale-seen", proposal: id, flipped: body.flipped });
      record(ctx, id, { kind: "because", proposal: id, text: String(body.text ?? p.decision?.because ?? ""), checked: body.checked === true });
    } else if (stage === "deferred") {
      record(ctx, id, { kind: "deferred", proposal: id, reason: String(body.reason ?? "") });
    } else {
      print({ error: `unknown stage "${stage}"` });
      process.exitCode = 1;
      break;
    }
    const after = state(ctx).proposals.get(id);
    print({ proposal: id, status: after?.status });
    break;
  }

  case "accept": {
    const r = await accept(ctx, values.proposal ?? "");
    if (r.status === "deferred") record(ctx, values.proposal ?? "", { kind: "deferred", proposal: values.proposal ?? "", reason: r.reason });
    let line: string | undefined;
    if (r.status === "accepted") {
      const p = state(ctx).proposals.get(values.proposal ?? "");
      const e = p && edgeFor(p);
      if (p && e) line = statusLine({ relation: e.relation, by: p.propose.new.title, rel: e.rel, reviewed: true }).replace(/^⚠ /, "");
      print({ ...r, ...(p ? { old: p.propose.old.title, new: p.propose.new.title, line } : {}) });
    } else print(r);
    break;
  }

  case "revert": {
    // `last`: the most recent accepted revision in the open scopes.
    const ev = values.event === "last" ? (state(ctx).accepted.at(-1)?.event ?? "") : (values.event ?? "");
    const r = await revert(ctx, ev, values.reason ?? "reverted");
    print(r, r.status === "reverted" ? `Reverted (${r.revert})${r.commit ? `, commit ${r.commit.slice(0, 10)}` : ""}${r.conflict ? `; the file kept its edge: ${r.conflict}` : ""}.` : `Not reverted: ${r.reason}`);
    if (r.status !== "reverted") process.exitCode = 1;
    break;
  }

  case "pause":
  case "resume": {
    append(vault, MAIN, actor, { kind: sub });
    print({ ok: true, paused: sub === "pause" }, sub === "pause" ? "Revision paused: nothing will be accepted until /vault revise resume." : "Revision resumed.");
    break;
  }

  case "checked": {
    const ok = checked(ctx, values.note ?? "", values.event ?? "");
    print({ ok }, ok ? "Recorded: the note was checked against that revision and still holds." : "No such stale mark for that note and event.");
    break;
  }

  case "job-enqueue": {
    const body = await stdinJson();
    const r = await enqueue(ctx, {
      written: Array.isArray(body.written) ? body.written.map(String) : [],
      reads: Array.isArray(body.reads)
        ? (body.reads as unknown[]).map((r) => (r && typeof r === "object" ? { rel: String((r as Record<string, unknown>).rel), rev: String((r as Record<string, unknown>).rev ?? "") } : String(r)))
        : [],
      ...(Array.isArray(body.pairs) ? { pairs: (body.pairs as Array<Record<string, unknown>>).map((p) => ({ written: String(p.written), old: String(p.old), why: String(p.why ?? "") })) } : {}),
      origin: String(body.origin ?? actor.type),
      ...(body.unit ? { unit: String(body.unit) } : {}),
    });
    print(r);
    break;
  }

  case "job-next": {
    print(claim(ctx));
    break;
  }

  case "job-done": {
    const body = await stdinJson();
    print({ ok: finish(ctx, values.job ?? "", body) });
    break;
  }

  case "job-failed": {
    print({ status: fail(ctx, values.job ?? "", values.reason ?? "failed") });
    break;
  }

  case "projection": {
    writeProjections(ctx);
    print({ ok: true });
    break;
  }

  case "log": {
    const red = state(ctx);
    const limit = Number(values.limit ?? 20) || 20;
    let list = [...red.proposals.values()];
    if (values.note) {
      const q = values.note.toLowerCase().replace(/\.md$/, "");
      list = list.filter((p) => [p.propose.old.title, p.propose.new.title, p.propose.old.rel, p.propose.new.rel].some((x) => x.toLowerCase().replace(/\.md$/, "").includes(q)));
    }
    list.sort((a, b) => (a.id < b.id ? 1 : -1));
    const rows = list.slice(0, limit).map((p) => {
      const e = edgeFor(p);
      return {
        proposal: p.id,
        accept: p.accept?.id,
        status: p.status,
        old: p.propose.old.title,
        new: p.propose.new.title,
        claim: p.propose.old.claim,
        relation: e?.relation,
        because: e?.rel.because,
        commit: p.committed?.commit,
        reason: p.terminal && "reason" in p.terminal ? p.terminal.reason : p.revert?.reason,
        private: p.shard !== MAIN || undefined,
      };
    });
    const text = rows.length
      ? rows
          .map((r) => `${r.status.padEnd(9)} [[${r.old}]] ← [[${r.new}]]${r.relation ? ` (${r.relation})` : ""}\n          claim: "${r.claim}"${r.because ? `\n          because: ${r.because}` : ""}${r.reason ? `\n          note: ${r.reason}` : ""}${r.accept ? `\n          event ${r.accept}${r.commit ? ` · commit ${r.commit.slice(0, 10)}` : ""}` : ""}`)
          .join("\n")
      : "No revisions yet.";
    print(rows, text);
    break;
  }

  case "status":
  default: {
    const red = state(ctx);
    const counts: Record<string, number> = {};
    for (const p of red.proposals.values()) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const mode = red.scopes.get(MAIN)?.mode ?? "manual";
    const out = { mode, paused: red.paused, accepted: red.accepted.length, counts, stale: red.stale.length };
    print(out, `revision: ${mode}${red.paused ? " (paused)" : ""} · ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ") || "no proposals"}${red.stale.length ? ` · ${red.stale.length} summaries to recheck` : ""}`);
  }
}
