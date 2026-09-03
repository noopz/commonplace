/**
 * Tests for the pure seeding/judging helpers of the function-hooks module.
 *
 * The hook body itself needs a live `$` and a terminal surface, so it is not
 * unit-testable here — what IS testable is every decision that determines
 * whether a candidate ever costs a model call, which is where the behaviour
 * (and the cost) actually lives.
 *
 * FIXTURES ARE INVENTED. Per CLAUDE.md: this repo is public, so no note title,
 * concept name, domain slug or body text may come from a real vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tokenize,
  parseJsonl,
  scoreRecord,
  allGeneric,
  rankCandidates,
  stripFrontmatter,
  parseVerdict,
  renderConnection,
  statusLine,
} from "./register.ts";

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
  const tokens = tokenize("we compared the alpha method against a calibration baseline");

  const titleMatch = scoreRecord(
    { name: "Alpha Method", path: "c/alpha.md", abstraction: "unrelated wording here" },
    tokens,
  );
  const abstractionMatch = scoreRecord(
    { name: "Unrelated Name", path: "c/other.md", abstraction: "an alpha calibration technique" },
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
  sources: 0,
  concepts: 0,
  surfaced: 0,
  lastOutcome: "",
  lastError: "",
  partialIndex: false,
  paused: false,
};

test("statusLine draws nothing before the first run", () => {
  assert.equal(statusLine(baseStatus), null);
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
    partialIndex: true,
    lastError: "vault path unresolved",
  });
  assert.ok(line);
  assert.equal(line.dim, false);
  assert.equal(line.color, "yellow");
  assert.match(line.text, /stopped after repeated errors/);
  assert.match(line.text, /vault path unresolved/);
});

test("statusLine reports a partial index when not paused", () => {
  const line = statusLine({ ...baseStatus, phase: "warn", partialIndex: true });
  assert.ok(line);
  assert.equal(line.color, "yellow");
  assert.match(line.text, /outgrew the 2000-line read cap/);
});

test("statusLine omits the last-outcome clause when there is none", () => {
  const line = statusLine({ ...baseStatus, phase: "ok", sources: 1, concepts: 1 });
  assert.ok(line);
  assert.ok(!line.text.includes("last:"));
});

test("statusLine always returns a single line", () => {
  for (const s of [
    { ...baseStatus, phase: "ok" as const, lastOutcome: "surfaced a connection" },
    { ...baseStatus, phase: "warn" as const, paused: true, lastError: "x" },
    { ...baseStatus, phase: "warn" as const, partialIndex: true },
  ]) {
    const line = statusLine(s);
    assert.ok(line && !line.text.includes("\n"));
  }
});
