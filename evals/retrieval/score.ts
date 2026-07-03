/**
 * Pure scoring functions for the retrieval eval. Deterministic by design:
 * seed recall is set arithmetic; answer groundedness is citation overlap
 * plus the regex-only traceability check from lib/groundedness. No LLM
 * calls here — scripts are zero-token (an LLM-judged groundedness pass is
 * an agent procedure, not a script).
 */

import { checkGroundedness } from "../../scripts/lib/groundedness.js";

export interface GoldQuestion {
  id: string;
  question: string;
  /** Vault-relative note paths that a correct retrieval must surface. */
  expected_notes: string[];
  type: "single-hop" | "multi-hop" | "cross-domain";
}

export interface QuestionResult {
  id: string;
  type: GoldQuestion["type"];
  recall: number;
  /** Reciprocal rank of the first expected note in candidate order (0 = none found). */
  mrr: number;
  nCandidates: number;
  matchedExpected: string[];
  missedExpected: string[];
}

/** |expected ∩ candidates| / |expected| over vault-relative paths. */
export function seedRecall(expected: string[], candidateRelPaths: string[]): number {
  if (expected.length === 0) return 1;
  const candidates = new Set(candidateRelPaths);
  const matched = expected.filter((e) => candidates.has(e));
  return matched.length / expected.length;
}

/**
 * Reciprocal rank of the FIRST expected note within the ordered candidate
 * list — the position-sensitive counterpart to seedRecall, which is
 * set-based and blind to ranking changes (e.g. authority ordering).
 */
export function reciprocalRankOfFirstExpected(
  expected: string[],
  orderedCandidateRelPaths: string[],
): number {
  const expectedSet = new Set(expected);
  const i = orderedCandidateRelPaths.findIndex((p) => expectedSet.has(p));
  return i === -1 ? 0 : 1 / (i + 1);
}

export interface AggregateResult {
  n: number;
  overall: number;
  byType: Record<string, number>;
  medianCandidates: number;
  meanMrr: number;
}

export function aggregate(results: QuestionResult[]): AggregateResult {
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const byType: Record<string, number> = {};
  for (const t of [...new Set(results.map((r) => r.type))].sort()) {
    byType[t] = mean(results.filter((r) => r.type === t).map((r) => r.recall));
  }
  const counts = results.map((r) => r.nCandidates).sort((a, b) => a - b);
  const medianCandidates =
    counts.length === 0
      ? 0
      : counts.length % 2 === 1
        ? counts[(counts.length - 1) / 2]
        : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2;
  return {
    n: results.length,
    overall: mean(results.map((r) => r.recall)),
    byType,
    medianCandidates,
    meanMrr: mean(results.map((r) => r.mrr)),
  };
}

export interface AnswerScore {
  citationRecall: number;
  citationPrecision: number;
  ungroundedNumbers: string[];
  ungroundedQuotes: string[];
}

/**
 * Score one answer transcript: did it cite the expected notes (recall),
 * did it cite only relevant ones (precision vs expected), and are its
 * specific numbers/quotes traceable to the expected notes' text?
 */
export function scoreAnswer(
  answerText: string,
  citedRelPaths: string[],
  expected: string[],
  expectedNoteTexts: string[],
): AnswerScore {
  const expectedSet = new Set(expected);
  const cited = new Set(citedRelPaths);
  const hit = expected.filter((e) => cited.has(e)).length;
  const g = checkGroundedness(answerText, expectedNoteTexts.join("\n\n"));
  return {
    citationRecall: expected.length === 0 ? 1 : hit / expected.length,
    citationPrecision: cited.size === 0 ? 0 : [...cited].filter((c) => expectedSet.has(c)).length / cited.size,
    ungroundedNumbers: g.ungroundedNumbers,
    ungroundedQuotes: g.ungroundedQuotes,
  };
}
