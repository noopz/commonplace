import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, lexicalScores, topLexicalSeeds } from "./lexical.ts";

test("tokenize: drops stopwords and sub-3-char tokens, lowercases", () => {
  assert.deepEqual(tokenize("How does the AT protocol work"), ["protocol", "work"]);
});

test("lexicalScores: a rare shared term outscores a common one; no-overlap nodes omitted", () => {
  const nodes = [
    { path: "rare.md", text: "syntonization timing" },
    { path: "common.md", text: "timing timing timing" },
    { path: "other.md", text: "completely unrelated words" },
  ];
  // "syntonization" appears in 1 doc (high idf); "timing" in 2 (low idf).
  const scores = lexicalScores("syntonization timing", nodes);
  assert.ok(scores.get("rare.md")! > scores.get("common.md")!);
  assert.equal(scores.has("other.md"), false); // no overlap -> absent
});

test("topLexicalSeeds: returns a normalized distribution over the top-k", () => {
  const scores = new Map([["a", 3], ["b", 2], ["c", 1], ["d", 0.5]]);
  const seeds = topLexicalSeeds(scores, 2);
  assert.deepEqual([...seeds.keys()], ["a", "b"]);
  const sum = [...seeds.values()].reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});
