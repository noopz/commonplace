import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, STOPWORDS, GENERIC, isGeneric, isStopword } from "./text.ts";

test("tokenize lowercases, drops stopwords and tokens under 3 chars, keeps order and duplicates", () => {
  assert.deepEqual(
    tokenize("The Alpha Method is an AI method for Gamma; alpha again"),
    ["alpha", "method", "method", "gamma", "alpha", "again"],
  );
});

test("tokenize keeps inner hyphens and digits, trims trailing hyphens", () => {
  assert.deepEqual(tokenize("multi-step gamma-2 calibration-- 42x zz"), [
    "multi-step",
    "gamma-2",
    "calibration",
    "42x",
  ]);
});

test("tokenize honours a per-caller minLength", () => {
  assert.deepEqual(tokenize("alpha beta tau zeta", { minLength: 4 }), ["alpha", "beta", "zeta"]);
  assert.deepEqual(tokenize("alpha beta tau zeta"), ["alpha", "beta", "tau", "zeta"]);
});

test("the stopword set is the union of the three former lists", () => {
  // one representative from each former list that the others lacked
  for (const w of ["shall", "using", "via", "within", "says", "our", "vault"]) {
    assert.ok(STOPWORDS.has(w), w);
  }
  assert.deepEqual(tokenize("what does our vault say via notes"), []);
});

test("GENERIC is exported for query-time filtering and not applied by tokenize", () => {
  assert.deepEqual(tokenize("model tools"), ["model", "tools"]);
  assert.ok(GENERIC.has("model"));
  assert.ok(isGeneric("Model"));
  assert.ok(!isGeneric("calibration"));
  assert.ok(isStopword("The"));
});

test("tokenize tolerates empty and non-string input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(undefined as unknown as string), []);
});
