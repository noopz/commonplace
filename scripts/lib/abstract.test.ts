import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanForAbstraction,
  deriveAbstraction,
  extractSummaryParagraph,
  extractConceptDefinition,
  insertFrontmatterAbstraction,
} from "./abstract.ts";

test("cleanForAbstraction strips wikilinks, markdown links, and emphasis", () => {
  assert.equal(
    cleanForAbstraction("A **harmonic** [[Memory Layer|memory layer]] per [[Cue Anchors]] and [docs](https://example.com)"),
    "A harmonic memory layer per Cue Anchors and docs",
  );
});

test("deriveAbstraction takes the first sentence and strips boilerplate", () => {
  assert.equal(
    deriveAbstraction("This paper introduces a harmonic memory representation that decouples storage from retrieval. It also does other things."),
    "a harmonic memory representation that decouples storage from retrieval",
  );
});

test("deriveAbstraction caps at 12 words and trims trailing punctuation", () => {
  const long = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen.";
  assert.equal(
    deriveAbstraction(long),
    "One two three four five six seven eight nine ten eleven twelve",
  );
});

test("deriveAbstraction returns null for content-thin text", () => {
  assert.equal(deriveAbstraction("It is so."), null);
  assert.equal(deriveAbstraction(""), null);
});

test("extractSummaryParagraph finds the first paragraph under ## Summary", () => {
  const body = "# Title\n\n## Summary\n\nFirst paragraph here.\n\nSecond paragraph.\n\n## Key Contributions\n- x\n";
  assert.equal(extractSummaryParagraph(body), "First paragraph here.");
  assert.equal(extractSummaryParagraph("# Title\n\nNo summary section.\n"), null);
});

test("extractConceptDefinition skips headings and the stub sentinel", () => {
  const compiled = "# Concept Name\n\nA memory architecture with separate working and episodic layers.\n\n## Papers Using This Concept\n- [[X]]\n";
  assert.equal(
    extractConceptDefinition(compiled),
    "A memory architecture with separate working and episodic layers.",
  );
  const stub = "# Concept Name\n\nA concept related to wikilinks. *Definition pending - please update.*\n";
  assert.equal(extractConceptDefinition(stub), null);
});

test("insertFrontmatterAbstraction preserves all other bytes", () => {
  const raw = "---\ntags: [paper]\ncreated: '2026-01-01'\n---\n\n# Title\n\nBody.\n";
  const out = insertFrontmatterAbstraction(raw, "a harmonic memory representation");
  assert.equal(
    out,
    "---\ntags: [paper]\ncreated: '2026-01-01'\nabstraction: 'a harmonic memory representation'\n---\n\n# Title\n\nBody.\n",
  );
});

test("insertFrontmatterAbstraction escapes single quotes YAML-style", () => {
  const raw = "---\ntags: []\n---\nBody\n";
  const out = insertFrontmatterAbstraction(raw, "the model's memory");
  assert.ok(out!.includes("abstraction: 'the model''s memory'"));
});

test("insertFrontmatterAbstraction returns null without closed frontmatter", () => {
  assert.equal(insertFrontmatterAbstraction("# No frontmatter\n", "x y z"), null);
  assert.equal(insertFrontmatterAbstraction("---\nunclosed: true\n", "x y z"), null);
});
