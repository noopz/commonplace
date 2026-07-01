import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGroundedness } from "./groundedness.ts";

test("flags a percentage in the analysis that doesn't appear in the source", () => {
  const source = "The model achieved 87.3% accuracy on the benchmark.";
  const generated = "The paper reports the model reached 94.2% accuracy.";
  const result = checkGroundedness(generated, source);
  assert.ok(result.ungroundedNumbers.includes("94.2%"));
});

test("does not flag a number that appears in the source", () => {
  const source = "The model achieved 87.3% accuracy on the benchmark.";
  const generated = "The paper reports 87.3% accuracy.";
  const result = checkGroundedness(generated, source);
  assert.equal(result.ungroundedNumbers.includes("87.3%"), false);
});

test("ignores single-digit list/step numbers to reduce noise", () => {
  const source = "Step 1: preprocess. Step 2: train.";
  const generated = "Step 1: preprocess. Step 2: train. Step 3: evaluate.";
  const result = checkGroundedness(generated, source);
  // "3" alone (no decimal, no %) is exactly the noisy case this excludes.
  assert.equal(result.ungroundedNumbers.includes("3"), false);
});

test("flags a quoted string in the analysis absent from the source", () => {
  const source = "We conclude the method is effective.";
  const generated = 'The authors state "our method achieves state-of-the-art results".';
  const result = checkGroundedness(generated, source);
  assert.ok(
    result.ungroundedQuotes.some((q) => q.includes("state-of-the-art")),
  );
});

test("does not flag a quoted string that appears verbatim in the source", () => {
  const source = 'The authors state "our method achieves state-of-the-art results" in section 4.';
  const generated = 'The authors state "our method achieves state-of-the-art results".';
  const result = checkGroundedness(generated, source);
  assert.equal(result.ungroundedQuotes.length, 0);
});

test("returns empty arrays when nothing is ungrounded", () => {
  const text = "Same text on both sides, no numbers or quotes.";
  const result = checkGroundedness(text, text);
  assert.deepEqual(result, { ungroundedNumbers: [], ungroundedQuotes: [] });
});
