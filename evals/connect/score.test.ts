import { test } from "node:test";
import assert from "node:assert/strict";
import {
  f1,
  targetsOf,
  poolMetrics,
  triageMetrics,
  bootstrapCI,
  type ConnectGold,
} from "./score.ts";

test("f1: harmonic mean, zero when either side is zero", () => {
  assert.equal(f1(1, 1), 1);
  assert.equal(f1(0, 1), 0);
  assert.ok(Math.abs(f1(0.5, 1) - 2 / 3) < 1e-9);
});

test("targetsOf: excludes the seed notes (Connect reaches the OTHER notes)", () => {
  const g = { seed_notes: ["seed.md"], expected_notes: ["seed.md", "a.md", "b.md"] } as ConnectGold;
  assert.deepEqual(targetsOf(g), ["a.md", "b.md"]);
});

test("poolMetrics: recall counts presence anywhere, MRR uses first target's rank", () => {
  const pool = ["x.md", "a.md", "y.md", "b.md"]; // targets a,b at ranks 2 and 4
  const m = poolMetrics(["a.md", "b.md"], pool, 20);
  assert.equal(m.recall, 1);
  assert.equal(m.mrr, 1 / 2);
});

test("poolMetrics: a target outside top-k lowers baseline recall but stays in pool recall", () => {
  const pool = ["x.md", "y.md", "a.md"]; // target a.md at rank 3
  const full = poolMetrics(["a.md"], pool, 20);
  const topTwo = poolMetrics(["a.md"], pool, 2);
  assert.equal(full.recall, 1); // present in pool
  assert.equal(topTwo.baseRecall, 0); // but not in top-2
});

test("triageMetrics: abstaining scores zero; picks score recall/precision", () => {
  assert.deepEqual(triageMetrics(["a.md"], [], true), { recall: 0, precision: 0, f1: 0, abstained: true });
  const m = triageMetrics(["a.md", "b.md"], ["a.md", "junk.md"], false);
  assert.equal(m.recall, 0.5); // got 1 of 2 targets
  assert.equal(m.precision, 0.5); // 1 of 2 picks correct
});

test("bootstrapCI: deterministic given a seed, mean is exact, interval brackets it", () => {
  const values = [1, 1, 1, 0, 1, 0, 1, 1, 0, 1];
  const a = bootstrapCI(values, { seed: 42 });
  const b = bootstrapCI(values, { seed: 42 });
  assert.deepEqual(a, b); // reproducible
  assert.ok(Math.abs(a.mean - 0.7) < 1e-9);
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  assert.equal(a.n, 10);
});

test("bootstrapCI: single value collapses to a point interval", () => {
  assert.deepEqual(bootstrapCI([0.5]), { mean: 0.5, lo: 0.5, hi: 0.5, n: 1 });
});
