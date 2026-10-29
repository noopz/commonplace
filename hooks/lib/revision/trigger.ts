/**
 * The write-time trigger (docs/revision-design.md, "Triggers"): when a unit of
 * work wrote notes after reading related ones, a cheap check asks whether any
 * candidate's claims are changed, and a proposer names the exact claim.
 *
 * Candidate pool, per written note: the notes the agent actually read (whole
 * reads that completed), the graph's neighbours, and a search over the note's
 * own title and summary — so a related note the session never opened is still
 * considered. Only scopes the written note may cite are pooled: a public note
 * pools public notes only (public text from public inputs), a private one
 * public notes plus its own shard.
 *
 * Pure: everything outside comes through `TriggerPorts`; every branch logs.
 */

import { MODELS, DETECT_SYSTEM, detectPrompt, parseDetect, PROPOSE_SYSTEM, proposePrompt, parsePropose } from "./review.ts";

export type NoteInfo = { rel: string; title: string; abstraction: string; kind: string; shard: string };

export type TriggerPorts = {
  info(rel: string): Promise<NoteInfo | null>;
  /** Note body without frontmatter, or null. */
  text(rel: string): Promise<string | null>;
  neighbours(rel: string, k: number): Promise<string[]>;
  search(query: string, limit: number): Promise<string[]>;
  complete(req: { model: string; system: string; prompt: string; maxTokens: number }): Promise<string | null>;
  propose(p: { old: string; new: string; claim: string; rationale: string; inputs: string[] }): Promise<{ status: string; reason?: string }>;
  log(stage: string, data: Record<string, unknown>): void;
  /** [0, 1); the detector audit samples on it. */
  random(): number;
};

/**
 * Share of haiku's "nothing changed" answers re-asked of a stronger model.
 * Haiku's misses are invisible to everything downstream, so they are measured
 * here (`revision:audit`, agree or not) — and a change the audit finds is
 * proposed like any other rather than thrown away.
 */
export const AUDIT_RATE = 0.1;
export const AUDIT_MODEL = "sonnet";

export const POOL_MAX = 12;
export const WRITTEN_MAX = 3;
export const PROPOSALS_MAX = 3;
const CLAIM_KINDS = new Set(["source", "other"]);

export type TriggerJob = { written: string[]; reads: string[] };
export type TriggerResult = { examined: number; pool: number; truncated: boolean; changed: number; proposed: number };

export async function runTrigger(ports: TriggerPorts, job: TriggerJob): Promise<TriggerResult> {
  const res: TriggerResult = { examined: 0, pool: 0, truncated: false, changed: 0, proposed: 0 };
  const written = [...new Set(job.written)].slice(0, WRITTEN_MAX);
  if (job.written.length > WRITTEN_MAX) ports.log("revision:written-truncated", { written: job.written.length });
  for (const rel of written) {
    if (res.proposed >= PROPOSALS_MAX) break;
    const w = await ports.info(rel);
    if (!w) {
      ports.log("revision:skip", { why: "not-visible" });
      continue;
    }
    if (!CLAIM_KINDS.has(w.kind)) {
      // Summaries (concepts, MOCs) are revised through stale marks, not proposals.
      ports.log("revision:skip", { why: `kind-${w.kind}` });
      continue;
    }
    const wText = await ports.text(rel);
    if (!wText) continue;
    res.examined++;
    const allowed = (s: string) => s === "main" || s === w.shard;

    const seen = new Set<string>([rel]);
    const pool: NoteInfo[] = [];
    let offered = 0;
    const consider = async (r: string) => {
      if (seen.has(r)) return;
      seen.add(r);
      const n = await ports.info(r);
      if (!n || !allowed(n.shard) || !CLAIM_KINDS.has(n.kind)) return;
      offered++;
      if (pool.length < POOL_MAX) pool.push(n);
    };
    for (const r of job.reads) await consider(r);
    for (const r of await ports.neighbours(rel, 8)) await consider(r);
    for (const r of await ports.search(`${w.title} ${w.abstraction}`.slice(0, 300), 6)) await consider(r);
    res.pool += pool.length;
    const truncated = offered > pool.length;
    res.truncated ||= truncated;
    if (pool.length === 0) {
      ports.log("revision:pool-empty", { kind: w.kind });
      continue;
    }

    const det = await ports.complete({ model: MODELS.detect, system: DETECT_SYSTEM, prompt: detectPrompt({ title: w.title, text: wText }, pool), maxTokens: 400 });
    let changed = parseDetect(det ?? undefined, pool.length);
    ports.log("revision:detect", { pool: pool.length, truncated, changed: changed?.length ?? -1, answered: det !== null });
    if (changed && changed.length === 0 && ports.random() < AUDIT_RATE) {
      const again = await ports.complete({ model: AUDIT_MODEL, system: DETECT_SYSTEM, prompt: detectPrompt({ title: w.title, text: wText }, pool), maxTokens: 400 });
      const audit = parseDetect(again ?? undefined, pool.length);
      ports.log("revision:audit", { answered: audit !== null, agree: audit !== null && audit.length === 0, found: audit?.length ?? 0 });
      if (audit && audit.length) changed = audit;
    }
    if (!changed || changed.length === 0) continue;
    res.changed += changed.length;

    for (const c of changed) {
      if (res.proposed >= PROPOSALS_MAX) {
        ports.log("revision:proposal-cap", {});
        break;
      }
      const old = pool[c.n - 1];
      const oText = await ports.text(old.rel);
      if (!oText) continue;
      const pr = await ports.complete({
        model: MODELS.propose,
        system: PROPOSE_SYSTEM,
        prompt: proposePrompt({ title: old.title, text: oText }, { title: w.title, text: wText }),
        maxTokens: 500,
      });
      const parsed = parsePropose(pr ?? undefined);
      if (parsed === null || parsed === "none") {
        ports.log("revision:propose-none", { parsed: parsed === null ? "unparsed" : "none" });
        continue;
      }
      const r = await ports.propose({
        old: old.rel,
        new: rel,
        claim: parsed.claim,
        rationale: parsed.rationale || c.why,
        inputs: pool.map((p) => p.rel),
      });
      ports.log("revision:proposed", { status: r.status, ...(r.reason ? { reason: r.reason.slice(0, 80) } : {}) });
      if (r.status === "proposed") res.proposed++;
    }
  }
  return res;
}
