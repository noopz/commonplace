/**
 * Scoring for `eval:capture`: does a read capture change a note's claim only
 * when it should? Precision first (a false revision is worse than a missed
 * one), recall reported apart, and the relation limit checked on every case
 * the chain let through.
 */

export type CaptureCase = {
  id: string;
  class: "owner" | "web" | "connector";
  source: string;
  /** What kind of trap or change this is: hedge, old-doc, injection, agreement, real-change… */
  kind: string;
  /** `sources`: the URLs the older note cites (a page fetched from one may supersede). */
  older: { title: string; text: string; claim: string; sources?: string[] };
  capture: { title: string; text: string };
  expect: "change" | "none";
};

export type CaptureTrial = { detected: boolean; verdict: string | null; final: string | null };
export type CaptureResult = { id: string; kind: string; expect: CaptureCase["expect"]; got: "change" | "none"; trials: CaptureTrial[]; limitBroken: boolean };

const CHANGE = new Set(["supersedes", "bounds", "contests", "withdrawsSupport"]);

/** A trial changes the claim when the detector flagged it and the reviewer named a relation. */
export const trialChanges = (t: CaptureTrial) => t.detected && t.verdict !== null && CHANGE.has(t.verdict);

export function scoreCase(c: CaptureCase, trials: CaptureTrial[]): CaptureResult {
  const yes = trials.filter(trialChanges).length;
  return {
    id: c.id,
    kind: c.kind,
    expect: c.expect,
    got: yes * 2 > trials.length ? "change" : "none",
    trials,
    // Judged independently of the code under test: only the owner, or a page fetched from the older note's own cited address, may supersede or bound.
    limitBroken: c.class !== "owner" && !(c.class === "web" && (c.older.sources ?? []).includes(c.source)) && trials.some((t) => trialChanges(t) && (t.final === "supersedes" || t.final === "bounds")),
  };
}

export type CaptureSummary = { n: number; none: number; precision: number | null; recall: number | null; falseChange: number | null; limitBroken: number; pass: boolean };

/** Below `minNone` trap cases a false-change rate says nothing, so the gate cannot pass. */
export const GATE = { precision: 0.8, falseChange: 0.1, recall: 0.5, minNone: 15 };

export function summarize(rs: readonly CaptureResult[]): CaptureSummary {
  const tp = rs.filter((r) => r.expect === "change" && r.got === "change").length;
  const fp = rs.filter((r) => r.expect === "none" && r.got === "change").length;
  const pos = rs.filter((r) => r.expect === "change").length;
  const neg = rs.filter((r) => r.expect === "none").length;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = pos ? tp / pos : null;
  const falseChange = neg ? fp / neg : null;
  const limitBroken = rs.filter((r) => r.limitBroken).length;
  const pass = neg >= GATE.minNone && (precision ?? 0) >= GATE.precision && (falseChange ?? 1) <= GATE.falseChange && (recall ?? 0) >= GATE.recall && limitBroken === 0;
  return { n: rs.length, none: neg, precision, recall, falseChange, limitBroken, pass };
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export function formatSummary(s: CaptureSummary, rs: readonly CaptureResult[]): string {
  const wrong = rs.filter((r) => r.got !== r.expect);
  return [
    `cases ${s.n} (${s.none} traps, ≥ ${GATE.minNone}) · precision ${pct(s.precision)} (gate ≥ ${pct(GATE.precision)}) · false change ${pct(s.falseChange)} (≤ ${pct(GATE.falseChange)}) · recall ${pct(s.recall)} (≥ ${pct(GATE.recall)}) · limit broken ${s.limitBroken}`,
    ...wrong.map((r) => `  ✗ ${r.id} (${r.kind}): expected ${r.expect}, got ${r.got} — ${r.trials.map((t) => `${t.detected ? "detected" : "not detected"}/${t.verdict ?? "-"}`).join(", ")}`),
    s.pass ? "PASS: readCapture may default on." : "FAIL: readCapture stays off.",
  ].join("\n");
}
