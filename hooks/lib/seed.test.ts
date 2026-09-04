/**
 * Tests for `seed.ts` and `status.ts` — the pure seeding/judging helpers and
 * the status-band renderer.
 *
 * (This was `hooks/register.test.ts`, which never tested `register.ts` at all.
 * The hook body needs a live `$` and a terminal surface; the logic it used to
 * hold now lives in `pipeline.ts` and is tested there against fake ports.)
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note title,
 * concept name, domain slug or body text may come from a real vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { statusLine } from "./status.ts";
import {
  tokenize,
  parseJsonl,
  scoreRecord,
  allGeneric,
  rankCandidates,
  stripFrontmatter,
  parseVerdict,
  renderConnection,
  isSurfaceable,
} from "./seed.ts";

test("tokenize keeps significant words and drops stopwords and short words", () => {
  const t = tokenize("The Alpha Method was used for a big gamma calibration.");
  assert.ok(t.has("alpha"));
  assert.ok(t.has("gamma"));
  assert.ok(t.has("calibration"));
  // stopwords and sub-4-character words never become evidence
  assert.ok(!t.has("the"));
  assert.ok(!t.has("was"));
  assert.ok(!t.has("for"));
  assert.ok(!t.has("big"));
});

test("parseJsonl skips malformed lines instead of throwing", () => {
  const content = [
    '{"name":"Alpha Method","path":"concepts/alpha.md"}',
    "not json at all",
    '{"name":"Gamma Term","path":"conce',   // a torn line from a partial write
    "",
    '{"name":"Delta Rule","path":"concepts/delta.md"}',
  ].join("\n");

  const recs = parseJsonl(content);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].name, "Alpha Method");
  assert.equal(recs[1].name, "Delta Rule");
});

test("scoreRecord weights a title match above an abstraction match", () => {
  const tokens = tokenize("we compared the alpha technique against a calibration baseline");

  // Both fixtures match on exactly ONE substantive token ("calibration"), so
  // the comparison isolates per-token weight rather than match count.
  const titleMatch = scoreRecord(
    { name: "Calibration", path: "c/alpha.md", abstraction: "unrelated wording here" },
    tokens,
  );
  const abstractionMatch = scoreRecord(
    { name: "Unrelated Naming", path: "c/other.md", abstraction: "a calibration procedure" },
    tokens,
  );

  assert.ok(
    titleMatch.score > 0 && abstractionMatch.score > 0,
    "both fixtures should match on something",
  );
  assert.ok(
    titleMatch.score > abstractionMatch.score,
    `title match (${titleMatch.score}) should outweigh abstraction match (${abstractionMatch.score})`,
  );
});

test("scoreRecord returns zero for a record missing a name or path", () => {
  const tokens = tokenize("alpha method calibration");
  assert.equal(scoreRecord({ path: "c/alpha.md" }, tokens).score, 0);
  assert.equal(scoreRecord({ name: "Alpha Method" }, tokens).score, 0);
});

test("allGeneric rejects evidence made only of generic vocabulary", () => {
  assert.equal(allGeneric(["agent", "model", "system"]), true);
  assert.equal(allGeneric([]), true);
  // one substantive term is enough to make the match real
  assert.equal(allGeneric(["agent", "calibration"]), false);
});

test("rankCandidates drops purely generic matches even when they score high", () => {
  const tokens = tokenize(
    "the agent system model used a tool to process data output for the agent model system",
  );

  // Scores well on raw overlap, but every matched term is generic vocabulary.
  const records = [
    {
      name: "Agent Model System",
      path: "c/generic.md",
      abstraction: "an agent model system tool for data",
      anchors: [],
    },
  ];

  assert.deepEqual(rankCandidates(records, tokens, 4), []);
});

test("rankCandidates orders by score, breaking ties on authority", () => {
  const tokens = tokenize("alpha calibration drift across gamma cohorts");

  const records = [
    {
      name: "Alpha Calibration",
      path: "c/a.md",
      abstraction: "alpha calibration drift",
      anchors: [],
      authority: 0.1,
    },
    {
      name: "Alpha Calibration",
      path: "c/b.md",
      abstraction: "alpha calibration drift",
      anchors: [],
      authority: 0.9,
    },
  ];

  const ranked = rankCandidates(records, tokens, 4);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].path, "c/b.md", "higher authority breaks the tie");
});

test("rankCandidates respects the limit", () => {
  const tokens = tokenize("alpha calibration drift gamma cohorts baseline");
  const records = Array.from({ length: 10 }, (_, i) => ({
    name: `Alpha Calibration ${i}`,
    path: `c/${i}.md`,
    abstraction: "alpha calibration drift gamma",
    anchors: [],
    authority: i / 10,
  }));

  assert.equal(rankCandidates(records, tokens, 3).length, 3);
});

test("stripFrontmatter removes a YAML block but leaves plain prose alone", () => {
  const withFm = "---\ntags: [alpha]\ncreated: '2026-01-01'\n---\n\n# Alpha Method\n\nBody text.";
  assert.ok(!stripFrontmatter(withFm).includes("tags:"));
  assert.ok(stripFrontmatter(withFm).includes("Body text."));

  const withoutFm = "# Alpha Method\n\nBody text.";
  assert.equal(stripFrontmatter(withoutFm), withoutFm);
});

test("parseVerdict treats SKIP, empty, and junk as no-connection", () => {
  assert.equal(parseVerdict("SKIP"), null);
  assert.equal(parseVerdict("skip — nothing relevant here"), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("   "), null);
  // too short to be a real statement, and too long to be one sentence
  assert.equal(parseVerdict("no"), null);
  assert.equal(parseVerdict("x".repeat(400)), null);
});

test("parseVerdict keeps a single-sentence verdict and drops trailing lines", () => {
  const v = parseVerdict(
    "Your Alpha Method note records the same drift failure discussed here.\nExtra rambling.",
  );
  assert.equal(v, "Your Alpha Method note records the same drift failure discussed here.");
});

test("renderConnection produces one wikilinked line", () => {
  const line = renderConnection("Alpha Method", "records the same drift failure.");
  assert.equal(line, "⟡ vault · [[Alpha Method]] — records the same drift failure.");
  assert.ok(!line.includes("\n"), "must stay a single line");
});

// ---------------------------------------------------------------------------
// Status band
// ---------------------------------------------------------------------------

const baseStatus = {
  phase: "idle" as const,
  visible: true,
  sources: 0,
  concepts: 0,
  surfaced: 0,
  lastOutcome: "",
  lastError: "",
  paused: false,
};

test("statusLine draws nothing before the first run", () => {
  assert.equal(statusLine(baseStatus), null);
});

test("statusLine draws nothing while hidden, whatever the state", () => {
  // The band is cleared on every new prompt; a healthy pass or even a paused
  // breaker must stay invisible until the next turn raises it again.
  for (const s of [
    { ...baseStatus, visible: false, phase: "ok" as const, sources: 5, concepts: 5 },
    { ...baseStatus, visible: false, phase: "warn" as const, paused: true, lastError: "x" },
    { ...baseStatus, visible: false, phase: "warn" as const, paused: true },
  ]) {
    assert.equal(statusLine(s), null);
  }
});

test("statusLine reports a healthy pass as a dim heartbeat", () => {
  const line = statusLine({
    ...baseStatus,
    phase: "ok",
    sources: 12,
    concepts: 34,
    surfaced: 2,
    lastOutcome: "judged not relevant",
  });
  assert.ok(line);
  assert.equal(line.dim, true);
  assert.match(line.text, /12 sources/);
  assert.match(line.text, /34 concepts/);
  assert.match(line.text, /2 surfaced/);
  assert.match(line.text, /last: judged not relevant/);
});

test("statusLine surfaces a paused breaker above everything else", () => {
  // paused must win even when a partial index is also flagged
  const line = statusLine({
    ...baseStatus,
    phase: "warn",
    paused: true,
    lastError: "vault path unresolved",
  });
  assert.ok(line);
  assert.equal(line.dim, false);
  assert.equal(line.color, "yellow");
  assert.match(line.text, /stopped after repeated errors/);
  assert.match(line.text, /vault path unresolved/);
});


test("statusLine omits the last-outcome clause when there is none", () => {
  const line = statusLine({ ...baseStatus, phase: "ok", sources: 1, concepts: 1 });
  assert.ok(line);
  assert.ok(!line.text.includes("last:"));
});


// ---------------------------------------------------------------------------
// Regressions from the v1.55.1 review
// ---------------------------------------------------------------------------

test("generic terms do not inflate the score past the threshold", () => {
  // "Alpha Code Tool" shares only generic tokens with the answer. Before the
  // fix these counted toward the score, clearing MIN_SEED_SCORE on vocabulary
  // that appears in nearly every answer, so the all-generic veto never ran.
  const tokens = tokenize(
    "we changed the code in the tool and the system produced a new output value",
  );
  const rec = {
    name: "Code Tool System",
    path: "c/generic.md",
    abstraction: "a code tool for system output values",
    anchors: [],
  };
  assert.equal(scoreRecord(rec, tokens).score, 0);
  assert.deepEqual(rankCandidates([rec], tokens, 4), []);
});

test("scoreRecord counts tags and mocs as cue anchors, like commonplace seed", () => {
  const tokens = tokenize("a discussion of calibration drift in gamma cohorts");
  const viaTags = scoreRecord(
    { name: "Unrelated", path: "c/a.md", tags: ["calibration", "drift"], anchors: [] },
    tokens,
  );
  const viaMocs = scoreRecord(
    { name: "Unrelated", path: "c/b.md", mocs: ["Calibration Drift MOC"], anchors: [] },
    tokens,
  );
  assert.ok(viaTags.score > 0, "tags should contribute");
  assert.ok(viaMocs.score > 0, "mocs should contribute");
});

test("isSurfaceable refuses stubs, private-scope notes, and retired notes", () => {
  assert.equal(isSurfaceable({ name: "Alpha", path: "a.md" }), true);
  assert.equal(isSurfaceable({ name: "Alpha", path: "a.md", isStub: true }), false);
  assert.equal(isSurfaceable({ name: "Alpha", path: "a.md", scope: "private" }), false);
  assert.equal(
    isSurfaceable({ name: "Alpha", path: "a.md", tags: ["retired", "gamma"] }),
    false,
  );
});

test("rankCandidates never returns a private or retired note", () => {
  const tokens = tokenize("alpha calibration drift gamma cohorts baseline");
  const records = [
    {
      name: "Alpha Calibration",
      path: "c/private.md",
      abstraction: "alpha calibration drift gamma",
      scope: "private",
      anchors: [],
    },
    {
      name: "Alpha Calibration",
      path: "c/retired.md",
      abstraction: "alpha calibration drift gamma",
      tags: ["retired"],
      anchors: [],
    },
  ];
  assert.deepEqual(rankCandidates(records, tokens, 4), []);
});

test("parseVerdict rejects plain-English refusals, not just the SKIP token", () => {
  for (const reply of [
    "No connection here worth surfacing.",
    "None of this relates to the note.",
    "Not relevant to what was discussed.",
    "There is no meaningful connection.",
    "Nothing in the note bears on this.",
  ]) {
    assert.equal(parseVerdict(reply), null, `should reject: ${reply}`);
  }
  // a genuine verdict still passes
  assert.ok(parseVerdict("Your Alpha Method note records this same drift failure."));
});
