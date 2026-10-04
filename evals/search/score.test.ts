import { test } from "node:test";
import assert from "node:assert/strict";
import { findMetrics, poolResult, summarize, coordinateAscent, foldOf } from "./score.ts";

test("findMetrics: first-hit reciprocal rank and recall@k", () => {
  const r = findMetrics("q1", "paraphrase", ["Alpha.md"], ["X.md", "Y.md", "Alpha.md"]);
  assert.equal(r.rr, 1 / 3);
  assert.equal(r.firstRank, 3);
  assert.equal(r.recall[5], 1);
  const miss = findMetrics("q2", "literal", ["Alpha.md"], ["X.md"]);
  assert.equal(miss.rr, 0);
  assert.equal(miss.firstRank, null);
  assert.equal(miss.recall[25], 0);
});

test("poolResult and summarize: per-type means and the combined objective", () => {
  const f = [findMetrics("a", "t1", ["A"], ["A"]), findMetrics("b", "t2", ["B"], ["X", "B"])];
  const p = [poolResult("c", "connect-explicit", ["C", "D"], ["C"]), poolResult("d", "connect-latent", ["E"], [])];
  const s = summarize(f, p);
  assert.equal(s.find.mrr, 0.75);
  assert.equal(s.find.byType.t2.mrr, 0.5);
  assert.equal(s.connect.recall, 0.25);
  assert.equal(s.objective, 0.75 + 1 + 0.25 + 0.5);
  assert.equal(summarize([], p).objective, 0.25 + 0.5, "an absent gold set adds nothing");
});

test("coordinateAscent climbs, keeps only strict improvements, and stops", () => {
  const score = (c: { x: number; y: number }) => -((c.x - 3) ** 2) - (c.y - 1) ** 2;
  const r = coordinateAscent({ x: 0, y: 0 }, { x: [0, 1, 2, 3, 4], y: [0, 1, 2] }, score);
  assert.deepEqual(r.best, { x: 3, y: 1 });
  const flat = coordinateAscent({ x: 0 }, { x: [1, 2] }, () => 1);
  assert.deepEqual(flat.best, { x: 0 }, "ties never move the start");
});

test("foldOf is stable and splits both ways", () => {
  assert.equal(foldOf("q1"), foldOf("q1"));
  const folds = new Set(Array.from({ length: 20 }, (_, i) => foldOf(`q${i}`)));
  assert.deepEqual([...folds].sort(), [0, 1]);
});
