/**
 * Postings + cards on invented notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostings, indexPostings, searchPostings, noteTerms, authorityPrior, localRerank, type PostingsInput } from "./postings.ts";
import { makeCard, clip, CARD_MAX_BYTES, CARDS_PER_CHUNK, cardChunk, cardChunkName } from "./cards.ts";

const NOTES: PostingsInput[] = [
  { id: 0, title: "Alpha Calibration Drift", abstraction: "how staged calibration reduces drift", tags: ["paper"] },
  { id: 1, title: "Gamma Term", aliases: ["GT weighting"], abstraction: "a cohort weighting term" },
  { id: 2, title: "Beta Theory", headings: ["Calibration failures"], anchors: ["drift budget"] },
  { id: 3, title: "Delta Notes", abstraction: "unrelated observations about tides" },
];

test("field weights: title beats abstraction beats heading beats anchor", () => {
  const t0 = noteTerms(NOTES[0]);
  assert.equal(t0.get("calibration"), 4 + 3, "title + abstraction");
  assert.equal(noteTerms(NOTES[2]).get("calibration"), 2, "heading");
  assert.equal(noteTerms(NOTES[2]).get("drift"), 1, "anchor");
  assert.equal(noteTerms(NOTES[1]).get("weighting"), 4 + 3, "alias + abstraction");
});

test("search ranks by field score · idf and reports matched terms", () => {
  const idx = indexPostings(buildPostings(NOTES), NOTES.length);
  const hits = searchPostings(idx, "calibration drift");
  assert.deepEqual(hits.map((h) => h.id), [0, 2]);
  assert.deepEqual(hits[0].matched.sort(), ["calibration", "drift"]);
  assert.equal(searchPostings(idx, "tides")[0].id, 3);
  assert.deepEqual(searchPostings(idx, "nothing here matches"), []);
});

test("visible() filters before ranking: a hidden note leaves no trace", () => {
  const idx = indexPostings(buildPostings(NOTES), NOTES.length);
  const hits = searchPostings(idx, "calibration", { visible: (id) => id !== 0 });
  assert.deepEqual(hits.map((h) => h.id), [2]);
});

test("df cap drops terms in >20% of docs once the vault is big enough; top-N cap per term", () => {
  const many: PostingsInput[] = Array.from({ length: 100 }, (_, i) => ({
    id: i, title: `Note ${i} common`, abstraction: i < 5 ? "rare marker" : "",
  }));
  const rows = buildPostings(many, { maxPerTerm: 3 });
  assert.ok(!rows.some((r) => r.t === "common"), "too common");
  const rare = rows.find((r) => r.t === "rare")!;
  assert.equal(rare.df, 5);
  assert.equal(rare.n.length, 3, "capped");
});

test("postings build is deterministic", () => {
  assert.deepEqual(buildPostings(NOTES), buildPostings([...NOTES].reverse()));
});

test("cards fit the byte budget and clip on word boundaries", () => {
  const card = makeCard({
    id: 7, t: "Alpha Calibration Drift", k: "source", d: "alpha",
    a: "word ".repeat(80), deg: [3, 9], nb: [1, 2, 3, 4, 5], tags: ["a", "b", "c", "d", "e", "f", "g"], stub: false, ret: false,
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(card)).length <= CARD_MAX_BYTES);
  assert.ok(card.nb.length <= 3);
  assert.ok(card.a.endsWith("…"), "an over-long abstraction is clipped to CARD_ABSTRACTION_MAX");
  assert.equal(card.af, undefined);
  assert.equal(clip("short", 120), "short");
  assert.equal(cardChunk(CARDS_PER_CHUNK - 1), 0);
  assert.equal(cardChunkName("main", cardChunk(CARDS_PER_CHUNK * 2)), "main.002.jsonl");
});

// ---------------------------------------------------------------------------
// Term shape (stemming, phrases) and query-time ranking (saturation, coverage)
// ---------------------------------------------------------------------------

import { stemS, queryKeys, termSig, TERMS, RANK, RANK_LINEAR, type TermConfig } from "./postings.ts";

test("S-stemmer folds plurals only", () => {
  assert.equal(stemS("memories"), "memory");
  assert.equal(stemS("agents"), "agent");
  assert.equal(stemS("caches"), "cache");
  assert.equal(stemS("analysis"), "analysis", "-is kept");
  assert.equal(stemS("status"), "status", "-us kept");
  assert.equal(stemS("glass"), "glass", "-ss kept");
  assert.equal(stemS("gas"), "gas", "too short");
  assert.equal(stemS("retrieval"), "retrieval");
});

const PLAIN: TermConfig = { stem: "none", phrases: false, weights: TERMS.weights };
const STEMMED: TermConfig = { ...PLAIN, stem: "s" };

test("stemming lets a plural query meet a singular title", () => {
  const notes: PostingsInput[] = [
    { id: 0, title: "Kestrel Memory Architecture" },
    { id: 1, title: "Lantern Queue" },
  ];
  const plain = indexPostings(buildPostings(notes, { terms: PLAIN }), 2);
  const stemmed = indexPostings(buildPostings(notes, { terms: STEMMED }), 2);
  assert.deepEqual(searchPostings(plain, "kestrel memories", { terms: PLAIN }).map((h) => h.matched), [["kestrel"]]);
  assert.deepEqual(searchPostings(stemmed, "kestrel memories", { terms: STEMMED })[0].matched.sort(), ["kestrel", "memory"]);
});

test("coverage: matching more of the query beats one rare title word", () => {
  // One note shares a single rare word in its title; the other matches
  // three query words in weaker fields. Linear scoring ranks the rare word
  // first; coverage ranks the broader match first.
  const notes: PostingsInput[] = [
    { id: 0, title: "Long-Term Orchard Trust" },
    { id: 1, title: "Sensor Report", abstraction: "memory", tags: ["kestrel", "architecture"] },
    ...Array.from({ length: 6 }, (_, i) => ({ id: 2 + i, title: `Filler ${i}`, abstraction: `sensor memory note ${i}` })),
  ];
  const idx = indexPostings(buildPostings(notes, { terms: PLAIN }), notes.length);
  const q = "long-term kestrel memory architecture";
  const linear = searchPostings(idx, q, { terms: PLAIN, rank: RANK_LINEAR });
  const covered = searchPostings(idx, q, { terms: PLAIN, rank: { k1: 4, coverage: 2, phrase: 0 } });
  assert.ok(linear.findIndex((h) => h.id === 0) < linear.findIndex((h) => h.id === 1), "linear: rare title word first");
  assert.equal(covered[0].id, 1, "coverage: broader match first");
});

test("phrase keys only boost notes a word already found", () => {
  const PHR: TermConfig = { ...PLAIN, phrases: true };
  const notes: PostingsInput[] = [
    { id: 0, title: "Drift Budget" },
    { id: 1, title: "Budget Drift Notes" },
  ];
  const idx = indexPostings(buildPostings(notes, { terms: PHR }), 2);
  assert.deepEqual(queryKeys("drift budget", PHR).phrases, ["drift budget"]);
  const hits = searchPostings(idx, "drift budget", { terms: PHR, rank: { k1: Infinity, coverage: 0, phrase: 1 } });
  assert.equal(hits[0].id, 0, "the exact phrase ranks first");
  assert.deepEqual(hits[0].matched.sort(), ["budget", "drift"], "phrases never appear in matched");
  assert.equal(searchPostings(idx, "budget", { terms: PHR }).length, 2);
});

test("generic query words are dropped on the typed form and the stem", () => {
  assert.deepEqual(queryKeys("agents for kestrel", STEMMED).words, ["kestrel"]);
  assert.deepEqual(queryKeys("agents", STEMMED).words, ["agent"], "all generic: keep them");
});

test("termSig changes with every build-time knob; defaults are the measured ones", () => {
  const sigs = new Set([
    termSig(PLAIN),
    termSig(STEMMED),
    termSig({ ...PLAIN, phrases: true }),
    termSig({ ...PLAIN, weights: { ...PLAIN.weights, title: 5 } }),
  ]);
  assert.equal(sigs.size, 4);
  assert.equal(TERMS.stem, "s");
  assert.ok(RANK.coverage > 0 && Number.isFinite(RANK.k1));
  assert.ok(!Number.isFinite(RANK_LINEAR.k1) && RANK_LINEAR.coverage === 0);
});

test("authority prior: normalised to [0, 1], absent or flat authority is no prior", () => {
  assert.equal(authorityPrior(undefined), undefined);
  assert.equal(authorityPrior([0, 0]), undefined);
  const p = authorityPrior([0, 0.5, 1])!;
  assert.equal(p(0), 0);
  assert.equal(p(2), 1);
  assert.ok(p(1) > 0.5 && p(1) < 1, "the root spreads the heavy tail");
  assert.equal(p(9), 0, "an id past the base (a patched note) has no authority");
});

test("authority breaks a near-tie toward the cited note, and is off unless weighted", () => {
  const twins: PostingsInput[] = [
    { id: 0, title: "Epsilon Ledger" },
    { id: 1, title: "Epsilon Ledger Notes" },
  ];
  const idx = indexPostings(buildPostings(twins), twins.length);
  const prior = authorityPrior([0, 1]);
  assert.equal(searchPostings(idx, "epsilon ledger", { rank: RANK_LINEAR, prior })[0].id, 0, "weight 0: prior ignored");
  const r = { ...RANK_LINEAR, authority: 2 };
  assert.equal(searchPostings(idx, "epsilon ledger", { rank: r, prior })[0].id, 1);
});

test("local rerank: a hit the other hits link to rises; vault-wide popularity alone does not", () => {
  // Tied hits 0..3. Hits 1 and 2 link to 3 (the topical hub's member);
  // 0 is linked only from notes outside the result set (popular elsewhere).
  const hits = [0, 1, 2, 3].map((id) => ({ id, score: 1, matched: ["omega"] }));
  const inbound: Record<number, number[]> = { 0: [90, 91, 92, 93], 3: [1, 2], 1: [], 2: [] };
  const inLinks = (id: number, cb: (from: number) => void) => (inbound[id] ?? []).forEach(cb);
  const rank = { k1: 4, coverage: 2, phrase: 0 };
  assert.deepEqual(localRerank(hits, { ...rank, local: 0.5 }, 4, inLinks).map((h) => h.id), [3, 0, 1, 2]);
  assert.deepEqual(localRerank(hits, rank, 4, inLinks).map((h) => h.id), [0, 1, 2, 3], "off unless weighted");
  const self = { 0: [0], 1: [], 2: [], 3: [] } as Record<number, number[]>;
  assert.deepEqual(localRerank(hits, { ...rank, local: 1 }, 4, (id, cb) => (self[id] ?? []).forEach(cb)).map((h) => h.id), [0, 1, 2, 3], "a self-link counts for nothing");
});

test("a long title sheds tags and neighbours, never the abstraction", () => {
  const a = "staged ledger index that separates writes from lookups across shards"; // < CARD_ABSTRACTION_MAX
  const card = makeCard({
    id: 9, t: `Kappa Ledger ${"Extended Edition ".repeat(6)}— A Very Long Invented Title`, k: "source", d: "alpha",
    a, deg: [1, 1], nb: [1, 2, 3], tags: ["a", "b", "c", "d", "e"], stub: false, ret: false, pub: "2025-02", cr: "2026-01-05",
  });
  assert.equal(card.a, a, "abstraction intact");
  assert.equal(card.tags.length, 0, "tags went first");
  assert.equal(card.nb.length, 0, "then neighbours");
  assert.equal((card as Record<string, unknown>).p, undefined, "no path on cards");
});
