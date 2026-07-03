import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentTokens,
  abstractionSimilarity,
  findConsolidationCandidates,
} from "./consolidation.ts";
import type { SourceNote } from "./types.ts";

function src(title: string, abstraction?: string): SourceNote {
  return {
    title,
    path: `02 - Research/Alpha/${title}.md`,
    domain: "alpha",
    scope: "public",
    tags: ["paper"],
    concepts: [],
    mocs: [],
    buildsOn: [],
    comparesWith: [],
    usesMethod: [],
    ...(abstraction ? { abstraction } : {}),
  };
}

test("contentTokens lowercases, drops stopwords and short words", () => {
  const tokens = contentTokens("Consolidating the overlapping Memories into a single canonical entry");
  assert.deepEqual(
    [...tokens].sort(),
    ["canonical", "consolidating", "entry", "memories", "overlapping", "single"],
  );
});

test("abstractionSimilarity: near-duplicates score high, unrelated score zero", () => {
  const a = "consolidating overlapping memories into single canonical entry";
  const b = "consolidating overlapping memories into one canonical entry";
  // Token sets share 5 of 7 distinct tokens ("single" vs "one" differ) → 5/7.
  const sim = abstractionSimilarity(a, b);
  assert.ok(Math.abs(sim - 5 / 7) < 1e-9, `expected 5/7, got ${sim}`);
  assert.equal(abstractionSimilarity(a, "ranking exploration frontiers by authority signals"), 0);
  assert.equal(abstractionSimilarity("", a), 0);
});

test("findConsolidationCandidates: threshold, self-exclusion, missing abstractions, sort order", () => {
  const fresh = src("Fresh Consolidation Study", "consolidating overlapping memories into single canonical entry");
  const candidates = [
    fresh, // self — must be excluded by path
    src("Near Twin Report", "consolidating overlapping memories into one canonical entry"), // 5/7 ≈ 0.714
    src("Cousin Survey", "merging overlapping memories into canonical entries elsewhere"), // shares some tokens
    src("Distant Ranking Study", "ranking exploration frontiers by authority signals"), // 0
    src("No Abstraction Note"), // skipped
  ];
  const hits = findConsolidationCandidates(fresh, candidates, 0.5);
  assert.deepEqual(hits.map((h) => h.title), ["Near Twin Report"]);
  assert.equal(hits[0].similarity, 0.714);

  // Lower threshold admits the cousin, still sorted most-similar first.
  const loose = findConsolidationCandidates(fresh, candidates, 0.3);
  assert.deepEqual(loose.map((h) => h.title), ["Near Twin Report", "Cousin Survey"]);

  // A new source without an abstraction produces no candidates.
  assert.deepEqual(findConsolidationCandidates(src("Bare Note"), candidates, 0.1), []);
});
