/**
 * The revision runner: takes proposals through review → verify → (escalate)
 * → wording → accept, one step at a time. The CLI (`commonplace revise next`)
 * says which step is due and builds its packet — note texts, artifact
 * passages retrieved by commonplace itself — and records each result; the
 * runner only makes the model calls between. Single-flight per vault (the
 * caller guarantees it) and bounded in steps per run.
 *
 * Pure: the outside world comes through `RunnerPorts`.
 */

import {
  MODELS,
  REVIEW_SYSTEM,
  reviewPrompt,
  parseReview,
  VERIFY_SYSTEM,
  verifyPrompt,
  parseVerify,
  ESCALATE_SYSTEM,
  escalatePrompt,
  parseEscalate,
  WORDING_SYSTEM,
  wordingPrompt,
  parseWording,
  WORDING_CHECK_SYSTEM,
  wordingCheckPrompt,
  parseWordingCheck,
  type ReviewVerdict,
} from "./review.ts";

export type Accepted = { accept: string; old: string; new: string; line?: string; commit: string; stale: number };

export type RunnerPorts = {
  /** `commonplace revise <args>` → parsed JSON, or null on failure. */
  cli(args: string[], stdin?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  complete(req: { model: string; system: string; prompt: string; maxTokens: number }): Promise<string | null>;
  log(stage: string, data: Record<string, unknown>): void;
  onAccepted(a: Accepted): void;
};

export const STEPS_PER_RUN = 8;

type Side = { title: string; rel: string };
type Packet = {
  none?: boolean;
  proposal: string;
  stage: "review" | "verify" | "escalate" | "because" | "accept";
  claim: string;
  older: Side;
  newer: Side;
  olderText?: string;
  newerText?: string;
  oldFirst?: boolean;
  decision?: string;
  olderArtifact?: { hash: string; passages: Array<{ locator: string; text: string }> } | null;
  newerArtifact?: { hash: string; passages: Array<{ locator: string; text: string }> } | null;
  olderSource?: { hash: string; text: string } | null;
  newerSource?: { hash: string; text: string } | null;
  confirmed?: string;
  draft?: string;
  rationale?: string;
};

const verdictBody = (v: ReviewVerdict, model: string) => ({
  verdict: v.verdict,
  ...(v.kindOf ? { kindOf: v.kindOf } : {}),
  ...(v.within ? { within: v.within } : {}),
  ...(v.effective ? { effective: v.effective } : {}),
  ...(v.because ? { because: v.because } : {}),
  quotesOld: v.quotesOld,
  quotesNew: v.quotesNew,
  model,
});

/** Run up to `max` steps; returns how many ran. */
export async function runSteps(ports: RunnerPorts, max = STEPS_PER_RUN): Promise<number> {
  let n = 0;
  const tried = new Set<string>();
  for (; n < max; n++) {
    const p = (await ports.cli(["next"])) as unknown as Packet | null;
    if (!p || p.none) break;
    const key = `${p.proposal}:${p.stage}`;
    if (tried.has(key)) {
      // The same step came back: the last attempt recorded nothing. Stop rather than spin.
      ports.log("revision:stuck", { stage: p.stage });
      break;
    }
    tried.add(key);
    const record = (stage: string, body: Record<string, unknown>) => ports.cli(["record", "--proposal", p.proposal, "--stage", stage], body);

    if (p.stage === "review") {
      const text = await ports.complete({
        model: MODELS.review,
        system: REVIEW_SYSTEM,
        prompt: reviewPrompt({ claim: p.claim, older: { title: p.older.title, text: p.olderText ?? "" }, newer: { title: p.newer.title, text: p.newerText ?? "" }, oldFirst: p.oldFirst === true }),
        maxTokens: 900,
      });
      const v = parseReview(text ?? undefined);
      ports.log("revision:review", { answered: text !== null, verdict: v?.verdict ?? "unparsed" });
      if (!v) break; // no answer is not a verdict: try again next run
      await record("review", { ...verdictBody(v, MODELS.review), oldFirst: p.oldFirst === true });
    } else if (p.stage === "verify") {
      if (!p.olderArtifact && !p.newerArtifact) {
        ports.log("revision:verify", { result: "abstain", why: "sources-unreachable" });
        await record("verify", { result: "abstain", reason: "neither source could be retrieved", evidence: [], model: "none" });
        continue;
      }
      const text = await ports.complete({
        model: MODELS.verify,
        system: VERIFY_SYSTEM,
        prompt: verifyPrompt({
          claim: p.claim,
          decision: p.decision ?? "",
          older: { title: p.older.title, passages: p.olderArtifact?.passages ?? [] },
          newer: { title: p.newer.title, passages: p.newerArtifact?.passages ?? [] },
        }),
        maxTokens: 400,
      });
      const v = parseVerify(text ?? undefined);
      ports.log("revision:verify", { answered: text !== null, result: v?.result ?? "unparsed" });
      if (!v) break;
      const evidence = [
        ...(p.olderArtifact?.passages ?? []).map((x) => ({ note: p.older.rel, artifact: p.olderArtifact!.hash, locator: x.locator })),
        ...(p.newerArtifact?.passages ?? []).map((x) => ({ note: p.newer.rel, artifact: p.newerArtifact!.hash, locator: x.locator })),
      ];
      await record("verify", { result: v.result, reason: v.reason, evidence, model: MODELS.verify });
    } else if (p.stage === "escalate") {
      if (!p.olderSource && !p.newerSource) {
        ports.log("revision:escalate", { verdict: "insufficient", why: "sources-unreachable" });
        await record("escalate", { verdict: "insufficient", grounded: false, unreachable: true, model: "none", quotesOld: [], quotesNew: [] });
        continue;
      }
      const text = await ports.complete({
        model: MODELS.escalate,
        system: ESCALATE_SYSTEM,
        prompt: escalatePrompt({
          claim: p.claim,
          older: { title: p.older.title, text: p.olderText ?? "", source: p.olderSource?.text ?? "" },
          newer: { title: p.newer.title, text: p.newerText ?? "", source: p.newerSource?.text ?? "" },
        }),
        maxTokens: 1200,
      });
      const v = parseEscalate(text ?? undefined);
      ports.log("revision:escalate", { answered: text !== null, verdict: v?.verdict ?? "unparsed", grounded: v?.grounded ?? false });
      if (!v) break;
      await record("escalate", { ...verdictBody(v, MODELS.escalate), grounded: v.grounded });
    } else if (p.stage === "because") {
      const text = await ports.complete({
        model: MODELS.wording,
        system: WORDING_SYSTEM,
        prompt: wordingPrompt({ decision: p.decision ?? "", confirmed: p.confirmed ?? "", draft: p.draft ?? "", rationale: p.rationale ?? "" }),
        maxTokens: 300,
      });
      const w = parseWording(text ?? undefined);
      let final = p.draft ?? "";
      let checked = false;
      if (w) {
        const c = await ports.complete({ model: MODELS.wordingCheck, system: WORDING_CHECK_SYSTEM, prompt: wordingCheckPrompt(w.because, p.confirmed ?? ""), maxTokens: 40 });
        const adds = parseWordingCheck(c ?? undefined);
        // Wording that adds a claim the verifier did not confirm is dropped for the reviewer's own draft.
        if (adds === false) {
          final = w.because;
          checked = true;
        }
        ports.log("revision:wording", { flipped: w.flip, adds: adds ?? "unparsed" });
      } else ports.log("revision:wording", { answered: text !== null, parsed: false });
      await record("because", { text: final, checked, ...(w ? { flipped: w.flip } : {}) });
    } else if (p.stage === "accept") {
      const r = await ports.cli(["accept", "--proposal", p.proposal]);
      ports.log("revision:accept", { status: String(r?.status ?? "error"), ...(r?.reason ? { reason: String(r.reason).slice(0, 80) } : {}) });
      if (r?.status === "accepted") {
        ports.onAccepted({
          accept: String(r.accept),
          old: String(r.old ?? p.older.title),
          new: String(r.new ?? p.newer.title),
          ...(r.line ? { line: String(r.line) } : {}),
          commit: String(r.commit ?? ""),
          stale: Number(r.stale ?? 0),
        });
      }
    }
  }
  return n;
}
