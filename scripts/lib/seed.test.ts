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
    () => seedCandidates(["x"], INDEXES, { mode: "vector" as never }),
    /unknown seed mode/,
  );
});

const TIERED_INDEXES: SeedIndexes = {
  sources: [
    src("Harmonic Retrieval Survey", {
      tags: ["survey"],
      abstraction: "seeding and traversal strategies for finding related notes",
      anchors: ["Query Seeding", "Graph Traversal"],
    }),
    src("Latent Anchor Methods", { concepts: ["Cue Anchors"], anchors: ["Cue Anchors"] }),
    src("Plain Body Note", { concepts: ["Zeta Topic"] }),
  ],
  concepts: [
    { name: "Cue Anchors", path: "03 - Concepts/Cue Anchors.md", domains: ["alpha"], backlinkCount: 2, isStub: false },
  ],
  mocs: [],
};

test("flat mode ignores abstraction and anchors fields", () => {
  // "strategies" appears only in the abstraction; "seeding" only in
  // abstraction + anchors. Flat must see neither.
  assert.deepEqual(seedCandidates(["strategies"], TIERED_INDEXES, { mode: "flat" }), []);
  const seedingHits = seedCandidates(["seeding"], TIERED_INDEXES, { mode: "flat" });
  assert.deepEqual(seedingHits, []);
});

test("tiered: abstraction matches seed at Tier A", () => {
  const hits = seedCandidates(["strategies"], TIERED_INDEXES, { mode: "tiered" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "Harmonic Retrieval Survey");
  assert.equal(hits[0].tier, "A");
});

test("tiered: each record seeds once at its highest tier, ordered A then B then C", () => {
  // "seeding" hits the survey's abstraction (A) and its anchors (B) — A wins.
  // "anchor" hits Latent Anchor Methods' anchors (B) before its title (C).
  // The Cue Anchors CONCEPT record has no anchors field, so its name
  // matches at Tier C.
  const hits = seedCandidates(["seeding", "anchor"], TIERED_INDEXES, { mode: "tiered" });
  const byLabel = Object.fromEntries(hits.map((h) => [h.label, h.tier]));
  assert.equal(byLabel["Harmonic Retrieval Survey"], "A");
  assert.equal(byLabel["Latent Anchor Methods"], "B");
  assert.equal(byLabel["Cue Anchors"], "C");
  const tiers = hits.map((h) => h.tier);
  assert.deepEqual([...tiers].sort(), tiers, "hits must be ordered tier-first");
});

test("tiered: Tier D engages only when A-C seeds are under the gate", () => {
  // "zeta" is only findable in Plain Body Note's concepts array (baseline blob).
  const hits = seedCandidates(["zeta"], TIERED_INDEXES, { mode: "tiered" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "Plain Body Note");
  assert.equal(hits[0].tier, "D");

  // With the gate already met by A-C seeds, D must NOT engage.
  const gated = seedCandidates(["seeding", "anchor", "zeta"], TIERED_INDEXES, {
    mode: "tiered",
    tierDGate: 3,
  });
  assert.equal(gated.filter((h) => h.tier === "D").length, 0);
  assert.ok(gated.length >= 3);
});

test("tiered: skipAbstractionTier ablates Tier A", () => {
  const hits = seedCandidates(["strategies"], TIERED_INDEXES, { mode: "tiered", skipAbstractionTier: true });
  assert.deepEqual(hits, []);
  // Terms still reachable via anchors survive the ablation at Tier B.
  const seeding = seedCandidates(["seeding"], TIERED_INDEXES, { mode: "tiered", skipAbstractionTier: true });
  assert.equal(seeding.length, 1);
  assert.equal(seeding[0].tier, "B");
});
