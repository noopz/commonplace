import { test } from "node:test";
import assert from "node:assert/strict";
import { seedRecall, aggregate, scoreAnswer, type QuestionResult } from "./score.ts";

test("seedRecall is intersection over expected", () => {
  assert.equal(seedRecall(["a.md", "b.md"], ["b.md", "c.md"]), 0.5);
  assert.equal(seedRecall(["a.md"], []), 0);
  assert.equal(seedRecall([], ["x.md"]), 1);
});

test("aggregate computes overall, per-type means, and median candidate count", () => {
  const results: QuestionResult[] = [
    { id: "q1", type: "single-hop", recall: 1, nCandidates: 3, matchedExpected: [], missedExpected: [] },
    { id: "q2", type: "single-hop", recall: 0, nCandidates: 0, matchedExpected: [], missedExpected: [] },
    { id: "q3", type: "multi-hop", recall: 0.5, nCandidates: 7, matchedExpected: [], missedExpected: [] },
  ];
  const agg = aggregate(results);
  assert.equal(agg.n, 3);
  assert.equal(agg.overall, 0.5);
  assert.equal(agg.byType["single-hop"], 0.5);
  assert.equal(agg.byType["multi-hop"], 0.5);
  assert.equal(agg.medianCandidates, 3);
});

test("scoreAnswer: citation recall/precision over vault-relative paths", () => {
  const s = scoreAnswer("Answer text.", ["a.md", "z.md"], ["a.md", "b.md"], ["body a", "body b"]);
  assert.equal(s.citationRecall, 0.5);
  assert.equal(s.citationPrecision, 0.5);
});

test("scoreAnswer flags numbers and quotes not traceable to expected notes", () => {
  const s = scoreAnswer(
    'The method improves recall by 37% and calls it "harmonic gating".',
    ["a.md"],
    ["a.md"],
    ["The note discusses harmonic methods, without numbers."],
  );
  assert.deepEqual(s.ungroundedNumbers, ["37%"]);
  assert.deepEqual(s.ungroundedQuotes, ["harmonic gating"]);
});

test("scoreAnswer: grounded claims are not flagged", () => {
  const s = scoreAnswer(
    "Recall improved by 37%.",
    ["a.md"],
    ["a.md"],
    ["Table 2 reports recall improved by 37% over baseline."],
  );
  assert.deepEqual(s.ungroundedNumbers, []);
});
