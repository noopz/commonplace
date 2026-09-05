/**
 * Scoring for the judge-only eval — pure, no I/O.
 *
 * WHY A SECOND EVAL
 * `eval:connection` measures the whole chain: seed, rate limit, classify,
 * graph walk, read, judge. That is the right thing to measure for the feature
 * and the wrong thing for diagnosing it. Two runs of it scored 5/8 for
 * OPPOSITE reasons — one seeded the right notes and the judge dropped them,
 * the other seeded wrong ones and the judge was right to — and an end-to-end
 * number cannot tell those apart. RAGAS and ARES both isolate components for
 * exactly this reason.
 *
 * So this eval fixes the inputs. Each case is a stored (answer, note) pair and
 * an expected verdict; nothing upstream of the judge can vary. It is the only
 * way to say whether a change to JUDGE_SYSTEM helped, and it costs no seeding,
 * no walk and no full session.
 *
 * SELF-CONSISTENCY IS SCORED, NOT ASSUMED. The judge is a sampled model call,
 * so `--repeat` runs each case N times and reports how often it agrees with
 * itself. The LLM-as-judge literature is blunt about why this matters and
 * about its limit: high test-retest reliability coexists happily with severe
 * bias, so agreement is a floor on trustworthiness, never evidence of
 * correctness. Read it alongside precision, never instead of it.
 */

/** What the judge should say about one (answer, note) pair. */
export type JudgeExpect = "surface" | "skip";

export type JudgeCase = {
  id: string;
  /** Basename in `<wiki>/evals/answers/`, or inline text via `answer`. */
  answerFile?: string;
  answer?: string;
  /** Vault-relative path of the note the judge is shown. */
  note: string;
  expect: JudgeExpect;
  /** Why this case exists. Free text, printed on failure. */
  why?: string;
};

export type JudgeTrial = {
  /** The judge's one-line verdict, or "" for SKIP. */
  verdict: string;
  ms: number;
};

export type JudgeResult = {
  id: string;
  expect: JudgeExpect;
  trials: JudgeTrial[];
  /** Majority decision across trials. Ties resolve to "skip" — see below. */
  decided: JudgeExpect;
  correct: boolean;
  /** Fraction of trials agreeing with the majority. 1.0 when N = 1. */
  agreement: number;
  why: string;
};

/**
 * Reduce N trials to one decision.
 *
 * A TIE RESOLVES TO SKIP, deliberately. This is an ambient feature that
 * interrupts unprompted: a judge that cannot make up its mind is not evidence
 * for speaking, and the asymmetry between a missed connection and an unwanted
 * interruption is the whole reason the feature has a rate limit at all.
 */
export function decide(trials: readonly JudgeTrial[]): JudgeExpect {
  const surfaced = trials.filter((t) => t.verdict).length;
  return surfaced > trials.length / 2 ? "surface" : "skip";
}

export function scoreJudgeCase(c: JudgeCase, trials: readonly JudgeTrial[]): JudgeResult {
  const decided = decide(trials);
  const agreeing = trials.filter(
    (t) => (t.verdict ? "surface" : "skip") === decided,
  ).length;
  return {
    id: c.id,
    expect: c.expect,
    trials: [...trials],
    decided,
    correct: decided === c.expect,
    agreement: trials.length ? agreeing / trials.length : 0,
    why: c.why ?? "",
  };
}

export type JudgeSummary = {
  total: number;
  correct: number;
  /** Correct surfaces over all surfaces — the interruption-cost metric. */
  precision: number;
  /** Correct surfaces over cases that should surface. */
  recall: number;
  /** Mean per-case self-agreement across trials. */
  agreement: number;
  /** Cases the judge got wrong while being perfectly consistent about it. */
  confidentlyWrong: number;
  medianMs: number;
};

export function summarizeJudge(results: readonly JudgeResult[]): JudgeSummary {
  const positives = results.filter((r) => r.expect === "surface");
  const surfaces = results.filter((r) => r.decided === "surface");
  const hits = positives.filter((r) => r.correct).length;
  const ms = results
    .flatMap((r) => r.trials.map((t) => t.ms))
    .filter((m) => m > 0)
    .sort((a, b) => a - b);

  return {
    total: results.length,
    correct: results.filter((r) => r.correct).length,
    precision: surfaces.length ? hits / surfaces.length : 0,
    recall: positives.length ? hits / positives.length : 0,
    agreement: results.length
      ? results.reduce((a, r) => a + r.agreement, 0) / results.length
      : 0,
    // The number that keeps `agreement` honest: a judge can be perfectly
    // reliable and perfectly wrong, and these are the cases where it is.
    confidentlyWrong: results.filter((r) => !r.correct && r.agreement === 1).length,
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : 0,
  };
}

export function formatJudgeSummary(
  s: JudgeSummary,
  results: readonly JudgeResult[],
): string {
  const pct = (n: number) => n.toFixed(2);
  const out: string[] = [];
  out.push(`${s.correct}/${s.total} correct   (median judge call ${s.medianMs}ms)`);
  out.push(
    `  precision ${pct(s.precision)}   recall ${pct(s.recall)}   ` +
      `self-agreement ${pct(s.agreement)}`,
  );
  if (s.confidentlyWrong > 0) {
    out.push(
      `  ${s.confidentlyWrong} case(s) wrong with FULL self-agreement — ` +
        `consistency here is not correctness.`,
    );
  }
  out.push("");
  for (const r of results) {
    const mark = r.correct ? "ok  " : "MISS";
    const agree = r.trials.length > 1 ? ` agree=${pct(r.agreement)}` : "";
    const said = r.trials.find((t) => t.verdict)?.verdict ?? "SKIP";
    out.push(
      `  ${mark} ${r.id.padEnd(22)} want=${r.expect.padEnd(8)}` +
        `got=${r.decided.padEnd(8)}${agree}  ${said.slice(0, 60)}`,
    );
    if (!r.correct && r.why) out.push(`       why this case exists: ${r.why}`);
  }
  return out.join("\n");
}
