/**
 * Tests for the judge-only eval scorer.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note path,
 * verdict text or case name below comes from a real vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decide,
  scoreJudgeCase,
  summarizeJudge,
  formatJudgeSummary,
  type JudgeCase,
  type JudgeTrial,
} from "./score.ts";

const SURFACE = (ms = 500): JudgeTrial => ({ verdict: "Records the earlier drift finding.", ms });
const SKIP = (ms = 500): JudgeTrial => ({ verdict: "", ms });

const CASE = (over: Partial<JudgeCase> = {}): JudgeCase => ({
  id: "alpha-1",
  answer: "some answer",
  note: "concepts/alpha/Alpha Lattice.md",
  expect: "surface",
  ...over,
});

test("decide takes the majority of trials", () => {
  assert.equal(decide([SURFACE(), SURFACE(), SKIP()]), "surface");
  assert.equal(decide([SURFACE(), SKIP(), SKIP()]), "skip");
  assert.equal(decide([SURFACE()]), "surface");
});

test("a tie resolves to SKIP, never to surface", () => {
  // This feature interrupts unprompted. A judge that cannot make up its mind
  // is not evidence for speaking.
  assert.equal(decide([SURFACE(), SKIP()]), "skip");
  assert.equal(decide([SURFACE(), SURFACE(), SKIP(), SKIP()]), "skip");
  assert.equal(decide([]), "skip");
});

test("agreement measures self-consistency, per case", () => {
  const unanimous = scoreJudgeCase(CASE(), [SURFACE(), SURFACE(), SURFACE()]);
  assert.equal(unanimous.agreement, 1);
  assert.equal(unanimous.correct, true);

  const split = scoreJudgeCase(CASE(), [SURFACE(), SURFACE(), SKIP()]);
  assert.ok(Math.abs(split.agreement - 2 / 3) < 1e-9);
  assert.equal(split.decided, "surface");
});

test("a single trial is trivially self-consistent", () => {
  // Worth pinning: agreement 1.00 from one trial says nothing at all, and a
  // reader must not mistake it for a stability result.
  assert.equal(scoreJudgeCase(CASE(), [SKIP()]).agreement, 1);
});

test("summarize reports precision and recall apart", () => {
  const results = [
    scoreJudgeCase(CASE({ id: "p1", expect: "surface" }), [SURFACE()]),
    scoreJudgeCase(CASE({ id: "p2", expect: "surface" }), [SKIP()]),
    scoreJudgeCase(CASE({ id: "n1", expect: "skip" }), [SKIP()]),
    scoreJudgeCase(CASE({ id: "n2", expect: "skip" }), [SURFACE()]),
  ];
  const s = summarizeJudge(results);
  assert.equal(s.total, 4);
  assert.equal(s.correct, 2);
  assert.equal(s.precision, 0.5, "two surfaces, one of them right");
  assert.equal(s.recall, 0.5, "two positives, one of them found");
});

test("confidentlyWrong is what keeps the agreement number honest", () => {
  // A judge can be perfectly reliable and perfectly wrong; reporting only
  // agreement would read that as a good result.
  const results = [
    scoreJudgeCase(CASE({ id: "p1", expect: "surface" }), [SKIP(), SKIP(), SKIP()]),
    scoreJudgeCase(CASE({ id: "p2", expect: "surface" }), [SURFACE(), SKIP(), SKIP()]),
  ];
  const s = summarizeJudge(results);
  assert.equal(s.agreement, 1 * 0.5 + (2 / 3) * 0.5, "mean of 1.00 and 0.67");
  assert.equal(s.confidentlyWrong, 1, "only the unanimous-and-wrong case counts");
  assert.match(formatJudgeSummary(s, results), /consistency here is not correctness/);
});

test("the report explains a failing case rather than only flagging it", () => {
  const results = [
    scoreJudgeCase(
      CASE({ id: "p1", expect: "surface", why: "the note is the topic, not adjacent to it" }),
      [SKIP()],
    ),
  ];
  const text = formatJudgeSummary(summarizeJudge(results), results);
  assert.match(text, /MISS p1/);
  assert.match(text, /why this case exists: the note is the topic/);
});

test("median is over trials, not cases", () => {
  const results = [
    scoreJudgeCase(CASE({ id: "a" }), [SURFACE(100), SURFACE(300)]),
    scoreJudgeCase(CASE({ id: "b" }), [SURFACE(500)]),
  ];
  assert.equal(summarizeJudge(results).medianMs, 300);
});
