/**
 * Postings + cards on invented notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostings, indexPostings, searchPostings, noteTerms, type PostingsInput } from "./postings.ts";
import { makeCard, clip, CARD_MAX_BYTES, cardChunk, cardChunkName } from "./cards.ts";

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
    id: 7, t: "Alpha Calibration Drift", p: "02 - Research/Alpha/Alpha Calibration Drift.md", k: "source", d: "alpha",
    a: "word ".repeat(80), deg: [3, 9], nb: [1, 2, 3, 4, 5], tags: ["a", "b", "c", "d", "e", "f", "g"], stub: false, ret: false,
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(card)).length <= CARD_MAX_BYTES);
  assert.ok(card.nb.length <= 3);
  assert.ok(card.a.endsWith("…"));
  assert.equal(card.af, undefined);
  assert.equal(clip("short", 120), "short");
  assert.equal(cardChunk(1999), 0);
  assert.equal(cardChunkName("main", cardChunk(4000)), "main.002.jsonl");
});
