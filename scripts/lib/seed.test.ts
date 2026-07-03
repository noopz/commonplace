import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKeyTerms, seedCandidates, type SeedIndexes } from "./seed.ts";
import type { SourceNote } from "./types.js";

function src(title: string, extra: Partial<SourceNote> = {}): SourceNote {
  return {
    title,
    path: `02 - Research/Alpha/${title}.md`,
    domain: "alpha",
    scope: "public",
    tags: [],
    concepts: [],
    mocs: [],
    buildsOn: [],
    comparesWith: [],
    usesMethod: [],
    ...extra,
  };
}

const INDEXES: SeedIndexes = {
  sources: [
    src("Harmonic Retrieval Survey", { tags: ["survey"] }),
    src("Latent Anchor Methods", { concepts: ["Cue Anchors"] }),
  ],
  concepts: [
    { name: "Cue Anchors", path: "03 - Concepts/Cue Anchors.md", domains: ["alpha"], backlinkCount: 2, isStub: false },
  ],
  mocs: [
    // Neutral member titles: the MOC's sources array must not contain the
    // terms the tests search for, or every term-match test would also hit
    // this record.
    { name: "Alpha MOC", path: "05 - MOCs/Alpha MOC.md", domains: ["alpha"], sourceCount: 2, sources: ["First Note", "Second Note"], declaredCount: 2 },
  ],
};

test("extractKeyTerms drops stopwords and short words, lowercases", () => {
  assert.deepEqual(
    extractKeyTerms("What do the notes say about frontier ranking?"),
    ["frontier", "ranking"],
  );
});

test("extractKeyTerms captures quoted phrases and capitalized runs", () => {
  const terms = extractKeyTerms('Compare "seed recall" with the Latent Anchor Methods paper');
  assert.ok(terms.includes("seed recall"));
  assert.ok(terms.includes("latent anchor methods"));
  assert.ok(terms.includes("paper"));
});

test("extractKeyTerms dedupes case-insensitively", () => {
  assert.deepEqual(extractKeyTerms("Ranking ranking RANKING"), ["ranking"]);
});

test("flat seeding matches any term anywhere in the record", () => {
  const hits = seedCandidates(["anchor"], INDEXES);
  // "anchor" appears in the source title, the concepts array of that source,
  // and the concept record's name.
  const labels = hits.map((h) => h.label).sort();
  assert.deepEqual(labels, ["Cue Anchors", "Latent Anchor Methods"]);
});

test("flat seeding reports which terms matched", () => {
  const hits = seedCandidates(["harmonic", "survey", "zzz-no-match"], INDEXES);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].matchedTerms, ["harmonic", "survey"]);
});

test("flat seeding scans MOC records too", () => {
  const hits = seedCandidates(["alpha moc"], INDEXES);
  assert.deepEqual(hits.map((h) => h.kind), ["moc"]);
});

test("no terms means no candidates", () => {
  assert.deepEqual(seedCandidates([], INDEXES), []);
});

test("unknown mode throws", () => {
  assert.throws(
    () => seedCandidates(["x"], INDEXES, { mode: "tiered" as never }),
    /unknown seed mode/,
  );
});
