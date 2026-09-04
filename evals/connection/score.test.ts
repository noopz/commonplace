/**
 * Tests for the ambient-connection eval scorer.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note path,
 * title or prompt below comes from a real vault. The log shapes mirror what
 * hooks/lib/pipeline.ts actually writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  observePass,
  scoreCase,
  summarize,
  formatSummary,
  type GoldCase,
  type LogLine,
} from "./score.ts";

const ALPHA = "concepts/alpha/Alpha Lattice.md";
const GAMMA = "concepts/gamma/Gamma Term.md";

function line(at: string, o: Record<string, unknown>): LogLine {
  return { at, ...o };
}

const SURFACED: LogLine[] = [
  line("2020-01-01T00:00:00.000Z", { stage: "pass:enter" }),
  line("2020-01-01T00:00:00.100Z", { stage: "seed:lexical", candidates: 4, score: 18, top: ALPHA }),
  line("2020-01-01T00:00:00.101Z", { stage: "seed:graph-skipped", score: 18, need: 12 }),
  line("2020-01-01T00:00:00.102Z", { stage: "judge:candidate", path: ALPHA, tier: "lexical" }),
  line("2020-01-01T00:00:00.900Z", { outcome: "surfaced a connection" }),
];

const REJECTED: LogLine[] = [
  line("2020-01-01T00:00:00.000Z", { stage: "pass:enter" }),
  line("2020-01-01T00:00:00.100Z", { stage: "seed:lexical", candidates: 4, score: 7, top: GAMMA }),
  line("2020-01-01T00:00:00.400Z", { stage: "seed:graph", candidates: 6 }),
  line("2020-01-01T00:00:00.401Z", { stage: "judge:candidate", path: GAMMA, tier: "graph" }),
  line("2020-01-01T00:00:01.000Z", { outcome: "judged not relevant" }),
];

test("observePass reads the whole chain out of the log", () => {
  const o = observePass(SURFACED);
  assert.equal(o.stage, "surfaced");
  assert.equal(o.candidate, ALPHA);
  assert.equal(o.tier, "lexical");
  assert.equal(o.score, 18);
  assert.equal(o.walked, false);
  assert.equal(o.ms, 900);
});

test("observePass records that the graph walk ran", () => {
  const o = observePass(REJECTED);
  assert.equal(o.stage, "judged-not-relevant");
  assert.equal(o.tier, "graph");
  assert.equal(o.walked, true);
});

test("observePass names the stage a pass died at", () => {
  // The actionable half of the eval: four different stages are four different
  // bugs, and the raw outcome line distinguishes none of them.
  const cases: [Record<string, unknown>, string][] = [
    [{ stage: "skip:rate-limited", turnCount: 9, lastTurn: 8 }, "rate-limited"],
    [{ stage: "skip:off-topic", label: "routine-coding-chatter" }, "off-topic"],
    [{ stage: "skip:no-candidates" }, "no-candidates"],
    [{ stage: "skip:answer-too-short", chars: 40 }, "guard"],
  ];
  for (const [tail, expected] of cases) {
    const o = observePass([
      line("2020-01-01T00:00:00.000Z", { stage: "pass:enter" }),
      line("2020-01-01T00:00:00.010Z", tail),
    ]);
    assert.equal(o.stage, expected, JSON.stringify(tail));
  }
});

test("observePass scores the LAST pass when a session logged several", () => {
  // A session can emit more than one assistant turn; only the last one saw
  // the full answer.
  const o = observePass([...REJECTED, ...SURFACED]);
  assert.equal(o.stage, "surfaced");
  assert.equal(o.candidate, ALPHA);
});

test("observePass shrugs at an empty or unparsed log", () => {
  assert.equal(observePass([]).stage, "never-ran");
  assert.equal(observePass([{}, {}]).stage, "never-ran");
});

test("scoreCase checks WHICH note surfaced, not just that one did", () => {
  const gold: GoldCase = { id: "a", prompt: "p", expect: "surface", notes: [GAMMA] };
  const r = scoreCase(gold, observePass(SURFACED));
  assert.equal(r.correct, false, "surfaced the wrong note");
  assert.equal(r.wrongNote, true);

  const ok = scoreCase({ ...gold, notes: [ALPHA] }, observePass(SURFACED));
  assert.equal(ok.correct, true);
  assert.equal(ok.wrongNote, false);
});

test("scoreCase accepts any surface when the gold names no notes", () => {
  const gold: GoldCase = { id: "a", prompt: "p", expect: "surface" };
  assert.equal(scoreCase(gold, observePass(SURFACED)).correct, true);
});

test("a silent case is correct exactly when nothing surfaced", () => {
  const gold: GoldCase = { id: "n", prompt: "p", expect: "silent" };
  assert.equal(scoreCase(gold, observePass(REJECTED)).correct, true);
  assert.equal(scoreCase(gold, observePass(SURFACED)).correct, false);
});

test("summarize separates a miss from a false positive", () => {
  const results = [
    scoreCase({ id: "p1", prompt: "", expect: "surface", notes: [ALPHA] }, observePass(SURFACED)),
    scoreCase({ id: "p2", prompt: "", expect: "surface", notes: [ALPHA] }, observePass(REJECTED)),
    scoreCase({ id: "n1", prompt: "", expect: "silent" }, observePass(REJECTED)),
    scoreCase({ id: "n2", prompt: "", expect: "silent" }, observePass(SURFACED)),
  ];
  const s = summarize(results);
  assert.equal(s.total, 4);
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.falsePositives, 1);
  assert.equal(s.correct, 2);
  assert.deepEqual(s.missStages, { "judged-not-relevant": 1 });
});

test("the report leads with where the misses died", () => {
  const results = [
    scoreCase({ id: "p2", prompt: "", expect: "surface", notes: [ALPHA] }, observePass(REJECTED)),
  ];
  const text = formatSummary(summarize(results), results);
  assert.match(text, /where the misses died/);
  assert.match(text, /judged-not-relevant/);
  assert.match(text, /\+walk/, "and whether the graph tier was involved");
});
