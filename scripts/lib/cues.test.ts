/**
 * Cue drafting logic on invented notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cuesPrompt, parseCues, redundant, filterCues, insertFrontmatterCues } from "./cues.ts";
import { buildPostings, indexPostings, searchPostings, noteTerms } from "../../hooks/lib/index/postings.ts";

test("prompt carries every note under its key and asks for JSON keyed the same way", () => {
  const p = cuesPrompt([
    { key: "N1", title: "Alpha Method", abstraction: "staged calibration", body: "Body   text\nhere" },
    { key: "N2", title: "Gamma Term", abstraction: "", body: "" },
  ]);
  assert.match(p, /### N1\nTitle: Alpha Method\nSummary: staged calibration\nText: Body text here/);
  assert.match(p, /### N2\nTitle: Gamma Term\nText: /);
  assert.match(p, /\{"N1": \["query"/);
});

test("parseCues tolerates prose and fences, normalises, dedupes, drops junk", () => {
  const reply = 'Sure:\n```json\n{"N1": ["Fixing Drift", "fixing drift", "\\"quoted\\" one", "ab", 7], "N2": "nope"}\n```';
  const m = parseCues(reply, ["N1", "N2", "N3"]);
  assert.deepEqual(m.get("N1"), ["fixing drift", "quoted one"]);
  assert.equal(m.has("N2"), false);
  assert.equal(parseCues("no json here", ["N1"]).size, 0);
  assert.equal(parseCues("{broken", ["N1"]).size, 0);
});

test("a cue the title or an alias already says is redundant (plural-folded)", () => {
  assert.equal(redundant("alpha methods", "Alpha Method", []), true);
  assert.equal(redundant("gt", "Gamma Term", ["GT"]), true);
  assert.equal(redundant("calibration in stages", "Alpha Method", []), false);
});

test("filter keeps cues that rank their own note in the top 3, drops generic and redundant ones", () => {
  const notes = [
    { id: 0, title: "Alpha Method", cues: ["staged calibration fixes", "knowledge notes"] },
    ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Knowledge Notes ${i}`, cues: ["knowledge notes"] })),
  ];
  const idx = indexPostings(buildPostings(notes), notes.length);
  assert.ok(noteTerms(notes[0]).has("staged"));
  const rank = (q: string) => searchPostings(idx, q, { limit: 3 }).map((h) => h.id);
  const f = filterCues(0, ["staged calibration fixes", "knowledge notes", "alpha method"], "Alpha Method", [], rank);
  assert.deepEqual(f.kept, ["staged calibration fixes"]);
  assert.deepEqual(f.dropped, ["knowledge notes", "alpha method"]);
});

test("insertFrontmatterCues appends one flow list and touches nothing else", () => {
  const raw = "---\ntitle: Alpha Method\ntags: [x]\n---\n# Alpha Method\n\nBody.\n";
  assert.equal(
    insertFrontmatterCues(raw, ["it's staged", "two: parts"]),
    "---\ntitle: Alpha Method\ntags: [x]\ncues: ['it''s staged', 'two: parts']\n---\n# Alpha Method\n\nBody.\n",
  );
  assert.equal(insertFrontmatterCues("# No frontmatter\n", ["a"]), null);
  assert.equal(insertFrontmatterCues(raw, []), null);
});
