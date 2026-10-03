import { test } from "node:test";
import assert from "node:assert/strict";
import { observePrime, scorePrimeCase, summarizePrime, formatPrimeSummary, p95, type PrimeGold, type LogLine } from "./score.ts";

const line = (stage: string, extra: Record<string, unknown> = {}): LogLine => ({ stage, ...extra });

test("observePrime reads the sync decision and the async outcome", () => {
  const o = observePrime([line("pass:enter"), line("prime:sync", { ms: 4, decision: "candidate" }), line("prime:appended", { path: "A/Alpha Report.md", readInTurn: true })]);
  assert.deepEqual(o, { sync: "candidate", syncMs: 4, outcome: "appended", path: "A/Alpha Report.md", readInTurn: true });
  assert.equal(observePrime([line("prime:sync", { ms: 2, decision: "skip-weak" })]).outcome, "none");
  assert.equal(observePrime([line("prime:skip-cold")]).outcome, "skip-cold");
});

const P: PrimeGold = { id: "p1", prompt: "x", expect: "prime", expected_notes: ["A/Alpha Report.md"] };
const N = (i: number): PrimeGold => ({ id: `n${i}`, prompt: "x", expect: "none" });
const appended = (path: string) => observePrime([line("prime:sync", { ms: 3, decision: "candidate" }), line("prime:appended", { path, readInTurn: true })]);
const silent = observePrime([line("prime:sync", { ms: 3, decision: "skip-weak" })]);

test("a prime of the wrong note is a precision miss, not a hit", () => {
  assert.equal(scorePrimeCase(P, appended("A/Alpha Report.md")).correct, true);
  const wrong = scorePrimeCase(P, appended("B/Beta.md"));
  assert.equal(wrong.correct, false);
  assert.equal(wrong.rightNote, false);
  assert.equal(scorePrimeCase(N(1), appended("B/Beta.md")).correct, false);
  assert.equal(scorePrimeCase(N(1), silent).correct, true);
});

test("verdicts: insufficient N, below gate, inert, passed", () => {
  const few = summarizePrime([scorePrimeCase(P, appended("A/Alpha Report.md")), scorePrimeCase(N(1), silent)]);
  assert.equal(few.verdict, "insufficient-n");
  const nones = Array.from({ length: 40 }, (_, i) => scorePrimeCase(N(i), silent));
  const prime = Array.from({ length: 5 }, () => scorePrimeCase(P, appended("A/Alpha Report.md")));
  assert.equal(summarizePrime([...prime, ...nones]).verdict, "passed");
  const noisy = [...prime, ...nones.slice(0, 35), ...Array.from({ length: 5 }, (_, i) => scorePrimeCase(N(100 + i), appended("B/Beta.md")))];
  const s = summarizePrime(noisy);
  assert.equal(s.verdict, "below-gate");
  assert.match(formatPrimeSummary(s), /BELOW GATE/);
  const inert = summarizePrime([...Array.from({ length: 5 }, () => scorePrimeCase(P, silent)), ...nones]);
  assert.equal(inert.verdict, "inert");
});

test("p95", () => {
  assert.equal(p95([]), null);
  assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100]), 19);
});
