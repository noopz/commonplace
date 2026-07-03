import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIsStub, extractWikilinkDisplayTexts } from "./frontmatter.ts";

const SENTINEL_BODY = "# X\n\nA concept. *Definition pending - please update.*\n";
const REAL_BODY = "# X\n\nA real definition paragraph.\n";

test("flag off: computeIsStub is exactly the legacy sentinel check", () => {
  assert.equal(computeIsStub(SENTINEL_BODY, {}, false), true);
  assert.equal(computeIsStub(REAL_BODY, {}, false), false);
  // Even with an abstraction present, flag off ignores it entirely.
  assert.equal(computeIsStub(SENTINEL_BODY, { abstraction: "some key" }, false), true);
});

test("flag on: missing or empty abstraction also marks a stub", () => {
  assert.equal(computeIsStub(REAL_BODY, {}, true), true);
  assert.equal(computeIsStub(REAL_BODY, { abstraction: "   " }, true), true);
  assert.equal(computeIsStub(REAL_BODY, { abstraction: "a usable retrieval key here" }, true), false);
});

test("flag on: sentinel still wins even with an abstraction", () => {
  assert.equal(computeIsStub(SENTINEL_BODY, { abstraction: "a usable retrieval key" }, true), true);
});

test("extractWikilinkDisplayTexts prefers alias display text and dedupes", () => {
  const body = "See [[Cue Anchors|anchor keys]] and [[Graph Traversal]], plus [[Graph Traversal]] again.";
  assert.deepEqual(extractWikilinkDisplayTexts(body), ["anchor keys", "Graph Traversal"]);
});

test("extractWikilinkDisplayTexts returns empty for link-free text", () => {
  assert.deepEqual(extractWikilinkDisplayTexts("No links here."), []);
});
