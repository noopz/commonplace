/**
 * eval:prime scoring (plan §8.6). Pure: reads hook-log lines a case produced
 * and the case's gold expectation; the runner does the sessions.
 *
 * Reported apart, never as one number: precision protects the user from
 * interruption (alert fatigue kills an ambient feature), recall says whether
 * the feature does anything at all, and the operational rates say whether it
 * can run without hurting the session.
 */

export type PrimeGold = {
  id: string;
  prompt: string;
  expect: "prime" | "none";
  /** Vault-relative paths of acceptable notes (for `prime` cases). */
  expected_notes?: string[];
};

export type LogLine = { stage?: string; [k: string]: unknown };

export type PrimeObserved = {
  /** The sync lane's decision ("candidate", "skip-weak", …) or "absent". */
  sync: string;
  syncMs: number | null;
  /** The async lane's outcome, or "none" when the sync lane picked nothing. */
  outcome: "appended" | "judged-no" | "unanswered" | "late-drop" | "skip-cold" | "no-turn" | "error" | "none";
  path: string | null;
  readInTurn: boolean | null;
};

export function observePrime(lines: readonly LogLine[]): PrimeObserved {
  const o: PrimeObserved = { sync: "absent", syncMs: null, outcome: "none", path: null, readInTurn: null };
  for (const l of lines) {
    switch (l.stage) {
      case "prime:sync":
        o.sync = String(l.decision ?? "unknown");
        o.syncMs = typeof l.ms === "number" ? l.ms : null;
        break;
      case "prime:skip-cold":
        o.sync = "skip-cold";
        o.outcome = "skip-cold";
        break;
      case "prime:appended":
        o.outcome = "appended";
        o.path = typeof l.path === "string" ? l.path : null;
        o.readInTurn = l.readInTurn === true;
        break;
      case "prime:judged-no":
        o.outcome = "judged-no";
        o.path = typeof l.path === "string" ? l.path : null;
        break;
      case "prime:unanswered":
        o.outcome = "unanswered";
        break;
      case "prime:late-drop":
        o.outcome = "late-drop";
        break;
      case "prime:no-turn":
        o.outcome = "no-turn";
        break;
      case "prime:error":
        o.outcome = "error";
        break;
    }
  }
  return o;
}

export type PrimeCaseResult = { id: string; expect: PrimeGold["expect"]; observed: PrimeObserved; correct: boolean; rightNote: boolean };

export function scorePrimeCase(c: PrimeGold, o: PrimeObserved): PrimeCaseResult {
  const appended = o.outcome === "appended";
  const rightNote = appended && !!o.path && (c.expected_notes ?? []).includes(o.path);
  const correct = c.expect === "none" ? !appended : rightNote;
  return { id: c.id, expect: c.expect, observed: o, correct, rightNote };
}

export const GATE = {
  precision: 0.8,
  falsePrime: 0.05,
  minNoneCases: 40,
  recallFloor: 0.3,
  skipCold: 0.05,
  p95SyncMs: 30,
  lateDrop: 0.1,
} as const;

export type PrimeSummary = {
  cases: number;
  primeCases: number;
  noneCases: number;
  appended: number;
  precision: number | null;
  falsePrimeRate: number | null;
  recall: number | null;
  skipColdRate: number;
  p95SyncMs: number | null;
  lateDropRate: number | null;
  /** Judge calls that returned no verdict (timeout, API error), of all judged candidates. */
  unansweredRate: number | null;
  readInTurnRate: number | null;
  /**
   * Primes per case. Reported, NOT gated: on a gold set it is fixed by the
   * share of `prime` cases (24 of 69 makes a perfect prime 35%), so a ceiling
   * here measured the gold mix, not interruption. Interruption on prompts with
   * no matching note is `falsePrimeRate`; real frequency comes from the
   * hook-log of real sessions.
   */
  frequency: number;
  verdict: "passed" | "below-gate" | "inert" | "insufficient-n";
  failures: string[];
};

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function p95(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

export function summarizePrime(results: readonly PrimeCaseResult[]): PrimeSummary {
  const prime = results.filter((r) => r.expect === "prime");
  const none = results.filter((r) => r.expect === "none");
  const appended = results.filter((r) => r.observed.outcome === "appended");
  const late = results.filter((r) => r.observed.outcome === "late-drop");
  const s: PrimeSummary = {
    cases: results.length,
    primeCases: prime.length,
    noneCases: none.length,
    appended: appended.length,
    precision: ratio(appended.filter((r) => r.rightNote).length, appended.length),
    falsePrimeRate: ratio(none.filter((r) => r.observed.outcome === "appended").length, none.length),
    recall: ratio(prime.filter((r) => r.rightNote).length, prime.length),
    skipColdRate: ratio(results.filter((r) => r.observed.outcome === "skip-cold").length, results.length) ?? 0,
    p95SyncMs: p95(results.map((r) => r.observed.syncMs).filter((x): x is number => x !== null)),
    lateDropRate: ratio(late.length, appended.length + late.length),
    unansweredRate: ratio(
      results.filter((r) => r.observed.outcome === "unanswered").length,
      results.filter((r) => ["appended", "judged-no", "unanswered", "late-drop"].includes(r.observed.outcome)).length,
    ),
    readInTurnRate: ratio(appended.filter((r) => r.observed.readInTurn).length, appended.length),
    frequency: ratio(appended.length, results.length) ?? 0,
    verdict: "passed",
    failures: [],
  };
  const f = s.failures;
  if (s.precision !== null && s.precision < GATE.precision) f.push(`precision ${s.precision.toFixed(2)} < ${GATE.precision}`);
  if (s.falsePrimeRate !== null && s.falsePrimeRate > GATE.falsePrime) f.push(`false-prime ${s.falsePrimeRate.toFixed(2)} > ${GATE.falsePrime}`);
  if (s.skipColdRate >= GATE.skipCold) f.push(`skip-cold ${s.skipColdRate.toFixed(2)} ≥ ${GATE.skipCold}`);
  if (s.p95SyncMs !== null && s.p95SyncMs >= GATE.p95SyncMs) f.push(`p95 sync ${s.p95SyncMs} ms ≥ ${GATE.p95SyncMs}`);
  if (s.lateDropRate !== null && s.lateDropRate >= GATE.lateDrop) f.push(`late-drop ${s.lateDropRate.toFixed(2)} ≥ ${GATE.lateDrop}`);
  if (s.appended === 0 && s.primeCases > 0) f.push("nothing primed");
  // N counts distinct gold cases; repeats measure stability, not breadth.
  if (new Set(none.map((r) => r.id)).size < GATE.minNoneCases) s.verdict = "insufficient-n";
  else if (s.recall !== null && s.recall < GATE.recallFloor) s.verdict = "inert";
  else if (f.length) s.verdict = "below-gate";
  return s;
}

export function formatPrimeSummary(s: PrimeSummary): string {
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const lines = [
    `cases ${s.cases} (prime ${s.primeCases}, none ${s.noneCases}) · appended ${s.appended}`,
    `precision ${pct(s.precision)} · false-prime ${pct(s.falsePrimeRate)} · recall ${pct(s.recall)}`,
    `skip-cold ${pct(s.skipColdRate)} · p95 sync ${s.p95SyncMs ?? "—"} ms · late-drop ${pct(s.lateDropRate)} · unanswered ${pct(s.unansweredRate)} · read-in-turn ${pct(s.readInTurnRate)} · frequency ${pct(s.frequency)}`,
    "",
  ];
  if (s.verdict === "passed") lines.push("GATE PASSED — primeContext may default on for this vault.");
  else if (s.verdict === "inert") lines.push(`prime is inert (recall < ${Math.round(GATE.recallFloor * 100)}%) — keep primeContext off.`);
  else if (s.verdict === "insufficient-n") lines.push(`insufficient N: ${s.noneCases} none cases (gate needs ≥ ${GATE.minNoneCases}; run with --repeat 3). Not a verdict.`);
  else lines.push(`BELOW GATE — keep primeContext off: ${s.failures.join("; ")}`);
  return lines.join("\n");
}
